/**
 * Shutro ERP as an OAuth 2.0 provider on real PostgreSQL (RFC 0017 §5.2): an administrator registers apps (the
 * client secret once); a user's consent gives a code for the registered redirect only; the code with its PKCE
 * verifier gives an access token acting as the user within the scopes, and a refresh token that rotates — a reused
 * one revokes the grant's tokens; a used code, a wrong verifier, another redirect or client are refused; tokens are
 * revoked by the app or by the user's grant; discovery describes it all. Nothing gives administrator rights.
 */
import { createHash, randomBytes } from 'node:crypto';
import { defineModule as defineKoshModule } from '@kosh/modules-sdk';
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  base,
  baseShutro,
  createServer,
  installBase,
  type KoshServer,
  type ModuleContext,
  totp,
} from '../src/index.js';
import { orm } from '../src/orm.js';
import { contacts } from './fixtures/contacts.js';
import { type Services, startServices } from './support/services.js';

const tools = defineKoshModule({
  shutro: orm.defineModule({ name: 'tools', version: '0.1.0', depends: [baseShutro], models: [] }),
  depends: [base],
  kosh: '^0.1.0',
  accessLevels: { user: { label: 'Tools', groups: ['base.user'] } },
  routes: (context: ModuleContext) => {
    context.app.get('/api/v1/tools/ping', async (request) =>
      request.env(async () => ({ pong: true })),
    );
  },
});

let services: Services;
let server: KoshServer;
const PASSWORD = 'correct horse battery';
const REDIRECT = 'https://partner.example.test/callback';
const P = '/api/v1/models/res.partner';

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
const call = async (
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<{ status: number; json: Json }> => {
  const res = await server.app.inject({
    method,
    url,
    headers,
    ...(body === undefined
      ? {}
      : typeof body === 'string'
        ? { payload: body }
        : { payload: body as Record<string, unknown> }),
  });
  return { status: res.statusCode, json: res.body === '' ? null : res.json() };
};
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const login = async (user: string) =>
  (await call('POST', '/api/v1/auth/login', {}, { login: user, password: PASSWORD })).json
    .token as string;
let admin = '';
const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};
const query = (params: Record<string, string>) => new URLSearchParams(params).toString();
const form = (params: Record<string, string>) => ({
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(params).toString(),
});
const token = (params: Record<string, string>, headers: Record<string, string> = {}) => {
  const f = form(params);
  return call('POST', '/api/v1/oauth/token', { ...f.headers, ...headers }, f.body);
};

beforeAll(async () => {
  services = await startServices();
  server = await createServer({
    databaseUrl: services.databaseUrl,
    modules: [contacts, tools],
    auth: { secureCookies: false, cacheMs: 0, loginLimit: 0 },
    oauth: { baseUrl: 'https://erp.example.test' },
    logger: false,
  });
  for (const statement of orm.createTableStatements(server.registry.registry))
    await server.driver.query(statement);
  const auth = server.auth;
  if (auth === undefined) throw new Error('base is installed');
  const { company } = await installBase(server.shutro, auth, {
    company: { name: 'Dhaka Ltd', currency: 'BDT' },
    admin: { login: 'admin', name: 'Administrator', password: PASSWORD },
  });
  await auth.createUser({
    login: 'alice',
    name: 'Alice',
    password: PASSWORD,
    company,
    companies: [company],
    groups: ['contacts.user'],
  });
  admin = await login('admin');
  const setup = await call('POST', '/api/v1/auth/2fa/setup', bearer(admin));
  await call('POST', '/api/v1/auth/2fa/enable', bearer(admin), { code: totp(setup.json.secret) });
}, 120_000);

afterAll(async () => {
  await server?.close();
  await services?.stop();
});

let confidential: { clientId: string; clientSecret: string; id: number };
let publicApp: { clientId: string };

test('apps: registered by administrators, the secret once; others refused; addresses checked', async () => {
  const made = await call('POST', '/api/v1/oauth/apps', bearer(admin), {
    name: 'Partner CRM',
    redirectUris: [REDIRECT],
    scopes: ['read:contacts', 'write:contacts'],
    homepage: 'https://partner.example.test',
  });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  expect(made.json.clientId).toMatch(/^kc_/);
  expect(made.json.clientSecret).toMatch(/^ks_/);
  confidential = made.json;
  const listed = await call('GET', '/api/v1/oauth/apps', bearer(admin));
  expect(JSON.stringify(listed.json)).not.toContain(made.json.clientSecret);

  const pub = await call('POST', '/api/v1/oauth/apps', bearer(admin), {
    name: 'Phone app',
    confidential: false,
    redirectUris: ['http://localhost:7777/cb'],
    scopes: ['read:contacts'],
  });
  expect(pub.json.clientSecret).toBeNull();
  publicApp = pub.json;

  for (const body of [
    { name: 'X', redirectUris: ['http://partner.example.test/cb'], scopes: ['*'] }, // http, not localhost
    { name: 'X', redirectUris: [], scopes: ['*'] },
    { name: 'X', redirectUris: [REDIRECT], scopes: ['read:nothing'] },
  ])
    expect(
      (await call('POST', '/api/v1/oauth/apps', bearer(admin), body)).status,
    ).toBeGreaterThanOrEqual(400);
  const alice = await login('alice');
  expect((await call('GET', '/api/v1/oauth/apps', bearer(alice))).status).toBe(403);
});

