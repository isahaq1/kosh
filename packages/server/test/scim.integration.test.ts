/**
 * SCIM 2.0 provisioning (RFC 0034 §2.4) on real PostgreSQL, with the requests Entra ID and Okta send: a directory's
 * token is needed and a revoked one refused; a person is looked for, created without a password as an internal
 * user, updated, deactivated — signed out at once, never deleted —; the last Administrator cannot be deactivated;
 * service accounts are not the directory's; groups keep their members, and their roles — set here, never an
 * Administrator's — are given and taken as memberships change, roles given by hand untouched; all in the audit log.
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  base,
  createServer,
  installBase,
  type KoshServer,
  scimTokenHash,
  syncScimRoles,
} from '../src/index.js';
import { orm } from '../src/orm.js';
import { type TestDatabase, testDatabase } from '../src/testing.js';

const PASSWORD = 'correct horse battery';
const BASE = 'https://erp.example.test';
const TOKEN = 'scim_test_token_of_the_directory';
const USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';

let container: TestDatabase;
let server: KoshServer;
let company = 0;
let admin = 0;
let rumi = 0;

type Json = Record<string, unknown>;
const scim = async (
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  token: string | null = TOKEN,
) => {
  const response = await server.app.inject({
    method,
    url: `/api/scim/v2${path}`,
    headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      // As Entra ID sends it.
      ...(body === undefined ? {} : { 'content-type': 'application/scim+json; charset=utf-8' }),
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
  return {
    status: response.statusCode,
    type: String(response.headers['content-type'] ?? ''),
    body: (response.body === '' ? {} : JSON.parse(response.body)) as Json,
  };
};
const sql = <T extends Record<string, unknown>>(text: string, params: unknown[] = []) =>
  server.driver.query<T>({ text, params });
const rolesOf = async (user: number) =>
  (
    await sql<{ group: string }>(
      'SELECT "group" FROM auth_user_group WHERE user_id = $1 ORDER BY "group"',
      [user],
    )
  ).map((r) => r.group);
const audited = async (kind: string) =>
  (
    await sql<{ summary: string }>('SELECT summary FROM audit_event WHERE kind = $1 ORDER BY id', [
      kind,
    ])
  ).map((r) => r.summary);
const create = (name: string, rows: unknown[]) =>
  server.shutro.bootstrap({ reason: 'test' }, (env) =>
    (
      env.model(name as never) as unknown as {
        create(r: unknown[]): Promise<{ ids: readonly number[] }>;
      }
    ).create(rows),
  );
/** What an Administrator does in Settings: the roles a directory group gives. */
const setRoles = async (group: string, roles: string[]) => {
  const [before] = await sql<{ roles: string[] | null }>(
    'SELECT roles FROM auth_scim_group WHERE display_name = $1',
    [group],
  );
  await sql('UPDATE auth_scim_group SET roles = ($2::text)::jsonb WHERE display_name = $1', [
    group,
    JSON.stringify(roles),
  ]);
  await server.shutro.bootstrap({ reason: 'test' }, (env) =>
    syncScimRoles(env, 'all', { by: 'an Administrator', released: before?.roles ?? [] }),
  );
};

beforeAll(async () => {
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
  const installed = await installBase(server.shutro, auth, {
    company: { name: 'Padma Traders', currency: 'BDT' },
    admin: { login: 'admin', name: 'Administrator', password: PASSWORD },
  });
  company = installed.company;
  admin = (await sql<{ id: number }>("SELECT id FROM res_users WHERE login = 'admin'"))[0]
    ?.id as number;
  rumi = await auth.createUser({
    login: 'rumi@padma.test',
    name: 'Rumi',
    password: PASSWORD,
    company,
    companies: [company],
    groups: ['base.user'],
  });
  await create('auth.scim_token', [
    { name: 'Entra ID', tokenHash: scimTokenHash(TOKEN), prefix: 'scim_test', company },
    {
      name: 'Old',
      tokenHash: scimTokenHash('a-revoked-token'),
      prefix: 'a-revoke',
      company,
      revoked: true,
    },
  ]);
  await create('res.users', [
    { login: 'robot', name: 'A robot', company, companies: { set: [company] }, isService: true },
  ]);
}, 180_000);

