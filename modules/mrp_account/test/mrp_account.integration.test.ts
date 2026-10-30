/**
 * The Production ↔ Accounting bridge on real PostgreSQL (RFC 0021, Production step 2): the two apps propose it; a
 * product made enters stock at what it consumed plus its operations; the operations go into Work in progress
 * against Production labour and overhead; Work in progress clears.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accounting } from '@kosh/accounting';
import { contacts } from '@kosh/contacts';
import { messaging } from '@kosh/messaging';
import { planApps } from '@kosh/modules-sdk';
import { mrp } from '@kosh/mrp';
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
import { stockAccount } from '@kosh/stock_account';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { mrpAccount } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [
  base,
  settings,
  contacts,
  product,
  messaging,
  accounting,
  stock,
  stockAccount,
  mrp,
  mrpAccount,
];
const P = '/api/v1/models/mrp.production';
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
  payload?: unknown,
): Promise<{ status: number; json: Json }> {
  let token = tokens.get('maria');
  if (token === undefined) {
    const login = await host.server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { login: 'maria', password: PASSWORD },
    });
    token = (login.json() as { token: string }).token;
    tokens.set('maria', token);
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
    )
  ).json.items as Json[];
const ok = async (url: string) => {
  const res = await call('POST', url);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
};
const amount = (v: Json) => orm.toDecimal(String(v?.amount ?? v ?? '0'));
async function balanceOf(code: string): Promise<string> {
  const [account] = await find('account.account', { code }, 'id');
  if (account === undefined) return 'none';
  const lines = await find('account.move.line', { account: account.id }, 'debit,credit');
  return lines
    .reduce((s, l) => s.plus(amount(l.debit)).minus(amount(l.credit)), orm.toDecimal(0))
    .toFixed(2);
}

test('the plan proposes the bridge when Production and Accounting come', () => {
  const plan = planApps(catalogue, [], { install: ['mrp', 'accounting'] });
  expect(plan.install.find((i) => i.name === 'mrp_account')).toEqual({
    name: 'mrp_account',
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
  dir = await mkdtemp(join(tmpdir(), 'kosh-mrp-account-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({
      driver,
      catalogue,
      change: { install: ['settings', 'accounting', 'mrp'] },
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
    groups: ['account.manager', 'stock.manager', 'product.manager', 'mrp.manager'],
  });
  expect(
    (await call('POST', '/api/v1/accounting/charts/install', { template: 'generic' })).status,
  ).toBe(200);
  for (const l of await find('stock.location', {}, 'usage'))
    ids[l.usage === 'internal' ? 'stock' : l.usage === 'vendor' ? 'vendors' : String(l.usage)] =
      l.id;
  for (const u of await find('uom.uom', {}, 'name')) ids[u.name] = u.id;
  for (const [name, uom, standardPrice] of [
    ['Fixture', 'Units', '0'],
    ['Panel', 'Units', '100'],
    ['Cable', 'm', '10'],
  ] as const)
    ids[name] = (
      await call('POST', '/api/v1/models/product.product', { name, uom: ids[uom], standardPrice })
    ).json.id;
  const assembly = (
    await call('POST', '/api/v1/models/mrp.workcenter', { name: 'Assembly', costPerHour: '600' })
  ).json.id;
  ids['bom'] = (
    await call('POST', '/api/v1/models/mrp.bom', {
      product: ids['Fixture'],
      lines: {
        create: [
          { product: ids['Panel'], quantity: '1' },
          { product: ids['Cable'], quantity: '3', uom: ids['m'] },
        ],
      },
      operations: { create: [{ name: 'Assemble', workcenter: assembly, minutes: '20' }] },
    })
  ).json.id;
  for (const [name, quantity] of [
    ['Panel', '5'],
    ['Cable', '15'],
  ] as const) {
    const made = await call('POST', T, {
      kind: 'receipt',
      source: ids['vendors'],
      destination: ids['stock'],
      moves: { create: [{ product: ids[name], quantity }] },
    });
    await ok(`${T}/${made.json.id}/transitions/confirm`);
    await ok(`${T}/${made.json.id}/transitions/validate`);
  }
}, 240_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('made at what it consumed plus its operations; Work in progress clears', async () => {
  const id = (await call('POST', P, { product: ids['Fixture'], quantity: '5', bom: ids['bom'] }))
    .json.id as number;
  await ok(`${P}/${id}/transitions/confirm`);
  await ok(`${P}/${id}/transitions/produce`);
  const order = (await call('GET', `${P}/${id}`)).json;
  const [made] = await find(
    'stock.valuation.layer',
    { picking: order.output },
    'quantity,unitCost,value',
  );
  // 5 panels at 100 + 15 m of cable at 10 = 650; 5 × 20 minutes at 600 an hour = 1,000.
  expect(made).toMatchObject({ quantity: '5', unitCost: '330', value: '1650' });
  expect(
    (await call('GET', `/api/v1/models/product.product/${ids['Fixture']}`)).json.standardPrice,
  ).toBe('330');
  expect(await balanceOf('1250')).toBe('0.00');
  expect(await balanceOf('5200')).toBe('-1000.00');
  expect(await balanceOf('1200')).toBe('1650.00');
});
