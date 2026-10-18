/**
 * The server core on real PostgreSQL and Valkey: per-request Shutro environments, authentication gate, problem
 * details, health checks, rate limiting shared across instances, request ids, telemetry spans, graceful shutdown.
 */
import { tracing } from '@opentelemetry/sdk-node';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  type Authenticator,
  createServer,
  type KoshServer,
  ServerConfigError,
  startTelemetry,
} from '../src/index.js';
import { orm } from '../src/orm.js';
import { contacts } from './fixtures/contacts.js';
import { type Services, startServices } from './support/services.js';

// Test-only authentication: `x-test-user: <login>` (real sessions and 2FA come with the auth step).
const USERS: Record<string, { user: number; companies: number[]; groups: string[] }> = {
  alice: { user: 1, companies: [1, 2], groups: ['contacts.user'] },
  bob: { user: 2, companies: [1], groups: ['base.user'] }, // no contacts access
  carol: { user: 3, companies: [1], groups: ['contacts.user'] }, // only the rate-limit test
};
const authenticate: Authenticator = async (request) => {
  const login = request.headers['x-test-user'];
  const u = typeof login === 'string' ? USERS[login] : undefined;
  return u === undefined
    ? null
    : { user: u.user, company: u.companies[0] as number, companies: u.companies, groups: u.groups };
};

let services: Services;
let server: KoshServer;
const exporter = new tracing.InMemorySpanExporter();
const telemetry = startTelemetry({
  serviceName: 'kosh-test',
  spanProcessors: [new tracing.SimpleSpanProcessor(exporter)],
});

async function routes(s: KoshServer): Promise<void> {
  s.app.get('/test/whoami', async (request) =>
    request.env(async (env) => ({
      uid: env.uid,
      company: env.companyId,
      companies: env.companyIds,
      lang: env.lang,
      tz: env.tz,
      readOnly: env.readOnly,
    })),
  );
  s.app.get('/test/partners', async (request) =>
    request.env(async (env) =>
      (await env.model('res.partner' as never).search()).map(
        (p) => (p as unknown as { name: string }).name,
      ),
    ),
  );
  s.app.get('/test/write-in-get', async (request) =>
    request.env(async (env) =>
      (
        env.model('res.partner' as never) as unknown as { create(r: unknown[]): Promise<unknown> }
      ).create([{ name: 'x' }]),
    ),
  );
  s.app.post('/test/partners', async (request) =>
    request.env(async (env) => {
      const created = await (
        env.model('res.partner' as never) as unknown as {
          create(r: unknown[]): Promise<{ ids: number[] }>;
        }
      ).create([request.body]);
      return { id: created.ids[0] };
    }),
  );
  s.app.get('/test/slow', async (request) =>
    request.env(async () => new Promise((r) => setTimeout(() => r({ done: true }), 400))),
  );
}

beforeAll(async () => {
  services = await startServices();
  server = await createServer({
    databaseUrl: services.databaseUrl,
    valkeyUrl: services.valkeyUrl,
    modules: [contacts],
    authenticate,
    logger: false,
  });
  for (const statement of orm.createTableStatements(server.registry.registry))
    await server.driver.query(statement);
  for (const text of [
    "INSERT INTO res_users (login, name) VALUES ('alice', 'Alice'), ('bob', 'Bob'), ('carol', 'Carol')",
    "INSERT INTO res_currency (name) VALUES ('BDT')",
    "INSERT INTO res_company (name, currency_id) VALUES ('Dhaka Ltd', 1), ('Chattogram Ltd', 1)",
  ])
    await server.driver.query({ text, params: [] });
  await routes(server);
}, 240_000);

afterAll(async () => {
  await server?.close();
  await telemetry.shutdown();
  await services?.stop();
});

describe('per-request environment', () => {
  test('identity, narrowed by headers: company, companies, language, time zone; GET is read-only', async () => {
    const res = await server.app.inject({
      url: '/test/whoami',
      headers: {
        'x-test-user': 'alice',
        'x-company': '2',
        'accept-language': 'bn-BD,en;q=0.8',
        'x-timezone': 'Asia/Dhaka',
      },
    });
    expect(res.json()).toEqual({
      uid: 1,
      company: 2,
      companies: [1, 2],
      lang: 'bn_BD',
      tz: 'Asia/Dhaka',
      readOnly: true,
    });
    const narrowed = await server.app.inject({
      url: '/test/whoami',
      headers: { 'x-test-user': 'alice', 'x-companies': '2', 'x-company': '2' },
    });
    expect(narrowed.json().companies).toEqual([2]);
  });

  test('writes go through in POST and are refused in GET', async () => {
    const created = await server.app.inject({
      method: 'POST',
      url: '/test/partners',
      headers: { 'x-test-user': 'alice' },
      payload: { name: 'Acme' },
    });
    expect(created.statusCode).toBe(200);
    const list = await server.app.inject({
      url: '/test/partners',
      headers: { 'x-test-user': 'alice' },
    });
    expect(list.json()).toEqual(['Acme']);
    const sneaky = await server.app.inject({
      url: '/test/write-in-get',
      headers: { 'x-test-user': 'alice' },
    });
    expect(sneaky.statusCode).toBe(500); // the read-only transaction refuses the INSERT
  });
});

