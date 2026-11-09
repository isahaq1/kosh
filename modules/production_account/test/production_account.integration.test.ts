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
import { product } from '@kosh/product';
import { production } from '@kosh/production';
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
import { productionAccount } from '../src/index.js';

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
  production,
  productionAccount,
];
const P = '/api/v1/models/production.order';
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
  const plan = planApps(catalogue, [], { install: ['production', 'accounting'] });
  expect(plan.install.find((i) => i.name === 'production_account')).toEqual({
    name: 'production_account',
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
  dir = await mkdtemp(join(tmpdir(), 'kosh-production-account-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({
      driver,
      catalogue,
      change: { install: ['settings', 'accounting', 'production'] },
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
    groups: ['account.manager', 'stock.manager', 'product.manager', 'production.manager'],
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
    await call('POST', '/api/v1/models/production.workcenter', {
      name: 'Assembly',
      costPerHour: '600',
    })
  ).json.id;
  ids['bom'] = (
    await call('POST', '/api/v1/models/production.bom', {
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

test('a by-product carries its share of the cost; Work in progress still clears', async () => {
  const offcut = (
    await call('POST', '/api/v1/models/product.product', { name: 'Offcut', uom: ids['Units'] })
  ).json.id;
  const share = await call('POST', '/api/v1/models/production.bom.byproduct', {
    bom: ids['bom'],
    product: offcut,
    quantity: '2',
    costShare: '10',
  });
  expect(share.status, JSON.stringify(share.json)).toBe(201);
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
  const id = (await call('POST', P, { product: ids['Fixture'], quantity: '5', bom: ids['bom'] }))
    .json.id as number;
  await ok(`${P}/${id}/transitions/confirm`);
  await ok(`${P}/${id}/transitions/produce`);
  const order = (await call('GET', `${P}/${id}`)).json;
  const layers = await find(
    'stock.valuation.layer',
    { picking: order.output },
    'product,quantity,value',
  );
  // 1,650 in all: 90 % to the 5 fixtures, 10 % to the 10 offcuts.
  expect(layers.map((l) => [l.product, l.quantity, l.value])).toEqual([
    [ids['Fixture'], '5', '1485'],
    [offcut, '10', '165'],
  ]);
  expect(await balanceOf('1250')).toBe('0.00');
});

test('overheads from the costing master are absorbed into the product and posted; the month-end allocation spreads the difference once (RFC 0031 step 5)', async () => {
  const today = new Date().toISOString().slice(0, 10);
  // An overhead account; a costing master for the fixture: 50 an order, 10 % of the materials, 2 a unit.
  const overhead = (
    await call('POST', '/api/v1/models/account.account', {
      code: '5210',
      name: 'Manufacturing overhead',
      type: 'expense_direct_cost',
    })
  ).json;
  expect(overhead.id, JSON.stringify(overhead)).toBeDefined();
  const accrued = (
    await call('POST', '/api/v1/models/account.account', {
      code: '2210',
      name: 'Accrued expenses',
      type: 'liability_current',
    })
  ).json.id;
  const costing = await call('POST', '/api/v1/models/production.costing', {
    name: 'Fixtures',
    product: ids['Fixture'],
    lines: {
      create: [
        { name: 'Set-up', account: overhead.id, method: 'fixed', amount: '50' },
        { name: 'Factory', account: overhead.id, method: 'percent', amount: '10' },
        { name: 'Power', account: overhead.id, method: 'unit', amount: '2' },
      ],
    },
  });
  expect(costing.status, JSON.stringify(costing.json)).toBe(201);
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
  const id = (await call('POST', P, { product: ids['Fixture'], quantity: '5', bom: ids['bom'] }))
    .json.id as number;
  await ok(`${P}/${id}/transitions/confirm`);
  await ok(`${P}/${id}/transitions/produce`);
  // 650 of materials + 1,000 of operations + 125 of overhead (50 + 10 % of 650 + 5 × 2) = 1,775; 90 % to the
  // fixtures, 10 % to the offcuts (the by-product above).
  const order = (await call('GET', `${P}/${id}?fields=overheadCost,fullCost,output`)).json;
  expect(Number(order.overheadCost)).toBe(125);
  expect(Number(order.fullCost)).toBe(1775);
  const [offcut] = await find('product.product', { name: 'Offcut' }, 'id');
  const layers = await find(
    'stock.valuation.layer',
    { picking: order.output?.id ?? order.output },
    'product,quantity,value',
  );
  expect(
    layers.map((l) => [l.product?.id ?? l.product, Number(l.quantity), Number(l.value)]),
  ).toEqual([
    [ids['Fixture'], 5, 1597.5],
    [offcut.id, 10, 177.5],
  ]);
  expect(await balanceOf('1250')).toBe('0.00');
  expect(await balanceOf('5210')).toBe('-125.00');
  // Month end: 200 of rent booked on the overhead account; the allocation finds 75 under-absorbed and spreads it over
  // the month's three done orders (15 fixtures) by quantity, onto the stock on hand; the account nets to nothing.
  const [journal] = await find('account.journal', {}, 'id');
  const company = (await call('GET', '/api/v1/models/res.company/1?fields=currency')).json;
  const rent = await call('POST', '/api/v1/models/account.move', {
    kind: 'entry',
    journal: journal.id,
    date: today,
    ref: 'Rent',
    currency: company.currency?.id ?? company.currency,
    lines: {
      create: [
        { account: overhead.id, debit: '200', credit: '0', name: 'Rent' },
        { account: accrued, debit: '0', credit: '200', name: 'Rent' },
      ],
    },
  });
  expect(rent.status, JSON.stringify(rent.json)).toBe(201);
  await ok(`/api/v1/models/account.move/${rent.json.id}/transitions/post`);
  const A = '/api/v1/models/production.overhead.allocation';
  const alloc = await call('POST', A, { month: today });
  expect(alloc.status, JSON.stringify(alloc.json)).toBe(201);
  expect(String(alloc.json.name)).toMatch(/^OVH\//);
  expect((await call('POST', `${A}/${alloc.json.id}/transitions/post`)).status).toBe(409); // not worked out
  await ok(`${A}/${alloc.json.id}/transitions/reckon`);
  const lines = await find(
    'production.overhead.allocation.line',
    { allocation: alloc.json.id },
    'account,actual,absorbed,difference',
  );
  expect(lines.map((l) => [Number(l.actual), Number(l.absorbed), Number(l.difference)])).toEqual([
    [200, 125, 75],
  ]);
  const shares = await find(
    'production.overhead.allocation.share',
    { allocation: alloc.json.id },
    'order,quantity,share,amount',
  );
  expect(shares.length).toBe(3);
  expect(shares.reduce((s, x) => s + Number(x.amount), 0)).toBe(75);
  const before = Number(
    (await call('GET', `/api/v1/models/product.product/${ids['Fixture']}`)).json.standardPrice,
  );
  await ok(`${A}/${alloc.json.id}/transitions/post`);
  const posted = (await call('GET', `${A}/${alloc.json.id}?fields=state,move`)).json;
  expect(posted.state).toBe('posted');
  expect(posted.move).not.toBeNull();
  expect(await balanceOf('5210')).toBe('0.00');
  const after = Number(
    (await call('GET', `/api/v1/models/product.product/${ids['Fixture']}`)).json.standardPrice,
  );
  expect(after).toBeGreaterThan(before);
  // The month is closed: a second allocation is refused.
  const again = await call('POST', A, { month: today });
  await ok(`${A}/${again.json.id}/transitions/reckon`);
  expect((await call('POST', `${A}/${again.json.id}/transitions/post`)).status).toBe(409);
});
