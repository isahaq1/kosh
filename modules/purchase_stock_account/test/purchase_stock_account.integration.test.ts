/**
 * The Purchase ↔ Stockroom ↔ Accounting bridge on real PostgreSQL (RFC 0021 step 3): the three apps propose it; a
 * receipt from a purchase order is valued at the order's price (a dozen's price per unit); the vendor bill's goods
 * post to Goods received not billed; a price that differs on the bill goes to Price differences; the interim
 * account is cleared.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accounting } from '@kosh/accounting';
import { contacts } from '@kosh/contacts';
import { messaging } from '@kosh/messaging';
import { planApps } from '@kosh/modules-sdk';
import { permissions } from '@kosh/permissions';
import { product } from '@kosh/product';
import { purchase } from '@kosh/purchase';
import { purchaseAccount } from '@kosh/purchase_account';
import { purchaseStock, purchaseStockWorker } from '@kosh/purchase_stock';
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
import { stockAccount } from '@kosh/stock_account';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { purchaseStockAccount } from '../src/index.js';

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
  accounting,
  purchaseStock,
  stockAccount,
  purchaseAccount,
  purchaseStockAccount,
];
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
const find = async (model: string, filter: unknown, fields: string) =>
  (
    await call(
      'GET',
      `/api/v1/models/${model}?filter=${encodeURIComponent(JSON.stringify(filter))}&fields=${fields}&order=id+asc&limit=500`,
      'maria',
    )
  ).json.items as Json[];
const run = async (url: string) => {
  const res = await call('POST', url, 'maria');
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json;
};
const amount = (v: Json) => orm.toDecimal(String(v?.amount ?? v ?? '0'));
async function balanceOf(code: string): Promise<string> {
  const [account] = await find('account.account', { code }, 'id');
  const lines = await find('account.move.line', { account: account.id }, 'debit,credit');
  return lines
    .reduce((s, l) => s.plus(amount(l.debit)).minus(amount(l.credit)), orm.toDecimal(0))
    .toFixed(2);
}

test('the plan proposes the bridge when Purchase, Stockroom and Accounting come', () => {
  const plan = planApps(catalogue, [], { install: ['purchase', 'stock', 'accounting'] });
  expect(plan.install.find((i) => i.name === 'purchase_stock_account')).toEqual({
    name: 'purchase_stock_account',
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
  dir = await mkdtemp(join(tmpdir(), 'kosh-purchase-stock-account-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({
      driver,
      catalogue,
      change: { install: ['settings', 'purchase', 'stock', 'accounting'] },
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
      'stock.manager',
      'product.manager',
      'purchase.manager',
      'purchase_account.user',
      'contacts.manager',
    ],
  });
  expect(
    (await call('POST', '/api/v1/accounting/charts/install', 'maria', { template: 'generic' }))
      .status,
  ).toBe(200);
  for (const u of await find('uom.uom', {}, 'name')) ids[u.name] = u.id;
  const [bdt] = await host.server.shutro.bootstrap(
    { reason: 'test', company },
    (env) => env.sql<{ id: number }>`SELECT id FROM res_currency WHERE name = 'BDT'`,
  );
  ids['bdt'] = bdt?.id as number;
  ids['vendor'] = (
    await call('POST', '/api/v1/models/res.partner', 'maria', {
      name: 'Padma Cement',
      isVendor: true,
    })
  ).json.id;
  for (const [name, standardPrice] of [
    ['Cement', '100'],
    ['Panel', '150'],
  ] as const)
    ids[name] = (
      await call('POST', '/api/v1/models/product.product', 'maria', {
        name,
        uom: ids['Units'],
        standardPrice,
      })
    ).json.id;
}, 240_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('received at the order’s price; billed into Goods received not billed; the difference to Price differences', async () => {
  const made = await call('POST', O, 'maria', {
    partner: ids['vendor'],
    currency: ids['bdt'],
    lines: {
      create: [
        { product: ids['Cement'], name: 'Cement', quantity: '10', priceUnit: '120' },
        {
          product: ids['Panel'],
          name: 'Panel',
          quantity: '1',
          uom: ids['Dozens'],
          priceUnit: '2400',
        },
      ],
    },
  });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  const order = made.json.id as number;
  await run(`${O}/${order}/transitions/submit`);
  await run(`${O}/${order}/transitions/confirm`);
  expect(await purchaseStockWorker({ shutro: host.server.shutro }).drain()).toBe(1);
  const [receipt] = await find('stock.picking', { purchaseOrder: order }, 'id');
  await run(`/api/v1/models/stock.picking/${receipt.id}/transitions/validate`);

  const layers = await find(
    'stock.valuation.layer',
    { picking: receipt.id },
    'product,unitCost,value',
  );
  expect(layers.map((l) => [l.product, l.unitCost, l.value])).toEqual([
    [ids['Cement'], '120', '1200'],
    [ids['Panel'], '200', '2400'], // a dozen at 2,400: 200 a unit
  ]);
  const cement = (await call('GET', `/api/v1/models/product.product/${ids['Cement']}`, 'maria'))
    .json;
  expect(cement.standardPrice).toBe('120'); // the average cost follows
  expect(await balanceOf('2150')).toBe('-3600.00');

  // The bill: the cement at 125 instead of 120.
  await run(`${O}/${order}/transitions/bill`);
  const [bill] = await find('account.move', { purchaseOrder: order }, 'id');
  const [cementLine] = await find(
    'account.move.line',
    { move: bill.id, lineKind: 'product', product: ids['Cement'] },
    'id',
  );
  expect(
    (
      await call('PATCH', `/api/v1/models/account.move.line/${cementLine.id}`, 'maria', {
        priceUnit: '125',
      })
    ).status,
  ).toBe(200);
  await call('PATCH', `/api/v1/models/account.move/${bill.id}`, 'maria', {
    date: new Date().toISOString().slice(0, 10),
  });
  const posted = await call(
    'POST',
    `/api/v1/models/account.move/${bill.id}/transitions/post`,
    'maria',
  );
  expect(posted.status, JSON.stringify(posted.json)).toBe(200);

  const accounts = new Map(
    (await find('account.account', {}, 'code')).map((a: Json) => [a.id, a.code as string]),
  );
  const productLines = await find(
    'account.move.line',
    { move: bill.id, lineKind: 'product' },
    'account',
  );
  expect(productLines.map((l) => accounts.get(l.account))).toEqual(['2150', '2150']);
  expect(await balanceOf('5110')).toBe('50.00');
  expect(await balanceOf('2150')).toBe('0.00');
  expect(await balanceOf('1200')).toBe('3600.00');
});
