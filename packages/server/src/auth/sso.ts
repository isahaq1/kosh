/**
 * Single sign-on with OpenID Connect (RFC 0034 §2.4, design of 2026-11-18): a person signs in at their company's
 * identity provider — Google, Microsoft, Keycloak, any OIDC provider — and arrives signed in to Kosh.
 *
 * - The **authorization code flow with PKCE**: `start` sends the browser to the provider with a `state`, a `nonce`
 *   and a code challenge kept server-side (hashed, single use, ten minutes); `callback` exchanges the code with the
 *   client secret and the verifier, and verifies the ID token — its signature against the provider's published keys
 *   (RS256, PS256, ES256, on `node:crypto`: no dependency), its issuer, audience, expiry and nonce.
 * - **Only people who already exist** sign in: by an identity linked before (provider + subject), else by the
 *   verified email matching one active person's login or email — linked then. Nobody gets an account by having an
 *   address; an unknown or deactivated person is refused, and it is audited.
 * - The session is made by a **hand-off**: the callback redirects to the sign-in page with a single-use code good
 *   for a minute, which the page exchanges for the session (the cookie and the CSRF token), as a password sign-in
 *   gives them. A session token never travels in an address.
 * - The **second factor still applies**: an account with two-factor sign-in is asked for its code after the
 *   provider (and Administrators need theirs, as always).
 * - A provider's **client secret** is read from the environment (`KOSH_SSO_<KEY>_SECRET`), never stored.
 *
 * - `GET  /api/v1/auth/sso/providers`        the providers a person may choose (`{ key, name }`), public
 * - `GET  /api/v1/auth/sso/:key/start`       `?next=/path` → the provider
 * - `GET  /api/v1/auth/sso/:key/callback`    from the provider → the sign-in page with `?sso=<code>` or `?sso_error=`
 * - `POST /api/v1/auth/sso/complete`         `{ code }` → `{ token, csrfToken, twoFactorRequired }` + cookie
 */
import { createHash, createPublicKey, randomBytes, verify as verifySignature } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { audit } from '../audit.js';
import { HttpProblem } from '../errors.js';
import type { Env, Shutro } from '../orm.js';
import type { AuthService } from './service.js';

type Row = Record<string, unknown>;
type Recs = {
  readonly ids: readonly number[];
  readonly length: number;
  load(keys: readonly string[]): Promise<Recs>;
  read(keys: readonly string[]): Row[];
  write(values: Row): Promise<void>;
};
interface Loose {
  search(q: unknown): Promise<Recs>;
  create(values: unknown): Promise<Recs>;
}
const model = (env: Env, name: string): Loose => env.model(name as never) as unknown as Loose;
const rows = async (set: Recs | Promise<Recs>, keys: readonly string[]): Promise<Row[]> => {
  const s = await set;
  return s.length === 0 ? [] : (await s.load(keys)).read(['id', ...keys]);
};
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const random = (bytes = 32): string => randomBytes(bytes).toString('base64url');
const idOf = (v: unknown): number =>
  typeof v === 'object' && v !== null ? Number((v as { id: unknown }).id) : Number(v);

/** Where a provider's client secret is read from: `KOSH_SSO_GOOGLE_SECRET` for the provider `google`. */
export const ssoSecretName = (key: string): string =>
  `KOSH_SSO_${key.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_SECRET`;

// ---- the provider's documents: discovery and keys, cached

interface Discovery {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly jwks_uri: string;
}
interface Jwk {
  readonly kid?: string;
  readonly kty: string;
  readonly alg?: string;
  readonly use?: string;
  readonly [key: string]: unknown;
}
const CACHE_MS = 10 * 60_000;
const cached = new Map<string, { at: number; value: unknown }>();
async function document<T>(url: string, fresh = false): Promise<T> {
  const hit = cached.get(url);
  if (!fresh && hit !== undefined && Date.now() - hit.at < CACHE_MS) return hit.value as T;
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const value = (await response.json()) as T;
  cached.set(url, { at: Date.now(), value });
  return value;
}
/** The provider's configuration (`/.well-known/openid-configuration`); its issuer must be the one configured. */
export async function discover(issuer: string): Promise<Discovery> {
  const base = issuer.replace(/\/$/, '');
  const found = await document<Discovery>(`${base}/.well-known/openid-configuration`);
  if (String(found.issuer ?? '').replace(/\/$/, '') !== base)
    throw new Error(`The provider says its issuer is ${String(found.issuer)}, not ${issuer}.`);
  for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const)
    if (typeof found[key] !== 'string' || !/^https?:\/\//.test(found[key]))
      throw new Error(`The provider's configuration has no ${key}.`);
  return found;
}

// ---- the ID token

