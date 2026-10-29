/**
 * Settings › Company on real PostgreSQL (RFC 0018): holders of the Company settings access read and change the
 * current company's name, number grouping and brand colour (checked as `#rrggbb`); others are refused; the user's
 * details carry each company’s accent for the shell. The company’s details (the fields apps add) are offered and
 * checked; administrators add companies, which they and the creator can switch to.
 */
import { base, createServer, installBase, type KoshServer, totp } from '@kosh/server';
import { orm } from '@kosh/server/orm';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { settings } from '../src/index.js';

const PASSWORD = 'correct horse battery';
let container: StartedPostgreSqlContainer;
let server: KoshServer;
const tokens = new Map<string, string>();

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function call(method: 'GET' | 'PATCH' | 'POST', url: string, as: string, payload?: unknown) {
  let token = tokens.get(as);
  if (token === undefined) {
    const login = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { login: as, password: PASSWORD },
    });
    token = (login.json() as { token: string }).token;
    if (as === 'admin') {
      // Administrators act as such only after a second factor.
      const headers = { authorization: `Bearer ${token}` };
      const setup = await server.app.inject({
        method: 'POST',
        url: '/api/v1/auth/2fa/setup',
        headers,
      });
      const { secret } = setup.json() as { secret: string };
      await server.app.inject({
        method: 'POST',
        url: '/api/v1/auth/2fa/enable',
        headers,
        payload: { code: totp(secret) },
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

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18').start();
  server = await createServer({
    databaseUrl: container.getConnectionUri(),
    modules: [base, settings],
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
  for (const [login, groups] of [
    ['dana', ['settings.company']],
    ['bob', ['base.user']],
  ] as const)
    await auth.createUser({
      login,
      name: login,
      password: PASSWORD,
      company,
      companies: [company],
      groups: [...groups],
    });
}, 180_000);

afterAll(async () => {
  await server?.close();
  await container?.stop();
});

test('the company’s name, grouping and brand colour; the accent in the user’s details', async () => {
  const read = await call('GET', '/api/v1/settings/company', 'dana');
  expect(read.status, JSON.stringify(read.json)).toBe(200);
  expect(read.json).toMatchObject({
    name: 'Padma Traders',
    numberGrouping: 'international',
    accentColor: null,
  });
  const changed = await call('PATCH', '/api/v1/settings/company', 'dana', {
    name: 'Padma Traders Ltd',
    numberGrouping: 'lakh',
    accentColor: '#0D9488',
  });
  expect(changed.status, JSON.stringify(changed.json)).toBe(200);
  expect(changed.json).toMatchObject({
    name: 'Padma Traders Ltd',
    numberGrouping: 'lakh',
    accentColor: '#0d9488',
  });
  const me = await call('GET', '/api/v1/auth/me', 'bob');
  expect(Object.values(me.json.accents)).toEqual(['#0d9488']);
  expect(Object.values(me.json.groupings)).toEqual(['lakh']);

  // Back to the default.
  expect(
    (await call('PATCH', '/api/v1/settings/company', 'dana', { accentColor: null })).json
      .accentColor,
  ).toBeNull();
  expect((await call('GET', '/api/v1/auth/me', 'bob')).json.accents).toEqual({});
});

test('checked values; others refused', async () => {
  for (const body of [
    { accentColor: 'teal' },
    { accentColor: '#12345' },
    { name: ' ' },
    { numberGrouping: 'roman' },
  ])
    expect((await call('PATCH', '/api/v1/settings/company', 'dana', body)).status).toBe(422);
  expect((await call('GET', '/api/v1/settings/company', 'bob')).status).toBe(403);
  expect(
    (await call('PATCH', '/api/v1/settings/company', 'bob', { accentColor: '#000000' })).status,
  ).toBe(403);
});

test('the details: the simple fields of the company, offered and checked', async () => {
  const read = await call('GET', '/api/v1/settings/company', 'dana');
  expect(read.json.currency).toBe('BDT');
  const keys = read.json.details.map((d: Json) => d.key);
  expect(keys).toEqual(
    expect.arrayContaining(['street', 'city', 'zip', 'email', 'phone', 'website']),
  );
  expect(keys).not.toContain('name');
  expect(keys).not.toContain('accentColor');
  expect(read.json.details.find((d: Json) => d.key === 'city')).toMatchObject({
    label: 'City',
    kind: 'char',
    readonly: false,
    value: null,
  });

  const changed = await call('PATCH', '/api/v1/settings/company', 'dana', {
    details: { street: '12 Motijheel', city: 'Dhaka', phone: '' },
  });
  expect(changed.status, JSON.stringify(changed.json)).toBe(200);
  const value = (key: string) => changed.json.details.find((d: Json) => d.key === key).value;
  expect([value('street'), value('city'), value('phone')]).toEqual(['12 Motijheel', 'Dhaka', null]);

  for (const details of [{ nope: 'x' }, { name: 'Other' }, { city: 7 }, ['city']])
    expect((await call('PATCH', '/api/v1/settings/company', 'dana', { details })).status).toBe(422);
});

test('companies: listed with their people; administrators add them', async () => {
  const list = await call('GET', '/api/v1/settings/companies', 'admin');
  expect(list.status, JSON.stringify(list.json)).toBe(200);
  expect(list.json.canCreate).toBe(true);
  expect(list.json.companies).toEqual([
    expect.objectContaining({ currency: 'BDT', people: 3, current: true }),
  ]);
  const bdt = list.json.currencies.find((c: Json) => c.name === 'BDT').id;

  for (const body of [{ name: '', currency: bdt }, { name: 'X' }, { name: 'X', currency: 99999 }])
    expect((await call('POST', '/api/v1/settings/companies', 'admin', body)).status).toBe(422);
  expect(
    (await call('POST', '/api/v1/settings/companies', 'dana', { name: 'Dana Co', currency: bdt }))
      .status,
  ).toBe(403);
  expect((await call('GET', '/api/v1/settings/companies', 'dana')).json.canCreate).toBe(false);

  const made = await call('POST', '/api/v1/settings/companies', 'admin', {
    name: 'Meghna Exports',
    currency: bdt,
  });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  const after = await call('GET', '/api/v1/settings/companies', 'admin');
  expect(after.json.companies.find((c: Json) => c.name === 'Meghna Exports')).toMatchObject({
    id: made.json.id,
    people: 1,
    current: false,
    member: true,
  });
  expect(
    (await call('GET', '/api/v1/settings/companies', 'dana')).json.companies.find(
      (c: Json) => c.id === made.json.id,
    ).member,
  ).toBe(false);
  // The administrator can switch to it at once.
  const me = await call('GET', '/api/v1/auth/me', 'admin');
  expect(me.json.companies).toContain(made.json.id);
});
