/**
 * Shutro ERP as an OAuth 2.0 provider (RFC 0017 §5.2): third-party apps act for a user who consented, within scopes
 * — the API keys' scopes (`*`, `read:<app>`, `write:<app>`), narrowing the user's own rights, never widening them.
 * Authorization code with PKCE (S256; required of public apps), access tokens for an hour, refresh tokens rotated at
 * each use (a reused one revokes the grant), everything stored as digests and audited.
 *
 * - `GET  /.well-known/oauth-authorization-server`   discovery (RFC 8414)
 * - `GET  /api/v1/oauth/authorize?…`                  the consent screen's data: the app, the scopes in words
 * - `POST /api/v1/oauth/authorize`                    `{ …the same, decision: 'allow' | 'deny' }` → `{ redirect }`
 * - `POST /api/v1/oauth/token`                        `authorization_code` and `refresh_token` grants (form or JSON)
 * - `POST /api/v1/oauth/revoke`                       an access or refresh token (RFC 7009)
 * - `GET  /api/v1/auth/oauth/grants`                  the apps you allowed; `POST …/grants/:id/revoke`
 * - `GET / POST /api/v1/oauth/apps`, `PATCH …/:id`, `POST …/:id/secret`   the apps (administrators and
 *   Integrations managers, with a session)
 *
 * The consent page itself is the back-office's `/oauth/authorize` (the address in the discovery document).
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { audit } from '../audit.js';
import { HttpProblem } from '../errors.js';
import type { Env, Shutro } from '../orm.js';
import type { KoshRegistry } from '../registry.js';
import { digest, randomToken } from './crypto.js';
import { parseScopes } from './scopes.js';
import type { AuthService } from './service.js';
import { type SessionInfo, timeOf } from './service.js';

export const ACCESS_SECONDS = 3600;
const REFRESH_DAYS = 30;
const CODE_MINUTES = 10;
/** Access tokens start with it: the server tells them from sessions and API keys at a glance. */
export const ACCESS_PREFIX = 'oat_';
const REFRESH_PREFIX = 'ort_';

type Row = Record<string, unknown>;
interface Records {
  readonly ids: readonly number[];
  readonly length: number;
  read(keys: readonly string[]): Row[];
  write(values: unknown): Promise<void>;
  load(spec?: unknown): Promise<Records>;
}
interface Ref {
  search(query?: unknown): Promise<Records>;
  browse(ids: readonly number[]): Records;
  create(rows: readonly unknown[]): Promise<Records>;
}
const model = (env: Env, name: string): Ref => env.model(name as never) as unknown as Ref;
async function find(env: Env, name: string, where: unknown, keys: readonly string[]) {
  const set = await model(env, name).search({ where, order: ['id asc'] });
  return set.length === 0 ? [] : (await set.load(keys)).read(['id', ...keys]);
}
const words = (text: unknown) =>
  String(text ?? '')
    .split(/\s+/)
    .filter((w) => w !== '');
const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

/** An OAuth error as RFC 6749 §5.2 shapes it. */
class OAuthError extends Error {
  readonly code: string;
  readonly description: string;
  readonly status: number;
  constructor(code: string, description: string, status = 400) {
    super(description);
    this.code = code;
    this.description = description;
    this.status = status;
  }
}

export interface OAuthOptions {
  /** The back-office's address: the consent page is `<baseUrl>/oauth/authorize`. */
  readonly baseUrl: string;
}

/** A resolved access token: who it acts as, within which scopes. */
export interface OAuthAccess {
  readonly token: number;
  readonly user: number;
  readonly app: number;
  readonly scopes: string[];
}

/** Finds the access token `token` (`oat_…`), live, of an active app and a grant not revoked. */
export async function resolveAccessToken(env: Env, token: string): Promise<OAuthAccess | null> {
  const [row] = await find(env, 'oauth.token', { accessHash: digest(token), revoked: false }, [
    'grant',
    'accessExpiresAt',
  ]);
  if (row === undefined || (timeOf(row['accessExpiresAt']) ?? 0) <= Date.now()) return null;
  const [grant] = await find(env, 'oauth.grant', { id: row['grant'], revoked: false }, [
    'user',
    'app',
    'scopes',
    'lastUsedAt',
  ]);
  if (grant === undefined) return null;
  const [app] = await find(env, 'oauth.app', { id: grant['app'], active: true }, ['name']);
  // Archived users' tokens stop working with them.
  if (
    app === undefined ||
    (await model(env, 'res.users').search({ where: { id: grant['user'] } })).length === 0
  )
    return null;
  if ((timeOf(grant['lastUsedAt']) ?? 0) + 5 * 60_000 < Date.now())
    await model(env, 'oauth.grant')
      .browse([grant['id'] as number])
      .write({ lastUsedAt: new Date() });
  return {
    token: row['id'] as number,
    user: grant['user'] as number,
    app: grant['app'] as number,
    scopes: words(grant['scopes']),
  };
}

