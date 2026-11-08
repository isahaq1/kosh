/**
 * Fiscal positions and account determination on real PostgreSQL (RFC 0029 §3.5): a line's account from its category
 * when the product names none; the partner's own receivable account; an export position applied by itself to a
 * foreign customer, removing the VAT and moving the income account, shown in the preview before posting; a position
 * chosen on the partner wins; only accounting users see the preview.
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
import { accounting } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [base, accounting];

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let host: AppHost;
let company: number;
let bdt: number;
let vat: number;
let product: number;
const partners: Record<string, number> = {};
const accounts: Record<string, number> = {};
const journals: Record<string, number> = {};
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
const expectStatus = (r: { status: number; json: Json }, status: number) =>
  expect(r.status, JSON.stringify(r.json)).toBe(status);
const today = new Date().toISOString().slice(0, 10);

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-fiscal-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({ driver, catalogue, change: { install: ['accounting'] }, dir }),
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
    ['maria', ['account.manager']],
    ['rahim', ['account.user']],
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
  expectStatus(
    await call('POST', '/api/v1/accounting/charts/install', 'maria', { template: 'generic' }),
    200,
  );
  const accountRows = await call(
    'GET',
    '/api/v1/models/account.account?fields=id,code&limit=200',
    'maria',
  );
  for (const a of accountRows.json.items as { id: number; code: string }[]) accounts[a.code] = a.id;
  const journalRows = await call('GET', '/api/v1/models/account.journal?fields=id,code', 'maria');
  for (const j of journalRows.json.items as { id: number; code: string }[]) journals[j.code] = j.id;
  const ids = await host.server.shutro.bootstrap({ reason: 'test: data', company }, async (env) => {
    type Model = { create(rows: unknown[]): Promise<{ ids: number[] }> };
    const model = (name: string) => env.model(name as never) as unknown as Model;
    const [row] = await env.sql<{ id: number }>`SELECT id FROM res_currency WHERE name = 'BDT'`;
    const [tax] = (
      await model('account.tax').create([
        { name: 'VAT 15% (test)', use: 'sale', rate: '0.15', account: accounts['2200'] },
      ])
    ).ids;
    const [category] = (
      await model('product.category').create([
        { name: 'Services', incomeAccount: accounts['4100'] },
      ])
    ).ids;
    const [service] = (
      await model('product.product').create([{ name: 'Consulting', listPrice: '1000', category }])
    ).ids;
    const made = await model('res.partner').create([
      { name: 'Dhaka Mills', isCompany: true, isCustomer: true, country: 'BD' },
      {
        name: 'Rhine GmbH',
        isCompany: true,
        isCustomer: true,
        country: 'DE',
        receivableAccount: accounts['9999'],
      },
    ]);
    return {
      bdt: row?.id as number,
      vat: tax as number,
      product: service as number,
      partners: made.ids,
    };
  });
  bdt = ids.bdt;
  vat = ids.vat;
  product = ids.product;
  partners['dhaka'] = ids.partners[0] as number;
  partners['rhine'] = ids.partners[1] as number;
}, 180_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

/** A draft customer invoice of one consulting line with the VAT. */
async function draft(partner: number): Promise<number> {
  const created = await call('POST', '/api/v1/models/account.move', 'rahim', {
    kind: 'out_invoice',
    journal: journals['INV'],
    partner,
    currency: bdt,
    date: today,
    dateDue: today,
    lines: {
      create: [
        {
          lineKind: 'product',
          product,
          name: 'Consulting',
          quantity: '1',
          priceUnit: '1000',
          taxes: { set: [vat] },
        },
      ],
    },
  });
  expectStatus(created, 201);
  return created.json.id as number;
}
const post = async (id: number) =>
  expectStatus(
    await call('POST', `/api/v1/models/account.move/${id}/transitions/post`, 'rahim'),
    200,
  );
