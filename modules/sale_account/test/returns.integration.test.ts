/**
 * Credit notes for returns (RFC 0030 §3.2) on real PostgreSQL: an order invoiced as ordered, delivered, part of it
 * sent back; the credit note proposes what came back, at the line's price, once; nothing to credit before.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accounting } from '@kosh/accounting';
import { contacts } from '@kosh/contacts';
import { messaging } from '@kosh/messaging';
import { permissions } from '@kosh/permissions';
import { product } from '@kosh/product';
import { saleStock, saleStockWorker } from '@kosh/sale_stock';
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
import { saleAccount } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [
  base,
  settings,
  contacts,
  product,
  messaging,
  permissions,
  sales,
  stock,
  accounting,
  saleStock,
  saleAccount,
];
const O = '/api/v1/models/sale.order';
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
const run = async (url: string) => {
  const res = await call('POST', url, 'maria');
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json;
};

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-sale-returns-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({
      driver,
      catalogue,
      change: { install: ['settings', 'sales', 'stock', 'accounting'] },
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
  await auth.createUser({
    login: 'maria',
    name: 'Maria',
    password: PASSWORD,
    company,
    companies: [company],
    groups: [
      'account.manager',
      'sales.manager',
      'stock.manager',
      'sale_stock.user',
      'sale_account.user',
      'product.manager',
      'contacts.manager',
    ],
  });
  expect(
    (await call('POST', '/api/v1/accounting/charts/install', 'maria', { template: 'generic' }))
      .status,
  ).toBe(200);
  for (const l of await find('stock.location', {}, 'usage'))
    ids[l.usage === 'internal' ? 'stock' : l.usage === 'vendor' ? 'vendors' : String(l.usage)] =
      l.id;
  const [bdt] = await host.server.shutro.bootstrap(
    { reason: 'test', company },
    (env) => env.sql<{ id: number }>`SELECT id FROM res_currency WHERE name = 'BDT'`,
  );
  ids['bdt'] = bdt?.id as number;
  ids['customer'] = (
    await call('POST', '/api/v1/models/res.partner', 'maria', {
      name: 'Acme Trading',
      isCustomer: true,
    })
  ).json.id;
  ids['beam'] = (
    await call('POST', '/api/v1/models/product.product', 'maria', { name: 'Steel beam' })
  ).json.id;
}, 240_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('what the customer sent back is credited once, at the line’s price', async () => {
  const receipt = await call('POST', T, 'maria', {
    kind: 'receipt',
    source: ids['vendors'],
    destination: ids['stock'],
    moves: { create: [{ product: ids['beam'], quantity: '10' }] },
  });
  await run(`${T}/${receipt.json.id}/transitions/confirm`);
  await run(`${T}/${receipt.json.id}/transitions/validate`);
  const made = await call('POST', O, 'maria', {
    partner: ids['customer'],
    currency: ids['bdt'],
    lines: {
      create: [{ product: ids['beam'], name: 'Steel beam', quantity: '5', priceUnit: '1000' }],
    },
  });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  const order = made.json.id as number;
  await run(`${O}/${order}/transitions/confirm`);
  await saleStockWorker({ shutro: host.server.shutro }).drain();
  const [delivery] = await find('stock.picking', { saleOrder: order }, 'id');
  await run(`${T}/${delivery.id}/transitions/validate`);
  await run(`${O}/${order}/transitions/invoice`);
  // Nothing came back: nothing to credit.
  expect((await call('POST', `${O}/${order}/transitions/refund`, 'maria')).status).toBe(409);

  const { lines } = (
    await call('GET', `/api/v1/stockroom/pickings/${delivery.id}/returnable`, 'maria')
  ).json;
  const [reason] = await find('stock.return.reason', { code: 'damaged' }, 'id');
  const back = await call('POST', `/api/v1/stockroom/pickings/${delivery.id}/return`, 'maria', {
    lines: [{ move: lines[0].move, quantity: '2' }],
    reason: reason.id,
  });
  expect(back.status, JSON.stringify(back.json)).toBe(200);
  // A return not validated yet is not credited.
  expect((await call('POST', `${O}/${order}/transitions/refund`, 'maria')).status).toBe(409);
  await run(`${T}/${back.json.picking}/transitions/validate`);

  await run(`${O}/${order}/transitions/refund`);
  const [credit] = await find('account.move', { saleOrder: order, kind: 'out_refund' }, 'id');
  const [line] = await find(
    'account.move.line',
    { move: credit.id, lineKind: 'product' },
    'quantity,priceUnit,name',
  );
  expect([Number(line.quantity), Number(line.priceUnit)]).toEqual([2, 1000]);
  expect(line.name).toBe('Steel beam (returned)');
  const [orderLine] = await find(
    'sale.order.line',
    { order },
    'qtyDelivered,qtyReturned,qtyInvoiced',
  );
  expect(
    [orderLine.qtyDelivered, orderLine.qtyReturned, orderLine.qtyInvoiced].map(Number),
  ).toEqual([3, 2, 3]);
  // Credited once.
  expect((await call('POST', `${O}/${order}/transitions/refund`, 'maria')).status).toBe(409);
});
