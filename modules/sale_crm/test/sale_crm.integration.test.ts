/**
 * The Pipeline ↔ Sales bridge on real PostgreSQL (RFC 0028 step 4): New quotation on a deal, the deal won when a
 * quotation is confirmed, lost when every quotation is cancelled.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crm } from '@kosh/crm';
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
import { saleCrm, saleCrmWorkers } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [base, sales, crm, saleCrm];

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let host: AppHost;
let product: number;
let customer: number;
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
  dir = await mkdtemp(join(tmpdir(), 'kosh-sale-crm-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({ driver, catalogue, change: { install: ['sales', 'crm'] }, dir }),
    {
      driver,
      dir,
      actor: 'test',
    },
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
    ['rahim', ['sale_crm.user']],
    ['maria', ['sales.manager', 'crm.manager']],
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
      const partner = await (env.model('res.partner' as never) as unknown as Model).create([
        { name: 'Fair Traders' },
      ]);
      return {
        product: created.ids[0] as number,
        currency: bdt?.id as number,
        customer: partner.ids[0] as number,
      };
    },
  );
  product = ids.product;
  customer = ids.customer;
  currency = ids.currency;
}, 180_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

const D = '/api/v1/models/crm.deal';
const O = '/api/v1/models/sale.order';
const drain = async () => {
  for (const w of saleCrmWorkers({ shutro: host.server.shutro })) await w.drain();
};
async function quote(deal: number): Promise<number> {
  const made = await call('POST', O, 'rahim', {
    partner: customer,
    currency,
    deal,
    lines: { create: [{ product, name: 'Jute bag', quantity: '2' }] },
  });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  return made.json.id as number;
}

test('the deal form opens a new quotation filled from the deal', async () => {
  const views = await call('GET', '/api/v1/views/crm.deal.form', 'rahim');
  expect(views.status, JSON.stringify(views.json)).toBe(200);
  const view = views.json.view ?? views.json;
  const button = view.header.buttons.find((b: { id: string }) => b.id === 'new_quotation');
  expect(button.open).toMatchObject({ model: 'sale.order', values: { deal: { $record: 'id' } } });
});

test('a confirmed quotation wins its deal; a deal whose quotations are all cancelled is lost', async () => {
  const deal = (await call('POST', D, 'rahim', { name: 'Bags for the fair', partner: customer }))
    .json.id as number;
  const order = await quote(deal);
  expect((await call('POST', `${O}/${order}/transitions/confirm`, 'rahim')).status).toBe(200);
  await drain();
  expect((await call('GET', `${D}/${deal}?fields=status`, 'rahim')).json.status).toBe('won');

  const other = (await call('POST', D, 'rahim', { name: 'Bags for the shop', partner: customer }))
    .json.id as number;
  const a = await quote(other);
  const b = await quote(other);
  await call('POST', `${O}/${a}/transitions/cancel`, 'rahim');
  await drain();
  expect((await call('GET', `${D}/${other}?fields=status`, 'rahim')).json.status).toBe('open');
  await call('POST', `${O}/${b}/transitions/cancel`, 'rahim');
  await drain();
  expect((await call('GET', `${D}/${other}?fields=status`, 'rahim')).json.status).toBe('lost');
});
