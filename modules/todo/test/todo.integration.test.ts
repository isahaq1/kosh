/**
 * Focus on real PostgreSQL through the HTTP API (RFC 0021): installing it brings the chatter; a person's to-dos are
 * theirs alone, a shared list's to-dos are seen and worked on by its owner and members; a checklist's progress shows
 * on the to-do; Done and Reopen; people without Focus are refused; the demo data loads.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AppHost,
  applyApps,
  base,
  createAppHost,
  installBase,
  installDemo,
  prepareApps,
  recordInstalledApps,
} from '@kosh/server';
import { type Driver, orm, pg } from '@kosh/server/orm';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { todo } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [base, todo];
const T = '/api/v1/models/todo.task';
const L = '/api/v1/models/todo.list';

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let host: AppHost;
let company: number;
const users: Record<string, number> = {};
const tokens = new Map<string, string>();

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function call(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  as: string,
  payload?: unknown,
): Promise<{ status: number; json: Json }> {
  let token = tokens.get(as);
  if (token === undefined) {
    const login = await host.server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { login: as, password: PASSWORD },
    });
    token = (login.json() as { token: string }).token;
    tokens.set(as, token);
  }
  const res = await host.server.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: res.statusCode, json: res.body === '' ? null : res.json() };
}
const names = async (as: string) =>
  ((await call('GET', `${T}?fields=name&order=name+asc`, as)).json.items as Json[]).map(
    (t) => t.name,
  );

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-todo-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(await prepareApps({ driver, catalogue, change: { install: ['todo'] }, dir }), {
    driver,
    dir,
    actor: 'test',
  });
  host = await createAppHost({
    databaseUrl: container.getConnectionUri(),
    catalogue,
    migrationsDir: dir,
    logger: false,
    listen: false,
    auth: { secureCookies: false, cacheMs: 0, loginLimit: 0 },
    rateLimit: { max: 0, timeWindow: '1 minute' },
  });
  const auth = host.server.auth;
  if (auth === undefined) throw new Error('base is installed');
  ({ company } = await installBase(host.server.shutro, auth, {
    company: { name: 'Padma Traders', currency: 'BDT' },
    admin: { login: 'admin', name: 'Administrator', password: PASSWORD },
  }));
  for (const [login, groups] of [
    ['dina', ['todo.user']],
    ['rahim', ['todo.user']],
    ['sumi', ['todo.user']],
    ['bob', ['base.user']],
  ] as const)
    users[login] = await auth.createUser({
      login,
      name: login,
      password: PASSWORD,
      company,
      companies: [company],
      groups: [...groups],
    });
}, 240_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('own to-dos are private; a shared list’s to-dos are its owner’s and members’', async () => {
  expect((await call('POST', T, 'dina', { name: 'Dina alone' })).status).toBe(201);
  expect((await call('POST', T, 'sumi', { name: 'Sumi alone' })).status).toBe(201);
  const list = await call('POST', L, 'dina', {
    name: 'Office',
    members: { set: [users['rahim']] },
  });
  expect(list.status, JSON.stringify(list.json)).toBe(201);
  const shared = await call('POST', T, 'dina', { name: 'Shared one', list: list.json.id });
  expect(shared.status).toBe(201);

  expect(await names('dina')).toEqual(['Dina alone', 'Shared one']);
  expect(await names('rahim')).toEqual(['Shared one']); // a member
  expect(await names('sumi')).toEqual(['Sumi alone']);
  // A member works on it; others cannot reach it.
  expect(
    (await call('PATCH', `${T}/${shared.json.id}`, 'rahim', { priority: 'urgent' })).status,
  ).toBe(200);
  expect((await call('GET', `${T}/${shared.json.id}`, 'sumi')).status).toBe(403);
  expect((await call('GET', T, 'bob')).status).toBe(403);
});

test('the checklist’s progress shows on the to-do; done and reopened', async () => {
  const made = await call('POST', T, 'dina', {
    name: 'File the return',
    dueDate: '2026-11-01',
    items: {
      create: [
        { name: 'Export', done: true },
        { name: 'Check' },
        { name: 'File' },
        { name: 'Pay' },
      ],
    },
  });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  const id = made.json.id as number;
  const read = async () => (await call('GET', `${T}/${id}?fields=progress,state`, 'dina')).json;
  expect(await read()).toMatchObject({ progress: 25, state: 'open' });
  const items = (
    await call(
      'GET',
      `/api/v1/models/todo.item?filter=${encodeURIComponent(JSON.stringify({ task: id }))}`,
      'dina',
    )
  ).json.items as Json[];
  for (const item of items)
    await call('PATCH', `/api/v1/models/todo.item/${item.id}`, 'dina', { done: true });
  expect((await read()).progress).toBe(100);

  expect((await call('POST', `${T}/${id}/transitions/complete`, 'dina')).status).toBe(200);
  expect((await read()).state).toBe('done');
  expect(
    (await call('POST', `${T}/${id}/transitions/complete`, 'dina')).status,
  ).toBeGreaterThanOrEqual(400);
  expect((await call('POST', `${T}/${id}/transitions/reopen`, 'dina')).status).toBe(200);
  expect((await read()).state).toBe('open');
  // Another person's checklist stays out of reach.
  expect((await call('GET', `/api/v1/models/todo.item/${items[0].id}`, 'sumi')).status).toBe(403);
});

test('the demo data loads: a shared list and its to-dos', async () => {
  const auth = host.server.auth;
  if (auth === undefined) throw new Error('base is installed');
  const summary = await installDemo({
    shutro: host.server.shutro,
    auth,
    driver,
    modules: host.server.registry.loaded.modules,
    company,
  });
  expect(JSON.stringify(summary)).toContain('Focus');
  const [count] = await driver.query<{ n: number }>({
    text: "SELECT count(*)::int AS n FROM todo_task WHERE name = 'Prepare the monthly VAT return'",
    params: [],
  });
  expect(count?.n).toBe(1);
});