afterAll(async () => {
  await server?.close();
  await container?.stop();
});

test('a directory needs its token; a wrong or revoked one is refused in SCIM’s words', async () => {
  for (const token of [null, 'not-a-token', 'a-revoked-token']) {
    const refused = await scim('GET', '/Users', undefined, token);
    expect(refused.status).toBe(401);
    expect(refused.type).toContain('application/scim+json');
    expect(refused.body['schemas']).toEqual(['urn:ietf:params:scim:api:messages:2.0:Error']);
    expect(refused.body['status']).toBe('401');
  }
  const config = await scim('GET', '/ServiceProviderConfig');
  expect(config.status).toBe(200);
  expect((config.body['patch'] as Json)['supported']).toBe(true);
  const types = await scim('GET', '/ResourceTypes');
  expect(types.body['totalResults']).toBe(2);
  // The token says when it was last used.
  const [used] = await sql<{ last_used_at: Date | null }>(
    "SELECT last_used_at FROM auth_scim_token WHERE name = 'Entra ID'",
  );
  expect(used?.last_used_at).not.toBeNull();
});

test('a person is looked for, then created: an internal user without a password', async () => {
  const none = await scim(
    'GET',
    `/Users?filter=${encodeURIComponent('userName eq "tania@padma.test"')}`,
  );
  expect(none.status, JSON.stringify(none.body)).toBe(200);
  expect(none.body['totalResults']).toBe(0);
  expect(none.body['Resources']).toEqual([]);

  const made = await scim('POST', '/Users', {
    schemas: [USER],
    externalId: 'entra-0001',
    userName: 'Tania@Padma.test',
    name: { givenName: 'Tania', familyName: 'Rahman' },
    emails: [{ primary: true, type: 'work', value: 'tania@padma.test' }],
    active: true,
  });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  expect(made.body).toMatchObject({
    schemas: [USER],
    externalId: 'entra-0001',
    userName: 'tania@padma.test',
    displayName: 'Tania Rahman',
    active: true,
    emails: [{ value: 'tania@padma.test', primary: true }],
  });
  const id = Number(made.body['id']);
  expect((made.body['meta'] as Json)['location']).toBe(`${BASE}/api/scim/v2/Users/${id}`);
  expect(await rolesOf(id)).toEqual(['base.user']);
  // No password: nothing to sign in with until single sign-on or a reset link.
  expect(await sql('SELECT 1 FROM auth_credential WHERE user_id = $1', [id])).toHaveLength(0);
  const signIn = await server.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { login: 'tania@padma.test', password: '' },
  });
  expect(signIn.statusCode).toBeGreaterThanOrEqual(400);

  // Found now, by the login and by the directory's id.
  for (const filter of ['userName eq "TANIA@padma.test"', 'externalId eq "entra-0001"']) {
    const found = await scim('GET', `/Users?filter=${encodeURIComponent(filter)}`);
    expect(found.body['totalResults'], filter).toBe(1);
    expect(((found.body['Resources'] as Json[])[0] as Json)['id']).toBe(String(id));
  }
  // A second time: refused, as the protocol says.
  const again = await scim('POST', '/Users', { schemas: [USER], userName: 'tania@padma.test' });
  expect(again.status).toBe(409);
  expect(again.body['scimType']).toBe('uniqueness');
  expect(await audited('scim.user_created')).toEqual([
    'Tania Rahman (tania@padma.test) added by the directory (Entra ID).',
  ]);
  // A filter we do not have is refused, not ignored (it would list everyone).
  const odd = await scim('GET', `/Users?filter=${encodeURIComponent('name.familyName co "a"')}`);
  expect(odd.status).toBe(400);
  expect(odd.body['scimType']).toBe('invalidFilter');
});

