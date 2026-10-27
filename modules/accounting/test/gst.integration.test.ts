/**
 * Taxes split by place of supply, reverse charge and debit notes on real PostgreSQL (RFC 0016 step 5, part 1): a
 * GST-like tax with CGST and SGST within the state and IGST between states posts its components by the document's
 * place of supply (the partner's state, or set on the document; abroad is between states), the odd paisa on the
 * first; totals keep the tax whole. A reverse-charge tax on a bill posts what may be claimed and what is owed, net
 * zero, outside the total. Debit notes post like invoices; a vendor credit note settles on the payable account.
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
let inr: number;
let gst: number;
let gstReverse: number;
let gstHalf: number;
const partners: Record<string, number> = {};
const accounts: Record<string, number> = {};
const journals: Record<string, number> = {};
const tokens = new Map<string, string>();

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function call(
  method: 'GET' | 'POST' | 'PUT',
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

/** Creates and posts a document of one line; returns its id (or the refused posting). */
async function post(
  kind: string,
  partner: number,
  priceUnit: string,
  taxes: number[],
  extra: Record<string, unknown> = {},
): Promise<{ id: number; posted: { status: number; json: Json } }> {
  const journal = kind.startsWith('out_') ? journals['INV'] : journals['BILL'];
  const created = await call('POST', '/api/v1/models/account.move', 'maria', {
    kind,
    journal,
    partner,
    currency: inr,
    ...extra,
    lines: {
      create: [
        { lineKind: 'product', name: 'Laptop', quantity: '1', priceUnit, taxes: { set: taxes } },
      ],
    },
  });
  expectStatus(created, 201);
  const id = created.json.id as number;
  const posted = await call('POST', `/api/v1/models/account.move/${id}/transitions/post`, 'maria');
  return { id, posted };
}

