/**
 * The Purchase ↔ Stockroom bridge on real PostgreSQL (RFC 0021): installing both proposes it; confirming a purchase
 * order makes its receipt through the outbox, once, with its goods lines only, expected on the order's arrival date;
 * a buyer without Stockroom rights still gets it made; validating it receives the order.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contacts } from '@kosh/contacts';
import { messaging } from '@kosh/messaging';
import { planApps } from '@kosh/modules-sdk';
import { permissions } from '@kosh/permissions';
import { product } from '@kosh/product';
import { purchase } from '@kosh/purchase';
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
import { purchaseStock, purchaseStockWorker } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [
  base,
  settings,
  contacts,
  product,
  messaging,
  permissions,
  purchase,
  stock,
  purchaseStock,
];
const T = '/api/v1/models/stock.picking';
const O = '/api/v1/models/purchase.order';

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
/** A small order (no approval needed), submitted and confirmed. */
async function order(as: string, lines: readonly Record<string, unknown>[]): Promise<number> {
  const made = await call('POST', O, as, {
    partner: ids['vendor'],
    currency: ids['bdt'],
    datePlanned: '2026-12-01',
    lines: { create: lines },
  });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  await run(`${O}/${made.json.id}/transitions/submit`, as);
  await run(`${O}/${made.json.id}/transitions/confirm`, as);
  return made.json.id as number;
}

