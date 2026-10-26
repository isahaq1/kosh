/**
 * Payments and reconciliation on real PostgreSQL through the HTTP API (RFC 0009 step 3): registering a payment for
 * an invoice posts a bank entry and marks the invoice paid; a partial payment leaves a residual and a second
 * payment settles two invoices oldest due first; unreconciling reopens them; an open payment is matched by hand;
 * a USD invoice paid at another rate posts a realised exchange difference; a write-off settles a few paisa.
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
let usd: number;
let customer: number;
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
const plusDays = (days: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const move = (id: number, fields = 'name,state,amountTotal,amountResidual,paymentState,payments') =>
  call('GET', `/api/v1/models/account.move/${id}?fields=${fields}`, 'rahim');

/** A posted customer invoice of `amount` (no tax), due in `dueDays`. */
async function invoice(amount: string, dueDays = 0, currency = bdt): Promise<number> {
  const created = await call('POST', '/api/v1/models/account.move', 'rahim', {
    kind: 'out_invoice',
    journal: journals['INV'],
    partner: customer,
    currency,
    date: today,
    dateDue: plusDays(dueDays),
    lines: { create: [{ lineKind: 'product', name: 'Goods', quantity: '1', priceUnit: amount }] },
  });
  expectStatus(created, 201);
  expectStatus(
    await call('POST', `/api/v1/models/account.move/${created.json.id}/transitions/post`, 'rahim'),
    200,
  );
  return created.json.id as number;
}
const counterpartLine = async (moveId: number): Promise<number> => {
  const lines = await call(
    'GET',
    `/api/v1/models/account.move.line?filter=${encodeURIComponent(JSON.stringify({ move: moveId, lineKind: 'counterpart' }))}&fields=id`,
    'rahim',
  );
  return lines.json.items[0].id as number;
};

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-payments-'));
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
    const c = await model('res.currency').create([
      { name: 'USD', rounding: '0.01', decimalPlaces: 2 },
    ]);
    const p = await model('res.partner').create([
      { name: 'Bengal Steel', isCompany: true, isCustomer: true },
    ]);
    await model('res.currency.rate').create([
      { currency: c.ids[0], date: plusDays(-30), rate: '0.01' },
    ]); // 100 BDT per USD
    return { bdt: row?.id as number, usd: c.ids[0] as number, customer: p.ids[0] as number };
  });
  bdt = ids.bdt;
  usd = ids.usd;
  customer = ids.customer;
  const accountRows = await call(
    'GET',
    '/api/v1/models/account.account?fields=id,code&limit=200',
    'maria',
  );
  for (const a of accountRows.json.items as { id: number; code: string }[]) accounts[a.code] = a.id;
  const journalRows = await call('GET', '/api/v1/models/account.journal?fields=id,code', 'maria');
  for (const j of journalRows.json.items as { id: number; code: string }[]) journals[j.code] = j.id;
}, 180_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('register payment: a bank entry, the invoice paid; a partial payment leaves the residual', async () => {
  const inv = await invoice('1000');
  expect((await move(inv)).json).toMatchObject({
    paymentState: 'not_paid',
    amountResidual: { amount: '1000.00' },
  });
  // Invoicing users may register payments (their entry is posted on their behalf).
  const paid = await call('POST', '/api/v1/accounting/payments/register', 'eve', {
    moves: [inv],
    journal: journals['BNK'],
    memo: 'Cheque 17',
  });
  expectStatus(paid, 200);
  expect(paid.json.amount).toBe('1000');
  expect(paid.json.name).toMatch(/^BNK\//);
  const after = await move(inv);
  expect(after.json).toMatchObject({ paymentState: 'paid', amountResidual: { amount: '0.00' } });
  expect(after.json.payments).toEqual([paid.json.id]);
  const payment = await call(
    'GET',
    `/api/v1/models/account.payment/${paid.json.id}?fields=state,move,name,kind`,
    'rahim',
  );
  expect(payment.json).toMatchObject({ state: 'posted', kind: 'inbound' });
  const entryLines = await call(
    'GET',
    `/api/v1/models/account.move.line?filter=${encodeURIComponent(JSON.stringify({ move: payment.json.move }))}&fields=account,debit,credit,reconciled`,
    'rahim',
  );
  const bank = entryLines.json.items.find((l: Json) => l.account === accounts['1010']);
  const receivable = entryLines.json.items.find((l: Json) => l.account === accounts['1100']);
  expect(bank.debit.amount).toBe('1000.00');
  expect(receivable).toMatchObject({ credit: { amount: '1000.00' }, reconciled: true });

  const inv2 = await invoice('500');
  const half = await call('POST', '/api/v1/accounting/payments/register', 'rahim', {
    moves: [inv2],
    journal: journals['CSH'],
    amount: '200',
  });
  expectStatus(half, 200);
  expect((await move(inv2)).json).toMatchObject({
    paymentState: 'partial',
    amountResidual: { amount: '300.00' },
  });
  // The wrong direction is refused.
  const refused = await call('POST', '/api/v1/models/account.payment', 'rahim', {
    kind: 'outbound',
    partner: customer,
    journal: journals['BNK'],
    currency: bdt,
    amount: '10',
    documents: { set: [inv2] },
  });
  expectStatus(refused, 201);
  const posting = await call(
    'POST',
    `/api/v1/models/account.payment/${refused.json.id}/transitions/post`,
    'rahim',
  );
  expect(posting.status).toBe(422);
  expect(posting.json.detail).toContain('money to send');
});

test('one payment settles two invoices oldest due first; unreconciling reopens them', async () => {
  const later = await invoice('100', 30);
  const sooner = await invoice('100', 5);
  const paid = await call('POST', '/api/v1/accounting/payments/register', 'rahim', {
    moves: [later, sooner],
    journal: journals['BNK'],
    amount: '150',
  });
  expectStatus(paid, 200);
  expect((await move(sooner)).json).toMatchObject({ paymentState: 'paid' });
  expect((await move(later)).json).toMatchObject({
    paymentState: 'partial',
    amountResidual: { amount: '50.00' },
  });
  // Unreconcile the sooner invoice's receivable line: 100 of the payment is free again.
  const line = await counterpartLine(sooner);
  expectStatus(await call('POST', '/api/v1/accounting/unreconcile', 'eve', { lines: [line] }), 403); // needs account.reconcile
  const undone = await call('POST', '/api/v1/accounting/unreconcile', 'rahim', { lines: [line] });
  expectStatus(undone, 200);
  expect((await move(sooner)).json.paymentState).toBe('not_paid');
  expect((await move(later)).json.paymentState).toBe('partial'); // its own match stays
  // Match by hand: the payment line (open items of the receivable account) with both invoices again.
  const open = await call(
    'GET',
    `/api/v1/accounting/open-items?account=${accounts['1100']}&partner=${customer}`,
    'rahim',
  );
  expectStatus(open, 200);
  const payLine = open.json.items.find((i: Json) => Number(i.residual) < 0);
  expect(payLine).toBeDefined();
  const matched = await call('POST', '/api/v1/accounting/reconcile', 'rahim', {
    lines: [payLine.id, await counterpartLine(sooner), await counterpartLine(later)],
  });
  expectStatus(matched, 200);
  expect(matched.json.partials).toHaveLength(1); // the 100 freed by the unreconciliation
  expect((await move(sooner)).json.paymentState).toBe('paid');
  expect((await move(later)).json).toMatchObject({
    paymentState: 'partial',
    amountResidual: { amount: '50.00' },
  });
});

test('a USD invoice paid at another rate posts the exchange difference; a write-off settles the rest', async () => {
  const inv = await invoice('100', 0, usd); // 100 USD at 100 BDT/USD = 10,000 BDT receivable
  const invLine = await counterpartLine(inv);
  // A new rate: 110 BDT per USD (0.00909 USD per BDT).
  expectStatus(
    await call('POST', '/api/v1/models/res.currency.rate', 'maria', {
      currency: usd,
      date: today,
      rate: '0.009090909091',
    }),
    201,
  );
  const paid = await call('POST', '/api/v1/accounting/payments/register', 'rahim', {
    moves: [inv],
    journal: journals['BNK'],
  });
  expectStatus(paid, 200);
  const after = await move(inv);
  expect(after.json.paymentState).toBe('paid');
  const lineRead = await call(
    'GET',
    `/api/v1/models/account.move.line/${invLine}?fields=amountResidual,amountResidualCurrency,reconciled,fullReconcile`,
    'rahim',
  );
  expect(lineRead.json).toMatchObject({
    reconciled: true,
    amountResidual: { amount: '0.00' },
    amountResidualCurrency: { amount: '0.00' },
  });
  expect(lineRead.json.fullReconcile).not.toBeNull();
  // The payment entry is worth 11,000 BDT; the invoice 10,000: a 1,000 BDT gain was posted in MISC.
  const gains = await call(
    'GET',
    `/api/v1/models/account.move.line?filter=${encodeURIComponent(JSON.stringify({ account: accounts['4910'] }))}&fields=credit,debit`,
    'rahim',
  );
  expect(gains.json.items.map((l: Json) => l.credit.amount)).toEqual(['1000.00']);

  // A write-off: 99.98 paid on a 100.00 invoice, the 0.02 to bank charges.
  const small = await invoice('100');
  const almost = await call('POST', '/api/v1/accounting/payments/register', 'rahim', {
    moves: [small],
    journal: journals['BNK'],
    amount: '99.98',
  });
  expectStatus(almost, 200);
  expect((await move(small)).json).toMatchObject({
    paymentState: 'partial',
    amountResidual: { amount: '0.02' },
  });
  const written = await call('POST', '/api/v1/accounting/reconcile', 'rahim', {
    lines: [await counterpartLine(small)],
    writeOff: { account: accounts['6500'], label: 'Rounding' },
  });
  expectStatus(written, 200);
  expect((await move(small)).json.paymentState).toBe('paid');
});