/** The generated lines of a document: [kind, account code, debit, credit, component code, reverse charge]. */
async function generated(id: number) {
  const lines = await call(
    'GET',
    `/api/v1/models/account.move.line?filter=${encodeURIComponent(JSON.stringify({ move: id }))}&fields=lineKind,account,debit,credit,taxComponent,taxReverseCharge,taxBase&order=id+asc`,
    'maria',
  );
  expectStatus(lines, 200);
  const codeOf = new Map(Object.entries(accounts).map(([code, id]) => [id, code]));
  const components = await call(
    'GET',
    '/api/v1/models/account.tax.component?fields=id,code',
    'maria',
  );
  const componentOf = new Map(
    (components.json.items as Json[]).map((c) => [c.id as number, c.code as string]),
  );
  return (lines.json.items as Json[])
    .filter((l) => l.lineKind !== 'product')
    .map((l) => [
      l.lineKind,
      codeOf.get(l.account),
      l.debit.amount,
      l.credit.amount,
      l.taxComponent === null ? null : componentOf.get(l.taxComponent),
      l.taxReverseCharge,
    ]);
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-gst-'));
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
    company: { name: 'Sahyadri Traders', currency: 'INR' },
    admin: { login: 'admin', name: 'Administrator', password: PASSWORD },
  }));
  await installDefaults(host.server.shutro, host.server.registry.loaded.modules, { company });
  await auth.createUser({
    login: 'maria',
    name: 'Maria',
    password: PASSWORD,
    company,
    companies: [company],
    groups: ['account.manager'],
  });
  expectStatus(
    await call('POST', '/api/v1/accounting/charts/install', 'maria', { template: 'generic' }),
    200,
  );
  // The company is in Maharashtra.
  const settings = await call('PUT', '/api/v1/accounting/settings', 'maria', {
    country: 'in',
    state: 'in-mh',
  });
  expectStatus(settings, 200);
  expect(settings.json).toMatchObject({ country: 'IN', state: 'IN-MH' });
  expect(
    (await call('PUT', '/api/v1/accounting/settings', 'maria', { state: 'Maharashtra' })).status,
  ).toBe(400);

  for (const [code, name, type] of [
    ['2311', 'CGST payable', 'liability_current'],
    ['2312', 'SGST payable', 'liability_current'],
    ['2313', 'IGST payable', 'liability_current'],
    ['2316', 'IGST under reverse charge payable', 'liability_current'],
    ['1313', 'IGST input credit', 'asset_current'],
  ] as const) {
    const created = await call('POST', '/api/v1/models/account.account', 'maria', {
      code,
      name,
      type,
    });
    expectStatus(created, 201);
  }
  const accountRows = await call(
    'GET',
    '/api/v1/models/account.account?fields=id,code&limit=200',
    'maria',
  );
  for (const a of accountRows.json.items as { id: number; code: string }[]) accounts[a.code] = a.id;
  const journalRows = await call('GET', '/api/v1/models/account.journal?fields=id,code', 'maria');
  for (const j of journalRows.json.items as { id: number; code: string }[]) journals[j.code] = j.id;

  const tax = async (payload: Record<string, unknown>) => {
    const created = await call('POST', '/api/v1/models/account.tax', 'maria', payload);
    expectStatus(created, 201);
    return created.json.id as number;
  };
  gst = await tax({
    name: 'GST 18%',
    use: 'sale',
    rate: '0.18',
    components: {
      create: [
        { name: 'CGST 9%', code: 'CGST', share: '0.5', scope: 'intra', account: accounts['2311'] },
        { name: 'SGST 9%', code: 'SGST', share: '0.5', scope: 'intra', account: accounts['2312'] },
        { name: 'IGST 18%', code: 'IGST', share: '1', scope: 'inter', account: accounts['2313'] },
      ],
    },
  });
  gstReverse = await tax({
    name: 'GST 18% (reverse charge)',
    use: 'purchase',
    rate: '0.18',
    reverseCharge: true,
    components: {
      create: [
        {
          name: 'IGST 18% (reverse charge)',
          code: 'IGST',
          share: '1',
          scope: 'inter',
          account: accounts['1313'],
          reverseChargeAccount: accounts['2316'],
        },
        {
          name: 'IGST 18% (reverse charge, same state)',
          code: 'IGST',
          share: '1',
          scope: 'intra',
          account: accounts['1313'],
          reverseChargeAccount: accounts['2316'],
        },
      ],
    },
  });
  gstHalf = await tax({
    name: 'GST 5% (missing SGST)',
    use: 'sale',
    rate: '0.05',
    components: {
      create: [
        {
          name: 'CGST 2.5%',
          code: 'CGST',
          share: '0.5',
          scope: 'intra',
          account: accounts['2311'],
        },
      ],
    },
  });

  const ids = await host.server.shutro.bootstrap({ reason: 'test: data', company }, async (env) => {
    const [row] = await env.sql<{ id: number }>`SELECT id FROM res_currency WHERE name = 'INR'`;
    const created = await (
      env.model('res.partner' as never) as unknown as {
        create(rows: unknown[]): Promise<{ ids: number[] }>;
      }
    ).create([
      { name: 'Pune Retail', isCustomer: true, country: 'IN', state: 'IN-MH' },
      { name: 'Bengaluru Labs', isCustomer: true, country: 'IN', state: 'IN-KA' },
      { name: 'Boston Imports', isCustomer: true, country: 'US' },
      { name: 'Delhi Consultants', isVendor: true, country: 'IN', state: 'IN-DL' },
    ]);
    return { inr: row?.id as number, partners: created.ids };
  });
  inr = ids.inr;
  [partners['pune'], partners['bengaluru'], partners['boston'], partners['delhi']] =
    ids.partners as [number, number, number, number];
}, 180_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('within the state: CGST and SGST, the odd paisa on the first; the total keeps the tax whole', async () => {
  // 18 % of 100.05 = 18.009 → 18.01: 9.01 + 9.00.
  const { id, posted } = await post('out_invoice', partners['pune'] as number, '100.05', [gst]);
  expectStatus(posted, 200);
  expect(posted.json.placeOfSupply).toBe('IN-MH');
  // The document's total is exact (118.059); the posted receivable is rounded per tax (below).
  expect(Number(posted.json.amountTotal.amount)).toBeCloseTo(118.06, 2);
  expect(await generated(id)).toEqual([
    ['tax', '2311', '0.00', '9.01', 'CGST', false],
    ['tax', '2312', '0.00', '9.00', 'SGST', false],
    ['counterpart', '1100', '118.06', '0.00', null, false],
  ]);
});

