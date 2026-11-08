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

test('a dropshipped order: never valued in stock, its bill keeps the purchases account', async () => {
  const made = await call('POST', O, 'maria', {
    partner: ids['vendor'],
    currency: ids['bdt'],
    dropship: true,
    lines: {
      create: [{ product: ids['Cement'], name: 'Cement', quantity: '4', priceUnit: '110' }],
    },
  });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  const order = made.json.id as number;
  await run(`${O}/${order}/transitions/submit`);
  await run(`${O}/${order}/transitions/confirm`);
  await run(`${O}/${order}/transitions/bill`);
  const [bill] = await find('account.move', { purchaseOrder: order }, 'id');
  await call('PATCH', `/api/v1/models/account.move/${bill.id}`, 'maria', {
    date: new Date().toISOString().slice(0, 10),
  });
  const posted = await call(
    'POST',
    `/api/v1/models/account.move/${bill.id}/transitions/post`,
    'maria',
  );
  expect(posted.status, JSON.stringify(posted.json)).toBe(200);
  const [line] = await find('account.move.line', { move: bill.id, lineKind: 'product' }, 'account');
  const [interim] = await find('account.account', { code: '2150' }, 'id');
  expect(line.account?.id ?? line.account).not.toBe(interim.id);
  expect(await balanceOf('2150')).toBe('0.00');
});

test('billed as received: the bill takes what came in; the three-way check flags billing beyond it (RFC 0028)', async () => {
  const bolt = await call('POST', '/api/v1/models/product.product', 'maria', {
    name: 'Bolt',
    kind: 'goods',
    uom: ids['Units'],
    invoicePolicy: 'delivered',
  });
  expect(bolt.status, JSON.stringify(bolt.json)).toBe(201);
  const made = await call('POST', O, 'maria', {
    partner: ids['vendor'],
    currency: ids['bdt'],
    lines: { create: [{ product: bolt.json.id, name: 'Bolt', quantity: '10', priceUnit: '5' }] },
  });
  const order = made.json.id as number;
  await run(`${O}/${order}/transitions/submit`);
  await run(`${O}/${order}/transitions/confirm`);
  await purchaseStockWorker({ shutro: host.server.shutro }).drain();
  // Nothing received: nothing to bill.
  expect((await call('POST', `${O}/${order}/transitions/bill`, 'maria')).status).toBe(409);
  const [receipt] = await find('stock.picking', { purchaseOrder: order }, 'id');
  const [move] = await find('stock.move', { picking: receipt.id }, 'id');
  await call('PATCH', `/api/v1/models/stock.move/${move.id}`, 'maria', { quantityDone: '4' });
  await run(`/api/v1/models/stock.picking/${receipt.id}/transitions/validate`);
  await run(`${O}/${order}/transitions/bill`);
  const [bill] = await find('account.move', { purchaseOrder: order }, 'id');
  const [line] = await find(
    'account.move.line',
    { move: bill.id, lineKind: 'product' },
    'id,quantity,matchNote',
  );
  expect(line).toMatchObject({ quantity: '4', matchNote: 'ordered 10, received 4, billed 4' });
  const again = await call('POST', `${O}/${order}/transitions/bill`, 'maria');
  expect(again.status).toBe(409);
  expect(again.json.detail).toContain('Nothing to bill now');
  // The vendor bills six: the check says it is more than was received.
  await call('PATCH', `/api/v1/models/account.move.line/${line.id}`, 'maria', { quantity: '6' });
  const [checked] = await find('account.move.line', { id: line.id }, 'matchNote');
  expect(checked.matchNote).toBe('ordered 10, received 4, billed 6 — more than received');
});