test('the code flow with PKCE: a token acting as the user within the scopes; refresh rotates', async () => {
  const alice = await login('alice');
  const { verifier, challenge } = pkce();
  const ask = {
    response_type: 'code',
    client_id: confidential.clientId,
    redirect_uri: REDIRECT,
    scope: 'read:contacts',
    state: 'xyz',
    code_challenge: challenge,
    code_challenge_method: 'S256',
  };
  const screen = await call('GET', `/api/v1/oauth/authorize?${query(ask)}`, bearer(alice));
  expect(screen.status, JSON.stringify(screen.json)).toBe(200);
  expect(screen.json).toMatchObject({
    app: { name: 'Partner CRM' },
    redirectHost: 'partner.example.test',
    alreadyAllowed: false,
  });
  expect(screen.json.scopes[0].label).toBe('Read Contacts');

  // Never to an address the app did not register; never more than the app may ask.
  for (const wrong of [
    { redirect_uri: 'https://evil.example.test/cb' },
    { scope: '*' },
    { client_id: 'kc_nope' },
  ])
    expect(
      (await call('GET', `/api/v1/oauth/authorize?${query({ ...ask, ...wrong })}`, bearer(alice)))
        .status,
    ).toBe(400);

  const denied = await call('POST', '/api/v1/oauth/authorize', bearer(alice), {
    ...ask,
    decision: 'deny',
  });
  expect(denied.json.redirect).toBe(
    `${REDIRECT}?error=access_denied&error_description=The+user+declined.&state=xyz`,
  );

  const allowed = await call('POST', '/api/v1/oauth/authorize', bearer(alice), {
    ...ask,
    decision: 'allow',
  });
  const back = new URL(allowed.json.redirect);
  expect(back.origin + back.pathname).toBe(REDIRECT);
  expect(back.searchParams.get('state')).toBe('xyz');
  const code = back.searchParams.get('code') as string;

  const client = { client_id: confidential.clientId, client_secret: confidential.clientSecret };
  const wrongVerifier = await token({
    ...client,
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
    code_verifier: pkce().verifier,
  });
  expect(wrongVerifier.status).toBe(400);
  expect(wrongVerifier.json.error).toBe('invalid_grant');
  expect(
    (
      await token({
        client_id: confidential.clientId,
        client_secret: 'ks_wrong',
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      })
    ).status,
  ).toBe(401);

  const issued = await token({
    ...client,
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
    code_verifier: verifier,
  });
  expect(issued.status, JSON.stringify(issued.json)).toBe(200);
  expect(issued.json).toMatchObject({
    token_type: 'Bearer',
    expires_in: 3600,
    scope: 'read:contacts',
  });
  expect(issued.json.access_token).toMatch(/^oat_/);
  const access = issued.json.access_token as string;

  // As Alice, within the scopes.
  expect((await call('GET', P, bearer(access))).status).toBe(200);
  expect((await call('POST', P, bearer(access), { name: 'Padma' })).status).toBe(403);
  expect((await call('GET', '/api/v1/tools/ping', bearer(access))).status).toBe(403);
  expect((await call('GET', '/api/v1/auth/api-keys', bearer(access))).status).toBe(401); // credentials: a session
  expect((await call('GET', '/api/v1/oauth/apps', bearer(access))).status).toBe(403);

  // The code once: used again, the grant's tokens go.
  const replay = await token({
    ...client,
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
    code_verifier: verifier,
  });
  expect(replay.json.error).toBe('invalid_grant');
  expect((await call('GET', P, bearer(access))).status).toBe(401);

  // A fresh consent; the refresh token rotates, and a reused one revokes everything.
  const again = new URL(
    (await call('POST', '/api/v1/oauth/authorize', bearer(alice), { ...ask, decision: 'allow' }))
      .json.redirect,
  ).searchParams.get('code') as string;
  const second = (
    await token({
      ...client,
      grant_type: 'authorization_code',
      code: again,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    })
  ).json;
  const basic = `Basic ${Buffer.from(`${confidential.clientId}:${confidential.clientSecret}`).toString('base64')}`;
  const rotated = await token(
    { grant_type: 'refresh_token', refresh_token: second.refresh_token },
    { authorization: basic },
  );
  expect(rotated.status, JSON.stringify(rotated.json)).toBe(200);
  expect(rotated.json.refresh_token).not.toBe(second.refresh_token);
  expect((await call('GET', P, bearer(second.access_token))).status).toBe(401); // the old pair is gone
  expect((await call('GET', P, bearer(rotated.json.access_token))).status).toBe(200);
  const reused = await token(
    { grant_type: 'refresh_token', refresh_token: second.refresh_token },
    { authorization: basic },
  );
  expect(reused.json.error).toBe('invalid_grant');
  expect((await call('GET', P, bearer(rotated.json.access_token))).status).toBe(401);
});

