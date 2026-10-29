/**
 * People on real PostgreSQL (RFC 0019 §3.2): a People manager invites a person with roles (the link emailed after the
 * commit and returned to copy), who chooses a password once; the list shows invited, active and deactivated people
 * (not portal users); roles per company are replaced; deactivating signs the person out everywhere; two-factor is
 * reset. People managers cannot grant administrator roles, change their own roles or touch an administrator; others
 * are refused. Everything is audited.
 */
import type { Mailer } from '@kosh/mail';
import { base, createServer, installBase, type KoshServer } from '@kosh/server';
import { orm } from '@kosh/server/orm';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { settingsModule } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const sent: { to: string; subject: string; html?: string; text?: string }[] = [];
const mailer = {
  send: async (message: { to: string; subject: string; html?: string; text?: string }) => {
    sent.push(message);
  },
} as unknown as Mailer;

let container: StartedPostgreSqlContainer;
let server: KoshServer;
let company: number;
let admin = 0;
let hana = 0;
const tokens = new Map<string, string>();

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function login(as: string, password = PASSWORD): Promise<string> {
  const res = await server.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { login: as, password },
  });
  return (res.json() as { token: string }).token;
}
async function call(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  url: string,
  as: string,
  payload?: unknown,
) {
  let token = tokens.get(as);
  if (token === undefined) {
    token = await login(as);
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
const P = '/api/v1/settings/people';

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18').start();
  server = await createServer({
    databaseUrl: container.getConnectionUri(),
    modules: [base, settingsModule({ baseUrl: 'https://erp.example.test', mailer })],
    auth: { secureCookies: false, cacheMs: 0, loginLimit: 0 },
    rateLimit: { max: 0, timeWindow: '1 minute' },
    logger: false,
  });
  for (const statement of orm.createTableStatements(server.registry.registry))
    await server.driver.query(statement);
  const auth = server.auth;
  if (auth === undefined) throw new Error('base is installed');
  ({ company, admin } = (await installBase(server.shutro, auth, {
    company: { name: 'Padma Traders', currency: 'BDT' },
    admin: { login: 'admin', name: 'Administrator', password: PASSWORD },
  })) as unknown as { company: number; admin: number });
  hana = await auth.createUser({
    login: 'hana',
    name: 'Hana',
    password: PASSWORD,
    company,
    companies: [company],
    groups: ['settings.people'],
  });
  await auth.createUser({
    login: 'bob',
    name: 'Bob',
    password: PASSWORD,
    company,
    companies: [company],
    groups: ['base.user'],
  });
}, 180_000);

afterAll(async () => {
  await server?.close();
  await container?.stop();
});

let rumi = 0;
let link = '';

test('the catalogue: apps with their access levels, roles, companies', async () => {
  const catalogue = await call('GET', `${P}/catalogue`, 'hana');
  expect(catalogue.status, JSON.stringify(catalogue.json)).toBe(200);
  const settingsApp = catalogue.json.apps.find((a: Json) => a.module === 'settings');
  expect(settingsApp.levels.map((l: Json) => l.key)).toEqual(['apps', 'company', 'people']);
  expect(catalogue.json.companies).toEqual([{ id: company, name: 'Padma Traders' }]);
  expect(catalogue.json.administratorGroups.length).toBeGreaterThan(0);
  expect((await call('GET', `${P}/catalogue`, 'bob')).status).toBe(403);
});