test('returns: part of a receipt goes back to the vendor at its own cost, linked, with a reason; never more than came in', async () => {
  const worker = purchaseStockWorker({ shutro: host.server.shutro });
  const receive = async (quantity: string, price: string) => {
    const made = await call('POST', O, 'maria', {
      partner: ids['vendor'],
      currency: ids['bdt'],
      lines: { create: [{ product: ids['Panel'], name: 'Panel', quantity, priceUnit: price }] },
    });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    await run(`${O}/${made.json.id}/transitions/submit`);
    await run(`${O}/${made.json.id}/transitions/confirm`);
    expect(await worker.drain()).toBe(1);
    const [receipt] = await find('stock.picking', { purchaseOrder: made.json.id }, 'id,name');
    await run(`/api/v1/models/stock.picking/${receipt.id}/transitions/validate`);
    return { order: made.json.id as number, receipt };
  };
  const first = await receive('10', '300');
  await receive('10', '500'); // the average cost moves on

  const returnable = await call(
    'GET',
    `/api/v1/stockroom/pickings/${first.receipt.id}/returnable`,
    'maria',
  );
  expect(returnable.status, JSON.stringify(returnable.json)).toBe(200);
  const [line] = returnable.json.lines;
  expect(line).toMatchObject({ done: '10', returned: '0', returnable: '10' });
  const [damaged] = await find('stock.return.reason', { code: 'damaged' }, 'id,name');
  expect(damaged.name).toBe('Damaged');
  const R = `/api/v1/stockroom/pickings/${first.receipt.id}/return`;
  expect(
    (await call('POST', R, 'maria', { lines: [{ move: line.move, quantity: '3' }] })).status,
  ).toBe(400); // a reason is required
  expect(
    (
      await call('POST', R, 'maria', {
        lines: [{ move: line.move, quantity: '11' }],
        reason: damaged.id,
      })
    ).status,
  ).toBe(409);
  const made = await call('POST', R, 'maria', {
    lines: [{ move: line.move, quantity: '3' }],
    reason: damaged.id,
    note: 'Cracked glass',
  });
  expect(made.status, JSON.stringify(made.json)).toBe(200);
  const [back] = await find(
    'stock.picking',
    { id: made.json.picking },
    'kind,state,returnOf,returnReason,origin,purchaseOrder',
  );
  expect(back).toMatchObject({ kind: 'delivery', state: 'confirmed' });
  expect(back.returnOf?.id ?? back.returnOf).toBe(first.receipt.id);
  expect(back.purchaseOrder?.id ?? back.purchaseOrder).toBe(first.order);
  expect(back.origin).toBe(`Return of ${first.receipt.name}`);
  // What is being returned counts: only 7 can still go back.
  const after = await call(
    'GET',
    `/api/v1/stockroom/pickings/${first.receipt.id}/returnable`,
    'maria',
  );
  expect(after.json.lines[0]).toMatchObject({ returned: '3', returnable: '7' });

  await run(`/api/v1/models/stock.picking/${back.id}/transitions/validate`);
  // Valued at the receipt's 300, not the average 400.
  const [layer] = await find('stock.valuation.layer', { picking: back.id }, 'unitCost,value');
  expect([Number(layer.unitCost), Number(layer.value)]).toEqual([300, -900]);
  // The order line received 10 and returned 3: 7 received, 3 returned.
  const [orderLine] = await find(
    'purchase.order.line',
    { order: first.order },
    'qtyReceived,qtyReturned,qtyBilled',
  );
  expect([Number(orderLine.qtyReceived), Number(orderLine.qtyReturned)]).toEqual([7, 3]);
  // Nothing billed yet: nothing to refund.
  expect((await call('POST', `${O}/${first.order}/transitions/refund`, 'maria')).status).toBe(409);
  // Billed as ordered (10), the 3 that went back are refunded once, at the order's price.
  await run(`${O}/${first.order}/transitions/bill`);
  await run(`${O}/${first.order}/transitions/refund`);
  const [refund] = await find(
    'account.move',
    { purchaseOrder: first.order, kind: 'in_refund' },
    'id,state',
  );
  const [refundLine] = await find(
    'account.move.line',
    { move: refund.id, lineKind: 'product' },
    'quantity,priceUnit,name',
  );
  expect([Number(refundLine.quantity), Number(refundLine.priceUnit)]).toEqual([3, 300]);
  expect(refundLine.name).toContain('(returned)');
  const [billed] = await find('purchase.order.line', { order: first.order }, 'qtyBilled');
  expect(Number(billed.qtyBilled)).toBe(7);
  expect((await call('POST', `${O}/${first.order}/transitions/refund`, 'maria')).status).toBe(409);
  // Buyers without Stockroom rights do not return goods.
  await host.server.auth?.createUser({
    login: 'pat',
    name: 'Pat',
    password: PASSWORD,
    company,
    companies: [company],
    groups: ['purchase.user'],
  });
  expect(
    (
      await call('POST', R, 'pat', {
        lines: [{ move: line.move, quantity: '1' }],
        reason: damaged.id,
      })
    ).status,
  ).toBe(403);
  // An unknown transfer cannot be returned.
  expect(
    (await call('GET', `/api/v1/stockroom/pickings/${back.id + 1000}/returnable`, 'maria')).status,
  ).toBe(404);
});