test('public apps need PKCE; the user lists and revokes grants; the app revokes tokens; discovery', async () => {
  const alice = await login('alice');
  const noPkce = {
    response_type: 'code',
    client_id: publicApp.clientId,
    redirect_uri: 'http://localhost:7777/cb',
  };
  expect(
    (await call('GET', `/api/v1/oauth/authorize?${query(noPkce)}`, bearer(alice))).status,
  ).toBe(400);
  const { verifier, challenge } = pkce();
  const ask = { ...noPkce, code_challenge: challenge, code_challenge_method: 'S256' };
  const code = new URL(
    (await call('POST', '/api/v1/oauth/authorize', bearer(alice), { ...ask, decision: 'allow' }))
      .json.redirect,
  ).searchParams.get('code') as string;
  const issued = (
    await token({
      client_id: publicApp.clientId,
      grant_type: 'authorization_code',
      code,
      redirect_uri: 'http://localhost:7777/cb',
      code_verifier: verifier,
    })
  ).json;
  expect(issued.scope).toBe('read:contacts'); // no scope asked: the app's own
  expect((await call('GET', P, bearer(issued.access_token))).status).toBe(200);

  // The refresh token rotates for a public app too (no secret).
  const refreshed = (
    await token({
      client_id: publicApp.clientId,
      grant_type: 'refresh_token',
      refresh_token: issued.refresh_token,
    })
  ).json;
  expect(refreshed.access_token).toMatch(/^oat_/);
  expect((await call('GET', P, bearer(issued.access_token))).status).toBe(401);

  // The app revokes its access token (RFC 7009); a client is required.
  expect((await token({}, {})).status).toBe(401);
  const f = form({ client_id: publicApp.clientId, token: refreshed.access_token });
  expect((await call('POST', '/api/v1/oauth/revoke', f.headers, f.body)).status).toBe(200);
  expect((await call('GET', P, bearer(refreshed.access_token))).status).toBe(401);

  // The user's grants: listed, revoked with every token.
  const third = new URL(
    (await call('POST', '/api/v1/oauth/authorize', bearer(alice), { ...ask, decision: 'allow' }))
      .json.redirect,
  ).searchParams.get('code') as string;
  const live = (
    await token({
      client_id: publicApp.clientId,
      grant_type: 'authorization_code',
      code: third,
      redirect_uri: 'http://localhost:7777/cb',
      code_verifier: verifier,
    })
  ).json;
  expect((await call('GET', P, bearer(live.access_token))).status).toBe(200);
  const grants = await call('GET', '/api/v1/auth/oauth/grants', bearer(alice));
  expect(grants.json.grants.map((g: Json) => g.app).sort()).toEqual(['Partner CRM', 'Phone app']);
  const phone = grants.json.grants.find((g: Json) => g.app === 'Phone app');
  expect(
    (await call('POST', `/api/v1/auth/oauth/grants/${phone.id}/revoke`, bearer(alice))).status,
  ).toBe(204);
  expect((await call('GET', P, bearer(live.access_token))).status).toBe(401);
  expect(
    (
      await token({
        client_id: publicApp.clientId,
        grant_type: 'refresh_token',
        refresh_token: live.refresh_token,
      })
    ).json.error,
  ).toBe('invalid_grant');

  const discovery = await call('GET', '/.well-known/oauth-authorization-server');
  expect(discovery.json).toMatchObject({
    issuer: 'https://erp.example.test',
    authorization_endpoint: 'https://erp.example.test/oauth/authorize',
    code_challenge_methods_supported: ['S256'],
  });
  expect(discovery.json.scopes_supported).toContain('read:contacts');

  const [audited] = await server.driver.query<{ n: number }>({
    text: "SELECT count(*)::int AS n FROM audit_event WHERE kind LIKE 'oauth.%'",
    params: [],
  });
  expect(audited?.n).toBeGreaterThanOrEqual(6);
});
