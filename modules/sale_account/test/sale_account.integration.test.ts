/**
 * The Sales ↔ Accounting bridge on real PostgreSQL (RFC 0008 §5.1, RFC 0009 §5.8): installing Sales and Accounting
 * proposes the bridge (reason `bridge`), unless it is left out; a confirmed order's "Create invoice" makes a draft
 * customer invoice from its lines in the sales journal, the order turns `invoiced`, and the invoice posts with the
 * order's total; an invoiced order is not invoiced twice.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accounting } from '@kosh/accounting';
import { planApps } from '@kosh/modules-sdk';
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
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { saleAccount } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [base, sales, accounting, saleAccount];

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let host: AppHost;
let company: number;
let bdt: number;
let customer: number;
let product: number;
let tax: number;
const tokens = new Map<string, string>();

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function call(
  method: 'GET' | 'POST',
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
const expectStatus = (r: { status: number; json: Json }, status: number) =>
  expect(r.status, JSON.stringify(r.json)).toBe(status);

test('the plan proposes the bridge when both apps come, unless it is left out', () => {
  const plan = planApps(catalogue, [], { install: ['sales', 'accounting'] });
  expect(plan.install.find((i) => i.name === 'sale_account')).toEqual({
    name: 'sale_account',
    reason: 'bridge',
  });
  const without = planApps(catalogue, [], {
    install: ['sales', 'accounting'],
    withoutBridges: ['sale_account'],
  });
  expect(without.install.some((i) => i.name === 'sale_account')).toBe(false);
  // Sales alone: no bridge.
  expect(
    planApps(catalogue, [], { install: ['sales'] }).install.some((i) => i.name === 'sale_account'),
  ).toBe(false);
});

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-sale-account-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({ driver, catalogue, change: { install: ['sales', 'accounting'] }, dir }),
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
    ['maria', ['account.manager', 'sales.manager']],
    ['sumi', ['sale_account.user']],
  ] as const)
    await auth.createUser({
      login,
      name: login,
      password: PASSWORD,
      company,
      companies: [company],
      groups: [...groups],
    });
  expectStatus(
    await call('POST', '/api/v1/accounting/charts/install', 'maria', { template: 'generic' }),
    200,
  );
  const ids = await host.server.shutro.bootstrap({ reason: 'test: data', company }, async (env) => {
    type Model = { create(rows: unknown[]): Promise<{ ids: number[] }> };
    const model = (name: string) => env.model(name as never) as unknown as Model;
    const [row] = await env.sql<{ id: number }>`SELECT id FROM res_currency WHERE name = 'BDT'`;
    const [vat] = await env.sql<{
      id: number;
    }>`SELECT id FROM account_tax WHERE use = 'sale' AND account_id IS NOT NULL ORDER BY id LIMIT 1`;
    const p = await model('product.product').create([
      { name: 'Steel beam', listPrice: '1000', taxes: { set: [vat?.id] } },
    ]);
    const c = await model('res.partner').create([
      { name: 'Bengal Steel', isCompany: true, isCustomer: true },
    ]);
    return {
      bdt: row?.id as number,
      product: p.ids[0] as number,
      customer: c.ids[0] as number,
      tax: vat?.id as number,
    };
  });
  bdt = ids.bdt;
  product = ids.product;
  customer = ids.customer;
  tax = ids.tax;
}, 180_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('the bridge is installed with the apps; a confirmed order is invoiced once, and the invoice posts', async () => {
  const installed = await driver.query<{ name: string; reason: string }>({
    text: "SELECT name, reason FROM kosh_module WHERE name IN ('sale_account', 'sales', 'accounting') ORDER BY name",
    params: [],
  });
  expect(installed).toEqual([
    { name: 'accounting', reason: 'selected' },
    { name: 'sale_account', reason: 'bridge' },
    { name: 'sales', reason: 'selected' },
  ]);
  const order = await call('POST', '/api/v1/models/sale.order', 'sumi', {
    partner: customer,
    currency: bdt,
    lines: {
      create: [
        {
          product,
          name: 'Steel beam',
          quantity: '3',
          priceUnit: '1000',
          discount: '10',
          taxes: { set: [tax] },
        },
      ],
    },
  });
  expectStatus(order, 201);
  const id = order.json.id as number;
  expect(order.json.invoiceState).toBe('no');
  // Not invoiceable before confirmation (the transition is not available from a quotation).
  expect(
    (await call('POST', `/api/v1/models/sale.order/${id}/transitions/invoice`, 'sumi')).status,
  ).toBeGreaterThanOrEqual(400);
  expectStatus(
    await call('POST', `/api/v1/models/sale.order/${id}/transitions/confirm`, 'sumi'),
    200,
  );
  expect(
    (await call('GET', `/api/v1/models/sale.order/${id}?fields=invoiceState,amountTotal`, 'sumi'))
      .json.invoiceState,
  ).toBe('to_invoice');

  const invoiced = await call(
    'POST',
    `/api/v1/models/sale.order/${id}/transitions/invoice`,
    'sumi',
  );
  expectStatus(invoiced, 200);
  expect(invoiced.json.state).toBe('sale'); // the order stays a sales order
  expect(invoiced.json.invoiceState).toBe('invoiced');
  const invoices = await call(
    'GET',
    `/api/v1/models/account.move?filter=${encodeURIComponent(JSON.stringify({ saleOrder: id }))}&fields=id,kind,state,invoiceOrigin,amountTotal,partner`,
    'sumi',
  );
  expect(invoices.json.items).toHaveLength(1);
  const invoice = invoices.json.items[0];
  expect(invoice).toMatchObject({ kind: 'out_invoice', state: 'draft', partner: customer });
  expect(invoice.invoiceOrigin).toMatch(/^SO\//);
  const orderRead = await call('GET', `/api/v1/models/sale.order/${id}?fields=amountTotal`, 'sumi');
  expect(invoice.amountTotal.amount).toBe(orderRead.json.amountTotal.amount); // 2700 + 15 % = 3105.00
  expect(invoice.amountTotal.amount).toBe('3105.00');
  // Invoiced once.
  const again = await call('POST', `/api/v1/models/sale.order/${id}/transitions/invoice`, 'sumi');
  expect(again.status).toBe(409);
  expect(again.json.detail).toContain('invoiced already');
  // The accountant posts it.
  const posted = await call(
    'POST',
    `/api/v1/models/account.move/${invoice.id}/transitions/post`,
    'maria',
  );
  expectStatus(posted, 200);
  expect(posted.json.name).toMatch(/^INV\//);
});
