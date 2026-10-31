/**
 * The Trade Finance ↔ sales bridge on real PostgreSQL (RFC 0021, Trade Finance step 3): the two apps propose it;
 * an LC opened from a sales order takes its counterparty, currency and total, its direction and source document; the
 * order lists its LCs.
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
import { tradeFinance } from '@kosh/trade_finance';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { tradeFinanceSale } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [
  base,
  settings,
  contacts,
  product,
  messaging,
  sales,
  tradeFinance,
  tradeFinanceSale,
];

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let host: AppHost;
let company: number;
const ids: Record<string, number> = {};
let token: string | undefined;

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function call(
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
): Promise<{ status: number; json: Json }> {
  if (token === undefined) {
    const login = await host.server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { login: 'maria', password: PASSWORD },
    });
    token = (login.json() as { token: string }).token;
  }
  const res = await host.server.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: res.statusCode, json: res.body === '' ? null : res.json() };
}

test('the plan proposes the bridge when Trade Finance and sales come', () => {
  const plan = planApps(catalogue, [], { install: ['trade_finance', 'sales'] });
  expect(plan.install.find((i) => i.name === 'trade_finance_sale')).toEqual({
    name: 'trade_finance_sale',
    reason: 'bridge',
  });
});

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-trade-finance-sale-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({
      driver,
      catalogue,
      change: { install: ['settings', 'sales', 'trade_finance'] },
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
    groups: ['trade_finance.manager', 'sales.manager', 'contacts.manager', 'product.manager'],
  });
  const [bdt] = await host.server.shutro.bootstrap(
    { reason: 'test', company },
    (env) => env.sql<{ id: number }>`SELECT id FROM res_currency WHERE name = 'BDT'`,
  );
  ids['bdt'] = bdt?.id as number;
  for (const [key, name, flags] of [
    ['partner', 'Bengal Steel', { isCustomer: true }],
    ['bank', 'Dhaka Commerce Bank', {}],
  ] as const)
    ids[key] = (
      await call('POST', '/api/v1/models/res.partner', { name, isCompany: true, ...flags })
    ).json.id;
  ids['product'] = (
    await call('POST', '/api/v1/models/product.product', { name: 'Steel beam' })
  ).json.id;
}, 240_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('an LC from the order takes its counterparty, currency and total; the order lists it', async () => {
  const order = await call('POST', '/api/v1/models/sale.order', {
    partner: ids['partner'],
    currency: ids['bdt'],
    lines: {
      create: [{ product: ids['product'], name: 'Steel beam', quantity: '10', priceUnit: '1200' }],
    },
  });
  expect(order.status, JSON.stringify(order.json)).toBe(201);
  const proposed = await call('POST', '/api/v1/models/trade.lc/onchange', {
    values: { saleOrder: order.json.id },
    changed: ['saleOrder'],
  });
  expect(proposed.status, JSON.stringify(proposed.json)).toBe(200);
  const name = (await call('GET', `/api/v1/models/sale.order/${order.json.id}`)).json.name;
  expect(proposed.json.values).toMatchObject({
    direction: 'export',
    partner: ids['partner'],
    currency: ids['bdt'],
    origin: name,
  });
  expect(Number(proposed.json.values.amount?.amount ?? proposed.json.values.amount)).toBe(12000);
  const lc = await call('POST', '/api/v1/models/trade.lc', {
    direction: proposed.json.values.direction,
    partner: proposed.json.values.partner,
    currency: proposed.json.values.currency,
    amount: proposed.json.values.amount?.amount ?? proposed.json.values.amount,
    origin: proposed.json.values.origin,
    saleOrder: order.json.id,
    bank: ids['bank'],
    latestShipmentDate: '2099-01-10',
    expiryDate: '2099-01-31',
  });
  expect(lc.status, JSON.stringify(lc.json)).toBe(201);
  const listed = await call(
    'GET',
    `/api/v1/models/trade.lc?filter=${encodeURIComponent(JSON.stringify({ saleOrder: order.json.id }))}&fields=id`,
  );
  expect(listed.json.items.map((l: Json) => l.id)).toEqual([lc.json.id]);
});
