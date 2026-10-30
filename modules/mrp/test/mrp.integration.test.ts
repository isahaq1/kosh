/**
 * Production on real PostgreSQL through the HTTP API (RFC 0021): the bill of materials valid on an order's date
 * (versions with effective dates); an order lists what is required, available and short, and what it costs
 * (materials and operations), before it starts; Confirm reserves the components through Stockroom; Produce waits
 * for them, then consumes them and puts the product in stock; cancelling releases; the checks; access; the demo.
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
import { stock } from '@kosh/stock';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { mrp } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [base, settings, contacts, product, messaging, stock, mrp];
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
      `/api/v1/models/${model}?filter=${encodeURIComponent(JSON.stringify(filter))}&fields=${fields}&order=id+asc`,
      as,
    )
  ).json.items as Json[];
const run = (id: number, transition: string, as = 'rahim') =>
  call('POST', `${P}/${id}/transitions/${transition}`, as);
async function receive(name: string, quantity: string): Promise<void> {
  const made = await call('POST', T, 'maria', {
    kind: 'receipt',
    source: ids['vendors'],
    destination: ids['stock'],
    moves: { create: [{ product: ids[name], quantity }] },
  });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  await call('POST', `${T}/${made.json.id}/transitions/confirm`, 'maria');
  expect((await call('POST', `${T}/${made.json.id}/transitions/validate`, 'maria')).status).toBe(
    200,
  );
}
const onHand = async (name: string) =>
  Number(
    (await call('GET', `/api/v1/models/product.product/${ids[name]}`, 'maria')).json.qtyOnHand,
  );

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-mrp-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({ driver, catalogue, change: { install: ['settings', 'mrp'] }, dir }),
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
    ['maria', ['mrp.manager', 'stock.manager', 'product.manager']],
    ['rahim', ['mrp.user']],
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
      await call('POST', '/api/v1/models/product.product', 'maria', {
        name,
        uom: ids[uom],
        standardPrice,
      })
    ).json.id;
  ids['assembly'] = (
    await call('POST', '/api/v1/models/mrp.workcenter', 'maria', {
      name: 'Assembly',
      costPerHour: '600',
    })
  ).json.id;
  for (const [version, cable, validFrom] of [
    ['v1', '3', null],
    ['v2', '2', '2026-12-01'],
  ] as const) {
    const bom = await call('POST', '/api/v1/models/mrp.bom', 'maria', {
      product: ids['Fixture'],
      version,
      validFrom,
      lines: {
        create: [
          { product: ids['Panel'], quantity: '1' },
          { product: ids['Cable'], quantity: cable, uom: ids['m'] },
        ],
      },
      operations: {
        create: [{ name: 'Assemble', workcenter: ids['assembly'], minutes: '20' }],
      },
    });
    expect(bom.status, JSON.stringify(bom.json)).toBe(201);
    ids[version] = bom.json.id;
  }
}, 240_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('the bill valid on the order’s date: a new version from its first day', async () => {
  const proposed = async (date: string) =>
    (
      await call('POST', `${P}/onchange`, 'rahim', {
        values: { product: ids['Fixture'], date },
        changed: ['product'],
      })
    ).json.values.bom;
  expect(await proposed('2026-11-15')).toBe(ids['v1']);
  expect(await proposed('2026-12-05')).toBe(ids['v2']);
});

test('what is short and what it costs, before it starts; then made through Stockroom', async () => {
  const made = await call('POST', P, 'rahim', {
    product: ids['Fixture'],
    quantity: '5',
    bom: ids['v1'],
    date: '2026-11-15',
  });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  const id = made.json.id as number;
  expect((await run(id, 'check')).status).toBe(200);
  const needs = await find(
    'mrp.production.component',
    { production: id },
    'product,required,available,short,cost',
    'rahim',
  );
  expect(needs.map((n) => [n.product, n.required, n.available, n.short, n.cost])).toEqual([
    [ids['Panel'], '5', '0', '5', '500'],
    [ids['Cable'], '15', '0', '15', '150'],
  ]);
  const order = (await call('GET', `${P}/${id}`, 'rahim')).json;
  // 650 of materials; 5 × 20 minutes at 600 an hour = 1,000; 1,650 for 5.
  expect(order).toMatchObject({
    materialCost: '650',
    operationCost: '1000',
    totalCost: '1650',
    unitCost: '330',
    status: 'draft',
  });

  await receive('Panel', '3');
  await receive('Cable', '20');
  expect((await run(id, 'confirm')).status).toBe(200);
  const confirmed = (await call('GET', `${P}/${id}`, 'rahim')).json;
  expect(confirmed.status).toBe('waiting');
  const consumption = (await call('GET', `${T}/${confirmed.consumption}`, 'maria')).json;
  expect(consumption).toMatchObject({ kind: 'production', availability: 'partial' });
  const short = await run(id, 'produce');
  expect(short.status).toBe(409);
  expect(JSON.stringify(short.json)).toContain('Components are short');

  await receive('Panel', '2');
  expect((await run(id, 'reserve')).status).toBe(200);
  expect((await call('GET', `${P}/${id}`, 'rahim')).json.status).toBe('ready');
  const produced = await run(id, 'produce');
  expect(produced.status, JSON.stringify(produced.json)).toBe(200);
  const done = (await call('GET', `${P}/${id}`, 'rahim')).json;
  expect(done.status).toBe('done');
  expect((await call('GET', `${T}/${done.output}`, 'maria')).json).toMatchObject({
    kind: 'production',
    state: 'done',
  });
  expect(await onHand('Fixture')).toBe(5);
  expect(await onHand('Panel')).toBe(0);
  expect(await onHand('Cable')).toBe(5);
});

test('cancelling a confirmed order releases its components', async () => {
  await receive('Panel', '1');
  const id = (
    await call('POST', P, 'rahim', { product: ids['Fixture'], quantity: '1', bom: ids['v1'] })
  ).json.id as number;
  await run(id, 'confirm');
  const panel = async () =>
    (await call('GET', `/api/v1/models/product.product/${ids['Panel']}`, 'maria')).json;
  expect(Number((await panel()).qtyReserved)).toBe(1);
  expect((await run(id, 'cancel')).status).toBe(200);
  expect(Number((await panel()).qtyReserved)).toBe(0);
});

test('the checks; access by role', async () => {
  const other = await call('POST', '/api/v1/models/mrp.bom', 'maria', {
    product: ids['Panel'],
    lines: { create: [{ product: ids['Cable'], quantity: '1' }] },
  });
  expect(other.status).toBe(201);
  expect(
    (await call('POST', P, 'rahim', { product: ids['Fixture'], quantity: '1', bom: other.json.id }))
      .status,
  ).toBe(422);
  expect((await call('POST', P, 'rahim', { product: ids['Fixture'], quantity: '0' })).status).toBe(
    422,
  );
  expect(
    (
      await call('POST', '/api/v1/models/mrp.bom', 'maria', {
        product: ids['Panel'],
        lines: { create: [{ product: ids['Panel'], quantity: '1' }] },
      })
    ).status,
  ).toBe(422);
  expect(
    (await call('POST', '/api/v1/models/mrp.bom', 'rahim', { product: ids['Panel'] })).status,
  ).toBe(403);
  expect((await call('GET', P, 'bob')).status).toBe(403);
});

test('scrap on an order, with its reason; by-products of a bill must be other products', async () => {
  const order = (
    await call('POST', P, 'rahim', { product: ids['Fixture'], quantity: '1', bom: ids['v1'] })
  ).json.id as number;
  await receive('Panel', '1');
  const scrap = await call('POST', '/api/v1/models/stock.scrap', 'rahim', {
    product: ids['Panel'],
    quantity: '1',
    reason: 'defect',
    production: order,
  });
  expect(scrap.status, JSON.stringify(scrap.json)).toBe(201);
  expect(
    (
      await call(
        'POST',
        `/api/v1/models/stock.scrap/${scrap.json.id}/transitions/validate`,
        'rahim',
      )
    ).status,
  ).toBe(200);
  const listed = await find('stock.scrap', { production: order }, 'reason,state', 'rahim');
  expect(listed.map((x) => [x.reason, x.state])).toEqual([['defect', 'done']]);
  const itself = await call('POST', '/api/v1/models/mrp.bom.byproduct', 'maria', {
    bom: ids['v1'],
    product: ids['Fixture'],
    quantity: '1',
  });
  expect(itself.status).toBe(422);
  const all = await call('POST', '/api/v1/models/mrp.bom.byproduct', 'maria', {
    bom: ids['v1'],
    product: ids['Cable'],
    quantity: '1',
    costShare: '100',
  });
  expect(all.status).toBe(422);
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
  expect(JSON.stringify(summary)).toContain('Production');
});
