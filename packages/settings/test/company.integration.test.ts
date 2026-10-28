/**
 * Settings › Company on real PostgreSQL (RFC 0018): holders of the Company settings access read and change the
 * current company's name, number grouping and brand colour (checked as `#rrggbb`); others are refused; the user's
 * details carry each company's accent for the shell.
 */
import { base, createServer, installBase, type KoshServer } from '@kosh/server';
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
async function call(method: 'GET' | 'PATCH', url: string, as: string, payload?: unknown) {
  let token = tokens.get(as);
  if (token === undefined) {
    const login = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { login: as, password: PASSWORD },
    });
    token = (login.json() as { token: string }).token;
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
