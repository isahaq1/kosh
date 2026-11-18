/**
 * Single sign-on with OpenID Connect (RFC 0034 §2.4) on real PostgreSQL, against a fake provider over real HTTP: a
 * person who exists signs in by their verified address and is linked to the provider; the next time the link signs
 * them in whatever their address; someone unknown, deactivated or unverified is refused; a token for another
 * application, expired, signed by another key or of another sign-in is refused; a state or a hand-off code works
 * once; an account with two-factor sign-in still owes its code; every outcome is in the audit log.
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  base,
  createServer,
  installBase,
  type KoshServer,
  ssoSecretName,
  totp,
} from '../src/index.js';
import { orm } from '../src/orm.js';
import { type TestDatabase, testDatabase } from '../src/testing.js';
import { type FakeOidc, fakeOidc } from './support/fake-oidc.js';

const PASSWORD = 'correct horse battery';
const BASE = 'https://erp.example.test';

let container: TestDatabase;
let server: KoshServer;
let provider: FakeOidc;
let rumi = 0;

const get = (url: string) => server.app.inject({ method: 'GET', url });
/** The path and query of an address of ours. */
const local = (location: string) => location.replace(BASE, '');
/**
 * The browser's journey: start with us, be approved at the provider, come back. Returns where the callback sends
 * the browser (the sign-in page, with a hand-off code or an error).
 */
async function journey(next?: string): Promise<URL> {
  const start = await get(
    `/api/v1/auth/sso/fake/start${next === undefined ? '' : `?next=${encodeURIComponent(next)}`}`,
  );
  expect(start.statusCode, start.body).toBe(302);
  const atProvider = await fetch(String(start.headers.location), { redirect: 'manual' });
  expect(atProvider.status).toBe(302);
  const back = await get(local(String(atProvider.headers.get('location'))));
  expect(back.statusCode, back.body).toBe(302);
  return new URL(String(back.headers.location));
}
const complete = (code: string) =>
  server.app.inject({ method: 'POST', url: '/api/v1/auth/sso/complete', payload: { code } });
const audited = async (kind: string) =>
  (
    await server.driver.query<{ summary: string }>({
      text: 'SELECT summary FROM audit_event WHERE kind = $1 ORDER BY id',
      params: [kind],
    })
  ).map((r) => r.summary);

beforeAll(async () => {
  provider = await fakeOidc();
  process.env[ssoSecretName('fake')] = provider.clientSecret;
  container = await testDatabase();
  server = await createServer({
    databaseUrl: container.getConnectionUri(),
    modules: [base],
    auth: { secureCookies: false, cacheMs: 0, loginLimit: 0 },
    oauth: { baseUrl: BASE },
    rateLimit: { max: 0, timeWindow: '1 minute' },
    logger: false,
  });
  for (const statement of orm.createTableStatements(server.registry.registry))
    await server.driver.query(statement);
  const auth = server.auth;
  if (auth === undefined) throw new Error('base is installed');
  const { company } = await installBase(server.shutro, auth, {
    company: { name: 'Padma Traders', currency: 'BDT' },
    admin: { login: 'admin', name: 'Administrator', password: PASSWORD },
  });
  rumi = await auth.createUser({
    login: 'rumi@padma.test',
    name: 'Rumi',
    password: PASSWORD,
    company,
    companies: [company],
    groups: ['base.user'],
  });
  await auth.createUser({
    login: 'gone@padma.test',
    name: 'Gone',
    password: PASSWORD,
    company,
    companies: [company],
    groups: ['base.user'],
  });
  await server.shutro.bootstrap({ reason: 'test' }, async (env) => {
    const create = (name: string, rows: unknown[]) =>
      (env.model(name as never) as unknown as { create(r: unknown[]): Promise<unknown> }).create(
        rows,
      );
    await create('auth.sso_provider', [
      { key: 'fake', name: 'Fake ID', issuer: provider.issuer, clientId: provider.clientId },
      { key: 'nosecret', name: 'No secret', issuer: provider.issuer, clientId: 'x' },
      { key: 'off', name: 'Off', issuer: provider.issuer, clientId: 'x', enabled: false },
    ]);
    await env.sql`UPDATE res_users SET active = false WHERE login = 'gone@padma.test'`;
  });
}, 180_000);

afterAll(async () => {
  await server?.close();
  await container?.stop();
  await provider?.close();
});

test('the providers offered are the enabled ones that have their secret', async () => {
  const offered = await get('/api/v1/auth/sso/providers');
  expect(offered.json()).toEqual({ providers: [{ key: 'fake', name: 'Fake ID' }] });
  expect((await get('/api/v1/auth/sso/nosecret/start')).statusCode).toBe(404);
  expect((await get('/api/v1/auth/sso/off/start')).statusCode).toBe(404);
});

test('a person who exists signs in by their verified address; the hand-off works once', async () => {
  provider.person = { sub: 'rumi-at-fake', email: 'Rumi@Padma.test', email_verified: true };
  const landed = await journey('/sales/a/orders');
  expect(`${landed.origin}${landed.pathname}`).toBe(`${BASE}/login`);
  expect(landed.searchParams.get('next')).toBe('/sales/a/orders');
  const code = landed.searchParams.get('sso') ?? '';
  expect(code.length).toBeGreaterThan(30);

  const signedIn = await complete(code);
  expect(signedIn.statusCode, signedIn.body).toBe(200);
  const session = signedIn.json() as {
    token: string;
    csrfToken: string;
    twoFactorRequired: boolean;
  };
  expect(session.twoFactorRequired).toBe(false);
  expect(String(signedIn.headers['set-cookie'])).toContain('HttpOnly');
  const me = await server.app.inject({
    method: 'GET',
    url: '/api/v1/auth/me',
    headers: { authorization: `Bearer ${session.token}` },
  });
  expect(me.statusCode).toBe(200);
  expect((me.json() as { login: string }).login).toBe('rumi@padma.test');
  // Once.
  expect((await complete(code)).statusCode).toBe(401);
  expect((await complete('not-a-code')).statusCode).toBe(401);
  expect((await audited('auth.login')).at(-1)).toBe('rumi@padma.test signed in by single sign-on.');
});