export interface IdClaims {
  readonly iss: string;
  readonly sub: string;
  readonly aud: string | readonly string[];
  readonly exp: number;
  readonly iat?: number;
  readonly nonce?: string;
  readonly email?: string;
  readonly email_verified?: boolean;
  readonly name?: string;
  readonly [claim: string]: unknown;
}

/** Why an ID token is not accepted. */
export class IdTokenError extends Error {
  override readonly name = 'IdTokenError';
}

const ALGORITHMS: Readonly<
  Record<string, { hash: string; padding?: 'pss'; ecdsa?: true; kty: string }>
> = {
  RS256: { hash: 'sha256', kty: 'RSA' },
  PS256: { hash: 'sha256', padding: 'pss', kty: 'RSA' },
  ES256: { hash: 'sha256', ecdsa: true, kty: 'EC' },
};
const decode = (part: string): Row => {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Row;
  } catch {
    throw new IdTokenError('The ID token is not a signed token.');
  }
};

/**
 * Verifies an ID token: signed by one of the provider's keys with an algorithm we accept (never `none`, never a
 * shared secret), issued by the provider for this client, not expired, and carrying the nonce of this sign-in.
 */
export function verifyIdToken(
  token: string,
  keys: readonly Jwk[],
  expected: {
    readonly issuer: string;
    readonly audience: string;
    readonly nonce: string;
    readonly now?: number;
  },
): IdClaims {
  const [head, body, signature, ...more] = token.split('.');
  if (head === undefined || body === undefined || signature === undefined || more.length > 0)
    throw new IdTokenError('The ID token is not a signed token.');
  const header = decode(head);
  const algorithm = ALGORITHMS[String(header['alg'])];
  if (algorithm === undefined)
    throw new IdTokenError(
      `The ID token is signed with ${String(header['alg'])}, which is not accepted.`,
    );
  const candidates = keys.filter(
    (k) =>
      k.kty === algorithm.kty &&
      (header['kid'] === undefined || k.kid === header['kid']) &&
      (k.use === undefined || k.use === 'sig'),
  );
  const signed = Buffer.from(`${head}.${body}`);
  const given = Buffer.from(signature, 'base64url');
  const ok = candidates.some((jwk) => {
    try {
      const key = createPublicKey({ key: jwk as never, format: 'jwk' });
      return verifySignature(
        algorithm.hash,
        signed,
        algorithm.padding === 'pss'
          ? { key, padding: 6 /* RSA_PKCS1_PSS_PADDING */, saltLength: 32 }
          : algorithm.ecdsa === true
            ? { key, dsaEncoding: 'ieee-p1363' }
            : key,
        given,
      );
    } catch {
      return false;
    }
  });
  if (!ok) throw new IdTokenError('The ID token is not signed by the provider.');
  const claims = decode(body) as unknown as IdClaims;
  const now = (expected.now ?? Date.now()) / 1000;
  const issuer = (v: unknown) => String(v ?? '').replace(/\/$/, '');
  if (issuer(claims.iss) !== issuer(expected.issuer))
    throw new IdTokenError('The ID token comes from another issuer.');
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(expected.audience))
    throw new IdTokenError('The ID token was issued for another application.');
  if (audience.length > 1 && claims['azp'] !== expected.audience)
    throw new IdTokenError('The ID token was issued for another application.');
  // A minute of clock difference is allowed.
  if (typeof claims.exp !== 'number' || claims.exp + 60 < now)
    throw new IdTokenError('The ID token has expired.');
  if (typeof claims.iat === 'number' && claims.iat - 60 > now)
    throw new IdTokenError('The ID token is dated in the future.');
  if (claims.nonce !== expected.nonce)
    throw new IdTokenError('The ID token does not belong to this sign-in.');
  if (typeof claims.sub !== 'string' || claims.sub === '')
    throw new IdTokenError('The ID token names nobody.');
  return claims;
}

// ---- the routes

interface Provider {
  readonly id: number;
  readonly key: string;
  readonly name: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly scopes: string;
  readonly trustEmail: boolean;
}
const PROVIDER_KEYS = ['key', 'name', 'issuer', 'clientId', 'scopes', 'trustEmail', 'enabled'];
const STATE_MS = 10 * 60_000;
const HANDOFF_MS = 60_000;