test('landed costs: split by quantity, previewed, posted once — on hand to stock and its average cost, sold to cost of sales', async () => {
  const product = async (name: string, extra: Record<string, unknown> = {}) =>
    (
      await call('POST', '/api/v1/models/product.product', 'maria', {
        name,
        uom: ids['Units'],
        ...extra,
      })
    ).json.id as number;
  const rice = await product('Rice');
  const beans = await product('Beans');
  const freight = await product('Freight', {
    kind: 'service',
    landedCost: true,
    landedSplit: 'quantity',
  });
  const made = await call('POST', O, 'maria', {
    partner: ids['vendor'],
    currency: ids['bdt'],
    lines: {
      create: [
        { product: rice, name: 'Rice', quantity: '10', priceUnit: '100' },
        { product: beans, name: 'Beans', quantity: '30', priceUnit: '100' },
      ],
    },
  });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  await run(`${O}/${made.json.id}/transitions/submit`);
  await run(`${O}/${made.json.id}/transitions/confirm`);
  expect(await purchaseStockWorker({ shutro: host.server.shutro }).drain()).toBe(1);
  const [receipt] = await find(
    'stock.picking',
    { purchaseOrder: made.json.id },
    'id,source,destination',
  );
  await run(`/api/v1/models/stock.picking/${receipt.id}/transitions/validate`);
  // Half the rice is sold before the freight is known.
  const [customers] = await find('stock.location', { usage: 'customer' }, 'id');
  const out = await call('POST', '/api/v1/models/stock.picking', 'maria', {
    kind: 'delivery',
    source: receipt.destination?.id ?? receipt.destination,
    destination: customers.id,
    moves: { create: [{ product: rice, quantity: '5' }] },
  });
  await run(`/api/v1/models/stock.picking/${out.json.id}/transitions/confirm`);
  await run(`/api/v1/models/stock.picking/${out.json.id}/transitions/validate`);

  const L = '/api/v1/models/stock.landed.cost';
  const cost = await call('POST', L, 'maria', {
    company,
    pickings: { set: [receipt.id] },
    lines: {
      create: [{ product: freight, name: 'Sea freight', amount: '400', split: 'quantity' }],
    },
  });
  expect(cost.status, JSON.stringify(cost.json)).toBe(201);
  const preview = await call(
    'GET',
    `/api/v1/stockroom/landed-costs/${cost.json.id}/preview`,
    'maria',
  );
  expect(preview.status, JSON.stringify(preview.json)).toBe(200);
  expect(preview.json.lines.map((l: Json) => [l.product, l.added, l.toStock, l.toCogs])).toEqual([
    ['Rice', '100.00', '50.00', '50.00'],
    ['Beans', '300.00', '300.00', '0.00'],
  ]);
  // Stock users prepare landed costs; posting them takes Accounting.
  await host.server.auth?.createUser({
    login: 'sam',
    name: 'Sam',
    password: PASSWORD,
    company,
    companies: [company],
    groups: ['stock_account.user'],
  });
  expect((await call('POST', `${L}/${cost.json.id}/transitions/post`, 'sam')).status).toBe(403);
  const before = { stock: await balanceOf('1200'), cogs: await balanceOf('5000') };
  await run(`${L}/${cost.json.id}/transitions/post`);
  expect(
    orm
      .toDecimal(await balanceOf('1200'))
      .minus(before.stock)
      .toFixed(2),
  ).toBe('350.00');
  expect(
    orm
      .toDecimal(await balanceOf('5000'))
      .minus(before.cogs)
      .toFixed(2),
  ).toBe('50.00');
  const prices = await find('product.product', { id: { in: [rice, beans] } }, 'standardPrice');
  expect(prices.map((p) => Number(p.standardPrice))).toEqual([110, 110]);
  // Posted once.
  expect((await call('POST', `${L}/${cost.json.id}/transitions/post`, 'maria')).status).toBe(409);

  // From a vendor bill's freight line: a draft with its amount.
  const [journal] = await find('account.journal', { type: 'purchase' }, 'id');
  const bill = await call('POST', '/api/v1/models/account.move', 'maria', {
    kind: 'in_invoice',
    journal: journal.id,
    partner: ids['vendor'],
    currency: ids['bdt'],
    date: new Date().toISOString().slice(0, 10),
    lines: {
      create: [
        { lineKind: 'product', product: freight, name: 'Freight', quantity: '1', priceUnit: '250' },
      ],
    },
  });
  expect(bill.status, JSON.stringify(bill.json)).toBe(201);
  const drafted = await call(
    'POST',
    `/api/v1/stockroom/landed-costs/from-bill/${bill.json.id}`,
    'maria',
  );
  expect(drafted.status, JSON.stringify(drafted.json)).toBe(200);
  const [line] = await find('stock.landed.cost.line', { cost: drafted.json.id }, 'amount,split');
  expect([Number(line.amount), line.split]).toEqual([250, 'quantity']);
});
