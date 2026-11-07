/**
 * Invoicing by what was delivered and down payments on real PostgreSQL (RFC 0028 step 3), with Sales, Stockroom
 * and Accounting.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accounting } from '@kosh/accounting';
import { contacts } from '@kosh/contacts';
import { messaging } from '@kosh/messaging';
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
  sales,
  stock,
  saleStock,
  accounting,
  saleAccount,
];
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

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off'; // the test drains the subscriber itself
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-sale-invoicing-'));
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
  for (const [login, groups] of [
    ['sumi', ['sale_stock.user', 'sale_account.user', 'product.manager', 'contacts.manager']],
    ['maria', ['account.manager', 'sales.manager']],
  ] as const)
    await auth.createUser({
      login,
      name: login,
      password: PASSWORD,
      company,
      companies: [company],
      groups: [...groups],
    });
  expect(
    (await call('POST', '/api/v1/accounting/charts/install', 'maria', { template: 'generic' }))
      .status,
  ).toBe(200);
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

const invoiceLines = async (order: number) => {
  const moves = await find('account.move', { saleOrder: order }, 'id');
  const out: Json[] = [];
  for (const m of moves)
    out.push(
      (
        await find(
          'account.move.line',
          { move: m.id, lineKind: 'product' },
          'name,quantity,priceUnit',
        )
      ).map((l: Json) => [l.name, l.quantity, l.priceUnit]),
    );
  return out;
};

test('invoiced as delivered: each invoice takes what was delivered and not invoiced; nothing more until more goes', async () => {
  const worker = saleStockWorker({ shutro: host.server.shutro });
  expect(
    (
      await call('PATCH', `/api/v1/models/product.product/${ids['Steel beam']}`, 'sumi', {
        invoicePolicy: 'delivered',
      })
    ).status,
  ).toBe(200);
  await receive('Steel beam', '10');
  const id = await order('sumi', [
    { product: ids['Steel beam'], name: 'Steel beam', quantity: '10', priceUnit: '1000' },
  ]);
  await worker.drain();
  // Nothing delivered yet: nothing to invoice.
  expect((await call('POST', `${O}/${id}/transitions/invoice`, 'sumi')).status).toBe(409);
  const [delivery] = await find('stock.picking', { saleOrder: id }, 'id');
  const [move] = await find('stock.move', { picking: delivery.id }, 'id');
  await call('PATCH', `/api/v1/models/stock.move/${move.id}`, 'sumi', { quantityDone: '4' });
  await run(`${T}/${delivery.id}/transitions/validate`);
  await run(`${O}/${id}/transitions/invoice`);
  expect(await invoiceLines(id)).toEqual([[['Steel beam', '4', '1000']]]);
  expect((await call('GET', `${O}/${id}?fields=invoiceState`, 'sumi')).json.invoiceState).toBe(
    'to_invoice',
  );
  const again = await call('POST', `${O}/${id}/transitions/invoice`, 'sumi');
  expect(again.status).toBe(409);
  expect(again.json.detail).toContain('Nothing to invoice now');
  // The rest goes: the second invoice takes the six.
  const [backorder] = await find('stock.picking', { saleOrder: id, status: { ne: 'done' } }, 'id');
  await run(`${T}/${backorder.id}/transitions/validate`);
  await run(`${O}/${id}/transitions/invoice`);
  expect((await invoiceLines(id))[1]).toEqual([['Steel beam', '6', '1000']]);
  expect((await call('GET', `${O}/${id}?fields=invoiceState`, 'sumi')).json.invoiceState).toBe(
    'invoiced',
  );
});

test('a down payment, invoiced on its own and deducted from the next invoice; never beyond the total', async () => {
  const id = await order('sumi', [
    { product: ids['Installation'], name: 'Installation', quantity: '4', priceUnit: '500' },
  ]);
  expect((await call('POST', `${O}/${id}/transitions/invoiceDownPayment`, 'sumi')).status).toBe(
    409,
  );
  await call('PATCH', `${O}/${id}`, 'sumi', { downPaymentPercent: '25' });
  await run(`${O}/${id}/transitions/invoiceDownPayment`);
  const after = (
    await call('GET', `${O}/${id}?fields=downPaymentPercent,downPaymentAmount`, 'sumi')
  ).json;
  expect(after).toMatchObject({ downPaymentPercent: null, downPaymentAmount: null });
  await call('PATCH', `${O}/${id}`, 'sumi', { downPaymentAmount: '1600' });
  expect((await call('POST', `${O}/${id}/transitions/invoiceDownPayment`, 'sumi')).status).toBe(
    422,
  );
  await call('PATCH', `${O}/${id}`, 'sumi', { downPaymentAmount: null });
  await run(`${O}/${id}/transitions/invoice`);
  const lines = await invoiceLines(id);
  expect(lines[0]).toEqual([[expect.stringContaining('Down payment on'), '1', '500']]);
  expect(lines[1]).toEqual([
    ['Installation', '4', '500'],
    [expect.stringContaining('Down payment deducted'), '1', '-500'],
  ]);
});