test('the plan proposes the bridge when Purchase and Stockroom come', () => {
  const plan = planApps(catalogue, [], { install: ['purchase', 'stock'] });
  expect(plan.install.find((i) => i.name === 'purchase_stock')).toEqual({
    name: 'purchase_stock',
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
  dir = await mkdtemp(join(tmpdir(), 'kosh-purchase-stock-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({
      driver,
      catalogue,
      change: { install: ['settings', 'purchase', 'stock'] },
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
    ['sumi', ['purchase_stock.user', 'product.manager', 'contacts.manager']],
    ['rahim', ['purchase.user']],
    ['mona', ['stock.manager', 'purchase_stock.user']],
  ] as const)
    await auth.createUser({
      login,
      name: login,
      password: PASSWORD,
      company,
      companies: [company],
      groups: [...groups],
    });
  for (const u of await find('uom.uom', {}, 'name')) ids[u.name] = u.id;
  const [bdt] = await host.server.shutro.bootstrap(
    { reason: 'test', company },
    (env) => env.sql<{ id: number }>`SELECT id FROM res_currency WHERE name = 'BDT'`,
  );
  ids['bdt'] = bdt?.id as number;
  ids['vendor'] = (
    await call('POST', '/api/v1/models/res.partner', 'sumi', {
      name: 'Padma Cement',
      isVendor: true,
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

test('a confirmed order gets its receipt once: goods lines, their units, the arrival date', async () => {
  const worker = purchaseStockWorker({ shutro: host.server.shutro });
  const id = await order('sumi', [
    { product: ids['Steel beam'], name: 'Steel beam', quantity: '3', priceUnit: '700' },
    {
      product: ids['LED panel'],
      name: 'LED panel',
      quantity: '2',
      uom: ids['Dozens'],
      priceUnit: '18000',
    },
    { product: ids['Installation'], name: 'Installation', quantity: '4', priceUnit: '300' },
  ]);
  expect(await find('stock.picking', { purchaseOrder: id }, 'id')).toHaveLength(0); // the outbox
  expect(await worker.drain()).toBe(1);
  const [receipt, ...others] = await find(
    'stock.picking',
    { purchaseOrder: id },
    'kind,origin,status,scheduledDate',
  );
  expect(others).toHaveLength(0);
  const name = (await call('GET', `${O}/${id}`, 'sumi')).json.name;
  expect(receipt).toMatchObject({
    kind: 'receipt',
    origin: name,
    status: 'ready',
    scheduledDate: '2026-12-01',
  });
  expect(await find('stock.move', { picking: receipt.id }, 'id')).toHaveLength(2);
  expect((await call('GET', `${O}/${id}`, 'sumi')).json.receiptState).toBe('to_receive');

  await host.server.shutro.bootstrap({ reason: 'test: replay', company }, (env) =>
    env.emit('purchase.order.confirmed', { id }),
  );
  expect(await worker.drain()).toBe(1);
  expect(await find('stock.picking', { purchaseOrder: id }, 'id')).toHaveLength(1);

  await run(`${T}/${receipt.id}/transitions/validate`);
  expect((await call('GET', `${O}/${id}`, 'sumi')).json.receiptState).toBe('received');
  const lines = await find('purchase.order.line', { order: id }, 'name,qtyReceived');
  expect(lines.map((l) => [l.name, l.qtyReceived])).toEqual([
    ['Steel beam', '3'],
    ['LED panel', '2'],
    ['Installation', '0'],
  ]);
  const panel = (await call('GET', `/api/v1/models/product.product/${ids['LED panel']}`, 'sumi'))
    .json;
  expect(Number(panel.qtyOnHand)).toBe(24); // two dozen, in units
});

test('a buyer without Stockroom rights still gets the receipt made', async () => {
  const worker = purchaseStockWorker({ shutro: host.server.shutro });
  const id = await order('rahim', [
    { product: ids['Steel beam'], name: 'Steel beam', quantity: '1', priceUnit: '700' },
  ]);
  expect((await call('GET', T, 'rahim')).status).toBe(403);
  expect(await worker.drain()).toBe(1);
  expect(await find('stock.picking', { purchaseOrder: id }, 'status')).toHaveLength(1);
});

test('reorder rules that buy: a request for quotation to the vendor, into the rule’s warehouse, counted as on order', async () => {
  const worker = purchaseStockWorker({ shutro: host.server.shutro });
  const R = '/api/v1/models/stock.reorder';
  const north = (
    await call('POST', '/api/v1/models/stock.warehouse', 'mona', { name: 'North', code: 'NW' })
  ).json.id;
  const northStock = (
    await call('POST', '/api/v1/models/stock.location', 'mona', {
      name: 'Stock',
      usage: 'internal',
      warehouse: north,
    })
  ).json.id;
  await call('PATCH', `/api/v1/models/product.product/${ids['Steel beam']}`, 'sumi', {
    standardPrice: '650',
  });
  const rule = async (productId: number | undefined, minimum: string, maximum: string) => {
    const made = await call('POST', R, 'mona', {
      product: productId,
      warehouse: north,
      method: 'buy',
      vendor: ids['vendor'],
      minimum,
      maximum,
      leadDays: 5,
    });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    return made.json.id as number;
  };
  const beams = await rule(ids['Steel beam'], '10', '40');
  const panels = await rule(ids['LED panel'], '5', '12');
  const ordered = await call('POST', '/api/v1/stockroom/replenishment/order', 'mona', {
    rules: [beams],
  });
  expect(ordered.status, JSON.stringify(ordered.json)).toBe(200);
  const rfq = ordered.json.ordered[0].document as string;
  const [made] = await find(
    'purchase.order',
    { name: rfq },
    'state,origin,warehouse,dateOrder,datePlanned',
    'mona',
  );
  expect(made).toMatchObject({ state: 'draft', origin: 'Replenishment' });
  expect(made.warehouse?.id ?? made.warehouse).toBe(north);
  expect((Date.parse(made.datePlanned) - Date.parse(made.dateOrder)) / 86_400_000).toBe(5);
  // A second rule for the same vendor and warehouse adds to the draft request.
  const second = await call('POST', '/api/v1/stockroom/replenishment/order', 'mona', {
    rules: [panels],
    quantities: { [panels]: '15' },
  });
  expect(second.json.ordered[0].document).toBe(rfq);
  const lines = await find(
    'purchase.order.line',
    { order: made.id },
    'name,quantity,priceUnit',
    'mona',
  );
  expect(lines.map((l) => [l.name, Number(l.quantity), Number(l.priceUnit)])).toEqual([
    ['Steel beam', 40, 650],
    ['LED panel', 15, 0],
  ]);
  const onOrder = (await call('GET', `${R}/${beams}`, 'mona')).json;
  expect(onOrder.explanation).toBe(
    `On hand 0 + on order 40 (${rfq}) = forecast 40; not below the minimum 10: nothing to order.`,
  );

  // Confirmed and received into North: the receipt is coming in, the order no longer counted twice.
  await run(`${O}/${made.id}/transitions/submit`, 'mona');
  await run(`${O}/${made.id}/transitions/confirm`, 'mona');
  expect(await worker.drain()).toBe(1);
  const [receipt] = await find(
    'stock.picking',
    { purchaseOrder: made.id },
    'name,destination',
    'mona',
  );
  expect(receipt.destination?.id ?? receipt.destination).toBe(northStock);
  await call('POST', '/api/v1/stockroom/replenishment/refresh', 'mona', { rules: [beams] });
  const coming = (await call('GET', `${R}/${beams}`, 'mona')).json;
  expect(Number(coming.forecast)).toBe(40);
  expect(coming.explanation).toContain(`coming in 40 (${receipt.name})`);
});

test('dropship: the vendor delivers to the customer — the lines leave the delivery, on a request marked as a dropship, never received', async () => {
  const worker = purchaseStockWorker({ shutro: host.server.shutro });
  const [main] = await find('stock.warehouse', { code: 'WH' }, 'id', 'mona');
  const [stock] = await find(
    'stock.location',
    { warehouse: main.id, usage: 'internal', step: { isNull: true } },
    'id',
    'mona',
  );
  const [customers] = await find('stock.location', { usage: 'customer' }, 'id', 'mona');
  const rule = await call('POST', '/api/v1/models/stock.reorder', 'mona', {
    product: ids['Steel beam'],
    warehouse: main.id,
    method: 'dropship',
    trigger: 'order',
    vendor: ids['vendor'],
    leadDays: 2,
  });
  expect(rule.status, JSON.stringify(rule.json)).toBe(201);
  const delivery = await call('POST', T, 'mona', {
    kind: 'delivery',
    source: stock.id,
    destination: customers.id,
    origin: 'SO/2026/00042',
    moves: {
      create: [
        { product: ids['Steel beam'], quantity: '3' },
        { product: ids['LED panel'], quantity: '1' },
      ],
    },
  });
  expect(delivery.status, JSON.stringify(delivery.json)).toBe(201);
  await run(`${T}/${delivery.json.id}/transitions/confirm`, 'mona');
  const left = await find('stock.move', { picking: delivery.json.id }, 'product', 'mona');
  expect(left.map((m) => m.product?.id ?? m.product)).toEqual([ids['LED panel']]);
  const [shipped] = await find(
    'stock.picking',
    { kind: 'dropship' },
    'status,origin,purchaseOrder',
    'mona',
  );
  expect(shipped).toMatchObject({ status: 'ready', origin: 'SO/2026/00042' });
  const po = shipped.purchaseOrder?.id ?? shipped.purchaseOrder;
  const order = (await call('GET', `${O}/${po}`, 'mona')).json;
  expect(order).toMatchObject({ dropship: true, state: 'draft', origin: 'SO/2026/00042' });
  // Confirmed: no receipt into stock — the dropship is the order's transfer.
  await run(`${O}/${po}/transitions/submit`, 'mona');
  await run(`${O}/${po}/transitions/confirm`, 'mona');
  await worker.drain();
  expect(await find('stock.picking', { purchaseOrder: po }, 'kind', 'mona')).toEqual([
    expect.objectContaining({ kind: 'dropship' }),
  ]);
  const before = Number(
    (await call('GET', `/api/v1/models/product.product/${ids['Steel beam']}`, 'mona')).json
      .qtyOnHand,
  );
  await run(`${T}/${shipped.id}/transitions/validate`, 'mona');
  expect((await call('GET', `${O}/${po}`, 'mona')).json.receiptState).toBe('received');
  expect(
    Number(
      (await call('GET', `/api/v1/models/product.product/${ids['Steel beam']}`, 'mona')).json
        .qtyOnHand,
    ),
  ).toBe(before);
});
