/**
 * The Shop ↔ Stockroom bridge on real PostgreSQL (RFC 0024 §2.7): products show in stock, few left or out of stock
 * from what Stockroom has, services nothing; a site that does not sell beyond stock refuses a cart line beyond what
 * is available, with what is left.
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
import { settings } from '@kosh/settings';
import { stock } from '@kosh/stock';
import { websiteSale } from '@kosh/website_sale';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { websiteSaleStock } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [base, settings, websiteSale, stock, websiteSaleStock];
const SHOP = '/api/v1/public/shop/bazar';

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let host: AppHost;
let company: number;
const ids: Record<string, number> = {};
const tokens = new Map<string, string>();

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function call(method: 'GET' | 'POST' | 'PATCH', url: string, as: string, payload?: unknown) {
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
  return { status: res.statusCode, json: (res.body === '' ? null : res.json()) as Json };
}
/** A visitor's call: no sign-in, the cart's token if any. */
async function visit(
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  cart?: string,
  payload?: unknown,
) {
  const res = await host.server.app.inject({
    method,
    url,
    headers: cart === undefined ? {} : { 'x-cart-token': cart },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: res.statusCode, json: (res.body === '' ? null : res.json()) as Json };
}
const newCart = async () => {
  const made = await visit('POST', `${SHOP}/cart`);
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  return made.json.token as string;
};
const put = (cart: string, product: number | undefined, quantity: string) =>
  visit('PUT', `${SHOP}/cart/lines`, cart, { product, quantity });

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-website-sale-stock-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({
      driver,
      catalogue,
      change: { install: ['settings', 'website_sale', 'stock', 'website_sale_stock'] },
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
    login: 'dina',
    name: 'Dina',
    password: PASSWORD,
    company,
    companies: [company],
    groups: ['website_sale.manager', 'product.manager', 'stock.manager', 'contacts.manager'],
  });
  ids['site'] = (
    await call('POST', '/api/v1/models/website.site', 'dina', {
      name: 'Bazar',
      key: 'bazar',
      shop: true,
      fewLeft: 5,
    })
  ).json.id;
  for (const [name, kind] of [
    ['Rice 5 kg', 'goods'],
    ['Mustard oil 1 L', 'goods'],
    ['Gift wrapping', 'service'],
  ] as const)
    ids[name] = (
      await call('POST', '/api/v1/models/product.product', 'dina', {
        name,
        kind,
        listPrice: '100',
        published: true,
      })
    ).json.id;
  const places = (await call('GET', '/api/v1/models/stock.location?fields=usage&limit=50', 'dina'))
    .json.items as Json[];
  const receipt = await call('POST', '/api/v1/models/stock.picking', 'dina', {
    kind: 'receipt',
    source: places.find((l) => l.usage === 'vendor').id,
    destination: places.find((l) => l.usage === 'internal').id,
    moves: { create: [{ product: ids['Rice 5 kg'], quantity: '3' }] },
  });
  expect(receipt.status, JSON.stringify(receipt.json)).toBe(201);
  for (const t of ['confirm', 'validate'])
    expect(
      (
        await call(
          'POST',
          `/api/v1/models/stock.picking/${receipt.json.id}/transitions/${t}`,
          'dina',
        )
      ).status,
    ).toBe(200);
}, 240_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('the shop shows what Stockroom has: few left with how many, out of stock, services without', async () => {
  const shown = Object.fromEntries(
    ((await visit('GET', `${SHOP}/products`)).json.products as Json[]).map((p) => [
      p.name,
      [p.availability, p.left ?? null],
    ]),
  );
  expect(shown).toEqual({
    'Rice 5 kg': ['few_left', '3'],
    'Mustard oil 1 L': ['out_of_stock', null],
    'Gift wrapping': [null, null],
  });
  expect((await visit('GET', `${SHOP}/products/${ids['Rice 5 kg']}`)).json.availability).toBe(
    'few_left',
  );
});

test('beyond stock: sold by default; refused with what is left once the site does not sell beyond stock', async () => {
  const cart = await newCart();
  expect((await put(cart, ids['Mustard oil 1 L'], '2')).status).toBe(200);
  await call('PATCH', `/api/v1/models/website.site/${ids['site']}`, 'dina', {
    allowBackorders: false,
  });
  const other = await newCart();
  const refused = await put(other, ids['Rice 5 kg'], '4');
  expect(refused.status).toBe(422);
  expect(JSON.stringify(refused.json)).toContain('Only 3 of Rice 5 kg left');
  expect((await put(other, ids['Rice 5 kg'], '3')).status).toBe(200);
  expect(JSON.stringify((await put(other, ids['Mustard oil 1 L'], '1')).json)).toContain(
    'out of stock',
  );
  expect((await put(other, ids['Gift wrapping'], '9')).status).toBe(200);
});
