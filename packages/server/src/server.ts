/**
 * The Kosh server (RFC 0002, CLAUDE.md robustness): Fastify with Pino logs (request ids, redacted credentials),
 * authentication through an {@link Authenticator}, one Shutro transaction per request (`request.env`), RFC 9457
 * errors, rate limiting on Valkey, OpenTelemetry spans, health checks, and graceful shutdown.
 */
import rateLimit from '@fastify/rate-limit';
import type { KoshModule } from '@isahaq/kosh-modules-sdk';
import type { Span } from '@opentelemetry/api';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { Valkey } from 'iovalkey';
import { idempotencyTableStatements } from './api/idempotency.js';
import { publicApiModels } from './api/metadata.js';
import { Navigation } from './api/navigation.js';
import { openApiDocument } from './api/openapi.js';
import { registerRestApi } from './api/rest.js';
import { ViewRegistry } from './api/views.js';
import { registerAuthRoutes } from './auth/routes.js';
import { type AuthOptions, AuthService } from './auth/service.js';
import { HttpProblem, problemOf } from './errors.js';
import { type Authenticator, denyAll, type RequestIdentity, runOptionsOf } from './identity.js';
import { type Driver, type Env, orm, pg, type Shutro } from './orm.js';
import { buildKoshRegistry, KOSH_VERSION, type KoshRegistry } from './registry.js';
import { endSpan, tracer } from './telemetry.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** The verified identity, or `null` on public routes. */
    identity: RequestIdentity | null;
    /**
     * Runs `fn` in this request's Shutro transaction (read-only for GET / HEAD, unless `write`: for reads that open
     * audited system scopes). @throws {HttpProblem} 401 without identity
     */
    env<T>(fn: (env: Env) => Promise<T>, options?: { readonly write?: boolean }): Promise<T>;
    /** @internal */
    span: Span | undefined;
  }
  interface FastifyContextConfig {
    /** No authentication, no rate limit (health checks). */
    public?: boolean;
    /** `false`: the route checks the session itself (sign-in, 2FA); still rate limited. */
    auth?: boolean;
  }
}

/** Options of {@link createServer}. */
export interface ServerOptions {
  readonly databaseUrl: string;
  readonly modules: readonly KoshModule[];
  /** Valkey for rate limiting (and later caches, pub/sub); without it, limits are per process. */
  readonly valkeyUrl?: string;
  /**
   * Who is calling. Default: Kosh sessions (cookie or Bearer, 2FA) when the `base` module is installed, otherwise
   * nobody is authenticated.
   */
  readonly authenticate?: Authenticator;
  /** Session settings of the built-in authentication. */
  readonly auth?: AuthOptions & {
    /** Sign-in attempts per 15 minutes per IP and login (default 10; 0 turns the limit off). */
    readonly loginLimit?: number;
  };
  /**
   * Shutro's identity loader checks every request's user (active, companies, groups) against `base`'s data. Default:
   * on with the built-in authentication; custom authenticators opt in.
   */
  readonly verifyIdentities?: boolean;
  /** Requests per window per user (or IP when anonymous). Default 600 per minute. */
  readonly rateLimit?: { readonly max: number; readonly timeWindow: string | number };
  readonly logger?: FastifyServerOptions['logger'];
  /** Maximum database connections (default 10). */
  readonly poolSize?: number;
  /** Passed to the registry: `{ enforce: false }` only for tests of non-security features. */
  readonly security?: { readonly enforce?: boolean | 'warn' };
}

/** What a module's `routes` hook receives (`defineModule({ routes })`). */
export interface ModuleContext {
  readonly app: FastifyInstance;
  readonly shutro: Shutro;
  readonly driver: Driver;
  readonly registry: KoshRegistry;
  readonly auth: AuthService | undefined;
}

/** A created server. */
export interface KoshServer {
  readonly app: FastifyInstance;
  readonly shutro: Shutro;
  readonly driver: Driver;
  readonly registry: KoshRegistry;
  /** The built-in authentication (when `base` is installed). */
  readonly auth: AuthService | undefined;
  /** Stops accepting requests, lets in-flight ones finish, then closes the pool and Valkey. Safe to call twice. */
  close(): Promise<void>;
}

