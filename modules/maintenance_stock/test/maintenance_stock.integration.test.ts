/**
 * The Asset Care ↔ Stockroom bridge on real PostgreSQL (RFC 0021, Asset Care step 2): the two apps propose it; an
 * order's spare parts are reserved when it starts — by a technician without Stockroom rights — and its finish is
 * refused while some are short, then consumes them to the Maintenance location; labour is costed at the rate of
 * App settings; cancelling releases the parts.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contacts } from '@kosh/contacts';
import { maintenance } from '@kosh/maintenance';
import { messaging } from '@kosh/messaging';
import { planApps } from '@kosh/modules-sdk';
import { product } from '@kosh/product';
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
import { settings } from '@kosh/settings';
import { stock } from '@kosh/stock';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { maintenanceStock } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [
  base,
  settings,
  contacts,
  product,
  messaging,
  stock,
  maintenance,
  maintenanceStock,
];
const R = '/api/v1/models/maintenance.request';
const T = '/api/v1/models/stock.picking';

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let host: AppHost;
let company: number;
const ids: Record<string, number> = {};
const tokens = new Map<string, string>();

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function call(
  method: 'GET' | 'POST' | 'PATCH',
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
const find = async (model: string, filter: unknown, fields: string) =>
  (
    await call(
      'GET',
      `/api/v1/models/${model}?filter=${encodeURIComponent(JSON.stringify(filter))}&fields=${fields}&order=id+asc`,
      'maria',
    )
  ).json.items as Json[];
async function receive(quantity: string): Promise<void> {
  const made = await call('POST', T, 'maria', {
    kind: 'receipt',
    source: ids['vendors'],
    destination: ids['stock'],
    moves: { create: [{ product: ids['filter'], quantity }] },
  });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  await call('POST', `${T}/${made.json.id}/transitions/confirm`, 'maria');
  expect((await call('POST', `${T}/${made.json.id}/transitions/validate`, 'maria')).status).toBe(
    200,
  );
}
const filter = async () =>
  (await call('GET', `/api/v1/models/product.product/${ids['filter']}`, 'maria')).json;

test('the plan proposes the bridge when Asset Care and Stockroom come', () => {
  const plan = planApps(catalogue, [], { install: ['maintenance', 'stock'] });
  expect(plan.install.find((i) => i.name === 'maintenance_stock')).toEqual({
    name: 'maintenance_stock',
    reason: 'bridge',
  });
});

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-maintenance-stock-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({
      driver,
      catalogue,
      change: { install: ['settings', 'maintenance', 'stock'] },
      dir,
    }),
    { driver, dir, actor: 'test' },
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
  ({ company } = await installBase(host.server.shutro, auth, {
    company: { name: 'Padma Traders', currency: 'BDT' },
    admin: { login: 'admin', name: 'Administrator', password: PASSWORD },
  }));
  await installDefaults(host.server.shutro, host.server.registry.loaded.modules, { company });
  for (const [login, groups] of [
    ['maria', ['maintenance.manager', 'stock.manager', 'product.manager']],
    ['rahim', ['maintenance_stock.user']],
  ] as const)
    await auth.createUser({
      login,
      name: login,
      password: PASSWORD,
      company,
      companies: [company],
      groups: [...groups],
    });
  for (const l of await find('stock.location', {}, 'usage,name'))
    ids[
      l.usage === 'internal'
        ? 'stock'
        : l.usage === 'vendor'
          ? 'vendors'
          : String(l.name).toLowerCase()
    ] = l.id;
  ids['filter'] = (
    await call('POST', '/api/v1/models/product.product', 'maria', {
      name: 'Filter',
      standardPrice: '50',
    })
  ).json.id;
  ids['press'] = (
    await call('POST', '/api/v1/models/maintenance.equipment', 'maria', { name: 'Press' })
  ).json.id;
  await receive('1');
  expect(
    (
      await call('PATCH', '/api/v1/settings/app-settings/maintenance/plans', 'maria', {
        values: { labourRate: '500' },
      })
    ).status,
  ).toBe(200);
}, 240_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('parts reserved at the start, consumed at the finish — not while short; labour costed', async () => {
  const order = await call('POST', R, 'rahim', {
    equipment: ids['press'],
    description: 'Clogged filters',
    labourHours: '1.5',
    parts: { create: [{ product: ids['filter'], quantity: '2' }] },
  });
  expect(order.status, JSON.stringify(order.json)).toBe(201);
  const id = order.json.id as number;
  expect((await call('POST', `${R}/${id}/transitions/start`, 'rahim')).status).toBe(200);
  const started = (await call('GET', `${R}/${id}`, 'rahim')).json;
  expect(started.partsCost).toBe('100');
  expect(Number((await filter()).qtyReserved)).toBe(1);
  const short = await call('POST', `${R}/${id}/transitions/finish`, 'rahim');
  expect(short.status).toBe(422);
  expect(JSON.stringify(short.json)).toContain('Parts are short: Filter (1)');

  await receive('1');
  const finished = await call('POST', `${R}/${id}/transitions/finish`, 'rahim');
  expect(finished.status, JSON.stringify(finished.json)).toBe(200);
  const done = (await call('GET', `${R}/${id}`, 'rahim')).json;
  expect(done).toMatchObject({ state: 'done', labourCost: '750' });
  expect(Number((await filter()).qtyOnHand)).toBe(0);
  const transfer = (await call('GET', `${T}/${done.partsTransfer}`, 'maria')).json;
  expect(transfer).toMatchObject({
    kind: 'adjustment',
    state: 'done',
    destination: ids['maintenance'],
  });
});

test('cancelling releases the parts', async () => {
  await receive('3');
  const id = (
    await call('POST', R, 'rahim', {
      equipment: ids['press'],
      parts: { create: [{ product: ids['filter'], quantity: '2' }] },
    })
  ).json.id as number;
  await call('POST', `${R}/${id}/transitions/start`, 'rahim');
  expect(Number((await filter()).qtyReserved)).toBe(2);
  expect((await call('POST', `${R}/${id}/transitions/cancel`, 'rahim')).status).toBe(200);
  expect(Number((await filter()).qtyReserved)).toBe(0);
});
