/**
 * Price lists on real PostgreSQL (RFC 0028 step 1): rules by category, product and quantity, formulas, lists on
 * lists, prices typed in kept, the customer's list on a new order, cycles refused.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { sales } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [base, sales];

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let host: AppHost;
let product: number;
let currency: number;
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

let company: number;
const extra = { wholesale: 0, dealer: 0, customer: 0 };

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-pricelist-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(await prepareApps({ driver, catalogue, change: { install: ['sales'] }, dir }), {
    driver,
    dir,
    actor: 'test',
  });
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
    ['rahim', ['sales.user']],
    ['karim', ['sales.user']],
    ['maria', ['sales.manager']],
    ['bob', ['base.user']],
    ['pia', ['product.manager']],
  ] as const)
    await auth.createUser({
      login,
      name: login,
      password: PASSWORD,
      company,
      companies: [company],
      groups: [...groups],
    });
  type Model = { create(rows: unknown[]): Promise<{ ids: number[] }> };
  const ids = await host.server.shutro.bootstrap(
    { reason: 'test: product', company },
    async (env) => {
      const [vat] = (
        await (env.model('account.tax' as never) as unknown as Model).create([
          { name: 'VAT 15% (test)', use: 'sale', rate: '0.15' },
        ])
      ).ids.map((id) => ({ id }));
      const [bdt] = await env.sql<{ id: number }>`SELECT id FROM res_currency WHERE name = 'BDT'`;
      const [bags] = (
        await (env.model('product.category' as never) as unknown as Model).create([
          { name: 'Bags' },
        ])
      ).ids;
      const created = await (env.model('product.product' as never) as unknown as Model).create([
        {
          name: 'Jute bag',
          listPrice: '1000',
          standardPrice: '600',
          category: bags,
          taxes: { set: [vat?.id] },
        },
      ]);
      const jute = created.ids[0] as number;
      const lists = env.model('product.pricelist' as never) as unknown as Model;
      const [wholesale] = (
        await lists.create([
          {
            name: 'Wholesale',
            currency: bdt?.id,
            rules: {
              create: [
                { appliesTo: 'category', category: bags, compute: 'discount', discount: '10' },
                {
                  appliesTo: 'product',
                  product: jute,
                  minQuantity: '100',
                  compute: 'formula',
                  base: 'cost',
                  discount: '-20',
                  rounding: '10',
                },
                { appliesTo: 'all', compute: 'fixed', fixedPrice: '1', dateTo: '2020-01-01' },
              ],
            },
          },
        ])
      ).ids;
      const [dealer] = (
        await lists.create([
          {
            name: 'Dealer',
            currency: bdt?.id,
            rules: {
              create: [
                { compute: 'discount', base: 'pricelist', basePricelist: wholesale, discount: '5' },
              ],
            },
          },
        ])
      ).ids;
      const [customer] = (
        await (env.model('res.partner' as never) as unknown as Model).create([
          { name: 'Rupa Traders', pricelist: wholesale },
        ])
      ).ids;
      extra.wholesale = wholesale as number;
      extra.dealer = dealer as number;
      extra.customer = customer as number;
      return { product: jute, currency: bdt?.id as number };
    },
  );
  product = ids.product;
  currency = ids.currency;
}, 180_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

const L = '/api/v1/models/sale.order.line';
const line = async (id: number) =>
  (await call('GET', `${L}/${id}?fields=priceUnit,priceReason,manualPrice`, 'rahim')).json;

test('the price list prices lines and says why: a category, a quantity break with a formula, a list on a list', async () => {
  const made = await call('POST', '/api/v1/models/sale.order', 'rahim', {
    partner: extra.customer,
    pricelist: extra.wholesale,
    currency,
    lines: { create: [{ product, name: 'Jute bag', quantity: '10' }] },
  });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  const [lineId] = (
    await call('GET', `/api/v1/models/sale.order/${made.json.id}?fields=lines`, 'rahim')
  ).json.lines as number[];
  // Bags: 10 % off the list price (the dated rule has ended).
  expect(await line(lineId as number)).toMatchObject({
    priceUnit: '900',
    priceReason: 'Wholesale: 10 % off the list price.',
    manualPrice: null,
  });
  // From 100: the product's rule, the cost plus 20 %, rounded to 10.
  await call('PATCH', `${L}/${lineId}`, 'rahim', { quantity: '100' });
  expect((await line(lineId as number)).priceUnit).toBe('720');
  // The Dealer list: 5 % off the Wholesale price.
  await call('PATCH', `/api/v1/models/sale.order/${made.json.id}`, 'rahim', {
    pricelist: extra.dealer,
  });
  expect(await line(lineId as number)).toMatchObject({
    priceUnit: '684',
    priceReason: 'Dealer: 5 % off another list.',
  });
  // A price typed in stays when the quantity changes.
  await call('PATCH', `${L}/${lineId}`, 'rahim', { priceUnit: '650' });
  await call('PATCH', `${L}/${lineId}`, 'rahim', { quantity: '120' });
  expect(await line(lineId as number)).toMatchObject({
    priceUnit: '650',
    priceReason: 'Typed in.',
    manualPrice: '650',
  });
});

test('without a list, the list price; a price typed when the line is made is kept', async () => {
  const made = await call('POST', '/api/v1/models/sale.order', 'rahim', {
    partner: extra.customer,
    currency,
    lines: {
      create: [
        { product, name: 'Jute bag', quantity: '1' },
        { product, name: 'Jute bag', quantity: '1', priceUnit: '777' },
      ],
    },
  });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  const ids = (await call('GET', `/api/v1/models/sale.order/${made.json.id}?fields=lines`, 'rahim'))
    .json.lines as number[];
  expect(await line(ids[0] as number)).toMatchObject({
    priceUnit: '1000',
    priceReason: 'List price.',
  });
  expect(await line(ids[1] as number)).toMatchObject({
    priceUnit: '777',
    priceReason: 'Typed in.',
  });
});

test('the customer brings their list to a new order; a list based on itself is refused', async () => {
  const changed = await call('POST', '/api/v1/models/sale.order/onchange', 'rahim', {
    values: { partner: extra.customer },
    changed: ['partner'],
  });
  expect(changed.json.values.pricelist).toBe(extra.wholesale);
  const cycle = await call('POST', '/api/v1/models/product.pricelist.rule', 'pia', {
    pricelist: extra.wholesale,
    compute: 'discount',
    base: 'pricelist',
    basePricelist: extra.dealer,
  });
  expect(cycle.status).toBe(422);
});