describe('refusals are problem details', () => {
  test('401 without identity, 403 for ACL and companies, 400 for a bad time zone', async () => {
    const anonymous = await server.app.inject({ url: '/test/partners' });
    expect([anonymous.statusCode, anonymous.headers['content-type']]).toEqual([
      401,
      'application/problem+json; charset=utf-8',
    ]);
    expect(anonymous.json()).toMatchObject({
      type: 'https://kosh.dev/problems/unauthenticated',
      status: 401,
    });
    const bob = await server.app.inject({
      url: '/test/partners',
      headers: { 'x-test-user': 'bob' },
    });
    expect(bob.json()).toMatchObject({ status: 403, type: 'https://kosh.dev/problems/access' });
    const company = await server.app.inject({
      url: '/test/whoami',
      headers: { 'x-test-user': 'bob', 'x-company': '2' },
    });
    expect(company.statusCode).toBe(403);
    const tz = await server.app.inject({
      url: '/test/whoami',
      headers: { 'x-test-user': 'alice', 'x-timezone': 'Mars/Olympus' },
    });
    expect(tz.json()).toMatchObject({
      status: 400,
      type: 'https://kosh.dev/problems/invalid-identity',
    });
    const missing = await server.app.inject({ url: '/nope' });
    expect(missing.json()).toMatchObject({ status: 404 });
  });
});

describe('operations', () => {
  test('health: liveness and readiness (database and Valkey), without authentication', async () => {
    expect((await server.app.inject({ url: '/health/live' })).json()).toEqual({ status: 'ok' });
    const ready = await server.app.inject({ url: '/health/ready' });
    expect([ready.statusCode, ready.json()]).toEqual([
      200,
      { status: 'ok', checks: { database: 'ok', valkey: 'ok' } },
    ]);
  });

  test('request ids are echoed (or generated); spans cover the request and the Shutro transaction', async () => {
    exporter.reset();
    const res = await server.app.inject({
      url: '/test/whoami',
      headers: { 'x-test-user': 'alice', 'x-request-id': 'req-42' },
    });
    expect(res.headers['x-request-id']).toBe('req-42');
    expect((await server.app.inject({ url: '/health/live' })).headers['x-request-id']).toMatch(
      /^[0-9a-f-]{36}$/,
    );
    const names = exporter.getFinishedSpans().map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(['HTTP GET', 'shutro.run']));
    const http = exporter
      .getFinishedSpans()
      .find((s) => s.attributes['kosh.request_id'] === 'req-42');
    expect(http?.attributes).toMatchObject({
      'http.route': '/test/whoami',
      'http.response.status_code': 200,
    });
  });

  test('rate limits are per user and shared by every instance through Valkey', async () => {
    const limited = await createServer({
      databaseUrl: services.databaseUrl,
      valkeyUrl: services.valkeyUrl,
      modules: [contacts],
      authenticate,
      logger: false,
      rateLimit: { max: 3, timeWindow: '1 minute' },
    });
    const twin = await createServer({
      databaseUrl: services.databaseUrl,
      valkeyUrl: services.valkeyUrl,
      modules: [contacts],
      authenticate,
      logger: false,
      rateLimit: { max: 3, timeWindow: '1 minute' },
    });
    try {
      await routes(limited);
      await routes(twin);
      const hit = (s: KoshServer, user: string) =>
        s.app.inject({ url: '/test/whoami', headers: { 'x-test-user': user } });
      // carol is fresh: alice's earlier requests already count in the shared Valkey window.
      const codes = [
        await hit(limited, 'carol'),
        await hit(twin, 'carol'),
        await hit(limited, 'carol'),
        await hit(twin, 'carol'),
      ].map((r) => r.statusCode);
      expect(codes).toEqual([200, 200, 200, 429]);
      expect((await hit(twin, 'carol')).json()).toMatchObject({
        status: 429,
        type: 'https://kosh.dev/problems/rate-limited',
      });
      expect((await hit(limited, 'bob')).statusCode).toBe(200); // another user has their own budget
      expect((await limited.app.inject({ url: '/health/live' })).statusCode).toBe(200); // health is never limited
    } finally {
      await limited.close();
      await twin.close();
    }
  });

  test('graceful shutdown: in-flight requests finish, new connections are refused, close is idempotent', async () => {
    const s = await createServer({
      databaseUrl: services.databaseUrl,
      modules: [contacts],
      authenticate,
      logger: false,
    });
    await routes(s);
    const address = await s.app.listen({ port: 0, host: '127.0.0.1' });
    const inFlight = fetch(`${address}/test/slow`, { headers: { 'x-test-user': 'alice' } });
    await new Promise((r) => setTimeout(r, 100));
    const closing = s.close();
    const response = await inFlight;
    expect([response.status, await response.json()]).toEqual([200, { done: true }]);
    await closing;
    await s.close();
    await expect(fetch(`${address}/health/live`)).rejects.toThrow();
  });
});

describe('module loading', () => {
  test('a manifest must wrap a real Shutro module', async () => {
    // Passes the module loader (same shape and groups) but is not a Shutro module.
    const fake = {
      ...contacts,
      shutro: {
        name: 'contacts',
        version: '0.1.0',
        depends: [{ name: 'base' }],
        groups: [{ code: 'contacts.user' }, { code: 'contacts.manager' }],
        permissions: [],
      },
    };
    await expect(
      createServer({ databaseUrl: services.databaseUrl, modules: [fake], logger: false }),
    ).rejects.toBeInstanceOf(ServerConfigError);
  });
});