test('a person is updated: Okta’s PUT and Entra’s PATCH', async () => {
  const [tania] = await sql<{ id: number }>(
    "SELECT id FROM res_users WHERE login = 'tania@padma.test'",
  );
  const id = tania?.id as number;
  const put = await scim('PUT', `/Users/${id}`, {
    schemas: [USER],
    userName: 'tania@padma.test',
    name: { givenName: 'Tania', familyName: 'Rahman Khan' },
    emails: [{ primary: true, value: 'tania@padma.test' }],
    active: true,
  });
  expect(put.status, JSON.stringify(put.body)).toBe(200);
  expect(put.body['displayName']).toBe('Tania Rahman Khan');
  const patch = await scim('PATCH', `/Users/${id}`, {
    schemas: [PATCH],
    Operations: [
      { op: 'Replace', path: 'displayName', value: 'Tania R. Khan' },
      { op: 'Replace', path: 'emails[type eq "work"].value', value: 'Tania.Khan@padma.test' },
    ],
  });
  expect(patch.status, JSON.stringify(patch.body)).toBe(200);
  expect(patch.body).toMatchObject({
    displayName: 'Tania R. Khan',
    emails: [{ value: 'tania.khan@padma.test' }],
  });
  expect((await scim('GET', '/Users/999999')).status).toBe(404);
  expect((await scim('PATCH', '/Users/abc', { Operations: [] })).status).toBe(404);
});

test('deactivated by the directory: signed out at once, never deleted, and back again', async () => {
  const signIn = await server.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { login: 'rumi@padma.test', password: PASSWORD },
  });
  expect(signIn.statusCode, signIn.body).toBe(200);
  const cookie = [signIn.headers['set-cookie']]
    .flat()
    .map((c) => String(c).split(';')[0])
    .join('; ');
  const me = () =>
    server.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } });
  expect((await me()).statusCode).toBe(200);

  // Entra ID: a string for the boolean, a capital on the operation.
  const off = await scim('PATCH', `/Users/${rumi}`, {
    schemas: [PATCH],
    Operations: [{ op: 'Replace', path: 'active', value: 'False' }],
  });
  expect(off.status, JSON.stringify(off.body)).toBe(200);
  expect(off.body['active']).toBe(false);
  expect((await me()).statusCode).toBe(401);
  const again = await server.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { login: 'rumi@padma.test', password: PASSWORD },
  });
  expect(again.statusCode).toBeGreaterThanOrEqual(400);

  // Okta: the value is an object, without a path.
  const on = await scim('PATCH', `/Users/${rumi}`, {
    schemas: [PATCH],
    Operations: [{ op: 'replace', value: { active: true } }],
  });
  expect(on.body['active']).toBe(true);

  // DELETE deactivates: the person and what they wrote stay.
  expect((await scim('DELETE', `/Users/${rumi}`)).status).toBe(204);
  const [row] = await sql<{ active: boolean }>('SELECT active FROM res_users WHERE id = $1', [
    rumi,
  ]);
  expect(row?.active).toBe(false);
  expect((await scim('GET', `/Users/${rumi}`)).body['active']).toBe(false);
  expect(await audited('scim.user_deactivated')).toHaveLength(2);
  expect(await audited('scim.user_reactivated')).toHaveLength(1);
  await scim('PATCH', `/Users/${rumi}`, {
    Operations: [{ op: 'replace', value: { active: true } }],
  });
});

test('the last Administrator stays; service accounts are not the directory’s', async () => {
  const refused = await scim('DELETE', `/Users/${admin}`);
  expect(refused.status, JSON.stringify(refused.body)).toBeGreaterThanOrEqual(400);
  expect(refused.status).toBeLessThan(500);
  const [row] = await sql<{ active: boolean }>('SELECT active FROM res_users WHERE id = $1', [
    admin,
  ]);
  expect(row?.active).toBe(true);

  const [robot] = await sql<{ id: number }>("SELECT id FROM res_users WHERE login = 'robot'");
  expect((await scim('GET', `/Users/${robot?.id}`)).status).toBe(404);
  expect((await scim('DELETE', `/Users/${robot?.id}`)).status).toBe(404);
  const all = await scim('GET', '/Users?startIndex=1&count=100');
  const logins = (all.body['Resources'] as Json[]).map((u) => u['userName']);
  expect(logins).toContain('admin');
  expect(logins).not.toContain('robot');
  // Pages.
  const page = await scim('GET', '/Users?startIndex=2&count=1');
  expect(page.body).toMatchObject({ startIndex: 2, itemsPerPage: 1, totalResults: logins.length });
});

