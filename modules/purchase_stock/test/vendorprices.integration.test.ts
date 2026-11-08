/**
 * Vendor prices on real PostgreSQL (RFC 0030 §3.1): purchase lines priced by the order's vendor for their quantity
 * (price breaks, the vendor's code, why), a typed price kept, a category's price for its products; reorder rules
 * buying from the cheapest vendor that arrives in time and saying so; the vendor's scorecard; only buyers set prices.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contacts } from '@kosh/contacts';
import { messaging } from '@kosh/messaging';
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
const O = '/api/v1/models/purchase.order';
const V = '/api/v1/models/product.vendor.price';

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
const expectStatus = (r: { status: number; json: Json }, status: number) =>
  expect(r.status, JSON.stringify(r.json)).toBe(status);
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
const today = new Date().toISOString().slice(0, 10);

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off'; // the test drains the subscriber itself
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-vendor-prices-'));
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
    ['mona', ['stock.manager', 'purchase_stock.user']],
    ['bob', ['product.user', 'contacts.user']],
  ] as const)
    await auth.createUser({
      login,
      name: login,
      password: PASSWORD,
      company,
      companies: [company],
      groups: [...groups],
    });
  const [bdt] = await host.server.shutro.bootstrap(
    { reason: 'test', company },
    (env) => env.sql<{ id: number }>`SELECT id FROM res_currency WHERE name = 'BDT'`,
  );
  ids['bdt'] = bdt?.id as number;
  for (const name of ['Padma Cement', 'Meghna Steel', 'Jamuna Supplies'])
    ids[name] = (
      await call('POST', '/api/v1/models/res.partner', 'sumi', { name, isVendor: true })
    ).json.id;
  ids['cat'] = (
    await call('POST', '/api/v1/models/product.category', 'sumi', { name: 'Fasteners' })
  ).json.id;
  for (const [name, category] of [
    ['Cement bag', null],
    ['Bolt M8', ids['cat']],
  ] as const)
    ids[name] = (
      await call('POST', '/api/v1/models/product.product', 'sumi', {
        name,
        standardPrice: '999',
        ...(category === null ? {} : { category }),
      })
    ).json.id;
}, 240_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('purchase lines priced by the vendor: breaks, the vendor’s code, why; a typed price kept; a category’s price', async () => {
  const price = (body: Record<string, unknown>) =>
    call('POST', V, 'sumi', { company, ...body }).then((r) => {
      expectStatus(r, 201);
      return r.json.id as number;
    });
  // Only buyers set vendor prices.
  expect(
    (
      await call('POST', V, 'bob', {
        vendor: ids['Padma Cement'],
        product: ids['Cement bag'],
        price: '1',
      })
    ).status,
  ).toBe(403);
  // A product or a category, not both or neither.
  expect(
    (await call('POST', V, 'sumi', { vendor: ids['Padma Cement'], price: '1', company })).status,
  ).toBe(422);
  await price({
    vendor: ids['Padma Cement'],
    product: ids['Cement bag'],
    vendorCode: 'PC-50',
    price: '520',
    leadDays: 2,
  });
  await price({
    vendor: ids['Padma Cement'],
    product: ids['Cement bag'],
    vendorCode: 'PC-50',
    minQuantity: '100',
    price: '480',
    leadDays: 2,
  });
  await price({ vendor: ids['Padma Cement'], category: ids['cat'], price: '12' });

  const order = await call('POST', O, 'sumi', {
    partner: ids['Padma Cement'],
    currency: ids['bdt'],
    lines: {
      create: [
        { product: ids['Cement bag'], name: 'Cement bag', quantity: '10' },
        { product: ids['Cement bag'], name: 'Cement bag', quantity: '150' },
        { product: ids['Bolt M8'], name: 'Bolt M8', quantity: '500' },
        { product: ids['Cement bag'], name: 'Cement bag', quantity: '5', priceUnit: '500' },
      ],
    },
  });
  expectStatus(order, 201);
  const lines = await find(
    'purchase.order.line',
    { order: order.json.id },
    'quantity,priceUnit,vendorCode,priceReason',
  );
  expect(lines.map((l) => Number(l.priceUnit))).toEqual([520, 480, 12, 500]);
  expect(lines[0]).toMatchObject({ vendorCode: 'PC-50' });
  expect(lines[1].priceReason).toBe('Padma Cement’s price from 100; 2 days to arrive.');
  expect(lines[2].priceReason).toContain('its category’s price');
  expect(lines[3].priceReason).toBe('Typed in.');

  // Another vendor without prices: the product's cost, said so.
  const other = await call('POST', O, 'sumi', {
    partner: ids['Jamuna Supplies'],
    currency: ids['bdt'],
    lines: { create: [{ product: ids['Cement bag'], name: 'Cement bag', quantity: '1' }] },
  });
  const [line] = await find(
    'purchase.order.line',
    { order: other.json.id },
    'priceUnit,priceReason',
  );
  expect(Number(line.priceUnit)).toBe(999);
  expect(line.priceReason).toContain('this vendor has no price');
});

test('a buying rule orders from the cheapest vendor that arrives in time, and says so; the scorecard counts it', async () => {
  ids['Rebar'] = (
    await call('POST', '/api/v1/models/product.product', 'sumi', {
      name: 'Rebar',
      standardPrice: '999',
    })
  ).json.id;
  await call('POST', V, 'sumi', {
    company,
    vendor: ids['Padma Cement'],
    product: ids['Rebar'],
    price: '520',
    leadDays: 2,
  });
  // Meghna is cheaper but too slow for the rule's 5 days; Jamuna arrives in 4; Padma is dearer.
  for (const [vendor, value, lead] of [
    ['Meghna Steel', '400', 10],
    ['Jamuna Supplies', '450', 4],
  ] as const)
    expectStatus(
      await call('POST', V, 'sumi', {
        company,
        vendor: ids[vendor],
        product: ids['Rebar'],
        price: value,
        leadDays: lead,
      }),
      201,
    );
  const [main] = await find('stock.warehouse', { code: 'WH' }, 'id', 'mona');
  const rule = await call('POST', '/api/v1/models/stock.reorder', 'mona', {
    product: ids['Rebar'],
    warehouse: main.id,
    method: 'buy',
    vendor: ids['Padma Cement'],
    minimum: '10',
    maximum: '60',
    leadDays: 5,
  });
  expectStatus(rule, 201);
  await call('POST', '/api/v1/stockroom/replenishment/refresh', 'mona', { rules: [rule.json.id] });
  const refreshed = (await call('GET', `/api/v1/models/stock.reorder/${rule.json.id}`, 'mona'))
    .json;
  // Padma's 520 at 60 (no break) is dearer than Jamuna's 450; Meghna's 400 arrives too late.
  expect(refreshed.explanation).toContain(
    'Bought from Jamuna Supplies: Jamuna Supplies is the cheapest of 2; arrives in 4 days, in time.',
  );
  const ordered = await call('POST', '/api/v1/stockroom/replenishment/order', 'mona', {
    rules: [rule.json.id],
  });
  expectStatus(ordered, 200);
  const [rfq] = await find(
    'purchase.order',
    { name: ordered.json.ordered[0].document },
    'partner,dateOrder,datePlanned',
    'mona',
  );
  expect(rfq.partner?.id ?? rfq.partner).toBe(ids['Jamuna Supplies']);
  expect((Date.parse(rfq.datePlanned) - Date.parse(rfq.dateOrder)) / 86_400_000).toBe(4);
  const [line] = await find('purchase.order.line', { order: rfq.id }, 'priceUnit', 'mona');
  expect(Number(line.priceUnit)).toBe(450);

  // Confirmed and received today, by the expected date: on time.
  const worker = purchaseStockWorker({ shutro: host.server.shutro });
  await run(`${O}/${rfq.id}/transitions/submit`, 'mona');
  await run(`${O}/${rfq.id}/transitions/confirm`, 'mona');
  expect(await worker.drain()).toBe(1);
  const [receipt] = await find('stock.picking', { purchaseOrder: rfq.id }, 'id', 'mona');
  await run(`/api/v1/models/stock.picking/${receipt.id}/transitions/validate`, 'mona');
  const card = await call(
    'GET',
    `/api/v1/purchase/vendors/${ids['Jamuna Supplies']}/scorecard`,
    'mona',
  );
  expectStatus(card, 200);
  expect(card.json).toMatchObject({
    orders: 1,
    receipts: 1,
    onTime: 1,
    onTimeRate: 100,
    averageLeadDays: 0,
  });
  expect(card.json.products[0]).toMatchObject({ name: 'Rebar', lastPrice: '450.00' });
  expect(today).toBeTruthy();
});