test('an invitation: emailed after the commit and returned; the person chooses a password once', async () => {
  const invited = await call('POST', P, 'hana', {
    name: 'Rumi Akter',
    email: 'Rumi@Padma.test',
    assignments: [{ group: 'settings.company', company }],
  });
  expect(invited.status, JSON.stringify(invited.json)).toBe(201);
  expect(invited.json).toMatchObject({ login: 'rumi@padma.test', emailed: true });
  rumi = invited.json.id;
  link = invited.json.activationUrl;
  expect(link).toMatch(/^https:\/\/erp\.example\.test\/activate\?token=[\w-]{40,}$/);
  expect(sent.at(-1)).toMatchObject({ to: 'rumi@padma.test' });
  expect(JSON.stringify(sent.at(-1))).toContain(link);

  const listed = (await call('GET', `${P}?status=invited`, 'hana')).json.people as Json[];
  expect(listed.map((p) => p.login)).toEqual(['rumi@padma.test']);
  expect(listed[0]).toMatchObject({ state: 'invited', twoFactor: false });
  expect(listed[0].assignments).toEqual([
    { group: 'settings.company', label: 'Settings · Company settings', company },
  ]);
  expect((await call('POST', P, 'hana', { name: 'Again', email: 'rumi@padma.test' })).status).toBe(
    409,
  );

  const token = new URL(link).searchParams.get('token');
  const short = await server.app.inject({
    method: 'POST',
    url: '/api/v1/auth/activate',
    payload: { token, password: 'short' },
  });
  expect(short.statusCode).toBe(422);
  const activated = await server.app.inject({
    method: 'POST',
    url: '/api/v1/auth/activate',
    payload: { token, password: 'a long new password' },
  });
  expect(activated.json()).toEqual({ login: 'rumi@padma.test' });
  const again = await server.app.inject({
    method: 'POST',
    url: '/api/v1/auth/activate',
    payload: { token, password: 'another long password' },
  });
  expect(again.statusCode).toBe(410);
  tokens.set('rumi', await login('rumi@padma.test', 'a long new password'));
  expect((await call('GET', '/api/v1/auth/me', 'rumi')).json.name).toBe('Rumi Akter');
  const person = (await call('GET', `${P}/${rumi}`, 'hana')).json;
  expect(person.state).toBe('active');
  expect(person.activity.map((a: Json) => a.kind)).toEqual(
    expect.arrayContaining(['people.invited', 'people.activated']),
  );
});

test('roles replaced; a People manager’s limits; deactivation signs out; two-factor reset', async () => {
  const roles = await call('PUT', `${P}/${rumi}/roles`, 'hana', {
    assignments: [
      { group: 'settings.company', company },
      { group: 'settings.apps', company: null },
    ],
  });
  expect(roles.status, JSON.stringify(roles.json)).toBe(200);
  expect(roles.json.assignments.map((a: Json) => a.group).sort()).toEqual([
    'settings.apps',
    'settings.company',
  ]);
  const catalogue = (await call('GET', `${P}/catalogue`, 'hana')).json;
  const adminGroup = catalogue.administratorGroups[0];
  expect(
    (
      await call('PUT', `${P}/${rumi}/roles`, 'hana', {
        assignments: [{ group: adminGroup, company: null }],
      })
    ).status,
  ).toBe(403);
  expect((await call('PUT', `${P}/${hana}/roles`, 'hana', { assignments: [] })).status).toBe(403);
  expect((await call('PATCH', `${P}/${admin}`, 'hana', { active: false })).status).toBe(403);
  expect((await call('POST', `${P}/${admin}/reset-2fa`, 'hana')).status).toBe(403);
  expect(
    (
      await call('PUT', `${P}/${rumi}/roles`, 'hana', {
        assignments: [{ group: 'no.such', company }],
      })
    ).status,
  ).toBe(422);

  const off = await call('PATCH', `${P}/${rumi}`, 'hana', { active: false });
  expect(off.json).toMatchObject({ state: 'deactivated', active: false });
  expect((await call('GET', '/api/v1/auth/me', 'rumi')).status).toBe(401); // signed out everywhere
  expect(
    (await call('GET', `${P}?status=deactivated`, 'hana')).json.people.map((p: Json) => p.id),
  ).toEqual([rumi]);
  expect((await call('PATCH', `${P}/${rumi}`, 'hana', { active: true })).json.active).toBe(true);
  expect((await call('PATCH', `${P}/${hana}`, 'hana', { active: false })).status).toBe(422); // not yourself

  expect((await call('POST', `${P}/${rumi}/reset-2fa`, 'hana')).json).toEqual({ ok: true });
  const fresh = await call('POST', `${P}/${rumi}/invitation`, 'hana');
  expect(fresh.json.activationUrl).not.toBe(link);
  // The earlier link stopped working.
  const old = await server.app.inject({
    method: 'POST',
    url: '/api/v1/auth/activate',
    payload: { token: new URL(link).searchParams.get('token'), password: 'yet another long one' },
  });
  expect(old.statusCode).toBe(410);

  for (const path of [P, `${P}/${rumi}`]) expect((await call('GET', path, 'bob')).status).toBe(403);
  const kinds = await server.shutro.bootstrap(
    { reason: 'test' },
    (env) =>
      env.sql<{
        kind: string;
      }>`SELECT DISTINCT kind FROM audit_event WHERE kind LIKE 'people.%' OR kind = 'auth.2fa_reset'`,
  );
  expect(kinds.map((k) => k.kind).sort()).toEqual(
    expect.arrayContaining([
      'auth.2fa_reset',
      'people.activated',
      'people.deactivated',
      'people.invited',
      'people.reactivated',
    ]),
  );
});