const linesOf = async (id: number) =>
  (
    await call(
      'GET',
      `/api/v1/models/account.move.line?filter=${encodeURIComponent(JSON.stringify({ move: id }))}&fields=lineKind,account,taxes&order=id+asc`,
      'rahim',
    )
  ).json.items as Json[];
const idOf = (v: Json) => (typeof v === 'number' ? v : v?.id);

test('a domestic invoice: the category’s income account, the VAT kept, the company’s receivable', async () => {
  const id = await draft(partners['dhaka'] as number);
  const preview = await call('GET', `/api/v1/accounting/moves/${id}/preview`, 'rahim');
  expectStatus(preview, 200);
  expect(preview.json.position).toBeNull();
  expect(preview.json.lines[0]).toMatchObject({
    taxesAfter: ['VAT 15% (test)'],
    source: 'category',
    mapped: false,
  });
  expect(preview.json.lines[0].account).toContain('4100');
  expect(preview.json.counterpart).toMatchObject({ source: 'company' });
  expect((await call('GET', `/api/v1/accounting/moves/${id}/preview`, 'bob')).status).toBe(403);
  await post(id);
  const lines = await linesOf(id);
  expect(idOf(lines.find((l) => l.lineKind === 'product').account)).toBe(accounts['4100']);
  expect(lines.some((l) => l.lineKind === 'tax')).toBe(true);
  expect(idOf(lines.find((l) => l.lineKind === 'counterpart').account)).toBe(accounts['1100']);
});

test('an export position applied by itself: no VAT, the income account mapped, the partner’s receivable', async () => {
  const position = await call('POST', '/api/v1/models/account.fiscal.position', 'maria', {
    name: 'Export',
    company,
    autoApply: true,
    countries: '!BD',
    taxes: { create: [{ taxSrc: vat, taxDest: null }] },
    accounts: { create: [{ accountSrc: accounts['4100'], accountDest: accounts['4900'] }] },
  });
  expectStatus(position, 201);
  expect(
    (await call('POST', '/api/v1/models/account.fiscal.position', 'rahim', { name: 'No', company }))
      .status,
  ).toBe(403);

  const id = await draft(partners['rhine'] as number);
  const preview = await call('GET', `/api/v1/accounting/moves/${id}/preview`, 'rahim');
  expect(preview.json.position).toMatchObject({ name: 'Export' });
  expect(preview.json.why).toContain('applied by itself');
  expect(preview.json.lines[0]).toMatchObject({
    taxesBefore: ['VAT 15% (test)'],
    taxesAfter: [],
    source: 'category',
    mapped: true,
  });
  expect(preview.json.lines[0].account).toContain('4900');
  expect(preview.json.counterpart).toMatchObject({ source: 'partner' });
  await post(id);
  const move = await call(
    'GET',
    `/api/v1/models/account.move/${id}?fields=fiscalPosition,amountTax,amountTotal`,
    'rahim',
  );
  expect(idOf(move.json.fiscalPosition)).toBe(position.json.id);
  expect(move.json.amountTotal.amount).toBe('1000.00');
  const lines = await linesOf(id);
  expect(lines.some((l) => l.lineKind === 'tax')).toBe(false);
  expect(idOf(lines.find((l) => l.lineKind === 'product').account)).toBe(accounts['4900']);
  expect(idOf(lines.find((l) => l.lineKind === 'counterpart').account)).toBe(accounts['9999']);

  // A position named on the partner wins over the automatic one, even for a domestic customer.
  await host.server.shutro.bootstrap({ reason: 'test: partner position', company }, (env) =>
    (
      env.model('res.partner' as never) as unknown as {
        browse(ids: number[]): { write(v: unknown): Promise<void> };
      }
    )
      .browse([partners['dhaka'] as number])
      .write({ fiscalPosition: position.json.id }),
  );
  const domestic = await draft(partners['dhaka'] as number);
  const again = await call('GET', `/api/v1/accounting/moves/${domestic}/preview`, 'rahim');
  expect(again.json).toMatchObject({ position: { name: 'Export' }, why: 'the partner’s' });
});
