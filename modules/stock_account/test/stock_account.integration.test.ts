/**
 * The Stockroom ↔ Accounting bridge on real PostgreSQL (RFC 0021 step 3): installing both proposes it; receipts are
 * valued and posted to Inventory against Goods received not billed; deliveries at FIFO or average cost to Cost of
 * goods sold; a count's loss to Stock adjustments; internal moves post nothing; the stock's value at a date equals
 * the Inventory account's balance; nobody edits the valuation.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accounting } from '@kosh/accounting';
import { contacts } from '@kosh/contacts';
import { messaging } from '@kosh/messaging';
import { planApps } from '@kosh/modules-sdk';
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
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { stockAccount } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [base, settings, contacts, product, messaging, accounting, stock, stockAccount];
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
const find = async (model: string, filter: unknown, fields: string, as = 'maria') =>
  (
    await call(
      'GET',
      `/api/v1/models/${model}?filter=${encodeURIComponent(JSON.stringify(filter))}&fields=${fields}&order=id+asc&limit=500`,
      as,
    )
  ).json.items as Json[];
const run = async (url: string, as = 'maria') => {
  const res = await call('POST', url, as);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json;
};
/** A validated transfer of one product; its id. */
async function move(
  kind: 'receipt' | 'delivery' | 'internal' | 'production',
  name: string,
  quantity: string,
  places: { source: string; destination: string },
): Promise<number> {
  const made = await call('POST', T, 'maria', {
    kind,
    source: ids[places.source],
    destination: ids[places.destination],
    moves: { create: [{ product: ids[name], quantity }] },
  });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  await run(`${T}/${made.json.id}/transitions/confirm`);
  await run(`${T}/${made.json.id}/transitions/validate`);
  return made.json.id as number;
}
const receive = (name: string, quantity: string) =>
  move('receipt', name, quantity, { source: 'vendors', destination: 'stock' });
const deliver = (name: string, quantity: string) =>
  move('delivery', name, quantity, { source: 'stock', destination: 'customers' });
/** The entry lines of a transfer's valuation: [account code, debit, credit]. */
async function entryOf(picking: number): Promise<[string, string, string][]> {
  const layers = await find('stock.valuation.layer', { picking }, 'accountMove');
  const move = layers[0]?.accountMove;
  if (move === null || move === undefined) return [];
  const lines = await find('account.move.line', { move }, 'account,debit,credit');
  const codes = new Map(
    (await find('account.account', {}, 'code')).map((a: Json) => [a.id, a.code as string]),
  );
  const amount = (v: Json) => String(Number(v?.amount ?? v));
  return lines.map((l) => [codes.get(l.account) ?? '', amount(l.debit), amount(l.credit)]);
}

