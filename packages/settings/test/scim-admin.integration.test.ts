/**
 * Settings › Security › Directory provisioning (RFC 0034 §2.4) on real PostgreSQL: only an Administrator makes a
 * directory's token; it is shown once and only its digest kept; the directory provisions with it until it is
 * revoked; a group's roles are checked — they exist, none an Administrator's — and its members hold them at once,
 * and lose the ones it no longer gives; every change is audited.
 */
import { base, createServer, installBase, type KoshServer, totp } from '@kosh/server';
import { orm } from '@kosh/server/orm';
import { type TestDatabase, testDatabase } from '@kosh/server/testing';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { settingsModule } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const S = '/api/v1/settings/scim';
let container: TestDatabase;
let server: KoshServer;
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
/** The directory, with its token. */
const scim = async (method: 'GET' | 'POST', path: string, token: string, body?: unknown) => {
  const res = await server.app.inject({
    method,
    url: `/api/scim/v2${path}`,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/scim+json' }),
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
  return { status: res.statusCode, json: (res.body === '' ? null : JSON.parse(res.body)) as Json };
};
const rolesOf = async (user: number) =>
  (
    await server.driver.query<{ group: string }>({
      text: 'SELECT "group" FROM auth_user_group WHERE user_id = $1 ORDER BY "group"',
      params: [user],
    })
  ).map((r) => r.group);
const audited = async (kind: string) =>
  (
    await server.driver.query<{ summary: string }>({
      text: 'SELECT summary FROM audit_event WHERE kind = $1 ORDER BY id',
      params: [kind],
    })
  ).map((r) => r.summary);

beforeAll(async () => {
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
  await server?.close();
  await container?.stop();
});

test('only an Administrator sets provisioning up', async () => {
  for (const [method, url, body] of [
    ['GET', S, undefined],
    ['POST', `${S}/tokens`, { name: 'Entra ID' }],
    ['DELETE', `${S}/tokens/1`, undefined],
    ['PATCH', `${S}/groups/1`, { roles: [] }],
  ] as const)
    expect((await call(method, url, 'hana', body)).status, `${method} ${url}`).toBe(403);
  expect((await call('GET', S, 'admin')).json).toEqual({
    baseUrl: 'https://erp.example.test/api/scim/v2',
    people: 0,
    tokens: [],
    groups: [],
  });
});

test('a token is shown once, provisions, and is refused once revoked', async () => {
  expect((await call('POST', `${S}/tokens`, 'admin', { name: ' ' })).status).toBe(422);
  const made = await call('POST', `${S}/tokens`, 'admin', { name: 'Entra ID' });
  expect(made.status, JSON.stringify(made.json)).toBe(200);
  const token = String(made.json.token);
  expect(token).toMatch(/^scim_[A-Za-z0-9_-]{43}$/);
  // Only its digest is kept; the list never says the token.
  const stored = await server.driver.query<{ token_hash: string; prefix: string }>({
    text: 'SELECT token_hash, prefix FROM auth_scim_token',
    params: [],
  });
  expect(stored).toHaveLength(1);
  expect(stored[0]?.token_hash).not.toContain(token);
  expect(stored[0]?.prefix).toBe(token.slice(0, 10));
  const listed = (await call('GET', S, 'admin')).json;
  expect(JSON.stringify(listed)).not.toContain(token);
  expect(listed.tokens).toMatchObject([
    { name: 'Entra ID', prefix: token.slice(0, 10), company: { name: 'Padma Traders' } },
  ]);

  const person = await scim('POST', '/Users', token, {
    userName: 'tania@padma.test',
    displayName: 'Tania',
  });
  expect(person.status, JSON.stringify(person.json)).toBe(201);
  expect((await call('GET', S, 'admin')).json.people).toBe(1);
  expect((await call('GET', S, 'admin')).json.tokens[0].lastUsedAt).not.toBeNull();

  const second = await call('POST', `${S}/tokens`, 'admin', { name: 'Okta' });
  expect((await call('DELETE', `${S}/tokens/${second.json.id}`, 'admin')).status).toBe(200);
  expect((await scim('GET', '/Users', String(second.json.token))).status).toBe(401);
  expect((await call('DELETE', `${S}/tokens/${second.json.id}`, 'admin')).status).toBe(404);
  expect((await scim('GET', '/Users', token)).status).toBe(200);
  expect(await audited('security.scim_token_added')).toHaveLength(2);
  expect(await audited('security.scim_token_revoked')).toEqual([
    'Directory token Okta revoked: the directory is refused from now on.',
  ]);
});

test('a group’s roles are checked, given to its members at once, and taken when it gives them no more', async () => {
  const [stored] = await server.driver.query<{ id: number }>({
    text: "SELECT id FROM res_users WHERE login = 'tania@padma.test'",
    params: [],
  });
  const tania = stored?.id as number;
  const token = String(
    (await call('POST', `${S}/tokens`, 'admin', { name: 'Entra again' })).json.token,
  );
  const group = await scim('POST', '/Groups', token, {
    displayName: 'ERP people managers',
    members: [{ value: String(tania) }],
  });
  expect(group.status, JSON.stringify(group.json)).toBe(201);
  const id = Number(group.json.id);
  expect((await call('GET', S, 'admin')).json.groups).toEqual([
    { id, name: 'ERP people managers', roles: [], members: 1 },
  ]);

  const G = `${S}/groups/${id}`;
  const none = await call('PATCH', G, 'admin', { roles: ['no.such_role'] });
  expect(none.status).toBe(422);
  expect(none.json.detail).toContain('There is no role no.such_role.');
  const adminRole = await call('PATCH', G, 'admin', { roles: ['settings.people', 'base.admin'] });
  expect(adminRole.status).toBe(422);
  expect(adminRole.json.detail).toContain('is an Administrator role');
  expect((await call('PATCH', G, 'admin', { roles: 'settings.people' })).status).toBe(422);
  expect((await call('PATCH', `${S}/groups/999`, 'admin', { roles: [] })).status).toBe(404);
  expect(await rolesOf(tania)).toEqual(['base.user']);

  const given = await call('PATCH', G, 'admin', { roles: ['settings.people', 'settings.company'] });
  expect(given.json).toEqual({
    ok: true,
    roles: ['settings.people', 'settings.company'],
    changed: 1,
  });
  expect(await rolesOf(tania)).toEqual(['base.user', 'settings.company', 'settings.people']);
  // One role fewer: taken from its members, the other kept.
  const fewer = await call('PATCH', G, 'admin', { roles: ['settings.people'] });
  expect(fewer.json.changed).toBe(1);
  expect(await rolesOf(tania)).toEqual(['base.user', 'settings.people']);
  // The same again changes nobody.
  expect((await call('PATCH', G, 'admin', { roles: ['settings.people'] })).json.changed).toBe(0);
  expect(await audited('security.scim_group_roles')).toEqual(
    expect.arrayContaining([
      'Directory group ERP people managers gives: settings.people, settings.company (before: no role).',
      'Directory group ERP people managers gives: settings.people (before: settings.people, settings.company).',
    ]),
  );
  expect(await audited('scim.roles')).toEqual([
    `Roles of person ${tania} from the directory group ERP people managers: given settings.company, settings.people.`,
    `Roles of person ${tania} from the directory group ERP people managers: taken settings.company.`,
  ]);
});
