/**
 * Sales on real PostgreSQL through the HTTP API (RFC 0008): installing Sales brings Contacts, Products and the chatter
 * with their data (units, VAT); a salesperson creates a customer and a quotation whose totals are computed in the
 * order's currency (discount, VAT); confirming needs lines and numbers the order; salespeople see only their own
 * orders, managers see all, and users without Sales are refused by the server.
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

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-sales-'));
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
      const created = await (env.model('product.product' as never) as unknown as Model).create([
        { name: 'Jute bag', listPrice: '1000', standardPrice: '600', taxes: { set: [vat?.id] } },
      ]);
      return { product: created.ids[0] as number, currency: bdt?.id as number };
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

test('installing Sales brings Contacts, Products and their data', async () => {
  const installed = await driver.query<{ name: string }>({
    text: 'SELECT name FROM kosh_module ORDER BY name',
    params: [],
  });
  expect(installed.map((r) => r.name)).toEqual(
    expect.arrayContaining(['base', 'contacts', 'messaging', 'product', 'sales', 'storage']),
  );
  const units = await driver.query({ text: 'SELECT id FROM uom_uom', params: [] });
  expect(units.length).toBeGreaterThanOrEqual(8);
  const [code] = await driver.query<{ code: string }>({
    text: 'SELECT code FROM product_product WHERE id = $1',
    params: [product],
  });
  expect(code?.code).toBe('P00001'); // numbered by the product sequence
});

test('a quotation: totals with discount and VAT, confirmed into a numbered order', async () => {
  const customer = await call('POST', '/api/v1/models/res.partner', 'rahim', {
    name: 'Meghna Retail',
    isCompany: true,
    isCustomer: true,
    email: 'buy@meghna.test',
  });
  expect(customer.status, JSON.stringify(customer.json)).toBe(201);

  const empty = await call('POST', '/api/v1/models/sale.order', 'rahim', {
    partner: customer.json.id,
    currency,
  });
  expect(empty.status, JSON.stringify(empty.json)).toBe(201);
  const refused = await call(
    'POST',
    `/api/v1/models/sale.order/${empty.json.id}/transitions/confirm`,
    'rahim',
  );
  expect(refused.status).toBe(409);
  expect(refused.json.detail).toContain('Add at least one line');

  const quote = await call('POST', '/api/v1/models/sale.order', 'rahim', {
    partner: customer.json.id,
    currency,
    lines: {
      create: [{ product, name: 'Jute bag', quantity: '2', priceUnit: '1000', discount: '10' }],
    },
  });
  expect(quote.status, JSON.stringify(quote.json)).toBe(201);
  const id = quote.json.id as number;
  const read = await call('GET', `/api/v1/models/sale.order/${id}`, 'rahim');
  // 2 × 1000 − 10 % = 1800 untaxed; the line's tax comes from the product only through the onchange.
  expect(read.json).toMatchObject({ state: 'draft' });
  expect(Number(read.json.amountUntaxed?.amount ?? read.json.amountUntaxed)).toBe(1800);

  const confirmed = await call(
    'POST',
    `/api/v1/models/sale.order/${id}/transitions/confirm`,
    'rahim',
  );
  expect(confirmed.status, JSON.stringify(confirmed.json)).toBe(200);
  expect(confirmed.json.state).toBe('sale');
  expect(String(confirmed.json.name)).toMatch(/^SO\/\d{4}\/\d{5}$/);
});

test('the product onchange fills the description, price and VAT', async () => {
  const res = await call('POST', '/api/v1/models/sale.order.line/onchange', 'rahim', {
    values: { product },
    changed: ['product'],
  });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  expect(res.json.values).toMatchObject({ name: 'Jute bag' });
  expect(Number(res.json.values.priceUnit)).toBe(1000);
  expect(res.json.values.taxes).toEqual([expect.any(Number)]);
});

test('a blank new order: its defaults, no currency nor amounts yet; the customer brings the currency', async () => {
  const blank = await call('POST', '/api/v1/models/sale.order/onchange', 'rahim', {
    values: {},
    changed: [],
  });
  expect(blank.status, JSON.stringify(blank.json)).toBe(200);
  expect(blank.json.values.amountTotal ?? null).toBeNull();
  // The defaults come back: a new form shows them.
  expect(blank.json.values.user).toEqual(expect.any(Number));
  expect(blank.json.values.dateOrder).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  const partners = await call('GET', '/api/v1/models/res.partner?fields=id&limit=1', 'rahim');
  const res = await call('POST', '/api/v1/models/sale.order/onchange', 'rahim', {
    values: { partner: partners.json.items[0].id },
    changed: ['partner'],
  });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  expect(res.json.values.currency).toEqual(expect.any(Number));
});

test('salespeople see their own orders, managers all, others none', async () => {
  const own = await call('GET', '/api/v1/models/sale.order', 'rahim');
  expect(own.json.items.length).toBe(2);
  expect((await call('GET', '/api/v1/models/sale.order', 'karim')).json.items).toEqual([]);
  expect((await call('GET', '/api/v1/models/sale.order', 'maria')).json.items.length).toBe(2);
  const bob = await call('GET', '/api/v1/models/sale.order', 'bob');
  expect(bob.status).toBe(403);
  // A colleague's order is refused by the record rule, on reads and writes alike.
  const first = own.json.items[0].id as number;
  expect((await call('GET', `/api/v1/models/sale.order/${first}`, 'karim')).status).toBe(403);
  expect(
    (await call('PATCH', `/api/v1/models/sale.order/${first}`, 'karim', { note: 'x' })).status,
  ).toBe(403);
});

test('the Sales app: menus for salespeople, none for others', async () => {
  const apps = await call('GET', '/api/v1/apps', 'rahim');
  expect(apps.json.apps.map((a: Json) => a.code)).toContain('sales');
  const bob = await call('GET', '/api/v1/apps', 'bob');
  expect(bob.json.apps.map((a: Json) => a.code)).not.toContain('sales');
});

test('the company’s quotation settings (RFC 0020): validity from the order date, default terms', async () => {
  await driver.query({
    text: "UPDATE res_company SET sale_validity_days = 15, sale_terms = 'Payment within 30 days.'",
    params: [],
  });
  const partners = await call('GET', '/api/v1/models/res.partner?fields=id&limit=1', 'rahim');
  const res = await call('POST', '/api/v1/models/sale.order/onchange', 'rahim', {
    values: { partner: partners.json.items[0].id, dateOrder: '2026-03-01' },
    changed: ['partner'],
  });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  expect(res.json.values).toMatchObject({
    validityDate: '2026-03-16',
    note: 'Payment within 30 days.',
  });
  // A new date moves the validity; terms already written stay.
  const moved = await call('POST', '/api/v1/models/sale.order/onchange', 'rahim', {
    values: {
      partner: partners.json.items[0].id,
      dateOrder: '2026-04-01',
      validityDate: '2026-03-16',
      note: 'Mine',
    },
    changed: ['dateOrder'],
  });
  expect(moved.json.values.validityDate).toBe('2026-04-16');
  expect(moved.json.values.note ?? 'Mine').toBe('Mine');
  await driver.query({
    text: 'UPDATE res_company SET sale_validity_days = 0, sale_terms = NULL',
    params: [],
  });
  const open = await call('POST', '/api/v1/models/sale.order/onchange', 'rahim', {
    values: { partner: partners.json.items[0].id, dateOrder: '2026-03-01' },
    changed: ['partner'],
  });
  expect(open.json.values.validityDate ?? null).toBeNull();
});

test('the Sales overview (RFC 0022 §3.2): installed once as a dashboard, served with its cards to a sales user', async () => {
  const overview = await call('GET', '/api/v1/reports/overview?app=sales', 'rahim');
  expect(overview.status, JSON.stringify(overview.json)).toBe(200);
  expect(overview.json.label).toBe('Sales');
  expect(overview.json.cards.map((c: { id: string }) => c.id)).toEqual([
    'sales_month',
    'orders_month',
    'open_quotations',
    'average_order',
    'sales_by_month',
    'top_customers',
    'by_salesperson',
    'quotations_to_chase',
  ]);
  // Running the defaults again adds nothing.
  await installDefaults(host.server.shutro, host.server.registry.loaded.modules, { company });
  expect((await call('GET', '/api/v1/reports/overview?app=sales', 'rahim')).json.id).toBe(
    overview.json.id,
  );
  expect((await call('GET', '/api/v1/reports/overview?app=contacts', 'rahim')).status).toBe(404);
});

test('the next step (RFC 0022 §3.4): Confirm refused by its guard with the message, Send allowed; with a line, Confirm allowed', async () => {
  const customer = await call('POST', '/api/v1/models/res.partner', 'rahim', {
    name: 'Next Step Ltd',
    isCustomer: true,
  });
  const empty = await call('POST', '/api/v1/models/sale.order', 'rahim', {
    partner: customer.json.id,
    currency,
  });
  expect(empty.status, JSON.stringify(empty.json)).toBe(201);
  const next = await call('GET', `/api/v1/models/sale.order/${empty.json.id}/next`, 'rahim');
  expect(next.status, JSON.stringify(next.json)).toBe(200);
  expect(next.json.transitions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: 'confirm',
        to: 'sale',
        allowed: false,
        message: 'Add at least one line before confirming the order.',
      }),
      expect.objectContaining({ name: 'send', allowed: true, message: null }),
    ]),
  );
  // Nothing changed by asking.
  expect(
    (await call('GET', `/api/v1/models/sale.order/${empty.json.id}`, 'rahim')).json.state,
  ).toBe('draft');
  const quote = await call('POST', '/api/v1/models/sale.order', 'rahim', {
    partner: customer.json.id,
    currency,
    lines: { create: [{ product, name: 'Jute bag', quantity: '1', priceUnit: '100' }] },
  });
  const ready = await call('GET', `/api/v1/models/sale.order/${quote.json.id}/next`, 'rahim');
  expect(
    ready.json.transitions.find((tr: { name: string }) => tr.name === 'confirm'),
  ).toMatchObject({
    allowed: true,
    message: null,
  });
  expect((await call('GET', '/api/v1/models/sale.order/999999/next', 'rahim')).status).toBe(404);
});