test('once linked, the provider’s person signs in whatever their address says', async () => {
  // The address changed at the provider and is not verified: the link made at the first sign-in is what counts.
  provider.person = {
    sub: 'rumi-at-fake',
    email: 'someone-else@elsewhere.test',
    email_verified: false,
  };
  const landed = await journey();
  const signedIn = await complete(landed.searchParams.get('sso') ?? '');
  expect(signedIn.statusCode, landed.toString()).toBe(200);
  const [link] = await server.driver.query<{ user_id: number }>({
    text: "SELECT user_id FROM auth_sso_identity WHERE subject = 'rumi-at-fake'",
    params: [],
  });
  expect(Number(link?.user_id)).toBe(rumi);
});

test('nobody gets an account by having an address: unknown, deactivated and unverified people are refused', async () => {
  for (const [person, reason] of [
    [{ sub: 'stranger', email: 'stranger@padma.test', email_verified: true }, 'unknown'],
    [{ sub: 'gone', email: 'gone@padma.test', email_verified: true }, 'unknown'],
    [{ sub: 'unverified', email: 'admin@padma.test', email_verified: false }, 'email'],
    [{ sub: 'no-address' }, 'email'],
  ] as const) {
    provider.person = person;
    const landed = await journey();
    expect(landed.searchParams.get('sso'), JSON.stringify(person)).toBeNull();
    expect(landed.searchParams.get('sso_error'), JSON.stringify(person)).toBe(reason);
  }
  const refusals = await audited('auth.sso_refused');
  expect(refusals).toEqual(
    expect.arrayContaining([
      'Nobody here has the address stranger@padma.test (Fake ID).',
      'Fake ID gave no verified email address.',
    ]),
  );
  const [count] = await server.driver.query<{ n: number }>({
    text: 'SELECT count(*)::int AS n FROM res_users',
    params: [],
  });
  expect(count?.n).toBe(3); // the administrator and the two people made above: nobody was created
});

test('a token for another application, expired, of another sign-in or signed by another key is refused', async () => {
  provider.person = { sub: 'rumi-at-fake', email: 'rumi@padma.test', email_verified: true };
  for (const tamper of [
    { aud: 'another-application' },
    { exp: Math.floor(Date.now() / 1000) - 3600 },
    { nonce: 'of-another-sign-in' },
    { iss: 'https://another-issuer.example' },
  ]) {
    provider.tamper = tamper;
    const landed = await journey();
    expect(landed.searchParams.get('sso_error'), JSON.stringify(tamper)).toBe('token');
  }
  provider.tamper = {};
  provider.foreignKey = true;
  expect((await journey()).searchParams.get('sso_error')).toBe('token');
  provider.foreignKey = false;
  expect((await audited('auth.sso_refused')).join('\n')).toContain(
    'The ID token is not signed by the provider.',
  );
  // And it works again untampered.
  expect((await journey()).searchParams.get('sso')).not.toBeNull();
});

test('a state is ours and works once; an answer without one is refused', async () => {
  const start = await get('/api/v1/auth/sso/fake/start');
  const atProvider = await fetch(String(start.headers.location), { redirect: 'manual' });
  const callback = local(String(atProvider.headers.get('location')));
  const first = await get(callback);
  expect(new URL(String(first.headers.location)).searchParams.get('sso')).not.toBeNull();
  // The same answer again (a replay): refused.
  const replay = await get(callback);
  expect(new URL(String(replay.headers.location)).searchParams.get('sso_error')).toBe('state');
  const forged = await get('/api/v1/auth/sso/fake/callback?code=x&state=made-up');
  expect(new URL(String(forged.headers.location)).searchParams.get('sso_error')).toBe('state');
});

test('an account with two-factor sign-in still owes its code after the provider', async () => {
  // Rumi turns two-factor on.
  const password = await server.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { login: 'rumi@padma.test', password: PASSWORD },
  });
  const headers = { authorization: `Bearer ${(password.json() as { token: string }).token}` };
  const setup = await server.app.inject({ method: 'POST', url: '/api/v1/auth/2fa/setup', headers });
  const secret = (setup.json() as { secret: string }).secret;
  await server.app.inject({
    method: 'POST',
    url: '/api/v1/auth/2fa/enable',
    headers,
    payload: { code: totp(secret) },
  });

  const landed = await journey();
  const signedIn = await complete(landed.searchParams.get('sso') ?? '');
  const session = signedIn.json() as { token: string; twoFactorRequired: boolean };
  expect(session.twoFactorRequired).toBe(true);
  const pending = { authorization: `Bearer ${session.token}` };
  expect(
    (await server.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: pending }))
      .statusCode,
  ).toBe(401);
  const verified = await server.app.inject({
    method: 'POST',
    url: '/api/v1/auth/2fa/verify',
    headers: pending,
    payload: { code: totp(secret) },
  });
  expect(verified.statusCode, verified.body).toBe(200);
  expect(
    (await server.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: pending }))
      .statusCode,
  ).toBe(200);
});