export function registerSsoRoutes(
  app: FastifyInstance,
  auth: AuthService,
  shutro: () => Shutro,
  options: { readonly baseUrl: string },
): void {
  const base = options.baseUrl.replace(/\/$/, '');
  const system = <T>(reason: string, fn: (env: Env) => Promise<T>): Promise<T> =>
    shutro().bootstrap({ reason }, fn);
  const providerOf = async (env: Env, key: string): Promise<Provider | null> => {
    const [row] = await rows(
      model(env, 'auth.sso_provider').search({ where: { key, enabled: true }, limit: 1 }),
      PROVIDER_KEYS,
    );
    if (row === undefined) return null;
    return {
      id: row['id'] as number,
      key: String(row['key']),
      name: String(row['name']),
      issuer: String(row['issuer']),
      clientId: String(row['clientId']),
      scopes: String(row['scopes'] ?? 'openid email profile'),
      trustEmail: row['trustEmail'] === true,
    };
  };
  const secretOf = (key: string): string | undefined => {
    const value = process.env[ssoSecretName(key)];
    return value === undefined || value === '' ? undefined : value;
  };
  const callbackUrl = (key: string) =>
    `${base}/api/v1/auth/sso/${encodeURIComponent(key)}/callback`;
  /** Back to the sign-in page, saying why (a code the page has words for). */
  const refused = (reason: string) => `${base}/login?sso_error=${encodeURIComponent(reason)}`;
  const samePath = (next: unknown): string => {
    const path = typeof next === 'string' ? next : '';
    return path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/\\') ? path : '/';
  };

  app.get('/api/v1/auth/sso/providers', { config: { auth: false } }, async () =>
    system('sso providers', async (env) => ({
      providers: (
        await rows(
          model(env, 'auth.sso_provider').search({ where: { enabled: true }, order: ['name asc'] }),
          ['key', 'name'],
        )
      )
        // One without its secret cannot sign anyone in: not offered.
        .filter((p) => secretOf(String(p['key'])) !== undefined)
        .map((p) => ({ key: String(p['key']), name: String(p['name']) })),
    })),
  );

  app.get('/api/v1/auth/sso/:key/start', { config: { auth: false } }, async (request, reply) => {
    const key = String((request.params as { key?: unknown }).key ?? '');
    const provider = await system('sso start', (env) => providerOf(env, key));
    if (provider === null || secretOf(key) === undefined)
      throw new HttpProblem(
        404,
        'unknown-provider',
        'Unknown provider',
        `No sign-in provider '${key}'.`,
      );
    let found: Discovery;
    try {
      found = await discover(provider.issuer);
    } catch (error) {
      request.log.warn({ err: error, provider: key }, 'sso: the provider cannot be reached');
      return reply.redirect(refused('provider'));
    }
    const state = random();
    const nonce = random();
    const verifier = random(48);
    await system('sso start', async (env) => {
      await model(env, 'auth.sso_state').create([
        {
          kind: 'state',
          codeHash: sha256(state),
          provider: provider.id,
          nonce,
          verifier,
          next: samePath((request.query as { next?: unknown }).next),
          expiresAt: new Date(Date.now() + STATE_MS),
        },
      ]);
    });
    const url = new URL(found.authorization_endpoint);
    for (const [name, value] of Object.entries({
      response_type: 'code',
      client_id: provider.clientId,
      redirect_uri: callbackUrl(key),
      scope: provider.scopes,
      state,
      nonce,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    }))
      url.searchParams.set(name, value);
    return reply.redirect(url.toString());
  });

  app.get('/api/v1/auth/sso/:key/callback', { config: { auth: false } }, async (request, reply) => {
    const key = String((request.params as { key?: unknown }).key ?? '');
    const query = request.query as { code?: unknown; state?: unknown; error?: unknown };
    const failed = async (reason: string, summary: string, details: Row = {}) => {
      await system('sso refused', (env) =>
        audit(env, {
          kind: 'auth.sso_refused',
          summary: summary.slice(0, 300),
          details: { provider: key, ...details },
          ip: request.ip,
        }),
      );
      return reply.redirect(refused(reason));
    };
    // The state of this sign-in: used once, whatever comes next.
    const pending = await system('sso callback', async (env) => {
      const set = await model(env, 'auth.sso_state').search({
        where: { kind: 'state', codeHash: sha256(String(query.state ?? '')) },
        limit: 1,
      });
      const [row] = await rows(set, [
        'provider',
        'nonce',
        'verifier',
        'next',
        'expiresAt',
        'usedAt',
      ]);
      if (row === undefined || row['usedAt'] !== null) return null;
      await set.write({ usedAt: new Date() });
      return new Date(String(row['expiresAt'])).getTime() <= Date.now() ? null : row;
    });
    const provider = await system('sso callback', (env) => providerOf(env, key));
    const secret = secretOf(key);
    if (
      pending === null ||
      provider === null ||
      secret === undefined ||
      idOf(pending['provider']) !== provider.id
    )
      return failed(
        'state',
        'A single sign-on answer without a sign-in of ours (or one used or expired).',
      );
    if (typeof query.error === 'string')
      return failed('provider', `The provider refused the sign-in: ${query.error}.`);
    if (typeof query.code !== 'string' || query.code === '')
      return failed('provider', 'The provider answered without a code.');

    let claims: IdClaims;
    try {
      const found = await discover(provider.issuer);
      const response = await fetch(found.token_endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: query.code,
          redirect_uri: callbackUrl(key),
          client_id: provider.clientId,
          client_secret: secret,
          code_verifier: String(pending['verifier']),
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const answer = (await response.json().catch(() => ({}))) as { id_token?: unknown };
      if (!response.ok || typeof answer.id_token !== 'string')
        return failed('provider', `The provider did not exchange the code (${response.status}).`);
      const expected = {
        issuer: provider.issuer,
        audience: provider.clientId,
        nonce: String(pending['nonce']),
      };
      try {
        claims = verifyIdToken(
          answer.id_token,
          (await document<{ keys: Jwk[] }>(found.jwks_uri)).keys,
          expected,
        );
      } catch (error) {
        if (!(error instanceof IdTokenError)) throw error;
        // The provider may have changed its keys since they were cached: once more with fresh ones.
        claims = verifyIdToken(
          answer.id_token,
          (await document<{ keys: Jwk[] }>(found.jwks_uri, true)).keys,
          expected,
        );
      }
    } catch (error) {
      if (error instanceof IdTokenError) return failed('token', error.message);
      request.log.warn({ err: error, provider: key }, 'sso: the code was not exchanged');
      return failed('provider', 'The provider could not be reached to exchange the code.');
    }

    // Who it is: linked before, or the one active person with this verified address.
    const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
    const outcome = await system('sso sign-in', async (env) => {
      const [linked] = await rows(
        model(env, 'auth.sso_identity').search({
          where: { provider: provider.id, subject: claims.sub },
          limit: 1,
        }),
        ['user'],
      );
      let user = linked === undefined ? null : idOf(linked['user']);
      if (user === null) {
        if (email === '' || (claims.email_verified !== true && !provider.trustEmail))
          return { refused: 'email' as const };
        const byLogin = await model(env, 'res.users').search({
          where: { login: email, active: true },
          limit: 2,
        });
        const byEmail =
          byLogin.length > 0
            ? byLogin
            : await model(env, 'res.users').search({ where: { email, active: true }, limit: 2 });
        if (byEmail.length !== 1) return { refused: 'unknown' as const };
        user = byEmail.ids[0] as number;
        await model(env, 'auth.sso_identity').create([
          { provider: provider.id, subject: claims.sub, user, email },
        ]);
      }
      const [account] = await rows(
        model(env, 'res.users').search({ where: { id: user, active: true } }),
        ['login'],
      );
      if (account === undefined) return { refused: 'unknown' as const };
      const code = random();
      await model(env, 'auth.sso_state').create([
        {
          kind: 'handoff',
          codeHash: sha256(code),
          provider: provider.id,
          user,
          next: String(pending['next'] ?? '/'),
          expiresAt: new Date(Date.now() + HANDOFF_MS),
        },
      ]);
      return { code, next: String(pending['next'] ?? '/') };
    });
    if ('refused' in outcome)
      return failed(
        outcome.refused,
        outcome.refused === 'email'
          ? `${provider.name} gave no verified email address.`
          : `Nobody here has the address ${email.slice(0, 100)} (${provider.name}).`,
        { email: email.slice(0, 100) },
      );
    return reply.redirect(
      `${base}/login?sso=${outcome.code}${outcome.next === '/' ? '' : `&next=${encodeURIComponent(outcome.next)}`}`,
    );
  });

  app.post('/api/v1/auth/sso/complete', { config: { auth: false } }, async (request, reply) => {
    const code = String(((request.body ?? {}) as Row)['code'] ?? '');
    const handoff = await system('sso complete', async (env) => {
      const set = await model(env, 'auth.sso_state').search({
        where: { kind: 'handoff', codeHash: sha256(code) },
        limit: 1,
      });
      const [row] = await rows(set, ['user', 'provider', 'expiresAt', 'usedAt']);
      if (row === undefined || row['usedAt'] !== null) return null;
      await set.write({ usedAt: new Date() });
      return new Date(String(row['expiresAt'])).getTime() <= Date.now() ? null : row;
    });
    if (code === '' || handoff === null)
      throw new HttpProblem(
        401,
        'sso-invalid',
        'Not authenticated',
        'This sign-in was used already or took too long.',
        'Sign in again.',
      );
    const result = await auth.signInAs(
      request as FastifyRequest,
      idOf(handoff['user']),
      'single sign-on',
    );
    reply.header('set-cookie', auth.cookie(result.token));
    return result;
  });
}