const REDACT = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
];

/** Creates the server (not listening yet). @throws {ServerConfigError} for modules that cannot load together */
export async function createServer(options: ServerOptions): Promise<KoshServer> {
  const registry = buildKoshRegistry(options.modules, {
    ...(options.security === undefined ? {} : { security: options.security }),
  });
  const driver = pg.createDriver({
    url: options.databaseUrl,
    max: options.poolSize ?? 10,
    parseNumeric: orm.toDecimal,
    applicationName: 'kosh',
  });
  const hasBase = registry.registry.models.has('auth.session' as never);
  let shutro: Shutro | undefined;
  const auth = hasBase ? new AuthService(() => shutro as Shutro, options.auth) : undefined;
  const verify =
    auth !== undefined && (options.verifyIdentities ?? options.authenticate === undefined);
  shutro = orm.createShutro({
    driver,
    registry: registry.registry,
    runtimeSecurity: true, // roles, access, rules and field security edited by administrators (RFC 0003)
    ...(verify ? { identity: (uid: number) => auth.verify(uid) } : {}),
  });
  const authenticate: Authenticator =
    options.authenticate ??
    (auth === undefined ? denyAll : (request) => auth.authenticate(request));
  const valkey =
    options.valkeyUrl === undefined
      ? undefined
      : new Valkey(options.valkeyUrl, { lazyConnect: true, maxRetriesPerRequest: 2 });
  if (valkey !== undefined) await valkey.connect();

  const app = Fastify({
    logger: options.logger ?? { level: process.env['LOG_LEVEL'] ?? 'info', redact: REDACT },
    genReqId: (req) => {
      const given = req.headers['x-request-id'];
      return typeof given === 'string' && /^[\w.-]{1,128}$/.test(given)
        ? given
        : crypto.randomUUID();
    },
    requestIdHeader: false,
    return503OnClosing: true,
  });
  app.decorateRequest('identity', null);
  app.decorateRequest('span', undefined);
  // A generic method: Fastify's decorator typing cannot express it; the augmentation above types callers.
  app.decorateRequest('env', function env<T>(
    this: { identity: RequestIdentity | null; span?: Span },
    fn: (env: Env) => Promise<T>,
    options: { readonly write?: boolean } = {},
  ) {
    const request = this as unknown as Parameters<typeof runOptionsOf>[0] & {
      identity: RequestIdentity | null;
    };
    if (request.identity === null)
      throw new HttpProblem(
        401,
        'unauthenticated',
        'Not authenticated',
        'This route needs an authenticated user.',
        'Sign in first.',
      );
    const runOptions = {
      ...runOptionsOf(request, request.identity),
      ...(options.write === true ? { readOnly: false } : {}),
    };
    return tracer.startActiveSpan('shutro.run', async (span) => {
      try {
        return await shutro.run(runOptions, fn);
      } finally {
        span.end();
      }
    });
  } as never);

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
    request.span = tracer.startSpan(`HTTP ${request.method}`, {
      attributes: {
        'http.request.method': request.method,
        'url.path': request.url.split('?')[0] ?? '',
        'kosh.request_id': request.id,
      },
    });
  });
  // Authentication runs before rate limiting, so limits are per user when there is one.
  app.addHook('onRequest', async (request) => {
    const config = request.routeOptions.config;
    if (config.public === true || config.auth === false) return;
    request.identity = await authenticate(request);
  });
  if (options.rateLimit?.max !== 0)
    await app.register(rateLimit, {
      global: true,
      max: options.rateLimit?.max ?? 600,
      timeWindow: options.rateLimit?.timeWindow ?? '1 minute',
      ...(valkey === undefined ? {} : { redis: valkey, nameSpace: 'kosh:ratelimit:' }),
      keyGenerator: (request) =>
        request.identity === null ? `ip:${request.ip}` : `user:${request.identity.user}`,
      allowList: (request) => request.routeOptions.config.public === true,
      errorResponseBuilder: (_request, context) =>
        new HttpProblem(
          429,
          'rate-limited',
          'Too many requests',
          `Limit of ${context.max} requests per ${context.after} reached.`,
          `Retry after ${context.after}.`,
        ),
    });
  // While shutting down, responses ask the client to close its connection, so keep-alive sockets that were busy
  // when the shutdown began do not hold the server open afterwards.
  let shuttingDown = false;
  app.addHook('onSend', async (_request, reply) => {
    if (shuttingDown) reply.header('connection', 'close');
  });
  app.addHook('onResponse', async (request, reply) => {
    if (request.span !== undefined) {
      request.span.setAttribute('http.route', request.routeOptions.url ?? '');
      endSpan(request.span, reply.statusCode);
    }
  });

  app.setErrorHandler(async (error, request, reply) => {
    const problem = problemOf(error);
    if (problem.status >= 500) request.log.error({ err: error }, 'request failed');
    else request.log.info({ problem: problem.type, status: problem.status }, 'request refused');
    request.span?.recordException(error instanceof Error ? error : new Error(String(error)));
    await reply.status(problem.status).type('application/problem+json').send(problem);
  });
  app.setNotFoundHandler(async (request, reply) => {
    await reply
      .status(404)
      .type('application/problem+json')
      .send({
        type: 'https://kosh.dev/problems/not-found',
        title: 'Not found',
        status: 404,
        detail: `No route ${request.method} ${request.url.split('?')[0] ?? ''}.`,
      });
  });

  if (auth !== undefined)
    registerAuthRoutes(app, auth, { loginLimit: options.auth?.loginLimit ?? 10 });

  // The generated REST API and its OpenAPI document (RFC 0002 §6.3–6.4).
  for (const statement of idempotencyTableStatements()) await driver.query(statement);
  const models = publicApiModels(registry);
  const views = new ViewRegistry(registry.loaded.modules, models); // validated at startup
  let openapi: unknown;
  registerRestApi(app, {
    models,
    driver,
    openapi: () => {
      openapi ??= openApiDocument(models.values(), { title: 'Kosh API', version: KOSH_VERSION });
      return openapi;
    },
  });
  new Navigation(registry.loaded).register(app);
  views.register(app);

  // Module routes (admin APIs, custom endpoints), in dependency order.
  const context: ModuleContext = { app, shutro, driver, registry, auth };
  for (const m of registry.loaded.modules)
    if (m.routes !== undefined)
      await (m.routes as (c: ModuleContext) => void | Promise<void>)(context);

  // Health checks: public, not rate limited. Liveness: the process answers. Readiness: dependencies answer.
  app.get('/health/live', { config: { public: true } }, async () => ({ status: 'ok' }));
  app.get('/health/ready', { config: { public: true } }, async (_request, reply) => {
    const checks: Record<string, 'ok' | 'down'> = {};
    try {
      await driver.query({ text: 'SELECT 1', params: [] });
      checks['database'] = 'ok';
    } catch {
      checks['database'] = 'down';
    }
    if (valkey !== undefined)
      checks['valkey'] = (await valkey.ping().catch(() => 'down')) === 'PONG' ? 'ok' : 'down';
    const ready = Object.values(checks).every((c) => c === 'ok');
    await reply.status(ready ? 200 : 503).send({ status: ready ? 'ok' : 'unavailable', checks });
  });

  let closing: Promise<void> | undefined;
  return {
    app,
    shutro,
    driver,
    registry,
    auth,
    close() {
      closing ??= (async () => {
        shuttingDown = true;
        await app.close(); // stops accepting; waits for in-flight requests
        await driver.end({ timeoutSeconds: 10 });
        await valkey?.quit().catch(() => undefined);
      })();
      return closing;
    },
  };
}

/**
 * Listens and shuts down gracefully on SIGTERM / SIGINT (in-flight requests finish, then connections close).
 */
export async function startServer(
  server: KoshServer,
  options: {
    readonly port?: number;
    readonly host?: string;
    readonly onShutdown?: () => Promise<void>;
  } = {},
): Promise<string> {
  const address = await server.app.listen({
    port: options.port ?? 3000,
    host: options.host ?? '0.0.0.0',
  });
  const stop = (signal: string): void => {
    server.app.log.info({ signal }, 'shutting down');
    void server
      .close()
      .then(() => options.onShutdown?.())
      .finally(() => process.exit(0));
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
  return address;
}

export type { FastifyInstance };
