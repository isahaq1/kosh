/**
 * Settings › Security › Single sign-on (RFC 0034 §2.4) on real PostgreSQL: only an Administrator sets providers up;
 * a provider is refused without an https issuer, a proper key or `openid` in its scopes; the list says the redirect
 * address to register, which variable holds the secret and whether it is set; Test reads the provider's
 * configuration; a provider is offered at sign-in only when it is on and has its secret; every change is audited.
 */
import {
  base,
  createServer,
  installBase,
  type KoshServer,
  ssoSecretName,
  totp,
} from '@kosh/server';
import { orm } from '@kosh/server/orm';
import { type FakeOidc, fakeOidc, type TestDatabase, testDatabase } from '@kosh/server/testing';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { settingsModule } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const S = '/api/v1/settings/sso';
let container: TestDatabase;
let server: KoshServer;
let provider: FakeOidc;
const tokens = new Map<string, string>();

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function call(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  as: string,
  payload?: unknown,
) {
  let token = tokens.get(as);
  if (token === undefined) {
    const login = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { login: as, password: PASSWORD },
    });
    token = (login.json() as { token: string }).token;
    if (as === 'admin') {
      const headers = { authorization: `Bearer ${token}` };
      const setup = await server.app.inject({
        method: 'POST',
        url: '/api/v1/auth/2fa/setup',
        headers,
      });
      await server.app.inject({
        method: 'POST',
        url: '/api/v1/auth/2fa/enable',
        headers,
        payload: { code: totp((setup.json() as { secret: string }).secret) },
      });
    }
    tokens.set(as, token);
  }
  const res = await server.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: res.statusCode, json: (res.body === '' ? null : res.json()) as Json };
}
const offered = async () =>
  (
    (await server.app.inject({ method: 'GET', url: '/api/v1/auth/sso/providers' })).json() as {
      providers: { key: string }[];
    }
  ).providers.map((p) => p.key);

