/**
 * The documents on real PostgreSQL through the HTTP API (RFC 0009 step 2): a customer invoice with two lines and
 * VAT posts into the sales journal with one tax line per tax (rounded per document) and a receivable counterpart
 * per payment term part (with due dates); a credit note posts the other way; a vendor bill above the policy's
 * threshold waits for the accounting manager and is posted by the approval, a small one posts after submit; the
 * invoice PDF lists the product lines only; the chart's tax accounts are used.
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
import { accounting, addDays, fiscalYearOf } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [base, accounting];

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let host: AppHost;
let company: number;
let bdt: number;
let customer: number;
let vendor: number;
let vat15: number;
let vat5: number;
let purchaseVat: number;
let terms: Record<string, number> = {};
const accounts: Record<string, number> = {};
const journals: Record<string, number> = {};
const tokens = new Map<string, string>();

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function call(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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
const year = new Date().getUTCFullYear();
const transition = (id: number, name: string, as: string) =>
  call('POST', `/api/v1/models/account.move/${id}/transitions/${name}`, as);
const linesOf = (id: number, fields: string) =>
  call(
    'GET',
    `/api/v1/models/account.move.line?filter=${encodeURIComponent(JSON.stringify({ move: id }))}&fields=${fields}&order=id+asc`,
    'maria',
  );

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-documents-'));
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
    ['eve', ['account.invoicing']],
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
    const partners = await model('res.partner').create([
      { name: 'Bengal Steel', isCompany: true, isCustomer: true },
      { name: 'Jessore Jute Mills', isCompany: true, isVendor: true },
    ]);
    const taxes = await model('account.tax').create([
      { name: 'VAT 15 % (test)', use: 'sale', rate: '0.15' },
      { name: 'VAT 5 % (test)', use: 'sale', rate: '0.05' },
      { name: 'VAT 15 % purchases (test)', use: 'purchase', rate: '0.15' },
    ]);
    return {
      bdt: row?.id as number,
      customer: partners.ids[0] as number,
      vendor: partners.ids[1] as number,
      taxes: taxes.ids,
    };
  });
  bdt = ids.bdt;
  customer = ids.customer;
  vendor = ids.vendor;
  [vat15, vat5, purchaseVat] = ids.taxes as [number, number, number];
  // The taxes created after the chart get their accounts now (the chart links taxes without one).
  await host.server.shutro.bootstrap({ reason: 'test: tax accounts', company }, async (env) => {
    const [out] = await env.sql<{
      id: number;
    }>`SELECT id FROM account_account WHERE code = '2200' AND company_id = ${company}`;
    const [inp] = await env.sql<{
      id: number;
    }>`SELECT id FROM account_account WHERE code = '1300' AND company_id = ${company}`;
    await env.sql`UPDATE account_tax SET account_id = ${out?.id} WHERE use = 'sale' AND account_id IS NULL`;
    await env.sql`UPDATE account_tax SET account_id = ${inp?.id} WHERE use = 'purchase' AND account_id IS NULL`;
  });
  const accountRows = await call(
    'GET',
    '/api/v1/models/account.account?fields=id,code&limit=200',
    'maria',
  );
  for (const a of accountRows.json.items as { id: number; code: string }[]) accounts[a.code] = a.id;
  const journalRows = await call('GET', '/api/v1/models/account.journal?fields=id,code', 'maria');
  for (const j of journalRows.json.items as { id: number; code: string }[]) journals[j.code] = j.id;
  const termRows = await call('GET', '/api/v1/models/account.payment.term?fields=id,name', 'maria');
  terms = Object.fromEntries(
    (termRows.json.items as { id: number; name: string }[]).map((t) => [t.name, t.id]),
  );
}, 180_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('the payment terms are installed; a customer invoice posts with its tax lines and receivable parts', async () => {
  expect(Object.keys(terms).sort()).toEqual([
    '15 days',
    '30 days',
    '50 % now, 50 % in 30 days',
    'Immediate payment',
  ]);
  const created = await call('POST', '/api/v1/models/account.move', 'eve', {
    kind: 'out_invoice',
    journal: journals['INV'],
    partner: customer,
    currency: bdt,
    date: today,
    paymentTerm: terms['50 % now, 50 % in 30 days'],
    ref: 'PO-77',
    lines: {
      create: [
        {
          lineKind: 'product',
          name: 'Steel beams',
          quantity: '3',
          priceUnit: '1000.00',
          taxes: { set: [vat15] },
        },
        {
          lineKind: 'product',
          name: 'Delivery',
          quantity: '1',
          priceUnit: '333.33',
          discount: '10',
          taxes: { set: [vat15] },
        },
        {
          lineKind: 'product',
          name: 'Manual',
          quantity: '2',
          priceUnit: '10.005',
          taxes: { set: [vat5] },
        },
      ],
    },
  });
  expectStatus(created, 201);
  const id = created.json.id as number;
  // Totals from the product lines, in the document currency: 3000 + 299.997 + 20.01 = 3320.007 ≈ shown as money.
  expect(created.json.amountUntaxed).toMatchObject({ currency: 'BDT' });
  expect(Number(created.json.amountUntaxed.amount)).toBeCloseTo(3320.01, 2);
  expect(Number(created.json.amountTax.amount)).toBeCloseTo(496.0, 1); // 15 % of 3299.997 + 5 % of 20.01
  expect(created.json.name).toBe('/');

  // Invoicing users may not post; accountants may.
  expectStatus(await transition(id, 'post', 'eve'), 403);
  const posted = await transition(id, 'post', 'rahim');
  expectStatus(posted, 200);
  expect(posted.json.name).toBe(`INV/${year}/00001`);
  expect(posted.json.dateDue).toBe(addDays(today, 30)); // the latest part
  const lines = await linesOf(
    id,
    'lineKind,account,name,debit,credit,amountCurrency,dateMaturity,taxLineOf',
  );
  const by = (kind: string) => lines.json.items.filter((l: Json) => l.lineKind === kind);
  // Product lines credit the journal's income account; taxes credit the output VAT account; the receivable debits.
  expect(by('product')).toHaveLength(3);
  for (const l of by('product')) expect(l.account).toBe(accounts['4000']);
  expect(by('product').map((l: Json) => l.credit.amount)).toEqual(['3000.00', '300.00', '20.01']);
  const taxLines = by('tax');
  expect(taxLines).toHaveLength(2);
  expect(taxLines.map((l: Json) => [l.taxLineOf, l.credit.amount, l.account])).toEqual(
    expect.arrayContaining([
      [vat15, '495.00', accounts['2200']], // 15 % of (3000 + 300) = 495
      [vat5, '1.00', accounts['2200']], // 5 % of 20.01 = 1.0005 → 1.00
    ]),
  );
  const parts = by('counterpart');
  expect(parts).toHaveLength(2);
  expect(parts.map((l: Json) => [l.debit.amount, l.dateMaturity])).toEqual([
    ['1908.01', today], // 50 % of 3816.01 (the odd paisa on the first part)
    ['1908.00', addDays(today, 30)],
  ]);
  for (const l of parts) expect(l.account).toBe(accounts['1100']);
  // The product lines are the invoice's lines (the PDF and the reports read them), the generated ones are not.
  const invoiceLines = await call(
    'GET',
    `/api/v1/models/account.move.line?filter=${encodeURIComponent(JSON.stringify({ invoice: id }))}&fields=name`,
    'maria',
  );
  expect(invoiceLines.json.items.map((l: Json) => l.name).sort()).toEqual([
    'Delivery',
    'Manual',
    'Steel beams',
  ]);
  // The invoice PDF renders.
  const listed = await call('GET', '/api/v1/models/account.move/documents', 'maria');
  expectStatus(listed, 200);
  const templates = listed.json;
  const list = templates.templates as Json[];
  const template = list.find((t: Json) => t.key === 'accounting.invoice' || t.name === 'Invoice');
  expect(template, JSON.stringify(templates).slice(0, 300)).toBeDefined();
  const pdf = await host.server.app.inject({
    method: 'POST',
    url: `/api/v1/models/account.move/documents/${template.id}`,
    headers: { authorization: `Bearer ${tokens.get('maria') ?? ''}` },
    payload: { ids: [id] },
  });
  expect([200, 201], pdf.body.slice(0, 400)).toContain(pdf.statusCode);
  expect(pdf.headers['content-type']).toContain('pdf');
});

test('a credit note posts the other way; a reversal of an invoice is a credit note', async () => {
  const note = await call('POST', '/api/v1/models/account.move', 'rahim', {
    kind: 'out_refund',
    journal: journals['INV'],
    partner: customer,
    currency: bdt,
    date: today,
    lines: {
      create: [
        {
          lineKind: 'product',
          name: 'Returned beam',
          quantity: '1',
          priceUnit: '1000.00',
          taxes: { set: [vat15] },
        },
      ],
    },
  });
  expectStatus(note, 201);
  const posted = await transition(note.json.id, 'post', 'rahim');
  expectStatus(posted, 200);
  expect(posted.json.name).toBe(`INV/${year}/00002`);
  const lines = await linesOf(note.json.id, 'lineKind,debit,credit');
  const sum = (kind: string, side: 'debit' | 'credit') =>
    lines.json.items
      .filter((l: Json) => l.lineKind === kind)
      .reduce((n: number, l: Json) => n + Number(l[side].amount), 0);
  expect(sum('product', 'debit')).toBe(1000);
  expect(sum('tax', 'debit')).toBe(150);
  expect(sum('counterpart', 'credit')).toBe(1150);

  const invoice = await call(
    'GET',
    `/api/v1/models/account.move?filter=${encodeURIComponent(JSON.stringify({ name: `INV/${year}/00001` }))}&fields=id`,
    'rahim',
  );
  const reversed = await call(
    'POST',
    `/api/v1/accounting/moves/${invoice.json.items[0].id}/reverse`,
    'rahim',
    {
      post: true,
    },
  );
  expectStatus(reversed, 200);
  const reversal = await call(
    'GET',
    `/api/v1/models/account.move/${reversed.json.id}?fields=kind,amountTotal,state`,
    'rahim',
  );
  expect(reversal.json.kind).toBe('out_refund');
  expect(reversal.json.state).toBe('posted');
});

test('a vendor bill above the threshold waits for the manager; a small one posts after submit', async () => {
  const big = await call('POST', '/api/v1/models/account.move', 'rahim', {
    kind: 'in_invoice',
    journal: journals['BILL'],
    partner: vendor,
    currency: bdt,
    date: today,
    paymentTerm: terms['30 days'],
    lines: {
      create: [
        {
          lineKind: 'product',
          name: 'Raw jute',
          quantity: '2000',
          priceUnit: '100.00',
          taxes: { set: [purchaseVat] },
        },
      ],
    },
  });
  expectStatus(big, 201);
  expect(big.json.amountTotal.amount).toBe('230000.00');
  const submitted = await transition(big.json.id, 'submit', 'rahim');
  expectStatus(submitted, 200);
  expect(submitted.json.state).toBe('to_approve');
  expectStatus(await transition(big.json.id, 'post', 'rahim'), 409); // waiting for the manager
  const inbox = await call('GET', '/api/v1/approvals/inbox', 'maria');
  const request = inbox.json.requests.find((r: Json) => r.targetId === big.json.id);
  expect(request).toBeDefined();
  expectStatus(
    await call('POST', `/api/v1/approvals/requests/${request.id}/approve`, 'maria', {}),
    200,
  );
  const read = await call(
    'GET',
    `/api/v1/models/account.move/${big.json.id}?fields=state,name,dateDue`,
    'rahim',
  );
  expect(read.json.state).toBe('posted'); // the approval ran `post`
  expect(read.json.name).toBe(`BILL/${year}/00001`);
  expect(read.json.dateDue).toBe(addDays(today, 30));
  const lines = await linesOf(big.json.id, 'lineKind,account,debit,credit');
  const expense = lines.json.items.find((l: Json) => l.lineKind === 'product');
  expect(expense.account).toBe(accounts['6300']); // the purchases journal's default account
  expect(expense.debit.amount).toBe('200000.00');
  const payable = lines.json.items.find((l: Json) => l.lineKind === 'counterpart');
  expect(payable.account).toBe(accounts['2000']);
  expect(payable.credit.amount).toBe('230000.00');

  const small = await call('POST', '/api/v1/models/account.move', 'rahim', {
    kind: 'in_invoice',
    journal: journals['BILL'],
    partner: vendor,
    currency: bdt,
    date: today,
    lines: { create: [{ lineKind: 'product', name: 'Twine', quantity: '10', priceUnit: '50.00' }] },
  });
  expect((await transition(small.json.id, 'submit', 'rahim')).json.state).toBe('to_approve');
  const posted = await transition(small.json.id, 'post', 'rahim');
  expectStatus(posted, 200);
  expect(posted.json.name).toBe(`BILL/${year}/00002`);
});

test('a document without lines, without a partner, or with a tax without account is refused with the reason', async () => {
  const empty = await call('POST', '/api/v1/models/account.move', 'rahim', {
    kind: 'out_invoice',
    journal: journals['INV'],
    partner: customer,
    currency: bdt,
  });
  expect((await transition(empty.json.id, 'post', 'rahim')).json.detail).toContain(
    'no product lines',
  );
  const noPartner = await call('POST', '/api/v1/models/account.move', 'rahim', {
    kind: 'out_invoice',
    journal: journals['INV'],
    currency: bdt,
    lines: { create: [{ lineKind: 'product', name: 'x', quantity: '1', priceUnit: '1' }] },
  });
  expect((await transition(noPartner.json.id, 'post', 'rahim')).json.detail).toContain(
    'no partner',
  );
});

test('supplementary duty before VAT (RFC 0016): VAT on price + SD, one tax line each with its base', async () => {
  const sdAccount = await call('POST', '/api/v1/models/account.account', 'maria', {
    code: '2220',
    name: 'Supplementary duty payable',
    type: 'liability_current',
  });
  expectStatus(sdAccount, 201);
  accounts['2220'] = sdAccount.json.id;
  const sd = await call('POST', '/api/v1/models/account.tax', 'maria', {
    name: 'SD 20 % (test)',
    use: 'sale',
    rate: '0.2',
    sequence: 1,
    affectsBase: true,
    account: accounts['2220'],
  });
  expectStatus(sd, 201);
  const created = await call('POST', '/api/v1/models/account.move', 'rahim', {
    kind: 'out_invoice',
    journal: journals['INV'],
    partner: customer,
    currency: bdt,
    date: today,
    lines: {
      create: [
        {
          lineKind: 'product',
          name: 'Cigarettes',
          quantity: '1',
          priceUnit: '1000',
          // Given VAT first: the taxes apply by their sequence, SD first.
          taxes: { set: [vat15, sd.json.id] },
        },
      ],
    },
  });
  expectStatus(created, 201);
  expect(created.json.amountUntaxed.amount).toBe('1000.00');
  expect(created.json.amountTax.amount).toBe('380.00'); // 200 SD + 15 % of 1200
  expect(created.json.amountTotal.amount).toBe('1380.00');
  expectStatus(await transition(created.json.id, 'post', 'rahim'), 200);
  const lines = await linesOf(created.json.id, 'lineKind,taxLineOf,credit,taxBase,account');
  const taxes = lines.json.items.filter((l: Json) => l.lineKind === 'tax');
  expect(
    taxes.map((l: Json) => [l.taxLineOf, l.credit.amount, l.taxBase.amount, l.account]),
  ).toEqual(
    expect.arrayContaining([
      [sd.json.id, '200.00', '1000.00', accounts['2220']],
      [vat15, '180.00', '1200.00', accounts['2200']],
    ]),
  );
  expect(taxes).toHaveLength(2);
});

test('bank accounts give an invoice its payment details, in its currency, with the reference (RFC 0016)', async () => {
  for (const values of [
    {
      bank: 'Sonali Bank',
      branch: 'Motijheel',
      number: '0001-234567',
      routing: '200270522',
      currency: bdt,
    },
    { bank: 'City Bank', number: 'USD-99', swift: 'CIBLBDDH', currency: null },
  ])
    expectStatus(await call('POST', '/api/v1/models/res.bank.account', 'maria', values), 201);
  const created = await call('POST', '/api/v1/models/account.move', 'rahim', {
    kind: 'out_invoice',
    journal: journals['INV'],
    partner: customer,
    currency: bdt,
    date: today,
    lines: { create: [{ lineKind: 'product', name: 'Bags', quantity: '1', priceUnit: '100' }] },
  });
  const posted = await transition(created.json.id, 'post', 'rahim');
  const details = (
    await call(
      'GET',
      `/api/v1/models/account.move/${created.json.id}?fields=paymentDetails`,
      'rahim',
    )
  ).json.paymentDetails as string;
  expect(details.split('\n')).toEqual([
    'Sonali Bank, Motijheel · A/C 0001-234567 · Routing 200270522',
    'City Bank · A/C USD-99 · SWIFT CIBLBDDH',
    `Reference: ${posted.json.name}`,
  ]);
  // Bills have none.
  const bill = await call('POST', '/api/v1/models/account.move', 'rahim', {
    kind: 'in_invoice',
    journal: journals['BILL'],
    partner: vendor,
    currency: bdt,
    date: today,
    lines: { create: [{ lineKind: 'product', name: 'Jute', quantity: '1', priceUnit: '10' }] },
  });
  expect(
    (
      await call(
        'GET',
        `/api/v1/models/account.move/${bill.json.id}?fields=paymentDetails`,
        'rahim',
      )
    ).json.paymentDetails,
  ).toBe('');
});

test('fiscal years: one starting in July ends in June; the year a date falls in', async () => {
  const draft = await call('POST', '/api/v1/models/account.fiscal.year/onchange', 'maria', {
    values: { dateFrom: '2026-07-01' },
    changed: ['dateFrom'],
  });
  expect(draft.json.values).toMatchObject({ dateTo: '2027-06-30', name: '2026–27' });
  expect(fiscalYearOf('2026-03-15', 7)).toEqual({ dateFrom: '2025-07-01', dateTo: '2026-06-30' });
  expect(fiscalYearOf('2026-07-01', 7)).toEqual({ dateFrom: '2026-07-01', dateTo: '2027-06-30' });
  expect(fiscalYearOf('2026-12-31', 1)).toEqual({ dateFrom: '2026-01-01', dateTo: '2026-12-31' });
});
