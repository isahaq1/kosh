/**
 * The App manager's API through the app host, on real PostgreSQL and real HTTP (RFC 0008): users without the
 * Administrator role or the App manager access are refused on every route; an App manager plans, applies (one
 * transaction, audited) and the host serves the new app at once; stale plans, replays and disabling Settings are
 * refused; the Apps page is a client action in the Settings menu.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineModule as defineKoshModule } from '@kosh/modules-sdk';
import {
  type AppHost,
  applyApps,
  base,
  baseShutro,
  createAppHost,
  installBase,
  type ModuleContext,
  prepareApps,
  recordInstalledApps,
  totp,
} from '@kosh/server';
import { type Driver, orm, pg } from '@kosh/server/orm';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { settings } from '../src/index.js';

const PASSWORD = 'correct horse battery';

const library = defineKoshModule({
  shutro: orm.defineModule({
    name: 'library',
    version: '1.0.0',
    depends: [baseShutro],
    groups: [orm.defineGroup({ code: 'library.user', label: 'Library', implies: ['base.user'] })],
    models: [
      orm.defineModel('library.book', {
        access: { 'library.user': ['read'] },
        fields: { title: orm.f.char() },
      }),
    ],
  }),
  kosh: '^0.1.0',
  depends: [base],
  app: { code: 'library', label: 'Library', category: 'Services', summary: 'Books and shelves' },
  accessLevels: { user: { label: 'User', groups: ['library.user'] } },
  routes: ({ app }: ModuleContext) => {
    app.get('/api/v1/library/ping', { config: { public: true } }, async () => ({ ok: true }));
  },
});
const catalogue = [base, settings, library];

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let host: AppHost;
let url: string;
const users: Record<string, number> = {};
const tokens = new Map<string, string>();

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function http(
  method: string,
  path: string,
  options: { as?: string; body?: unknown } = {},
): Promise<{ status: number; json: Json }> {
  const token = options.as === undefined ? undefined : await tokenOf(options.as);
  const res = await fetch(`${url}${path}`, {
    method,
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text === '' ? null : JSON.parse(text) };
}
async function tokenOf(login: string): Promise<string> {
  const cached = tokens.get(login);
  if (cached !== undefined) return cached;
  const session = await fetch(`${url}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login, password: PASSWORD }),
  });
  const token = ((await session.json()) as { token: string }).token;
  if (login === 'admin') {
    // Administrator rights need a second factor: enrol it on this session.
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const setup = await fetch(`${url}/api/v1/auth/2fa/setup`, {
      method: 'POST',
      headers: auth,
      body: '{}',
    });
    const { secret } = (await setup.json()) as { secret: string };
    await fetch(`${url}/api/v1/auth/2fa/enable`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ code: totp(secret) }),
    });
  }
  tokens.set(login, token);
  return token;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-settings-'));
  // A fresh installation: base and Settings.
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({ driver, catalogue, change: { install: ['settings'] }, dir }),
    {
      driver,
      dir,
      actor: 'test',
    },
  );
  host = await createAppHost({
    databaseUrl: container.getConnectionUri(),
    catalogue,
    migrationsDir: dir,
    logger: false,
    auth: { secureCookies: false, cacheMs: 0, loginLimit: 0 },
    rateLimit: { max: 0, timeWindow: '1 minute' },
  });
  const auth = host.server.auth;
  if (auth === undefined) throw new Error('base is installed');
  const { company, admin } = await installBase(host.server.shutro, auth, {
    company: { name: 'Padma Traders', currency: 'BDT' },
    admin: { login: 'admin', name: 'Administrator', password: PASSWORD },
  });
  users['admin'] = admin;
  for (const [login, groups] of [
    ['manager', ['settings.apps']],
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
  url = await host.listen({ port: 0, host: '127.0.0.1' });
}, 180_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('only Administrators and App managers reach the App manager', async () => {
  for (const [method, path, body] of [
    ['GET', '/api/v1/settings/apps', undefined],
    ['POST', '/api/v1/settings/apps/plan', { install: ['library'] }],
    ['POST', '/api/v1/settings/apps/apply', { change: { install: ['library'] }, planId: 'x' }],
  ] as const) {
    expect((await http(method, path, { body })).status).toBe(401);
    const bob = await http(method, path, { as: 'bob', body });
    expect(bob.status, path).toBe(403);
    expect(bob.json.title).toBe('App managers only');
  }
  expect((await http('GET', '/api/v1/library/ping')).status).toBe(404); // nothing was installed
});

test('the catalogue: installed, available, protected', async () => {
  const { status, json } = await http('GET', '/api/v1/settings/apps', { as: 'manager' });
  expect(status).toBe(200);
  const byName = Object.fromEntries((json.apps as Json[]).map((a) => [a.name, a]));
  expect(byName.settings).toMatchObject({ state: 'installed', protected: true, application: true });
  expect(byName.base).toMatchObject({ state: 'installed', dependency: true, protected: true });
  expect(byName.library).toMatchObject({
    state: 'available',
    category: 'Services',
    summary: 'Books and shelves',
    depends: ['base'],
  });
});

test('plan, then apply: one transaction, audited, served at once', async () => {
  const plan = await http('POST', '/api/v1/settings/apps/plan', {
    as: 'manager',
    body: { install: ['library'] },
  });
  expect(plan.status).toBe(200);
  expect(plan.json.install).toEqual([{ name: 'library', reason: 'selected' }]);
  expect(plan.json.statements.length).toBeGreaterThan(0);

  const wrong = await http('POST', '/api/v1/settings/apps/apply', {
    as: 'manager',
    body: { change: { install: ['library'] }, planId: 'not-the-plan' },
  });
  expect(wrong.status).toBe(409);
  expect(wrong.json.title).toBe('The plan changed');

  const before = host.generation;
  const applied = await http('POST', '/api/v1/settings/apps/apply', {
    as: 'manager',
    body: { change: { install: ['library'] }, planId: plan.json.planId },
  });
  expect(applied.status, JSON.stringify(applied.json)).toBe(200);
  expect(applied.json).toMatchObject({ installed: ['library'], enabled: [], disabled: [] });
  expect(host.generation).toBeGreaterThan(before);
  expect((await http('GET', '/api/v1/library/ping')).json).toEqual({ ok: true });

  const [event] = await driver.query<{ kind: string; summary: string; actor: string }>({
    text: "SELECT kind, summary, actor_id::text AS actor FROM audit_event WHERE kind = 'apps.change' ORDER BY id DESC LIMIT 1",
    params: [],
  });
  expect(event).toEqual({
    kind: 'apps.change',
    summary: 'installed library',
    actor: String(users['manager']),
  });

  // The same request again: the plan no longer matches what is installed.
  const replay = await http('POST', '/api/v1/settings/apps/apply', {
    as: 'manager',
    body: { change: { install: ['library'] }, planId: plan.json.planId },
  });
  expect(replay.status).toBe(409);
});

test('Settings and base cannot be disabled', async () => {
  for (const name of ['settings', 'base']) {
    const res = await http('POST', '/api/v1/settings/apps/plan', {
      as: 'admin',
      body: { disable: [name] },
    });
    expect(res.status).toBe(409);
    expect(res.json.detail).toContain('cannot be disabled');
  }
});

test('an Administrator disables an app; it is gone from this server at once', async () => {
  const plan = await http('POST', '/api/v1/settings/apps/plan', {
    as: 'admin',
    body: { disable: ['library'] },
  });
  expect(plan.status).toBe(200);
  expect(plan.json.statements).toEqual([]);
  const applied = await http('POST', '/api/v1/settings/apps/apply', {
    as: 'admin',
    body: { change: { disable: ['library'] }, planId: plan.json.planId },
  });
  expect(applied.json).toMatchObject({ disabled: ['library'] });
  expect((await http('GET', '/api/v1/library/ping')).status).toBe(404);
});

test('the Apps page is a client action in the Settings menu', async () => {
  const menus = await http('GET', '/api/v1/menus?app=settings', { as: 'manager' });
  expect(JSON.stringify(menus.json)).toContain('"action":"settings.action_apps"');
  const action = await http('GET', '/api/v1/actions/settings.action_apps', { as: 'manager' });
  expect(action.json.spec).toEqual({ type: 'client', page: 'settings.Apps', label: 'Apps' });
  expect((await http('GET', '/api/v1/actions/settings.action_apps', { as: 'bob' })).status).toBe(
    403,
  );
});
