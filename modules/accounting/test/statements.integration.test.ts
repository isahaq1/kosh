/**
 * Bank statements on real PostgreSQL (RFC 0029 step 1): CSV, OFX and CAMT.053 import, duplicates skipped,
 * explained proposals, matching an invoice, writing off a fee, closing, a bank feed; only accountants reconcile.
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
import { accounting, parseCamt, parseOfx, registerBankFeed, testBankFeed } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [base, accounting];

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let host: AppHost;
let company: number;
let bdt: number;
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

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-statements-'));
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

const S = '/api/v1/accounting/statements/import';
const lineOf = async (statement: number) =>
  (
    await call(
      'GET',
      `/api/v1/models/account.bank.statement.line?filter=${encodeURIComponent(JSON.stringify({ statement }))}&fields=id,label,amount,state,payment,move&order=id+asc`,
      'rahim',
    )
  ).json.items as Json[];

test('a CSV statement: imported once, each line matched with an explained proposal or written off, then closed', async () => {
  const inv = await invoice('1200');
  const name = (await move(inv, 'name')).json.name as string;
  const csv = [
    'Date,Details,Amount,Ref',
    `${today},"Payment ${name} thank you",1200.00,TX1`,
    `${today},Bank charges,-50.00,TX2`,
  ].join('\n');
  const mapping = { date: 'Date', label: 'Details', amount: 'Amount', reference: 'Ref' };
  // Invoicing users do not reconcile the bank.
  expect(
    (
      await call('POST', S, 'eve', {
        journal: journals['BNK'],
        format: 'csv',
        content: csv,
        mapping,
      })
    ).status,
  ).toBe(403);
  const imported = await call('POST', S, 'rahim', {
    journal: journals['BNK'],
    format: 'csv',
    content: csv,
    mapping,
  });
  expectStatus(imported, 200);
  expect(imported.json).toMatchObject({ created: 2, skipped: 0 });
  const again = await call('POST', S, 'rahim', {
    journal: journals['BNK'],
    format: 'csv',
    content: csv,
    mapping,
  });
  expect(again.json).toMatchObject({ statement: null, created: 0, skipped: 2 });
  const statement = imported.json.statement as number;
  const [paymentLine, feeLine] = await lineOf(statement);

  const proposals = await call(
    'GET',
    `/api/v1/accounting/statement-lines/${paymentLine.id}/proposals`,
    'rahim',
  );
  expectStatus(proposals, 200);
  const [best] = proposals.json.proposals;
  expect(best).toMatchObject({ move: inv, name });
  expect(best.reasons).toEqual(expect.arrayContaining(['the same amount', `${name} in the label`]));

  expect(
    (
      await call('POST', `/api/v1/accounting/statement-lines/${paymentLine.id}/match`, 'eve', {
        moves: [inv],
      })
    ).status,
  ).toBe(403);
  const matched = await call(
    'POST',
    `/api/v1/accounting/statement-lines/${paymentLine.id}/match`,
    'rahim',
    { moves: [inv] },
  );
  expectStatus(matched, 200);
  expect((await move(inv)).json.paymentState).toBe('paid');
  // Not closed while a line is open.
  expect(
    (
      await call(
        'POST',
        `/api/v1/models/account.bank.statement/${statement}/transitions/close`,
        'rahim',
      )
    ).status,
  ).toBe(409);
  const fees = Object.entries(accounts).find(([code]) => code.startsWith('6'))?.[1];
  const written = await call(
    'POST',
    `/api/v1/accounting/statement-lines/${feeLine.id}/write-off`,
    'rahim',
    { account: fees, label: 'Bank charges' },
  );
  expectStatus(written, 200);
  const lines = await lineOf(statement);
  expect(lines.map((l) => l.state)).toEqual(['matched', 'matched']);
  expectStatus(
    await call(
      'POST',
      `/api/v1/models/account.bank.statement/${statement}/transitions/close`,
      'rahim',
    ),
    200,
  );
  expect(
    (
      await call('POST', `/api/v1/accounting/statement-lines/${paymentLine.id}/match`, 'rahim', {
        moves: [inv],
      })
    ).status,
  ).toBe(409);
});

test('OFX and CAMT.053 statements read as lines; a bank feed pulls new lines once', () => {
  const ofx = `<OFX><BANKTRANLIST>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261105<TRNAMT>1,500.00<FITID>F1<NAME>ACME LTD
</STMTTRN><STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261106120000<TRNAMT>-20<FITID>F2<MEMO>Fee
</STMTTRN></BANKTRANLIST></OFX>`;
  expect(parseOfx(ofx)).toEqual([
    { date: '2026-11-05', label: 'ACME LTD', amount: '1500.00', reference: 'F1' },
    { date: '2026-11-06', label: 'Fee', amount: '-20', reference: 'F2' },
  ]);
  const camt = `<Document><BkToCstmrStmt><Stmt>
<Ntry><Amt Ccy="BDT">700.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><BookgDt><Dt>2026-11-04</Dt></BookgDt>
<AcctSvcrRef>C1</AcctSvcrRef><NtryDtls><TxDtls><RmtInf><Ustrd>INV/2026/00001</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>
<Ntry><Amt Ccy="BDT">35.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>2026-11-04</Dt></BookgDt>
<AddtlNtryInf>SMS charges</AddtlNtryInf></Ntry>
</Stmt></BkToCstmrStmt></Document>`;
  expect(parseCamt(camt)).toEqual([
    { date: '2026-11-04', label: 'INV/2026/00001', amount: '700.00', reference: 'C1' },
    { date: '2026-11-04', label: 'SMS charges', amount: '-35.00' },
  ]);
});

test('a journal with a bank feed: each pull makes a statement of the lines since the last one', async () => {
  registerBankFeed(
    testBankFeed([
      { date: today, label: 'Feed in', amount: '300', reference: 'FD1' },
      { date: today, label: 'Feed out', amount: '-10', reference: 'FD2' },
    ]),
  );
  await host.server.shutro.bootstrap({ reason: 'test: feed', company }, async (env) => {
    await (
      env.model('account.journal' as never) as unknown as {
        browse(ids: number[]): { write(v: unknown): Promise<void> };
      }
    )
      .browse([journals['BNK'] as number])
      .write({ bankFeed: 'test' });
  });
  const first = await call('POST', `/api/v1/accounting/journals/${journals['BNK']}/pull`, 'rahim');
  expectStatus(first, 200);
  expect(first.json.created).toBe(2);
  const second = await call('POST', `/api/v1/accounting/journals/${journals['BNK']}/pull`, 'rahim');
  expect(second.json).toMatchObject({ statement: null, created: 0 });
});

test('reconciliation rules: run on import, first that applies wins, counted, a dry run, and every match undone', async () => {
  const inv = await invoice('800');
  const fees = Object.entries(accounts).find(([code]) => code.startsWith('6'))?.[1];
  const R = '/api/v1/models/account.reconcile.rule';
  // Accountants use rules; managers set them up.
  expect((await call('POST', R, 'rahim', { name: 'No', company, outcome: 'suggest' })).status).toBe(
    403,
  );
  // A write-off rule names its account.
  expect(
    (await call('POST', R, 'maria', { name: 'Bad', company, outcome: 'write_off' })).status,
  ).toBe(422);
  const sms = await call('POST', R, 'maria', {
    name: 'SMS charges',
    company,
    sequence: 1,
    labelContains: 'sms',
    direction: 'out',
    amountMax: '100',
    outcome: 'write_off',
    writeOffAccount: fees,
    writeOffLabel: 'SMS banking',
  });
  expectStatus(sms, 201);
  const pay = await call('POST', R, 'maria', {
    name: 'Customer payments',
    company,
    sequence: 2,
    direction: 'in',
    outcome: 'match',
  });
  expectStatus(pay, 201);
  const csv = [
    'Date,Details,Amount,Ref',
    `${today},Customer transfer,800.00,RR1`,
    `${today},SMS charges Oct,-15.00,RR2`,
    `${today},SMS charges big,-500.00,RR3`,
  ].join('\n');
  const imported = await call('POST', S, 'rahim', {
    journal: journals['BNK'],
    format: 'csv',
    content: csv,
    mapping: { date: 'Date', label: 'Details', amount: 'Amount', reference: 'Ref' },
  });
  expectStatus(imported, 200);
  expect(imported.json).toMatchObject({ created: 3, applied: 2 });
  const [payment, fee, big] = await lineOf(imported.json.statement as number);
  expect([payment.state, fee.state, big.state]).toEqual(['matched', 'matched', 'open']);
  expect((await move(inv)).json.paymentState).toBe('paid');
  const rules = await call('GET', `${R}?fields=id,hits&order=sequence+asc`, 'maria');
  expect(rules.json.items.map((r: Json) => r.hits)).toEqual([1, 1]);

  const dry = await call(
    'GET',
    `/api/v1/accounting/reconcile-rules/${sms.json.id}/dry-run?days=30`,
    'rahim',
  );
  expectStatus(dry, 200);
  expect(dry.json.hits).toBeGreaterThanOrEqual(1);
  expect(dry.json.rate).toBeGreaterThan(0);

  // Undone: the invoice is open again, the write-off reversed, both lines open.
  expect(
    (await call('POST', `/api/v1/accounting/statement-lines/${payment.id}/undo`, 'eve')).status,
  ).toBe(403);
  expectStatus(
    await call('POST', `/api/v1/accounting/statement-lines/${payment.id}/undo`, 'rahim'),
    200,
  );
  expect((await move(inv)).json.paymentState).not.toBe('paid');
  const feeMove = fee.move as number;
  expectStatus(
    await call('POST', `/api/v1/accounting/statement-lines/${fee.id}/undo`, 'rahim'),
    200,
  );
  expect((await move(feeMove, 'state')).json.state).toBe('posted');
  const after = await lineOf(imported.json.statement as number);
  expect(after.map((l) => l.state)).toEqual(['open', 'open', 'open']);
  expect(
    (await call('POST', `/api/v1/accounting/statement-lines/${fee.id}/undo`, 'rahim')).status,
  ).toBe(409);
  // Matched again by running the rules on demand.
  const run = await call('POST', '/api/v1/accounting/reconcile-rules/run', 'rahim');
  expectStatus(run, 200);
  expect((await move(inv)).json.paymentState).toBe('paid');
});