export function registerOAuthRoutes(
  app: FastifyInstance,
  auth: AuthService,
  shutro: () => Shutro,
  registry: KoshRegistry,
  options: OAuthOptions,
): void {
  const system = <T>(reason: string, fn: (env: Env) => Promise<T>) =>
    shutro().bootstrap({ reason: `oauth: ${reason}` }, fn);
  const installed = () => new Set(registry.loaded.modules.map((m) => m.name));
  const appLabel = (name: string) =>
    registry.loaded.modules.find((m) => m.name === name)?.app?.label ?? name;
  /** A scope in words, for the consent screen. */
  const describe = (scope: string) => {
    if (scope === '*') return 'Everything you may do';
    const [access, name] = scope.split(':') as [string, string];
    return access === 'read' ? `Read ${appLabel(name)}` : `Read and change ${appLabel(name)}`;
  };
  const base = options.baseUrl.replace(/\/$/, '');

  // ------------------------------------------------------------------------------------- discovery

  app.get(
    '/.well-known/oauth-authorization-server',
    { config: { auth: false } },
    async (request) => {
      const api = `${request.protocol}://${request.host}`;
      return {
        issuer: base,
        authorization_endpoint: `${base}/oauth/authorize`,
        token_endpoint: `${api}/api/v1/oauth/token`,
        revocation_endpoint: `${api}/api/v1/oauth/revoke`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: [
          'client_secret_basic',
          'client_secret_post',
          'none',
        ],
        scopes_supported: ['*', ...[...installed()].flatMap((m) => [`read:${m}`, `write:${m}`])],
      };
    },
  );

  // ------------------------------------------------------------------------------------- consent

  /** Checks an authorization request; problems before the redirect is trusted are 400s, never redirects. */
  const checkRequest = async (env: Env, q: Row) => {
    const bad = (detail: string) =>
      new HttpProblem(400, 'invalid-request', 'Invalid request', detail);
    if (q['response_type'] !== 'code') throw bad("response_type must be 'code'.");
    const [client] = await find(
      env,
      'oauth.app',
      { clientId: String(q['client_id'] ?? ''), active: true },
      ['name', 'homepage', 'confidential', 'redirectUris', 'scopes'],
    );
    if (client === undefined) throw bad('Unknown or inactive client_id.');
    const redirect = String(q['redirect_uri'] ?? '');
    if (!words(client['redirectUris']).includes(redirect))
      throw bad('redirect_uri is not one of the app’s registered addresses.');
    const allowed = new Set(words(client['scopes']));
    const asked =
      q['scope'] === undefined || q['scope'] === ''
        ? [...allowed]
        : parseScopes(String(q['scope']), installed());
    const outside = asked.filter((s) => !allowed.has(s));
    if (outside.length > 0) throw bad(`The app may not ask for ${outside.join(', ')}.`);
    const challenge = typeof q['code_challenge'] === 'string' ? q['code_challenge'] : '';
    if (challenge === '' && client['confidential'] !== true)
      throw bad('A public app must send a PKCE code_challenge (S256).');
    if (challenge !== '' && q['code_challenge_method'] !== 'S256')
      throw bad("code_challenge_method must be 'S256'.");
    if (challenge !== '' && !/^[A-Za-z0-9_-]{43}$/.test(challenge))
      throw bad('code_challenge is a base64url SHA-256 (43 characters).');
    return {
      client,
      redirect,
      scopes: asked.sort(),
      challenge,
      state: typeof q['state'] === 'string' ? q['state'] : undefined,
    };
  };
  const redirectTo = (uri: string, params: Record<string, string | undefined>) => {
    const url = new URL(uri);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
    return url.toString();
  };

  app.get('/api/v1/oauth/authorize', { config: { auth: false } }, async (request) => {
    const session = await auth.requireSession(request);
    return system('consent screen', async (env) => {
      const r = await checkRequest(env, (request.query ?? {}) as Row);
      const [grant] = await find(
        env,
        'oauth.grant',
        { user: session.user, app: r.client['id'], revoked: false },
        ['scopes'],
      );
      const granted = new Set(words(grant?.['scopes']));
      return {
        app: {
          name: String(r.client['name']),
          homepage: typeof r.client['homepage'] === 'string' ? r.client['homepage'] : null,
        },
        redirectHost: new URL(r.redirect).host,
        scopes: r.scopes.map((scope) => ({ scope, label: describe(scope) })),
        // Everything asked was allowed before: the screen may say so.
        alreadyAllowed: r.scopes.every((s) => granted.has(s)),
      };
    });
  });

  app.post('/api/v1/oauth/authorize', { config: { auth: false } }, async (request) => {
    const session = await auth.requireSession(request);
    const body = (request.body ?? {}) as Row;
    return system('consent', async (env) => {
      const r = await checkRequest(env, body);
      if (body['decision'] !== 'allow')
        return {
          redirect: redirectTo(r.redirect, {
            error: 'access_denied',
            error_description: 'The user declined.',
            state: r.state,
          }),
        };
      const grants = await model(env, 'oauth.grant').search({
        where: { user: session.user, app: r.client['id'] },
      });
      let grant: number;
      if (grants.length === 0)
        grant = (
          await model(env, 'oauth.grant').create([
            { user: session.user, app: r.client['id'], scopes: r.scopes.join(' ') },
          ])
        ).ids[0] as number;
      else {
        grant = grants.ids[0] as number;
        await model(env, 'oauth.grant')
          .browse([grant])
          .write({ scopes: r.scopes.join(' '), revoked: false });
      }
      const code = randomToken();
      await model(env, 'oauth.code').create([
        {
          codeHash: digest(code),
          grant,
          redirectUri: r.redirect,
          challenge: r.challenge === '' ? null : r.challenge,
          expiresAt: new Date(Date.now() + CODE_MINUTES * 60_000),
        },
      ]);
      await audit(env, {
        kind: 'oauth.consent',
        summary: `Allowed ${String(r.client['name'])}: ${r.scopes.join(' ')}.`,
        actor: session.user,
        targetModel: 'oauth.app',
        targetId: r.client['id'] as number,
        ip: request.ip,
      });
      return { redirect: redirectTo(r.redirect, { code, state: r.state }) };
    });
  });

  // ------------------------------------------------------------------------------------- tokens

  /** The client of a token or revoke request: `client_secret_basic`, `client_secret_post`, or public (`none`). */
  const clientOf = async (env: Env, request: FastifyRequest, body: Row) => {
    let id = typeof body['client_id'] === 'string' ? body['client_id'] : '';
    let secret = typeof body['client_secret'] === 'string' ? body['client_secret'] : '';
    const basic = /^Basic\s+(\S+)$/i.exec(String(request.headers.authorization ?? ''))?.[1];
    if (basic !== undefined) {
      const [user, pass] = Buffer.from(basic, 'base64').toString('utf8').split(':');
      id = decodeURIComponent(user ?? '');
      secret = decodeURIComponent(pass ?? '');
    }
    const [client] = await find(env, 'oauth.app', { clientId: id, active: true }, [
      'name',
      'confidential',
      'secretHash',
    ]);
    if (client === undefined) throw new OAuthError('invalid_client', 'Unknown client.', 401);
    if (client['confidential'] === true) {
      if (secret === '' || !same(digest(secret), String(client['secretHash'] ?? '')))
        throw new OAuthError('invalid_client', 'Wrong client credentials.', 401);
    }
    return client;
  };
  const issue = async (env: Env, grant: number) => {
    const access = `${ACCESS_PREFIX}${randomToken()}`;
    const refresh = `${REFRESH_PREFIX}${randomToken()}`;
    const now = Date.now();
    await model(env, 'oauth.token').create([
      {
        grant,
        accessHash: digest(access),
        refreshHash: digest(refresh),
        accessExpiresAt: new Date(now + ACCESS_SECONDS * 1000),
        refreshExpiresAt: new Date(now + REFRESH_DAYS * 86_400_000),
      },
    ]);
    const [row] = await find(env, 'oauth.grant', { id: grant }, ['scopes']);
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: ACCESS_SECONDS,
      refresh_token: refresh,
      scope: String(row?.['scopes'] ?? ''),
    };
  };
  /** Revokes a grant's tokens (a replayed code or refresh token: someone else may hold them). */
  const revokeGrantTokens = async (env: Env, grant: number) => {
    const tokens = await model(env, 'oauth.token').search({ where: { grant, revoked: false } });
    if (tokens.length > 0) await tokens.write({ revoked: true });
  };

  /** A refusal whose revocations must commit: returned from the transaction, thrown after it. */
  interface Failure {
    readonly failure: OAuthError;
  }
  const tokenEndpoint = async (request: FastifyRequest, body: Row) => {
    const out = await system(
      'token',
      async (env): Promise<Awaited<ReturnType<typeof issue>> | Failure> => {
        const client = await clientOf(env, request, body);
        if (body['grant_type'] === 'authorization_code') {
          const [code] = await find(
            env,
            'oauth.code',
            { codeHash: digest(String(body['code'] ?? '')) },
            ['grant', 'redirectUri', 'challenge', 'expiresAt', 'used'],
          );
          if (code === undefined) throw new OAuthError('invalid_grant', 'Unknown code.');
          const [grant] = await find(env, 'oauth.grant', { id: code['grant'] }, [
            'app',
            'user',
            'revoked',
          ]);
          if (grant === undefined || grant['app'] !== client['id'])
            throw new OAuthError('invalid_grant', 'The code was issued to another client.');
          if (code['used'] === true) {
            // A code used twice: its tokens may be in the wrong hands.
            await revokeGrantTokens(env, code['grant'] as number);
            return { failure: new OAuthError('invalid_grant', 'The code was already used.') };
          }
          if ((timeOf(code['expiresAt']) ?? 0) <= Date.now() || grant['revoked'] === true)
            throw new OAuthError('invalid_grant', 'The code expired.');
          if (body['redirect_uri'] !== code['redirectUri'])
            throw new OAuthError(
              'invalid_grant',
              'redirect_uri differs from the authorization request.',
            );
          if (typeof code['challenge'] === 'string') {
            const verifier = typeof body['code_verifier'] === 'string' ? body['code_verifier'] : '';
            if (
              !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
              !same(s256(verifier), code['challenge'])
            )
              throw new OAuthError('invalid_grant', 'The PKCE code_verifier does not match.');
          }
          await model(env, 'oauth.code')
            .browse([code['id'] as number])
            .write({ used: true });
          return issue(env, code['grant'] as number);
        }
        if (body['grant_type'] === 'refresh_token') {
          const [token] = await find(
            env,
            'oauth.token',
            { refreshHash: digest(String(body['refresh_token'] ?? '')) },
            ['grant', 'refreshExpiresAt', 'revoked', 'rotated'],
          );
          if (token === undefined) throw new OAuthError('invalid_grant', 'Unknown refresh token.');
          const [grant] = await find(env, 'oauth.grant', { id: token['grant'] }, [
            'app',
            'revoked',
          ]);
          if (grant === undefined || grant['app'] !== client['id'])
            throw new OAuthError('invalid_grant', 'The token was issued to another client.');
          if (token['rotated'] === true) {
            // A rotated refresh token used again: revoke the grant's tokens (RFC 9700 §4.14.2).
            await revokeGrantTokens(env, token['grant'] as number);
            await audit(env, {
              kind: 'oauth.refresh_reused',
              summary: `A used refresh token of ${String(client['name'])} came back: its tokens are revoked.`,
              targetModel: 'oauth.app',
              targetId: client['id'] as number,
              ip: request.ip,
            });
            return {
              failure: new OAuthError('invalid_grant', 'The refresh token was already used.'),
            };
          }
          if (
            token['revoked'] === true ||
            (timeOf(token['refreshExpiresAt']) ?? 0) <= Date.now() ||
            grant['revoked'] === true
          )
            throw new OAuthError('invalid_grant', 'The refresh token expired or was revoked.');
          await model(env, 'oauth.token')
            .browse([token['id'] as number])
            .write({ revoked: true, rotated: true });
          return issue(env, token['grant'] as number);
        }
        throw new OAuthError('unsupported_grant_type', 'Use authorization_code or refresh_token.');
      },
    );
    if ('failure' in out) throw out.failure;
    return out;
  };

  // The token and revoke endpoints take form bodies (RFC 6749 §4.1.3) as well as JSON.
  app.register(async (scope: FastifyInstance) => {
    scope.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: 16_384 },
      (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))),
    );
    const answer = async (reply: FastifyReply, run: () => Promise<unknown>) => {
      reply.header('cache-control', 'no-store').header('pragma', 'no-cache');
      try {
        return await run();
      } catch (e) {
        if (!(e instanceof OAuthError)) throw e;
        if (e.status === 401) reply.header('www-authenticate', 'Basic realm="oauth"');
        return reply.status(e.status).send({ error: e.code, error_description: e.description });
      }
    };
    scope.post('/api/v1/oauth/token', { config: { auth: false } }, async (request, reply) =>
      answer(reply, () => tokenEndpoint(request, (request.body ?? {}) as Row)),
    );
    scope.post('/api/v1/oauth/revoke', { config: { auth: false } }, async (request, reply) =>
      answer(reply, () =>
        system('revoke', async (env) => {
          const body = (request.body ?? {}) as Row;
          const client = await clientOf(env, request, body);
          const hash = digest(String(body['token'] ?? ''));
          for (const where of [{ accessHash: hash }, { refreshHash: hash }]) {
            const [token] = await find(env, 'oauth.token', where, ['grant']);
            if (token === undefined) continue;
            const [grant] = await find(env, 'oauth.grant', { id: token['grant'] }, ['app']);
            // Another client's token: answered the same way (RFC 7009 §2.2), left alone.
            if (grant?.['app'] === client['id'])
              await model(env, 'oauth.token')
                .browse([token['id'] as number])
                .write({ revoked: true });
          }
          return {};
        }),
      ),
    );
  });

  // ------------------------------------------------------------------------------------- the user's grants

  app.get('/api/v1/auth/oauth/grants', { config: { auth: false } }, async (request) => {
    const session = await auth.requireSession(request);
    return system('grants', async (env) => {
      const grants = await find(env, 'oauth.grant', { user: session.user, revoked: false }, [
        'app',
        'scopes',
        'createdAt',
        'lastUsedAt',
      ]);
      const apps = new Map(
        (
          await find(env, 'oauth.app', { id: { in: grants.map((g) => g['app']) } }, [
            'name',
            'homepage',
          ])
        ).map((a) => [a['id'], a]),
      );
      const iso = (v: unknown) =>
        timeOf(v) === null ? null : new Date(timeOf(v) as number).toISOString();
      return {
        grants: grants.map((g) => ({
          id: g['id'] as number,
          app: String(apps.get(g['app'])?.['name'] ?? ''),
          homepage: (apps.get(g['app'])?.['homepage'] as string | null | undefined) ?? null,
          scopes: words(g['scopes']).map((scope) => ({ scope, label: describe(scope) })),
          createdAt: iso(g['createdAt']),
          lastUsedAt: iso(g['lastUsedAt']),
        })),
      };
    });
  });

  app.post(
    '/api/v1/auth/oauth/grants/:id/revoke',
    { config: { auth: false } },
    async (request, reply) => {
      const session = await auth.requireSession(request);
      const id = Number((request.params as { id?: string }).id);
      await system('revoke grant', async (env) => {
        const grants = await model(env, 'oauth.grant').search({
          where: { id, user: session.user },
        });
        if (grants.length === 0)
          throw new HttpProblem(404, 'missing-record', 'Not found', `You have no grant ${id}.`);
        await grants.write({ revoked: true });
        await revokeGrantTokens(env, id);
        await audit(env, {
          kind: 'oauth.revoked',
          summary: `Access of an app revoked (grant ${id}).`,
          actor: session.user,
          targetModel: 'oauth.grant',
          targetId: id,
          ip: request.ip,
        });
      });
      return reply.status(204).send();
    },
  );

  // ------------------------------------------------------------------------------------- the apps

  /** Administrators and Integrations managers, with a session (no API key or token manages apps). */
  const manager = async (request: FastifyRequest): Promise<SessionInfo> => {
    if (request.identity?.scopes !== undefined)
      throw new HttpProblem(
        403,
        'session-only',
        'With a session only',
        'OAuth apps are managed with a session.',
      );
    const session = await auth.requireSession(request);
    const allowed = await request.env(
      async (env) => env.administrator || env.groups.has('integrations.manager'),
    );
    if (!allowed)
      throw new HttpProblem(
        403,
        'access',
        'OAuth apps',
        'Managing OAuth apps needs the Administrator role or the Integrations manager access.',
      );
    return session;
  };
  const appKeys = [
    'name',
    'clientId',
    'confidential',
    'redirectUris',
    'scopes',
    'homepage',
    'active',
  ] as const;
  const shape = (a: Row) => ({
    id: a['id'] as number,
    name: String(a['name']),
    clientId: String(a['clientId']),
    confidential: a['confidential'] === true,
    redirectUris: words(a['redirectUris']),
    scopes: words(a['scopes']),
    homepage: (a['homepage'] as string | null) ?? null,
    active: a['active'] === true,
  });
  const appValues = (body: Row, creating: boolean) => {
    const values: Row = {};
    const bad = (detail: string) => new HttpProblem(422, 'invalid-app', 'Invalid app', detail);
    if (creating || body['name'] !== undefined) {
      const name = String(body['name'] ?? '').trim();
      if (name === '' || name.length > 120) throw bad('The app needs a name.');
      values['name'] = name;
    }
    if (creating || body['redirectUris'] !== undefined) {
      const uris = Array.isArray(body['redirectUris']) ? body['redirectUris'].map(String) : [];
      if (uris.length === 0) throw bad('Give at least one redirect address.');
      for (const uri of uris) {
        let url: URL;
        try {
          url = new URL(uri);
        } catch {
          throw bad(`"${uri}" is not an address.`);
        }
        const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
        if (url.hash !== '' || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)))
          throw bad(`"${uri}" must be https (http only for localhost), without a #fragment.`);
      }
      values['redirectUris'] = uris.join('\n');
    }
    if (creating || body['scopes'] !== undefined)
      values['scopes'] = parseScopes(
        Array.isArray(body['scopes']) ? body['scopes'].map(String) : String(body['scopes'] ?? ''),
        installed(),
      ).join(' ');
    if (body['homepage'] !== undefined)
      values['homepage'] = body['homepage'] === null ? null : String(body['homepage']);
    if (body['active'] !== undefined) values['active'] = body['active'] === true;
    return values;
  };

  app.get('/api/v1/oauth/apps', async (request) => {
    await manager(request);
    return system('apps', async (env) => ({
      apps: (await find(env, 'oauth.app', {}, appKeys)).map(shape),
    }));
  });

  app.post('/api/v1/oauth/apps', async (request, reply) => {
    const session = await manager(request);
    const body = (request.body ?? {}) as Row;
    const values = appValues(body, true);
    const confidential = body['confidential'] !== false;
    const secret = confidential ? `ks_${randomToken()}` : null;
    const made = await system('new app', async (env) => {
      const created = await model(env, 'oauth.app').create([
        {
          ...values,
          clientId: `kc_${randomToken(12)}`,
          confidential,
          secretHash: secret === null ? null : digest(secret),
          owner: session.user,
        },
      ]);
      const id = created.ids[0] as number;
      await audit(env, {
        kind: 'oauth.app_created',
        summary: `OAuth app ${String(values['name'])} created.`,
        actor: session.user,
        targetModel: 'oauth.app',
        targetId: id,
        ip: request.ip,
      });
      const [row] = await find(env, 'oauth.app', { id }, appKeys);
      return shape(row as Row);
    });
    // The secret once: only its digest is kept.
    return reply.status(201).send({ ...made, clientSecret: secret });
  });

  app.patch('/api/v1/oauth/apps/:id', async (request) => {
    const session = await manager(request);
    const id = Number((request.params as { id?: string }).id);
    const values = appValues((request.body ?? {}) as Row, false);
    return system('change app', async (env) => {
      const set = await model(env, 'oauth.app').search({ where: { id } });
      if (set.length === 0)
        throw new HttpProblem(404, 'missing-record', 'Not found', `There is no app ${id}.`);
      if (Object.keys(values).length > 0) await set.write(values);
      await audit(env, {
        kind: 'oauth.app_changed',
        summary: `OAuth app ${id} changed: ${Object.keys(values).join(', ')}.`,
        actor: session.user,
        targetModel: 'oauth.app',
        targetId: id,
        ip: request.ip,
      });
      const [row] = await find(env, 'oauth.app', { id }, appKeys);
      return shape(row as Row);
    });
  });

  app.post('/api/v1/oauth/apps/:id/secret', async (request) => {
    const session = await manager(request);
    const id = Number((request.params as { id?: string }).id);
    const secret = `ks_${randomToken()}`;
    await system('new secret', async (env) => {
      const set = await model(env, 'oauth.app').search({ where: { id, confidential: true } });
      if (set.length === 0)
        throw new HttpProblem(
          404,
          'missing-record',
          'Not found',
          `There is no confidential app ${id}.`,
        );
      await set.write({ secretHash: digest(secret) });
      await audit(env, {
        kind: 'oauth.app_secret',
        summary: `A new client secret for OAuth app ${id}; the old one stops working.`,
        actor: session.user,
        targetModel: 'oauth.app',
        targetId: id,
        ip: request.ip,
      });
    });
    return { clientSecret: secret };
  });
}