test('the plan proposes the bridge when Stockroom and Accounting come', () => {
  const plan = planApps(catalogue, [], { install: ['stock', 'accounting'] });
  expect(plan.install.find((i) => i.name === 'stock_account')).toEqual({
    name: 'stock_account',
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
  dir = await mkdtemp(join(tmpdir(), 'kosh-stock-account-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({
      driver,
      catalogue,
      change: { install: ['settings', 'accounting', 'stock'] },
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
    ['maria', ['account.manager', 'stock.manager', 'product.manager']],
    ['rahim', ['stock.user']],
  ] as const)
    await auth.createUser({
      login,
      name: login,
      password: PASSWORD,
      company,
      companies: [company],
      groups: [...groups],
    });
  const chart = await call('POST', '/api/v1/accounting/charts/install', 'maria', {
    template: 'generic',
  });
  expect(chart.status, JSON.stringify(chart.json)).toBe(200);
  for (const l of await find('stock.location', {}, 'usage,fullName'))
    ids[
      l.usage === 'internal'
        ? 'stock'
        : l.usage === 'vendor'
          ? 'vendors'
          : l.usage === 'customer'
            ? 'customers'
            : String(l.usage)
    ] = l.id;
  ids['shelf'] = (
    await call('POST', '/api/v1/models/stock.location', 'maria', {
      name: 'Shelf',
      parent: ids['stock'],
      warehouse: (await find('stock.warehouse', {}, 'id'))[0].id,
    })
  ).json.id;
  for (const [name, costMethod, standardPrice] of [
    ['Cement', 'fifo', '100'],
    ['Panel', 'average', '50'],
  ] as const)
    ids[name] = (
      await call('POST', '/api/v1/models/product.product', 'maria', {
        name,
        costMethod,
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

test('receipts: valued at cost, posted to Inventory against Goods received not billed', async () => {
  const first = await receive('Cement', '10');
  expect(await entryOf(first)).toEqual([
    ['1200', '1000', '0'],
    ['2150', '0', '1000'],
  ]);
  const [layer] = await find(
    'stock.valuation.layer',
    { picking: first },
    'quantity,unitCost,value',
  );
  expect(layer).toMatchObject({ quantity: '10', unitCost: '100', value: '1000' });
  const [entry] = await find('stock.valuation.layer', { picking: first }, 'accountMove');
  expect(
    (await call('GET', `/api/v1/models/account.move/${entry.accountMove}`, 'maria')).json.state,
  ).toBe('posted');
  // The next cement costs more.
  await call('PATCH', `/api/v1/models/product.product/${ids['Cement']}`, 'maria', {
    standardPrice: '130',
  });
  await receive('Cement', '10');
});

test('FIFO: a delivery takes the cost of the oldest receipts still in stock', async () => {
  const out = await deliver('Cement', '15');
  // 10 × 100 + 5 × 130.
  expect(await entryOf(out)).toEqual([
    ['5000', '1650', '0'],
    ['1200', '0', '1650'],
  ]);
  const left = await find(
    'stock.valuation.layer',
    { product: ids['Cement'], remainingQty: { gt: '0' } },
    'remainingQty,remainingValue',
  );
  expect(left.map((l) => [l.remainingQty, l.remainingValue])).toEqual([['5', '650']]);
});

test('average cost: deliveries at the average; a count loss to Stock adjustments', async () => {
  await receive('Panel', '4');
  const out = await deliver('Panel', '1');
  expect(await entryOf(out)).toEqual([
    ['5000', '50', '0'],
    ['1200', '0', '50'],
  ]);
  const C = '/api/v1/models/stock.count';
  const count = (await call('POST', C, 'maria', { location: ids['stock'] })).json.id as number;
  await run(`${C}/${count}/transitions/start`);
  const [line] = await find('stock.count.line', { count, product: ids['Panel'] }, 'id');
  await call('PATCH', `/api/v1/models/stock.count.line/${line.id}`, 'maria', { counted: '2' });
  await run(`${C}/${count}/transitions/apply`);
  const [loss] = await find('stock.picking', { count }, 'id');
  expect(await entryOf(loss.id)).toEqual([
    ['5100', '50', '0'],
    ['1200', '0', '50'],
  ]);
});

test('internal moves keep their value; the stock value equals the Inventory account', async () => {
  const internal = await move('internal', 'Cement', '2', { source: 'stock', destination: 'shelf' });
  expect(await find('stock.valuation.layer', { picking: internal }, 'id')).toHaveLength(0);
  const valuation = await call('GET', '/api/v1/stockroom/valuation', 'maria');
  expect(valuation.status, JSON.stringify(valuation.json)).toBe(200);
  const byProduct = new Map(
    (valuation.json.products as Json[]).map((p) => [p.product?.id ?? p.product, p]),
  );
  expect(byProduct.get(ids['Cement'])).toMatchObject({ quantity: '5', value: '650.00' });
  expect(byProduct.get(ids['Panel'])).toMatchObject({ quantity: '2', value: '100.00' });
  const [inventory] = await find('account.account', { code: '1200' }, 'id');
  const lines = await find('account.move.line', { account: inventory.id }, 'debit,credit');
  const balance = lines.reduce(
    (s, l) =>
      s
        .plus(orm.toDecimal(String(l.debit?.amount ?? l.debit)))
        .minus(orm.toDecimal(String(l.credit?.amount ?? l.credit))),
    orm.toDecimal(0),
  );
  expect(balance.toFixed(2)).toBe('750.00');
});

test('production: components into Work in progress, the product out of it', async () => {
  const consumed = await move('production', 'Panel', '1', {
    source: 'stock',
    destination: 'production',
  });
  expect(await entryOf(consumed)).toEqual([
    ['1250', '50', '0'],
    ['1200', '0', '50'],
  ]);
  const made = await move('production', 'Cement', '1', {
    source: 'production',
    destination: 'stock',
  });
  const [layer] = await find('stock.valuation.layer', { picking: made }, 'value');
  expect((await entryOf(made))[0]).toEqual(['1200', layer.value, '0']);
  expect((await entryOf(made))[1]).toEqual(['1250', '0', layer.value]);
});

test('scrap: a loss to Stock adjustments', async () => {
  const S = '/api/v1/models/stock.scrap';
  const made = await call('POST', S, 'maria', {
    product: ids['Panel'],
    quantity: '1',
    reason: 'defect',
  });
  expect((await call('POST', `${S}/${made.json.id}/transitions/validate`, 'maria')).status).toBe(
    200,
  );
  const scrap = (await call('GET', `${S}/${made.json.id}`, 'maria')).json;
  expect(await entryOf(scrap.picking)).toEqual([
    ['5100', '50', '0'],
    ['1200', '0', '50'],
  ]);
});

test('nobody edits the valuation; stock users do not read it', async () => {
  const [layer] = await find('stock.valuation.layer', {}, 'id');
  expect(
    (
      await call('PATCH', `/api/v1/models/stock.valuation.layer/${layer.id}`, 'maria', {
        value: '1',
      })
    ).status,
  ).toBe(403);
  expect((await call('GET', '/api/v1/models/stock.valuation.layer', 'rahim')).status).toBe(403);
});