beforeAll(async () => {
  provider = await fakeOidc();
  container = await testDatabase();
  server = await createServer({
    databaseUrl: container.getConnectionUri(),
    modules: [base, settingsModule({ baseUrl: 'https://erp.example.test' })],
    auth: { secureCookies: false, cacheMs: 0, loginLimit: 0 },
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
  await auth.createUser({
    login: 'hana',
    name: 'Hana',
    password: PASSWORD,
    company,
    companies: [company],
    groups: ['settings.people', 'settings.company'],
  });
}, 180_000);

afterAll(async () => {
  delete process.env[ssoSecretName('acme')];
  await server?.close();
  await container?.stop();
  await provider?.close();
});

test('only an Administrator sets single sign-on up', async () => {
  for (const [method, url, body] of [
    ['GET', S, undefined],
    ['POST', S, { key: 'acme', name: 'Acme', issuer: provider.issuer, clientId: 'x' }],
    ['PATCH', `${S}/1`, { enabled: false }],
    ['DELETE', `${S}/1`, undefined],
    ['POST', `${S}/1/test`, {}],
  ] as const)
    expect((await call(method, url, 'hana', body)).status, `${method} ${url}`).toBe(403);
  expect((await call('GET', S, 'admin')).json).toEqual({ providers: [] });
});

test('a provider is checked, listed with what to register, tested, and offered once it has its secret', async () => {
  for (const wrong of [
    { key: 'Acme', name: 'Acme', issuer: 'https://id.acme.test', clientId: 'x' }, // a key with a capital
    { key: 'acme', name: 'Acme', issuer: 'http://id.acme.test', clientId: 'x' }, // not https
    { key: 'acme', name: 'Acme', issuer: 'https://id.acme.test', clientId: 'x', scopes: 'email' }, // no openid
    { key: 'acme', name: 'Acme', issuer: 'https://id.acme.test' }, // no client id
  ])
    expect((await call('POST', S, 'admin', wrong)).status, JSON.stringify(wrong)).toBe(422);

  const made = await call('POST', S, 'admin', {
    key: 'acme',
    name: 'Acme ID',
    issuer: `${provider.issuer}/`,
    clientId: provider.clientId,
  });
  expect(made.status, JSON.stringify(made.json)).toBe(200);
  expect(made.json).toMatchObject({
    key: 'acme',
    name: 'Acme ID',
    issuer: provider.issuer, // without the trailing slash
    enabled: true,
    callbackUrl: 'https://erp.example.test/api/v1/auth/sso/acme/callback',
    secretName: 'KOSH_SSO_ACME_SECRET',
    secretSet: false,
    people: 0,
  });
  expect((await call('POST', S, 'admin', { ...made.json, key: 'acme' })).status).toBe(409);

  // Reachable: the provider says its issuer.
  const tested = await call('POST', `${S}/${made.json.id}/test`, 'admin', {});
  expect(tested.json).toMatchObject({ ok: true, issuer: provider.issuer });

  // Offered at sign-in only once its secret is in the environment, and while it is on.
  expect(await offered()).toEqual([]);
  process.env[ssoSecretName('acme')] = provider.clientSecret;
  expect(await offered()).toEqual(['acme']);
  expect((await call('GET', S, 'admin')).json.providers[0].secretSet).toBe(true);
  const off = await call('PATCH', `${S}/${made.json.id}`, 'admin', { enabled: false });
  expect(off.json.enabled).toBe(false);
  expect(await offered()).toEqual([]);

  // An issuer that cannot be reached is said, not thrown.
  const moved = await call('PATCH', `${S}/${made.json.id}`, 'admin', {
    issuer: 'http://127.0.0.1:9/nothing-here',
  });
  expect(moved.status).toBe(200);
  const unreachable = await call('POST', `${S}/${made.json.id}/test`, 'admin', {});
  expect(unreachable.json.ok).toBe(false);
  expect(String(unreachable.json.error).length).toBeGreaterThan(0);

  expect((await call('DELETE', `${S}/${made.json.id}`, 'admin')).json).toEqual({ ok: true });
  expect((await call('GET', S, 'admin')).json).toEqual({ providers: [] });
  const kinds = (
    await server.driver.query<{ kind: string }>({
      text: "SELECT kind FROM audit_event WHERE kind LIKE 'security.sso_provider_%' ORDER BY id",
      params: [],
    })
  ).map((r) => r.kind);
  expect(kinds).toEqual([
    'security.sso_provider_added',
    'security.sso_provider_changed',
    'security.sso_provider_changed',
    'security.sso_provider_removed',
  ]);
});

test('the roles a provider’s groups give are checked: roles that exist, never an Administrator’s', async () => {
  const made = await call('POST', S, 'admin', {
    key: 'roles',
    name: 'Roles ID',
    issuer: 'https://id.roles.example',
    clientId: 'x',
  });
  const id = made.json.id as number;
  expect(made.json).toMatchObject({ groupsClaim: 'groups', groupMap: {} });
  for (const groupMap of [
    { sales: ['no.such_role'] },
    { admins: ['base.admin'] },
    { sales: 'settings.people' },
    ['settings.people'],
  ])
    expect(
      (await call('PATCH', `${S}/${id}`, 'admin', { groupMap })).status,
      JSON.stringify(groupMap),
    ).toBe(422);
  const refused = await call('PATCH', `${S}/${id}`, 'admin', {
    groupMap: { admins: ['base.admin'] },
  });
  expect(refused.json.detail).toContain('is an Administrator role, which a provider never gives');

  const saved = await call('PATCH', `${S}/${id}`, 'admin', {
    groupsClaim: 'roles',
    groupMap: { ' hr-team ': ['settings.people', 'settings.people'], nobody: [] },
  });
  expect(saved.status, JSON.stringify(saved.json)).toBe(200);
  // Trimmed, without repeats, and a group that gives nothing is left out.
  expect(saved.json).toMatchObject({
    groupsClaim: 'roles',
    groupMap: { 'hr-team': ['settings.people'] },
  });
  await call('DELETE', `${S}/${id}`, 'admin');
});
