/**
 * The Bangladesh localization on real PostgreSQL (RFC 0016 §5.3): installed with Accounting, its defaults set the
 * company up — the Bangladesh chart, the accounts of the VAT, SD and AT taxes, the VDS and TDS withholdings, a
 * July–June fiscal year and lakh grouping — once (running them again changes nothing); the chart routes offer
 * `bd`; BIN and TIN are checked; a company on another chart is left alone.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accounting } from '@kosh/accounting';
import { contacts } from '@kosh/contacts';
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
import { l10nBd } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [base, contacts, accounting, l10nBd];

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let host: AppHost;
let company: number;
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

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-l10n-bd-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({
      driver,
      catalogue,
      change: { install: ['contacts', 'accounting', 'l10n_bd'] },
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
    login: 'maria',
    name: 'Maria',
    password: PASSWORD,
    company,
    companies: [company],
    groups: ['account.manager', 'contacts.user'],
  });
}, 180_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

type SqlEnv = {
  sql<R>(strings: TemplateStringsArray, ...values: unknown[]): Promise<R[]>;
};
const sql = <T>(query: (env: SqlEnv) => Promise<T>) =>
  host.server.shutro.bootstrap({ reason: 'test: read', company }, (env) =>
    query(env as unknown as SqlEnv),
  );

test('installing it sets the company up for Bangladesh', async () => {
  const charts = await call('GET', '/api/v1/accounting/charts', 'maria');
  expectStatus(charts, 200);
  expect(charts.json.installed).toBe('bd');
  expect(charts.json.templates).toEqual(
    expect.arrayContaining([
      { code: 'generic', label: 'Generic' },
      { code: 'bd', label: 'Bangladesh' },
    ]),
  );

  const taxes = await sql(
    (env) => env.sql<{ name: string; code: string | null }>`
      SELECT t.name->>'en_US' AS name, a.code FROM account_tax t
      LEFT JOIN account_account a ON a.id = t.account_id`,
  );
  const accountOf = Object.fromEntries(taxes.map((t) => [t.name, t.code]));
  expect(accountOf).toMatchObject({
    'VAT 15%': '2200',
    'VAT 15% (purchases)': '1300',
    'SD 20%': '2220',
    'AT 5% (imports)': '1310',
  });
  expect(taxes.filter((t) => t.code === null)).toEqual([]);

  const withholdings = await sql(
    (env) => env.sql<{ name: string; direction: string; code: string }>`
      SELECT w.name->>'en_US' AS name, w.direction, a.code FROM account_withholding w JOIN account_account a ON a.id = w.account_id
      ORDER BY 1`,
  );
  expect(withholdings).toEqual([
    { name: 'AIT deducted by customers 3%', direction: 'customer', code: '1320' },
    { name: 'TDS 10% (services)', direction: 'vendor', code: '2230' },
    { name: 'TDS 5% (supplies)', direction: 'vendor', code: '2230' },
    { name: 'VDS (the full VAT)', direction: 'vendor', code: '2240' },
  ]);

  const [settings] = await sql(
    (env) => env.sql<{ fiscal_year_start: number; number_grouping: string }>`
      SELECT fiscal_year_start, number_grouping FROM res_company WHERE id = ${company}`,
  );
  expect(settings).toEqual({ fiscal_year_start: 7, number_grouping: 'lakh' });
  const years = await sql(
    (env) => env.sql<{ name: string; date_from: string }>`
      SELECT name, date_from::text FROM account_fiscal_year`,
  );
  expect(years).toHaveLength(1);
  expect(years[0]?.date_from).toMatch(/^\d{4}-07-01$/);
  expect(years[0]?.name).toMatch(/^\d{4}–\d{2}$/);
});

test('the defaults run again without changing anything', async () => {
  const count = () =>
    sql(
      (env) => env.sql<{ accounts: number; withholdings: number; years: number }>`
        SELECT (SELECT count(*)::int FROM account_account) AS accounts,
               (SELECT count(*)::int FROM account_withholding) AS withholdings,
               (SELECT count(*)::int FROM account_fiscal_year) AS years`,
    );
  const before = await count();
  await installDefaults(host.server.shutro, host.server.registry.loaded.modules, { company });
  expect(await count()).toEqual(before);
  // The chart is the company's: installing it again is refused.
  expect(
    (await call('POST', '/api/v1/accounting/charts/install', 'maria', { template: 'bd' })).status,
  ).toBe(409);
});

test('BIN and TIN are checked', async () => {
  const bad = await call('POST', '/api/v1/models/res.partner', 'maria', {
    name: 'Meghna Foods',
    isCompany: true,
    bin: '12345',
  });
  expect(bad.status).toBe(422);
  expect(JSON.stringify(bad.json)).toContain('A BIN has 13 digits.');
  expect(
    (
      await call('POST', '/api/v1/models/res.partner', 'maria', {
        name: 'Meghna Foods',
        isCompany: true,
        tin: '12-34',
      })
    ).status,
  ).toBe(422);
  const good = await call('POST', '/api/v1/models/res.partner', 'maria', {
    name: 'Meghna Foods',
    isCompany: true,
    bin: '0012345678901',
    tin: '123456789012',
  });
  expectStatus(good, 201);
});

test('a company on another chart is left alone', async () => {
  const other = await host.server.shutro.bootstrap({ reason: 'test: a company' }, async (env) => {
    const [bdt] = await env.sql<{ id: number }>`SELECT id FROM res_currency WHERE name = 'BDT'`;
    const created = await (
      env.model('res.company' as never) as unknown as {
        create(rows: unknown[]): Promise<{ ids: number[] }>;
      }
    ).create([{ name: 'Overseas Ltd', currency: bdt?.id }]);
    return created.ids[0] as number;
  });
  // Its own chart first (the generic one), then the localization's defaults.
  await host.server.shutro.bootstrap({ reason: 'test: generic chart', company: other }, (env) =>
    accountingInstallGeneric(env),
  );
  await installDefaults(host.server.shutro, host.server.registry.loaded.modules, {
    company: other,
  });
  const [row] = await sql(
    (env) => env.sql<{ chart: string; withholdings: number; grouping: string }>`
      SELECT c.chart_template AS chart, c.number_grouping AS grouping,
             (SELECT count(*)::int FROM account_withholding w WHERE w.company_id = c.id) AS withholdings
      FROM res_company c WHERE c.id = ${other}`,
  );
  expect(row).toEqual({ chart: 'generic', withholdings: 0, grouping: 'international' });
});

async function accountingInstallGeneric(env: unknown): Promise<void> {
  const { installChart } = await import('@kosh/accounting');
  await installChart(env as Parameters<typeof installChart>[0], 'generic');
}

test('the Mushak 6.3 tax invoice: SD, then VAT on price plus SD, per line; both BINs', async () => {
  const ids = await host.server.shutro.bootstrap(
    { reason: 'test: invoice data', company },
    async (env) => {
      await env.asSuperuser({ reason: 'test: company BIN' }, async (su) => {
        await su
          .model('res.company' as never)
          .browse([orm.asId(company, 'res.company')] as never)
          .write({ bin: '0009876543210' } as never);
        await su.flush();
      });
      const [journal] = await env.sql<{
        id: number;
      }>`SELECT id FROM account_journal WHERE code = 'INV'`;
      const [bdt] = await env.sql<{ id: number }>`SELECT id FROM res_currency WHERE name = 'BDT'`;
      return {
        journal: journal?.id as number,
        bdt: bdt?.id as number,
        sd: Number(await env.refId('account.tax' as never, 'l10n_bd.tax_sale_sd20')),
        vat: Number(await env.refId('account.tax' as never, 'l10n_bd.tax_sale_vat15')),
      };
    },
  );
  const buyer = await call('POST', '/api/v1/models/res.partner', 'maria', {
    name: 'Karnaphuli Traders',
    isCompany: true,
    isCustomer: true,
    bin: '0011122233344',
    street: '12 Agrabad',
    city: 'Chattogram',
  });
  expectStatus(buyer, 201);
  const invoice = await call('POST', '/api/v1/models/account.move', 'maria', {
    kind: 'out_invoice',
    journal: ids.journal,
    partner: buyer.json.id,
    currency: ids.bdt,
    lines: {
      create: [
        {
          lineKind: 'product',
          name: 'Soft drinks (crate)',
          quantity: '2',
          priceUnit: '500.00',
          taxes: { set: [ids.sd, ids.vat] },
        },
      ],
    },
  });
  expectStatus(invoice, 201);
  const id = invoice.json.id as number;
  expectStatus(
    await call('POST', `/api/v1/models/account.move/${id}/transitions/post`, 'maria'),
    200,
  );
  const lines = await call(
    'GET',
    `/api/v1/models/account.move.line?filter=${encodeURIComponent(JSON.stringify({ invoice: id }))}&fields=sdAmount,vatAmount,totalWithTaxes`,
    'maria',
  );
  expectStatus(lines, 200);
  const [line] = lines.json.items as Json[];
  expect([line.sdAmount.amount, line.vatAmount.amount, line.totalWithTaxes.amount]).toEqual([
    '200.00',
    '180.00',
    '1380.00',
  ]);

  const listed = await call('GET', '/api/v1/models/account.move/documents', 'maria');
  expectStatus(listed, 200);
  const template = (listed.json.templates as Json[]).find(
    (t) => t.name === 'Tax invoice (Mushak 6.3)',
  );
  expect(template, JSON.stringify(listed.json).slice(0, 300)).toBeDefined();
  const html = await host.server.app.inject({
    method: 'POST',
    url: `/api/v1/models/account.move/documents/${template.id}?format=html`,
    headers: { authorization: `Bearer ${tokens.get('maria') ?? ''}` },
    payload: { ids: [id] },
  });
  expect(html.statusCode, html.body.slice(0, 400)).toBe(200);
  for (const text of ['Tax invoice', 'Mushak 6.3', '0009876543210', '0011122233344', 'Chattogram'])
    expect(html.body).toContain(text);
  for (const amount of ['200.00', '180.00', '1,380.00']) expect(html.body).toContain(amount);
  // Every Mushak template is there: the credit note on invoices, the VDS certificate on payments.
  expect((listed.json.templates as Json[]).map((t) => t.name)).toContain(
    'Credit note (Mushak 6.7)',
  );
  const payments = await call('GET', '/api/v1/models/account.payment/documents', 'maria');
  expect((payments.json.templates as Json[]).map((t) => t.name)).toContain(
    'Certificate of VAT deducted at source (Mushak 6.6)',
  );
});
