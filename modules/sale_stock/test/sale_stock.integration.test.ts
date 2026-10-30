/**
 * The Sales ↔ Stockroom bridge on real PostgreSQL (RFC 0021): installing both proposes it; confirming an order
 * makes its delivery through the outbox, once, with its goods lines only, in their units, reserved; a salesperson
 * without Stockroom rights still gets the delivery made; validating it delivers the order.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contacts } from '@kosh/contacts';
import { messaging } from '@kosh/messaging';
import { planApps } from '@kosh/modules-sdk';
import { product } from '@kosh/product';
import { sales } from '@kosh/sales';
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
import { createDeliveryFor, saleStock, saleStockWorker } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [base, settings, contacts, product, messaging, sales, stock, saleStock];
const T = '/api/v1/models/stock.picking';
const O = '/api/v1/models/sale.order';

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
const find = async (model: string, filter: unknown, fields: string, as = 'sumi') =>
  (
    await call(
      'GET',
      `/api/v1/models/${model}?filter=${encodeURIComponent(JSON.stringify(filter))}&fields=${fields}&order=id+asc`,
      as,
    )
  ).json.items as Json[];
const run = async (url: string, as = 'sumi') => {
  const res = await call('POST', url, as);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json;
};
/** Stock in: a validated receipt of `quantity` of `name`. */
async function receive(name: string, quantity: string): Promise<void> {
  const made = await call('POST', T, 'sumi', {
    kind: 'receipt',
    source: ids['vendors'],
    destination: ids['stock'],
    moves: { create: [{ product: ids[name], quantity }] },
  });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  await run(`${T}/${made.json.id}/transitions/confirm`);
  await run(`${T}/${made.json.id}/transitions/validate`);
}
async function order(as: string, lines: readonly Record<string, unknown>[]): Promise<number> {
  const made = await call('POST', O, as, {
    partner: ids['customer'],
    currency: ids['bdt'],
    lines: { create: lines },
  });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  await run(`${O}/${made.json.id}/transitions/confirm`, as);
  return made.json.id as number;
}

test('the plan proposes the bridge when Sales and Stockroom come', () => {
  const plan = planApps(catalogue, [], { install: ['sales', 'stock'] });
  expect(plan.install.find((i) => i.name === 'sale_stock')).toEqual({
    name: 'sale_stock',
    reason: 'bridge',
  });
});

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off'; // the test drains the subscriber itself
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-sale-stock-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({
      driver,
      catalogue,
      change: { install: ['settings', 'sales', 'stock'] },
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
    ['sumi', ['sale_stock.user', 'product.manager', 'contacts.manager']],
    ['rahim', ['sales.user']],
  ] as const)
    await auth.createUser({
      login,
      name: login,
      password: PASSWORD,
      company,
      companies: [company],
      groups: [...groups],
    });
  for (const l of await find('stock.location', {}, 'usage'))
    ids[l.usage === 'internal' ? 'stock' : l.usage === 'vendor' ? 'vendors' : String(l.usage)] =
      l.id;
  for (const u of await find('uom.uom', {}, 'name')) ids[u.name] = u.id;
  const [bdt] = await host.server.shutro.bootstrap(
    { reason: 'test', company },
    (env) => env.sql<{ id: number }>`SELECT id FROM res_currency WHERE name = 'BDT'`,
  );
  ids['bdt'] = bdt?.id as number;
  ids['customer'] = (
    await call('POST', '/api/v1/models/res.partner', 'sumi', {
      name: 'Acme Trading',
      isCustomer: true,
    })
  ).json.id;
  for (const [name, kind] of [
    ['Steel beam', 'goods'],
    ['LED panel', 'goods'],
    ['Installation', 'service'],
  ] as const)
    ids[name] = (
      await call('POST', '/api/v1/models/product.product', 'sumi', {
        name,
        kind,
        uom: ids['Units'],
      })
    ).json.id;
}, 240_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('a confirmed order gets its delivery once: goods lines, their units, reserved', async () => {
  const worker = saleStockWorker({ shutro: host.server.shutro });
  await receive('Steel beam', '5');
  const id = await order('sumi', [
    { product: ids['Steel beam'], name: 'Steel beam', quantity: '3', priceUnit: '1000' },
    {
      product: ids['LED panel'],
      name: 'LED panel',
      quantity: '1',
      uom: ids['Dozens'],
      priceUnit: '24000',
    },
    { product: ids['Installation'], name: 'Installation', quantity: '4', priceUnit: '500' },
  ]);
  expect(await find('stock.picking', { saleOrder: id }, 'id')).toHaveLength(0); // not yet: the outbox
  expect(await worker.drain()).toBe(1);
  const [delivery, ...others] = await find(
    'stock.picking',
    { saleOrder: id },
    'name,kind,origin,status,availability',
  );
  expect(others).toHaveLength(0);
  const name = (await call('GET', `${O}/${id}`, 'sumi')).json.name;
  expect(delivery).toMatchObject({ kind: 'delivery', origin: name, status: 'waiting' });
  expect(delivery.availability).toBe('partial'); // beams reserved, panels not in stock
  const lines = await find('stock.move', { picking: delivery.id }, 'product,quantity,uom,reserved');
  expect(lines).toHaveLength(2); // services are not delivered
  expect(lines[1]).toMatchObject({ quantity: '1', uom: ids['Dozens'] });
  expect((await call('GET', `${O}/${id}`, 'sumi')).json.deliveryState).toBe('to_deliver');

  // Once: the event again, or the function again, makes nothing more.
  await host.server.shutro.bootstrap({ reason: 'test: replay', company }, (env) =>
    env.emit('sale.order.confirmed', { id }),
  );
  expect(await worker.drain()).toBe(1);
  expect(await find('stock.picking', { saleOrder: id }, 'id')).toHaveLength(1);

  // Twelve panels come in: the delivery is ready and validated; the order is delivered.
  await receive('LED panel', '12');
  await run(`${T}/${delivery.id}/transitions/reserve`);
  await run(`${T}/${delivery.id}/transitions/validate`);
  const delivered = (await call('GET', `${O}/${id}`, 'sumi')).json;
  expect(delivered.deliveryState).toBe('delivered');
  const orderLines = await find('sale.order.line', { order: id }, 'name,qtyDelivered');
  expect(orderLines.map((l) => [l.name, l.qtyDelivered])).toEqual([
    ['Steel beam', '3'],
    ['LED panel', '1'],
    ['Installation', '0'],
  ]);
});

