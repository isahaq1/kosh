/**
 * The Purchase ↔ Accounting bridge on real PostgreSQL (RFC 0008 §5.1, RFC 0009 §5.8): installed with Purchase and
 * Accounting as a bridge; a confirmed purchase order's "Create bill" makes a draft vendor bill from its lines in the
 * purchases journal with the order's reference, the order turns `billed`, the bill goes through the bill approval
 * flow and posts; an order is billed once.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accounting } from '@kosh/accounting';
import { planApps } from '@kosh/modules-sdk';
import { purchase } from '@kosh/purchase';
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
import { purchaseAccount } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [base, purchase, accounting, purchaseAccount];

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let host: AppHost;
let company: number;
let bdt: number;
let vendor: number;
let product: number;
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

test('the plan proposes the bridge when both apps come', () => {
  const plan = planApps(catalogue, [], { install: ['purchase', 'accounting'] });
  expect(plan.install.find((i) => i.name === 'purchase_account')).toEqual({
    name: 'purchase_account',
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
  dir = await mkdtemp(join(tmpdir(), 'kosh-purchase-account-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({ driver, catalogue, change: { install: ['purchase', 'accounting'] }, dir }),
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
    ['maria', ['account.manager', 'purchase.manager']],
    ['farid', ['purchase_account.user', 'account.user']],
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
    await call('POST', '/api/v1/accounting/charts/install', 'maria', { template: 'bd' }),
    200,
  );
  const ids = await host.server.shutro.bootstrap({ reason: 'test: data', company }, async (env) => {
    type Model = { create(rows: unknown[]): Promise<{ ids: number[] }> };
    const model = (name: string) => env.model(name as never) as unknown as Model;
    const [row] = await env.sql<{ id: number }>`SELECT id FROM res_currency WHERE name = 'BDT'`;
    const p = await model('product.product').create([{ name: 'Raw jute', standardPrice: '100' }]);
    const v = await model('res.partner').create([
      { name: 'Jessore Jute Mills', isCompany: true, isVendor: true },
    ]);
    return { bdt: row?.id as number, product: p.ids[0] as number, vendor: v.ids[0] as number };
  });
  bdt = ids.bdt;
  product = ids.product;
  vendor = ids.vendor;
}, 180_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('a confirmed purchase order is billed once; the bill carries the reference and posts', async () => {
  const order = await call('POST', '/api/v1/models/purchase.order', 'farid', {
    partner: vendor,
    currency: bdt,
    partnerReference: 'JJM-2026-17',
    lines: { create: [{ product, name: 'Raw jute (kg)', quantity: '50', priceUnit: '100' }] },
  });
  expectStatus(order, 201);
  const id = order.json.id as number;
  expectStatus(
    await call('POST', `/api/v1/models/purchase.order/${id}/transitions/submit`, 'farid'),
    200,
  );
  expectStatus(
    await call('POST', `/api/v1/models/purchase.order/${id}/transitions/confirm`, 'farid'),
    200,
  );
  expect(
    (await call('GET', `/api/v1/models/purchase.order/${id}?fields=billState`, 'farid')).json
      .billState,
  ).toBe('to_bill');

  const billed = await call(
    'POST',
    `/api/v1/models/purchase.order/${id}/transitions/bill`,
    'farid',
  );
  expectStatus(billed, 200);
  expect(billed.json).toMatchObject({ state: 'purchase', billState: 'billed' });
  const bills = await call(
    'GET',
    `/api/v1/models/account.move?filter=${encodeURIComponent(JSON.stringify({ purchaseOrder: id }))}&fields=id,kind,state,ref,invoiceOrigin,amountTotal`,
    'farid',
  );
  expect(bills.json.items).toHaveLength(1);
  const bill = bills.json.items[0];
  expect(bill).toMatchObject({ kind: 'in_invoice', state: 'draft', ref: 'JJM-2026-17' });
  expect(bill.invoiceOrigin).toMatch(/^PO\//);
  expect(bill.amountTotal.amount).toBe('5000.00');
  expect(
    (await call('POST', `/api/v1/models/purchase.order/${id}/transitions/bill`, 'farid')).status,
  ).toBe(409);

  // A small bill: submit, then post (no approval level applies below the threshold).
  expectStatus(
    await call('POST', `/api/v1/models/account.move/${bill.id}/transitions/submit`, 'farid'),
    200,
  );
  const posted = await call(
    'POST',
    `/api/v1/models/account.move/${bill.id}/transitions/post`,
    'farid',
  );
  expectStatus(posted, 200);
  expect(posted.json.name).toMatch(/^BILL\//);
});
