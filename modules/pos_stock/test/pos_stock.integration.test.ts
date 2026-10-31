/**
 * The Counter ↔ Stockroom bridge on real PostgreSQL (RFC 0021, Counter step 2): the two apps propose it; a closed
 * session's sold goods leave the shop's warehouse as one delivery, done at once, and the stock shows it.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accounting } from '@kosh/accounting';
import { contacts } from '@kosh/contacts';
import { messaging } from '@kosh/messaging';
import { planApps } from '@kosh/modules-sdk';
import { permissions } from '@kosh/permissions';
import { pos } from '@kosh/pos';
import { product } from '@kosh/product';
import { reporting } from '@kosh/reporting';
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
import { posStock } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [
  base,
  settings,
  contacts,
  product,
  accounting,
  messaging,
  permissions,
  reporting,
  stock,
  pos,
  posStock,
];

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let host: AppHost;
let token: string | undefined;
const ids: Record<string, number> = {};

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function call(
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  payload?: unknown,
): Promise<{ status: number; json: Json }> {
  if (token === undefined) {
    const res = await host.server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { login: 'dina', password: PASSWORD },
    });
    token = (res.json() as { token: string }).token;
  }
  const res = await host.server.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: res.statusCode, json: res.body === '' ? null : res.json() };
}

test('the plan proposes the bridge when Counter and Stockroom come', () => {
  const plan = planApps(catalogue, [], { install: ['pos', 'stock'] });
  expect(plan.install.find((i) => i.name === 'pos_stock')).toEqual({
    name: 'pos_stock',
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
  dir = await mkdtemp(join(tmpdir(), 'kosh-pos-stock-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({
      driver,
      catalogue,
      change: { install: ['settings', 'stock', 'pos'] },
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
  const { company } = await installBase(host.server.shutro, auth, {
    company: { name: 'Padma Traders', currency: 'BDT' },
    admin: { login: 'admin', name: 'Administrator', password: PASSWORD },
  });
  await installDefaults(host.server.shutro, host.server.registry.loaded.modules, { company });
  await auth.createUser({
    login: 'dina',
    name: 'Dina',
    password: PASSWORD,
    company,
    companies: [company],
    groups: ['pos.manager', 'stock.manager', 'product.manager'],
  });
  const tea = await call('POST', '/api/v1/models/product.product', {
    name: 'Tea 500 g',
    listPrice: '250',
    kind: 'goods',
  });
  ids['tea'] = tea.json.id;
  const shop = await call('POST', '/api/v1/models/pos.shop', {
    name: 'Padma Shop',
    methods: { create: [{ name: 'Cash', kind: 'cash' }] },
  });
  ids['shop'] = shop.json.id;
  const shops = await call('GET', '/api/v1/counter/shops');
  ids['cash'] = shops.json.shops[0].methods[0].id;
  // Ten teas on the shelf: a receipt into the warehouse, validated.
  const locations = (await call('GET', '/api/v1/models/stock.location?fields=name,usage')).json
    .items as { id: number; usage: string }[];
  const receipt = await call('POST', '/api/v1/models/stock.picking', {
    kind: 'receipt',
    source: locations.find((l) => l.usage === 'vendor')?.id,
    destination: locations.find((l) => l.usage === 'internal')?.id,
    moves: { create: [{ product: ids['tea'], name: 'Tea', quantity: '10', quantityDone: '10' }] },
  });
  expect(receipt.status, JSON.stringify(receipt.json)).toBe(201);
  for (const t of ['confirm', 'validate'])
    expect(
      (await call('POST', `/api/v1/models/stock.picking/${receipt.json.id}/transitions/${t}`))
        .status,
    ).toBe(200);
}, 240_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('a closed session leaves stock as one done delivery; the shelf shows it', async () => {
  const opened = await call('POST', '/api/v1/counter/sessions', {
    shop: ids['shop'],
    openingCash: '0',
  });
  expect(opened.status, JSON.stringify(opened.json)).toBe(201);
  const session = opened.json.session.id;
  for (const qty of ['2', '1']) {
    const sale = await call('POST', '/api/v1/counter/orders', {
      session,
      lines: [{ product: ids['tea'], quantity: qty }],
      payments: [{ method: ids['cash'], amount: String(250 * Number(qty)) }],
    });
    expect(sale.status, JSON.stringify(sale.json)).toBe(201);
  }
  const closed = await call('POST', `/api/v1/counter/sessions/${session}/close`, {
    closingCash: '750',
  });
  expect(closed.status, JSON.stringify(closed.json)).toBe(200);
  const read = await call('GET', `/api/v1/models/pos.session/${session}?fields=delivery`);
  const deliveryId = read.json.delivery?.id ?? read.json.delivery;
  expect(deliveryId).toBeTruthy();
  const delivery = await call(
    'GET',
    `/api/v1/models/stock.picking/${deliveryId}?fields=kind,state,origin`,
  );
  expect(delivery.json).toMatchObject({ kind: 'delivery', state: 'done' });
  const moves = await call(
    'GET',
    `/api/v1/models/stock.move?filter=${encodeURIComponent(JSON.stringify({ picking: deliveryId }))}&fields=quantity,quantityDone`,
  );
  expect(moves.json.items).toHaveLength(1);
  expect(Number(moves.json.items[0].quantityDone)).toBe(3);
  const quants = await call(
    'GET',
    `/api/v1/models/stock.quant?filter=${encodeURIComponent(JSON.stringify({ product: ids['tea'], 'location.usage': 'internal' }))}&fields=quantity`,
  );
  const onHand = quants.json.items.reduce(
    (sum: number, q: { quantity: string }) => sum + Number(q.quantity),
    0,
  );
  expect(onHand).toBe(7);
});
