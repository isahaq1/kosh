/**
 * Purchase on real PostgreSQL through the HTTP API (RFC 0008, RFC 0003 §5.3): installing Purchase brings Contacts,
 * Products, the chatter and Permissions, and its default approval policy; an order above the manager threshold
 * waits for a purchase manager (the buyer cannot confirm it, nor approve it), and the manager's approval confirms
 * it; a small order confirms right after it is submitted; buyers see their own orders and users without Purchase
 * are refused.
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
  installDefaults,
  prepareApps,
  recordInstalledApps,
} from '@kosh/server';
import { type Driver, orm, pg } from '@kosh/server/orm';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { purchase } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [base, purchase];

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let host: AppHost;
let product: number;
let vendor: number;
let currency: number;
const tokens = new Map<string, string>();

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function call(
  method: 'GET' | 'POST',
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

const order = (quantity: string) =>
  call('POST', '/api/v1/models/purchase.order', 'farid', {
    partner: vendor,
    currency,
    lines: { create: [{ product, name: 'Raw jute (kg)', quantity, priceUnit: '100' }] },
  });
const run = (id: number, transition: string, as = 'farid') =>
  call('POST', `/api/v1/models/purchase.order/${id}/transitions/${transition}`, as);

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-purchase-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({ driver, catalogue, change: { install: ['purchase'] }, dir }),
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
    listen: false,
    auth: { secureCookies: false, cacheMs: 0, loginLimit: 0 },
    rateLimit: { max: 0, timeWindow: '1 minute' },
  });
  const auth = host.server.auth;
  if (auth === undefined) throw new Error('base is installed');
  const { company } = await installBase(host.server.shutro, auth, {
    company: { name: 'Padma Traders', currency: 'BDT' },
    admin: { login: 'admin', name: 'Administrator', password: PASSWORD },
  });
  // As kosh init does: the apps' defaults again, now that the company exists (approval policies are per company).
  await installDefaults(host.server.shutro, host.server.registry.loaded.modules, { company });
  for (const [login, groups] of [
    ['farid', ['purchase.user']],
    ['nadia', ['purchase.user']],
    ['dina', ['purchase.manager']],
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
  type Model = { create(rows: unknown[]): Promise<{ ids: number[] }> };
  const model = (env: unknown, name: string) => (env as { model(n: string): Model }).model(name);
  const ids = await host.server.shutro.bootstrap({ reason: 'test: data', company }, async (env) => {
    const [bdt] = await env.sql<{ id: number }>`SELECT id FROM res_currency WHERE name = 'BDT'`;
    const p = await model(env, 'product.product').create([
      { name: 'Raw jute', standardPrice: '100' },
    ]);
    const v = await model(env, 'res.partner').create([
      { name: 'Jessore Jute Mills', isCompany: true, isVendor: true },
    ]);
    return { product: p.ids[0] as number, vendor: v.ids[0] as number, currency: bdt?.id as number };
  });
  product = ids.product;
  vendor = ids.vendor;
  currency = ids.currency;
}, 180_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('installing Purchase brings its dependencies and its approval policy', async () => {
  const installed = await driver.query<{ name: string }>({
    text: 'SELECT name FROM kosh_module ORDER BY name',
    params: [],
  });
  expect(installed.map((r) => r.name)).toEqual(
    expect.arrayContaining(['contacts', 'messaging', 'permissions', 'product', 'purchase']),
  );
  const levels = await driver.query<{ name: string }>({
    text: 'SELECT name FROM approval_level ORDER BY sequence, id',
    params: [],
  });
  expect(levels.map((l) => l.name)).toEqual(['Purchase manager', 'Purchase director']);
});

test('a large order waits for a manager, whose approval confirms it', async () => {
  const created = await order('1500'); // 150,000: above the manager threshold, below the director's
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const id = created.json.id as number;
  expect(String(created.json.name)).toMatch(/^PO\/\d{4}\/\d{5}$/);

  const submitted = await run(id, 'submit');
  expect(submitted.status, JSON.stringify(submitted.json)).toBe(200);
  expect(submitted.json.state).toBe('to_approve');

  const early = await run(id, 'confirm');
  expect(early.status).toBe(409);
  expect(early.json.detail).toContain('Waiting for approvals');

  // The buyer has nothing to decide; the manager does.
  expect((await call('GET', '/api/v1/approvals/inbox', 'farid')).json.requests).toEqual([]);
  const inbox = await call('GET', '/api/v1/approvals/inbox', 'dina');
  expect(inbox.json.requests).toHaveLength(1);
  const request = inbox.json.requests[0];
  expect(request.levelName).toBe('Purchase manager');
  expect(
    (await call('POST', `/api/v1/approvals/requests/${request.id}/approve`, 'farid')).status,
  ).toBeGreaterThanOrEqual(400);

  const approved = await call('POST', `/api/v1/approvals/requests/${request.id}/approve`, 'dina', {
    comment: 'Within budget',
  });
  expect(approved.status, JSON.stringify(approved.json)).toBe(200);
  const read = await call('GET', `/api/v1/models/purchase.order/${id}`, 'farid');
  expect(read.json.state).toBe('purchase'); // the last approval ran `confirm`
});

test('a small order needs no approval: submit, then confirm', async () => {
  const created = await order('10'); // 1,000
  const id = created.json.id as number;
  expect((await run(id, 'submit')).json.state).toBe('to_approve');
  const confirmed = await run(id, 'confirm');
  expect(confirmed.status, JSON.stringify(confirmed.json)).toBe(200);
  expect(confirmed.json.state).toBe('purchase');
});

test('the line onchange takes the product cost', async () => {
  const res = await call('POST', '/api/v1/models/purchase.order.line/onchange', 'farid', {
    values: { product },
    changed: ['product'],
  });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  expect(Number(res.json.values.priceUnit)).toBe(100);
});

test('buyers see their own orders, managers all, others none', async () => {
  expect((await call('GET', '/api/v1/models/purchase.order', 'farid')).json.items).toHaveLength(2);
  expect((await call('GET', '/api/v1/models/purchase.order', 'nadia')).json.items).toEqual([]);
  expect((await call('GET', '/api/v1/models/purchase.order', 'dina')).json.items).toHaveLength(2);
  expect((await call('GET', '/api/v1/models/purchase.order', 'bob')).status).toBe(403);
  const menus = await call('GET', '/api/v1/menus?app=purchase', 'farid');
  expect(JSON.stringify(menus.json)).not.toContain('purchase.action_to_approve'); // managers only
  const managers = await call('GET', '/api/v1/menus?app=purchase', 'dina');
  expect(JSON.stringify(managers.json)).toContain('purchase.action_to_approve');
});
