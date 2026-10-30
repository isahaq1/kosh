/**
 * Stockroom on real PostgreSQL through the HTTP API (RFC 0021): every company's main warehouse; receipts in any unit
 * of the product's category, converted exactly; deliveries reserve what is available, say what each reservation is
 * for, and are validated only when everything is reserved, so stock never goes below zero; cancelling releases;
 * lines are fixed once confirmed; quantities are never edited by hand; the reservation setting; the demo data.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contacts } from '@kosh/contacts';
import { messaging } from '@kosh/messaging';
import { product } from '@kosh/product';
import {
  type AppHost,
  applyApps,
  base,
  createAppHost,
  installBase,
  installDefaults,
  installDemo,
  prepareApps,
  recordInstalledApps,
} from '@kosh/server';
import { type Driver, orm, pg } from '@kosh/server/orm';
import { settings } from '@kosh/settings';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { stock } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [base, settings, contacts, product, messaging, stock];
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
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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
const find = async (model: string, filter: unknown, fields: string, as = 'dina') =>
  (
    await call(
      'GET',
      `/api/v1/models/${model}?filter=${encodeURIComponent(JSON.stringify(filter))}&fields=${fields}`,
      as,
    )
  ).json.items as Json[];
const idOf = (v: Json) => (typeof v === 'object' && v !== null ? v.id : v);
const transfer = async (
  kind: 'receipt' | 'delivery',
  lines: readonly Record<string, unknown>[],
  extra: Record<string, unknown> = {},
) => {
  const res = await call('POST', T, 'rahim', {
    kind,
    source: kind === 'receipt' ? ids['vendors'] : ids['stock'],
    destination: kind === 'receipt' ? ids['stock'] : ids['customers'],
    moves: { create: lines },
    ...extra,
  });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return res.json.id as number;
};
const run = (id: number, transition: string, as = 'rahim') =>
  call('POST', `${T}/${id}/transitions/${transition}`, as);
const onHand = async (name: string) =>
  (await call('GET', `/api/v1/models/product.product/${ids[name]}`, 'dina')).json;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-stock-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({ driver, catalogue, change: { install: ['settings', 'stock'] }, dir }),
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
    ['dina', ['stock.manager', 'product.manager']],
    ['rahim', ['stock.user']],
    ['bob', ['base.user']],
  ] as const)
    await auth.createUser({
      login,
      name: login,
      password: PASSWORD,
      company,
      companies: [company],
      groups: [...groups],
    });
  for (const l of await find('stock.location', {}, 'fullName,usage'))
    ids[
      l.usage === 'internal'
        ? 'stock'
        : String(
            l.usage === 'vendor' ? 'vendors' : l.usage === 'customer' ? 'customers' : 'adjustment',
          )
    ] = l.id;
  for (const u of await find('uom.uom', {}, 'name')) ids[u.name] = u.id;
  for (const [name, uom, kind] of [
    ['LED panel', 'Units', 'goods'],
    ['Rebar', 'kg', 'goods'],
    ['Installation', 'Hours', 'service'],
  ] as const)
    ids[name] = (
      await call('POST', '/api/v1/models/product.product', 'dina', { name, uom: ids[uom], kind })
    ).json.id;
}, 240_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('every company has its main warehouse and stock location; the shared locations', async () => {
  const [wh] = await find('stock.warehouse', {}, 'name,code');
  expect(wh).toMatchObject({ name: 'Main warehouse', code: 'WH' });
  expect((await find('stock.location', { usage: 'internal' }, 'fullName'))[0].fullName).toBe(
    'WH/Stock',
  );
  const shelf = await call('POST', '/api/v1/models/stock.location', 'dina', {
    name: 'Shelf A',
    parent: ids['stock'],
    warehouse: wh.id,
  });
  expect(shelf.status, JSON.stringify(shelf.json)).toBe(201);
  expect(
    (await call('GET', `/api/v1/models/stock.location/${shelf.json.id}`, 'dina')).json.fullName,
  ).toBe('WH/Stock/Shelf A');
  ids['shelf'] = shelf.json.id;
  expect(ids['vendors']).toBeDefined();
  expect(ids['customers']).toBeDefined();
});

test('receipts in any unit of the category, converted exactly; services and other categories refused', async () => {
  const receipt = await transfer('receipt', [
    { product: ids['LED panel'], quantity: '2', uom: ids['Dozens'] },
  ]);
  expect((await call('GET', `${T}/${receipt}`, 'rahim')).json.status).toBe('draft');
  expect((await run(receipt, 'confirm')).status).toBe(200);
  expect((await call('GET', `${T}/${receipt}`, 'rahim')).json.status).toBe('ready');
  expect((await run(receipt, 'validate')).status).toBe(200);
  const read = (await call('GET', `${T}/${receipt}`, 'rahim')).json;
  expect(read.status).toBe('done');
  expect(read.doneDate).toBeTruthy();
  expect(Number((await onHand('LED panel')).qtyOnHand)).toBe(24);

  const wrong = await call('POST', T, 'rahim', {
    kind: 'receipt',
    source: ids['vendors'],
    destination: ids['stock'],
    moves: { create: [{ product: ids['LED panel'], quantity: '1', uom: ids['kg'] }] },
  });
  expect(wrong.status).toBe(422);
  const service = await call('POST', T, 'rahim', {
    kind: 'receipt',
    source: ids['vendors'],
    destination: ids['stock'],
    moves: { create: [{ product: ids['Installation'], quantity: '1' }] },
  });
  expect(service.status).toBe(422);
  // Grams of a product kept in kg.
  const rebar = await transfer('receipt', [
    { product: ids['Rebar'], quantity: '1500', uom: ids['g'] },
  ]);
  await run(rebar, 'confirm');
  await run(rebar, 'validate');
  expect(Number((await onHand('Rebar')).qtyOnHand)).toBe(1.5);
});

test('a delivery reserves what is available, says for what, and waits; never below zero', async () => {
  const delivery = await transfer('delivery', [{ product: ids['LED panel'], quantity: '30' }], {
    origin: 'SO/2026/00017',
  });
  expect((await run(delivery, 'confirm')).status).toBe(200);
  const waiting = (await call('GET', `${T}/${delivery}`, 'rahim')).json;
  expect(waiting.status).toBe('waiting');
  expect(waiting.availability).toBe('partial');
  const [held] = await find('stock.reservation', {}, 'label,quantity', 'rahim');
  expect(held.label).toBe(`24 Units reserved for ${waiting.name} (SO/2026/00017)`);
  expect(Number((await onHand('LED panel')).qtyAvailable)).toBe(0);
  expect(Number((await onHand('LED panel')).qtyReserved)).toBe(24);
  const refused = await run(delivery, 'validate');
  expect(refused.status).toBe(409);
  expect(JSON.stringify(refused.json)).toContain('Not everything done is reserved');

  // Lines are fixed once confirmed.
  const [line] = await find('stock.move', { picking: delivery }, 'id', 'rahim');
  expect(
    (await call('PATCH', `/api/v1/models/stock.move/${line.id}`, 'rahim', { quantity: '5' }))
      .status,
  ).toBe(422);

  // Ten more come in, onto a shelf inside the stock location: Check availability finds them there.
  const more = await transfer('receipt', [{ product: ids['LED panel'], quantity: '10' }], {
    destination: ids['shelf'],
  });
  await run(more, 'confirm');
  await run(more, 'validate');
  expect((await run(delivery, 'reserve')).status).toBe(200);
  expect((await call('GET', `${T}/${delivery}`, 'rahim')).json.status).toBe('ready');
  expect((await run(delivery, 'validate')).status).toBe(200);
  const after = await onHand('LED panel');
  expect(Number(after.qtyOnHand)).toBe(4);
  expect(Number(after.qtyReserved)).toBe(0);
  expect(await find('stock.reservation', {}, 'id', 'rahim')).toHaveLength(0);
});

test('two deliveries compete: the first holds the stock; cancelling releases it', async () => {
  const first = await transfer('delivery', [{ product: ids['LED panel'], quantity: '4' }]);
  const second = await transfer('delivery', [{ product: ids['LED panel'], quantity: '4' }]);
  await run(first, 'confirm');
  await run(second, 'confirm');
  expect((await call('GET', `${T}/${first}`, 'rahim')).json.status).toBe('ready');
  expect((await call('GET', `${T}/${second}`, 'rahim')).json.availability).toBe('none');
  expect((await run(first, 'cancel')).status).toBe(200);
  await run(second, 'reserve');
  expect((await call('GET', `${T}/${second}`, 'rahim')).json.status).toBe('ready');
  await run(second, 'validate');
  expect(Number((await onHand('LED panel')).qtyOnHand)).toBe(0);
});

test('quantities are never edited by hand; access by role', async () => {
  const [quant] = await find('stock.quant', { product: ids['Rebar'] }, 'id,quantity');
  expect(
    (await call('PATCH', `/api/v1/models/stock.quant/${quant.id}`, 'dina', { quantity: '99' }))
      .status,
  ).toBe(403);
  expect(
    (
      await call('POST', '/api/v1/models/stock.quant', 'dina', {
        product: ids['Rebar'],
        location: ids['shelf'],
        quantity: '5',
      })
    ).status,
  ).toBe(403);
  expect(
    (await call('POST', '/api/v1/models/stock.warehouse', 'rahim', { name: 'X', code: 'X' }))
      .status,
  ).toBe(403);
  expect((await call('GET', T, 'bob')).status).toBe(403);
});

test('partial validation: what is done moves, the rest goes to a confirmed backorder', async () => {
  // Ten ordered from the vendor, six arrive.
  const receipt = await transfer('receipt', [{ product: ids['LED panel'], quantity: '10' }], {
    origin: 'PO/2026/00003',
  });
  await run(receipt, 'confirm');
  const [line] = await find('stock.move', { picking: receipt }, 'id', 'rahim');
  expect(
    (await call('PATCH', `/api/v1/models/stock.move/${line.id}`, 'rahim', { quantityDone: '6' }))
      .status,
  ).toBe(200);
  expect((await run(receipt, 'validate')).status).toBe(200);
  expect(Number((await onHand('LED panel')).qtyOnHand)).toBe(6);
  const [backorder] = await find(
    'stock.picking',
    { backorderOf: receipt },
    'name,kind,status,origin,source,destination',
    'rahim',
  );
  expect(backorder).toMatchObject({
    kind: 'receipt',
    status: 'ready',
    origin: 'PO/2026/00003',
    source: ids['vendors'],
    destination: ids['stock'],
  });
  const [rest] = await find('stock.move', { picking: backorder.id }, 'product,quantity', 'rahim');
  expect(rest).toMatchObject({ product: ids['LED panel'], quantity: '4' });
  const [done] = await find('stock.move', { picking: receipt }, 'quantity,quantityDone', 'rahim');
  expect(done).toMatchObject({ quantity: '10', quantityDone: '6' });

  // A delivery of five with only six on hand: done 2 of what is reserved; the rest waits, reserved again.
  const delivery = await transfer('delivery', [{ product: ids['LED panel'], quantity: '5' }]);
  await run(delivery, 'confirm');
  const [out] = await find('stock.move', { picking: delivery }, 'id', 'rahim');
  await call('PATCH', `/api/v1/models/stock.move/${out.id}`, 'rahim', { quantityDone: '7' });
  expect((await run(delivery, 'validate')).status).toBe(409); // more than is reserved
  await call('PATCH', `/api/v1/models/stock.move/${out.id}`, 'rahim', { quantityDone: '2' });
  expect((await run(delivery, 'validate')).status).toBe(200);
  const [left] = await find('stock.picking', { backorderOf: delivery }, 'status', 'rahim');
  expect(left.status).toBe('ready'); // 3 of the 4 left are reserved again
  const panel = await onHand('LED panel');
  expect(Number(panel.qtyOnHand)).toBe(4);
  expect(Number(panel.qtyReserved)).toBe(3);
  // A negative done quantity, and nothing done, are refused.
  expect(
    (await call('PATCH', `/api/v1/models/stock.move/${out.id}`, 'rahim', { quantityDone: '-1' }))
      .status,
  ).toBe(422);
  const nothing = await transfer('delivery', [{ product: ids['LED panel'], quantity: '1' }]);
  await run(nothing, 'confirm');
  const [zero] = await find('stock.move', { picking: nothing }, 'id', 'rahim');
  await call('PATCH', `/api/v1/models/stock.move/${zero.id}`, 'rahim', { quantityDone: '0' });
  expect((await run(nothing, 'validate')).status).toBe(409);
  await run(nothing, 'cancel');
  await run(left.id, 'cancel');
});

test('a count: listed with what is expected, scanned from a phone, applied by a manager', async () => {
  const C = '/api/v1/models/stock.count';
  for (const [name, barcode] of [
    ['Cement', '8901'],
    ['Sand', '8902'],
  ] as const)
    ids[name] = (
      await call('POST', '/api/v1/models/product.product', 'dina', {
        name,
        barcode,
        uom: ids['Units'],
      })
    ).json.id;
  const receipt = await transfer('receipt', [{ product: ids['Cement'], quantity: '10' }]);
  await run(receipt, 'confirm');
  await run(receipt, 'validate');

  const count = await call('POST', C, 'rahim', { location: ids['stock'] });
  expect(count.status, JSON.stringify(count.json)).toBe(201);
  const id = count.json.id as number;
  const scan = (barcode: string, quantity?: string) =>
    call('POST', `/api/v1/stockroom/counts/${id}/scan`, 'rahim', {
      barcode,
      ...(quantity === undefined ? {} : { quantity }),
    });
  expect((await scan('8901')).status).toBe(409); // not started
  const started = await call('POST', `${C}/${id}/transitions/start`, 'rahim');
  expect(started.status, JSON.stringify(started.json)).toBe(200);
  const [cement] = await find(
    'stock.count.line',
    { count: id, product: ids['Cement'] },
    'expected,counted',
    'rahim',
  );
  expect(cement).toMatchObject({ expected: '10', counted: null });

  // Seven cement bags counted, then one more; three bags of sand nobody expected; an unknown barcode.
  expect((await scan('8901', '7')).json).toEqual({ product: 'Cement', counted: '7' });
  expect((await scan('8901')).json.counted).toBe('8');
  expect((await scan('8902', '3')).json.counted).toBe('3');
  expect((await scan('0000')).status).toBe(404);
  expect((await scan('8901', '-2')).status).toBe(400);
  const lines = await find(
    'stock.count.line',
    { count: id, counted: { ne: null } },
    'product,expected,counted,difference',
    'rahim',
  );
  expect(lines.map((l) => [l.product, l.difference])).toEqual([
    [ids['Cement'], '-2'],
    [ids['Sand'], '3'],
  ]);

  // Counters count; managers apply.
  expect((await call('POST', `${C}/${id}/transitions/apply`, 'rahim')).status).toBe(403);
  const applied = await call('POST', `${C}/${id}/transitions/apply`, 'dina');
  expect(applied.status, JSON.stringify(applied.json)).toBe(200);
  expect(Number((await onHand('Cement')).qtyOnHand)).toBe(8);
  expect(Number((await onHand('Sand')).qtyOnHand)).toBe(3);
  const adjustments = await find(
    'stock.picking',
    { count: id },
    'kind,state,source,destination',
    'dina',
  );
  expect(adjustments).toHaveLength(2);
  expect(adjustments.every((a) => a.kind === 'adjustment' && a.state === 'done')).toBe(true);
  // Untouched products (not counted) stay as they were.
  expect(Number((await onHand('Rebar')).qtyOnHand)).toBe(1.5);
});

test('a count does not take what is reserved for a delivery: the reservation is named', async () => {
  const C = '/api/v1/models/stock.count';
  const delivery = await transfer('delivery', [{ product: ids['Cement'], quantity: '8' }], {
    origin: 'SO/2026/00099',
  });
  await run(delivery, 'confirm');
  const id = (await call('POST', C, 'dina', { location: ids['stock'] })).json.id as number;
  await call('POST', `${C}/${id}/transitions/start`, 'dina');
  await call('POST', `/api/v1/stockroom/counts/${id}/scan`, 'dina', {
    barcode: '8901',
    quantity: '5',
  });
  const refused = await call('POST', `${C}/${id}/transitions/apply`, 'dina');
  expect(refused.status).toBe(422);
  expect(JSON.stringify(refused.json)).toContain('reserved for');
  expect(JSON.stringify(refused.json)).toContain('SO/2026/00099');
  expect(Number((await onHand('Cement')).qtyOnHand)).toBe(8); // nothing changed
  await run(delivery, 'cancel');
  expect((await call('POST', `${C}/${id}/transitions/apply`, 'dina')).status).toBe(200);
  expect(Number((await onHand('Cement')).qtyOnHand)).toBe(5);
});

test('the setting: reserve only with Check availability', async () => {
  expect(
    (
      await call('PATCH', '/api/v1/settings/app-settings/stock/reservations', 'dina', {
        values: { reserveOnConfirm: false },
      })
    ).status,
  ).toBe(200);
  const delivery = await transfer('delivery', [{ product: ids['Rebar'], quantity: '1' }]);
  await run(delivery, 'confirm');
  expect((await call('GET', `${T}/${delivery}`, 'rahim')).json.availability).toBe('none');
  await run(delivery, 'reserve');
  expect((await call('GET', `${T}/${delivery}`, 'rahim')).json.status).toBe('ready');
  await call('PATCH', '/api/v1/settings/app-settings/stock/reservations', 'dina', {
    values: { reserveOnConfirm: true },
  });
});

test('the demo data loads', async () => {
  const auth = host.server.auth;
  if (auth === undefined) throw new Error('base is installed');
  const summary = await installDemo({
    shutro: host.server.shutro,
    auth,
    driver,
    modules: host.server.registry.loaded.modules,
    company,
  });
  expect(JSON.stringify(summary)).toContain('Stockroom');
  expect(idOf).toBeDefined();
});