test('a salesperson without Stockroom rights still gets the delivery made', async () => {
  const worker = saleStockWorker({ shutro: host.server.shutro });
  const id = await order('rahim', [
    { product: ids['Steel beam'], name: 'Steel beam', quantity: '1', priceUnit: '1000' },
  ]);
  expect((await call('GET', T, 'rahim')).status).toBe(403);
  expect(await worker.drain()).toBe(1);
  const [delivery] = await find('stock.picking', { saleOrder: id }, 'status');
  expect(delivery.status).toBe('ready'); // the two beams left hold one
});

test('a partial delivery: the order is partly delivered, the backorder stays with the order', async () => {
  const worker = saleStockWorker({ shutro: host.server.shutro });
  await receive('Steel beam', '10');
  const id = await order('sumi', [
    { product: ids['Steel beam'], name: 'Steel beam', quantity: '10', priceUnit: '1000' },
  ]);
  await worker.drain();
  const [delivery] = await find('stock.picking', { saleOrder: id }, 'id');
  const [line] = await find('stock.move', { picking: delivery.id }, 'id,saleLine');
  await call('PATCH', `/api/v1/models/stock.move/${line.id}`, 'sumi', { quantityDone: '4' });
  await run(`${T}/${delivery.id}/transitions/validate`);
  expect((await call('GET', `${O}/${id}`, 'sumi')).json.deliveryState).toBe('partial');
  const [orderLine] = await find('sale.order.line', { order: id }, 'qtyDelivered');
  expect(orderLine.qtyDelivered).toBe('4');
  const [backorder] = await find(
    'stock.picking',
    { backorderOf: delivery.id },
    'saleOrder,origin,status',
  );
  expect(backorder.saleOrder).toBe(id);
  const [rest] = await find('stock.move', { picking: backorder.id }, 'quantity,saleLine');
  expect(rest).toMatchObject({ quantity: '6', saleLine: line.saleLine });
  await run(`${T}/${backorder.id}/transitions/validate`);
  expect((await call('GET', `${O}/${id}`, 'sumi')).json.deliveryState).toBe('delivered');
  expect((await find('sale.order.line', { order: id }, 'qtyDelivered'))[0].qtyDelivered).toBe('10');
});

test('an order of services only gets no delivery', async () => {
  const id = await order('sumi', [
    { product: ids['Installation'], name: 'Installation', quantity: '2', priceUnit: '500' },
  ]);
  const made = await host.server.shutro.bootstrap({ reason: 'test', company }, (env) =>
    createDeliveryFor(env as never, id),
  );
  expect(made).toBeNull();
  expect((await call('GET', `${O}/${id}`, 'sumi')).json.deliveryState).toBe('nothing');
});