test('between states and abroad: IGST; a place of supply set on the document wins', async () => {
  const karnataka = await post('out_invoice', partners['bengaluru'] as number, '1000', [gst]);
  expectStatus(karnataka.posted, 200);
  expect(karnataka.posted.json.placeOfSupply).toBe('IN-KA');
  expect(await generated(karnataka.id)).toEqual([
    ['tax', '2313', '0.00', '180.00', 'IGST', false],
    ['counterpart', '1100', '1180.00', '0.00', null, false],
  ]);
  const abroad = await post('out_invoice', partners['boston'] as number, '1000', [gst]);
  expect((await generated(abroad.id))[0]).toEqual(['tax', '2313', '0.00', '180.00', 'IGST', false]);
  // Delivered in Maharashtra to a Karnataka customer: within the state.
  const delivered = await post('out_invoice', partners['bengaluru'] as number, '1000', [gst], {
    placeOfSupply: 'IN-MH',
  });
  expect((await generated(delivered.id)).map((l) => l[4])).toEqual(['CGST', 'SGST', null]);
});

test('reverse charge on a bill: claimable and owed, net zero, outside the total', async () => {
  const { id, posted } = await post('in_invoice', partners['delhi'] as number, '1000', [
    gstReverse,
  ]);
  expectStatus(posted, 200);
  expect(posted.json.amountTotal.amount).toBe('1000.00'); // the supplier is not paid the tax
  expect(await generated(id)).toEqual([
    ['tax', '1313', '180.00', '0.00', 'IGST', true],
    ['tax', '2316', '0.00', '180.00', 'IGST', true],
    ['counterpart', '2000', '0.00', '1000.00', null, false],
  ]);
});

test('components that do not add up to the whole tax are refused at posting', async () => {
  const { posted } = await post('out_invoice', partners['pune'] as number, '100', [gstHalf]);
  expect(posted.status).toBe(422);
  expect(JSON.stringify(posted.json)).toContain('add up to 0.5, not 1');
});

test('a debit note posts like an invoice and adds to it; a vendor credit note settles on payables', async () => {
  const invoice = await post('out_invoice', partners['bengaluru'] as number, '500', []);
  const debit = await post('out_debit', partners['bengaluru'] as number, '50', [gst], {
    debitOf: invoice.id,
    ref: 'Price revision',
  });
  expectStatus(debit.posted, 200);
  expect(debit.posted.json.debitOf).toBe(invoice.id);
  expect(await generated(debit.id)).toEqual([
    ['tax', '2313', '0.00', '9.00', 'IGST', false],
    ['counterpart', '1100', '59.00', '0.00', null, false],
  ]);
  const listed = await call(
    'GET',
    `/api/v1/models/account.move?filter=${encodeURIComponent(JSON.stringify({ kind: 'out_debit' }))}&fields=id`,
    'maria',
  );
  expect((listed.json.items as Json[]).map((m) => m.id)).toEqual([debit.id]);

  const note = await post('in_refund', partners['delhi'] as number, '100', []);
  expectStatus(note.posted, 200);
  expect(await generated(note.id)).toEqual([
    ['counterpart', '2000', '100.00', '0.00', null, false],
  ]);
});