test('groups keep their members; their roles are given and taken, never an Administrator’s', async () => {
  const [tania] = await sql<{ id: number }>(
    "SELECT id FROM res_users WHERE login = 'tania@padma.test'",
  );
  const t = tania?.id as number;
  // A role given by hand, outside any group: never touched.
  await create('auth.user_group', [{ user: rumi, company: null, group: 'base.developer' }]);

  const made = await scim('POST', '/Groups', {
    schemas: [GROUP],
    externalId: 'grp-01',
    displayName: 'ERP developers',
    members: [{ value: String(t) }],
  });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const group = Number(made.body['id']);
  expect(made.body['members']).toEqual([
    { value: String(t), display: 'Tania R. Khan', $ref: `${BASE}/api/scim/v2/Users/${t}` },
  ]);
  // A new group gives nothing until an Administrator says what.
  expect(await rolesOf(t)).toEqual(['base.user']);
  expect((await scim('POST', '/Groups', { displayName: 'ERP developers' })).status).toBe(409);

  // An Administrator's role in a group is left out, whatever was stored.
  await setRoles('ERP developers', ['base.developer', 'base.admin']);
  expect(await rolesOf(t)).toEqual(['base.developer', 'base.user']);

  // Entra adds a member, then removes them.
  const add = await scim('PATCH', `/Groups/${group}`, {
    schemas: [PATCH],
    Operations: [{ op: 'Add', path: 'members', value: [{ value: String(admin) }] }],
  });
  expect(add.status, JSON.stringify(add.body)).toBe(200);
  expect((add.body['members'] as Json[]).map((m) => m['value']).sort()).toEqual(
    [String(admin), String(t)].sort(),
  );
  expect(await rolesOf(admin)).toEqual(['base.admin', 'base.developer']);
  await scim('PATCH', `/Groups/${group}`, {
    Operations: [{ op: 'Remove', path: 'members', value: [{ value: String(admin) }] }],
  });
  expect(await rolesOf(admin)).toEqual(['base.admin']);

  // Okta removes a member by naming them in the path: the role goes with the membership.
  const out = await scim('PATCH', `/Groups/${group}`, {
    Operations: [{ op: 'remove', path: `members[value eq "${t}"]` }],
  });
  expect(out.body['members']).toEqual([]);
  expect(await rolesOf(t)).toEqual(['base.user']);
  // Rumi was never in the group: the role given to them by hand stays. Every change is in the log.
  expect(await rolesOf(rumi)).toEqual(['base.developer', 'base.user']);
  expect(await audited('scim.roles')).toEqual(
    expect.arrayContaining([
      `Roles of person ${t} from an Administrator: given base.developer.`,
      `Roles of person ${admin} from the directory (Entra ID): given base.developer.`,
      `Roles of person ${admin} from the directory (Entra ID): taken base.developer.`,
      `Roles of person ${t} from the directory (Entra ID): taken base.developer.`,
    ]),
  );

  // PUT sets the members; someone who is nobody is refused and nothing changes.
  const bad = await scim('PUT', `/Groups/${group}`, {
    displayName: 'ERP developers',
    members: [{ value: String(t) }, { value: '999999' }],
  });
  expect(bad.status).toBe(400);
  expect((await scim('GET', `/Groups/${group}`)).body['members']).toEqual([]);
  const put = await scim('PUT', `/Groups/${group}`, {
    displayName: 'ERP devs',
    members: [{ value: String(t) }],
  });
  expect(put.body).toMatchObject({ displayName: 'ERP devs', externalId: 'grp-01' });
  expect(await rolesOf(t)).toEqual(['base.developer', 'base.user']);
  const found = await scim(
    'GET',
    `/Groups?filter=${encodeURIComponent('displayName eq "ERP devs"')}`,
  );
  expect(found.body['totalResults']).toBe(1);

  // The group removed: its roles go with it.
  expect((await scim('DELETE', `/Groups/${group}`)).status).toBe(204);
  expect(await rolesOf(t)).toEqual(['base.user']);
  expect((await scim('GET', `/Groups/${group}`)).status).toBe(404);
});
