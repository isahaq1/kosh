/**
 * The opening-balance kit (RFC 0036 §2.1) on real PostgreSQL, with Accounting, Stockroom and its valuation: the
 * template lists the company's accounts; a workbook with a wrong row is refused with every error on its row; a
 * check-only run proves the figures and keeps nothing; a load keeps the opening entry, the open documents and the
 * stock, every check equal; a second load changes nothing; a control total that differs refuses the load. Through
 * the API: only an Administrator checks, loads and undoes; Undo reverses every posting and takes the stock back out,
 * the company can load again, and the first posting after an opening ends its undo.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  accounting,
  installChart,
  loadOpening,
  OPENING_SHEETS,
  type OpeningReport,
  openingReportText,
  openingTemplate,
  readOpeningWorkbook,
  verifyOpening,
} from '@kosh/accounting';
import { readXlsx } from '@kosh/import';
import { type Cell, workbook } from '@kosh/reporting';
import {
  type AppHost,
  applyApps,
  base,
  createAppHost,
  installBase,
  installDefaults,
  prepareApps,
  recordInstalledApps,
  totp,
} from '@kosh/server';
import { type Driver, type Env, orm, pg } from '@kosh/server/orm';
import { type TestDatabase, testDatabase } from '@kosh/server/testing';
import { settings } from '@kosh/settings';
import { stock } from '@kosh/stock';
import { stockAccount } from '@kosh/stock_account';
import { afterAll, beforeAll, expect, test } from 'vitest';

const catalogue = [base, settings, accounting, stock, stockAccount];
const CUTOFF = '2026-06-30';
const PASSWORD = 'correct horse battery';
const SIGNING_KEY = 'a-signing-key-of-this-test';

let container: TestDatabase;
let driver: Driver;
let dir: string;
let host: AppHost;
let company: number;

type Rows = {
  ids: readonly number[];
  length: number;
  load(k: unknown): Promise<Rows>;
  read(k: string[]): Record<string, unknown>[];
};
type Model = { search(q: unknown): Promise<Rows>; create(v: unknown): Promise<Rows> };
const model = (env: Env, name: string) => env.model(name as never) as unknown as Model;
const system = <T>(fn: (env: Env) => Promise<T>) =>
  host.server.shutro.bootstrap({ reason: 'test', company }, fn);

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  // The installation's signing key: what the API loads is signed with it.
  process.env['KOSH_SIGNING_KEY'] = SIGNING_KEY;
  container = await testDatabase();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-opening-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({
      driver,
      catalogue,
      change: { install: ['settings', 'accounting', 'stock', 'stock_account'] },
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
  // An accounting manager is not an Administrator.
  await auth.createUser({
    login: 'maria',
    name: 'Maria',
    password: PASSWORD,
    company,
    companies: [company],
    groups: ['account.manager'],
  });
  await system((env) => installChart(env as never, 'generic'));
  await installDefaults(host.server.shutro, host.server.registry.loaded.modules, { company });
  await system(async (env) => {
    await model(env, 'res.partner').create([
      { name: 'Meghna Stores', isCompany: true, isCustomer: true },
      { name: 'Karnaphuli Mills', isCompany: true, isVendor: true },
    ]);
    const [unit] = (await model(env, 'uom.uom').search({ where: {}, limit: 1 })).ids;
    await model(env, 'product.product').create([
      { name: 'Rice 50 kg', code: 'RICE50', kind: 'goods', uom: unit },
      { name: 'Oil 5 L', code: 'OIL5', kind: 'goods', uom: unit, tracking: 'lot' },
    ]);
    const [wh] = (await model(env, 'stock.warehouse').search({ where: {}, limit: 1 })).ids;
    const [root] = (
      await model(env, 'stock.location').search({ where: { warehouse: wh, usage: 'internal' } })
    ).ids;
    await model(env, 'stock.location').create([
      { name: 'Shelf 1', usage: 'internal', warehouse: wh, parent: root, company },
    ]);
    // Checked in this scope (the closing flush would check without its rights).
    await env.flush();
  });
}, 300_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  await container?.stop();
});

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
    if (as === 'admin') {
      // An Administrator has the rights once their second factor is set up.
      const headers = { authorization: `Bearer ${token}` };
      const setup = await host.server.app.inject({
        method: 'POST',
        url: '/api/v1/auth/2fa/setup',
        headers,
      });
      await host.server.app.inject({
        method: 'POST',
        url: '/api/v1/auth/2fa/enable',
        headers,
        payload: { code: totp((setup.json() as { secret: string }).secret) },
      });
    }
    tokens.set(as, token);
  }
  const res = await host.server.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  const json = res.headers['content-type']?.toString().includes('json') ? res.json() : null;
  return { status: res.statusCode, json };
}

/** The stock is worth 100 × 2,400 + 40 × 650.125 + 10 × 700 = 273,005.00. */
const STOCK_VALUE = '273005';
/** A filled workbook; `change` adjusts it for a case. */
function filled(
  change: { receivable?: string; cash?: string; extraReceivable?: Cell[]; stockRow?: Cell[] } = {},
): Buffer {
  const d = (decimal: string): Cell => ({ decimal });
  return workbook([
    {
      name: OPENING_SHEETS.balances,
      rows: [
        ['Account code', 'Account name', 'Debit', 'Credit'],
        ['1000', 'Cash', d(change.cash ?? '50000'), null],
        ['1100', 'Accounts receivable', d('31500'), null],
        ['1200', 'Inventory', d('273005'), null],
        ['2000', 'Accounts payable', null, d('18000')],
        ['3000', 'Capital', null, d('300000')],
        ['4000', 'Sales', null, d('120000')],
        ['5000', 'Cost of goods sold', d('83495'), null],
        ['9999', 'An account with no balance', null, null],
      ],
    },
    {
      name: OPENING_SHEETS.receivables,
      rows: [
        ['Kind', 'Number', 'Customer', 'Date', 'Due date', 'Amount left'],
        ['Invoice', 'INV-0412', 'Meghna Stores', '2026-05-20', '2026-07-19', d('30000')],
        ['Invoice', 'INV-0431', 'Meghna Stores', new Date('2026-06-11T00:00:00Z'), null, d('4000')],
        ['Credit note', 'CN-0007', 'Meghna Stores', '2026-06-15', null, d('1500')],
        ['Other', 'ADV-12', 'Meghna Stores', null, null, d('-1000')],
        ...(change.extraReceivable === undefined ? [] : [change.extraReceivable]),
      ],
    },
    {
      name: OPENING_SHEETS.payables,
      rows: [
        ['Kind', 'Number', 'Vendor', 'Date', 'Due date', 'Amount left'],
        ['Bill', 'KM/88', 'Karnaphuli Mills', '2026-06-02', '2026-07-02', d('18000')],
      ],
    },
    {
      name: OPENING_SHEETS.stock,
      rows: [
        [
          'Product code',
          'Product',
          'Location',
          'Lot / serial number',
          'Expiry date',
          'Quantity',
          'Unit cost',
        ],
        ['RICE50', null, 'WH/Stock', null, null, 100, d('2400')],
        ['OIL5', null, 'WH/Stock/Shelf 1', 'L-2026-01', '2027-01-31', 40, d('650.125')],
        [null, 'Oil 5 L', 'WH/Stock/Shelf 1', 'L-2026-02', null, 10, d('700')],
        ...(change.stockRow === undefined ? [] : [change.stockRow]),
      ],
    },
    {
      name: OPENING_SHEETS.totals,
      rows: [
        ['What', 'Value'],
        ['Cut-off date', CUTOFF],
        ['Total receivable', d(change.receivable ?? '31500')],
        ['Total payable', d('18000')],
        ['Stock value', d(STOCK_VALUE)],
      ],
    },
  ]);
}
const run = (bytes: Buffer, commit: boolean): Promise<OpeningReport> =>
  loadOpening(host.server.shutro, readOpeningWorkbook(bytes), { company, commit });
const moves = () =>
  system(async (env) => (await model(env, 'account.move').search({ where: {} })).length);

test('the template lists the company’s accounts and the sheets to fill', async () => {
  const bytes = await system((env) => openingTemplate(env));
  const balances = readXlsx(bytes, OPENING_SHEETS.balances).rows;
  expect(balances[0]).toEqual(['Account code', 'Account name', 'Debit', 'Credit']);
  expect(balances.some((r) => r[0] === '1000' || r[0] === 1000)).toBe(true);
  expect(readXlsx(bytes, OPENING_SHEETS.totals).rows.map((r) => r[0])).toEqual([
    'What',
    'Cut-off date',
    'Total receivable',
    'Total payable',
    'Stock value',
  ]);
  // An empty template is refused with what is missing, not loaded.
  const report = await run(bytes, true);
  expect(report.status).toBe('refused');
  expect(openingReportText(report)).toContain('The cut-off date is needed');
});

test('a workbook with wrong rows is refused: every error on its row, nothing kept', async () => {
  const before = await moves();
  const report = await run(
    filled({
      extraReceivable: ['Invoice', 'INV-0500', 'Nobody Ltd', '2026-06-01', null, { decimal: '10' }],
      stockRow: ['RICE50', null, 'WH/Nowhere', 'LOT-X', null, 5, null],
    }),
    true,
  );
  const text = openingReportText(report);
  expect(report.status, text).toBe('refused');
  expect(report.errors, text).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        sheet: 'Receivables',
        row: 6,
        message: 'No contact named Nobody Ltd.',
      }),
      expect.objectContaining({
        sheet: 'Stock',
        row: 5,
        message: 'No internal location WH/Nowhere.',
      }),
    ]),
  );
  expect(await moves()).toBe(before);
  // A trial balance that does not balance is refused before anything is read from Kosh.
  const unbalanced = await run(filled({ cash: '50001' }), true);
  expect(openingReportText(unbalanced)).toContain(
    'The trial balance does not balance: debits less credits leave 1.00.',
  );
});

test('a control total that differs refuses the load, with both figures', async () => {
  const before = await moves();
  const report = await run(filled({ receivable: '32000' }), true);
  const text = openingReportText(report);
  expect(report.status, text).toBe('refused');
  expect(report.checks.find((c) => c.name === 'total receivable')?.differences, text).toEqual([
    { what: 'total receivable', workbook: '32000.00', kosh: '31500.00' },
  ]);
  expect(await moves()).toBe(before);
});

test('a check-only run proves the figures and keeps nothing', async () => {
  const before = await moves();
  const report = await run(filled(), false);
  const text = openingReportText(report);
  expect(report.status, text).toBe('checked');
  expect(report.ok, text).toBe(true);
  expect(text).toContain('nothing was kept');
  expect(await moves()).toBe(before);
});

test('the load: the opening entry, the open documents and the stock, every check equal', async () => {
  const report = await run(filled(), true);
  const text = openingReportText(report);
  expect(report.status, text).toBe('loaded');
  expect(report.documents, text).toBe(4);
  expect(report.adjustments, text).toBe(2);
  expect(
    report.checks.map((c) => `${c.name}:${c.ok}`),
    text,
  ).toEqual([
    'trial balance:true',
    'total receivable:true',
    'total payable:true',
    'opening balances account:true',
    'stock on hand:true',
    'stock value:true',
    'stock in the books:true',
  ]);
  expect(text).toContain('the stock accounts hold 273005.00, the stock');

  await system(async (env) => {
    // The open invoice is a posted invoice of the customer for what is left, due as it was.
    const invoice = (
      await (
        await model(env, 'account.move').search({ where: { ref: 'INV-0412' } })
      ).load(['kind', 'state', 'amountResidual', 'dateDue'])
    ).read(['kind', 'state', 'amountResidual', 'dateDue'])[0];
    expect(invoice?.['kind']).toBe('out_invoice');
    expect(invoice?.['state']).toBe('posted');
    const [left] = await env.sql<{ left: string }>`
      SELECT amount_residual::text AS left FROM account_move WHERE ref = 'INV-0412'`;
    expect(Number(left?.left)).toBe(30000);
    expect(String(invoice?.['dateDue'])).toBe('2026-07-19');
    // The lot is in its location with its expiry, valued at the cut-off.
    const lot = (
      await (
        await model(env, 'stock.lot').search({ where: { name: 'L-2026-01' } })
      ).load(['qtyOnHand', 'expiryDate'])
    ).read(['qtyOnHand', 'expiryDate'])[0];
    expect(String(lot?.['qtyOnHand'])).toBe('40');
    expect(String(lot?.['expiryDate'])).toBe('2027-01-31');
    const [late] = await env.sql<{ n: number }>`
      SELECT count(*)::int AS n FROM stock_valuation_layer WHERE date <> ${CUTOFF}::date`;
    expect(late?.n).toBe(0);
  });
});

test('a second load finds the opening and changes nothing; the checks stay equal', async () => {
  const before = await moves();
  const report = await run(filled(), true);
  const text = openingReportText(report);
  expect(report.status, text).toBe('already');
  expect(
    report.checks.every((c) => c.ok),
    text,
  ).toBe(true);
  expect(await moves()).toBe(before);
});

test('through the API, only an Administrator reads, checks, loads and undoes the opening', async () => {
  const content = filled().toString('base64');
  for (const [method, url, payload] of [
    ['GET', '/api/v1/accounting/opening', undefined],
    ['GET', '/api/v1/accounting/opening/template', undefined],
    ['POST', '/api/v1/accounting/opening/check', { content }],
    ['POST', '/api/v1/accounting/opening/load', { content }],
    ['POST', '/api/v1/accounting/opening/undo', { reason: 'I should not be able to' }],
  ] as const) {
    const refused = await call(method, url, 'maria', payload);
    expect(refused.status, url).toBe(403);
  }
  const state = await call('GET', '/api/v1/accounting/opening', 'admin');
  expect(state.status).toBe(200);
  expect(state.json.canUndo).toBe(true);
  expect(state.json.openings).toHaveLength(1);
  expect(state.json.openings[0]).toMatchObject({
    cutoff: CUTOFF,
    status: 'loaded',
    documents: 4,
    adjustments: 2,
  });
  expect(state.json.openings[0].workbookHash).toMatch(/^[0-9a-f]{64}$/);
  // Not a workbook: said, not a server failure.
  const junk = await call('POST', '/api/v1/accounting/opening/check', 'admin', {
    content: Buffer.from('not a workbook').toString('base64'),
  });
  expect(junk.status).toBe(400);
  const again = await call('POST', '/api/v1/accounting/opening/check', 'admin', { content });
  expect(again.status).toBe(200);
  expect(again.json.status).toBe('already');
});

test('Undo reverses every posting and takes the stock back out; the company can load again', async () => {
  const noReason = await call('POST', '/api/v1/accounting/opening/undo', 'admin', { reason: ' ' });
  expect(noReason.status).toBe(400);
  const undone = await call('POST', '/api/v1/accounting/opening/undo', 'admin', {
    reason: 'The stock sheet had last month’s count',
  });
  expect(undone.status, JSON.stringify(undone.json)).toBe(200);
  // The entry and four documents reversed, two adjustments taken back.
  expect(undone.json).toEqual({ cutoff: CUTOFF, reversed: 5, returned: 2 });

  await system(async (env) => {
    // Every account is back to zero, nothing stays open, no stock is left and it is worth nothing.
    const balances = await env.sql<{ code: string; balance: string }>`
      SELECT a.code, SUM(l.balance)::text AS balance
      FROM account_move_line l JOIN account_account a ON a.id = l.account_id
      WHERE l.posted GROUP BY a.code HAVING SUM(l.balance) <> 0`;
    expect(balances).toEqual([]);
    const [open] = await env.sql<{ n: number }>`
      SELECT count(*)::int AS n FROM account_move
      WHERE state = 'posted' AND kind <> 'entry' AND amount_residual <> 0`;
    expect(open?.n).toBe(0);
    const [left] = await env.sql<{ quantity: string | null; value: string | null }>`
      SELECT (SELECT SUM(quantity) FROM stock_quant)::text AS quantity,
             (SELECT SUM(value) FROM stock_valuation_layer)::text AS value`;
    expect(Number(left?.quantity ?? 0)).toBe(0);
    expect(Number(left?.value ?? 0)).toBe(0);
  });
  const state = await call('GET', '/api/v1/accounting/opening', 'admin');
  expect(state.json.canUndo).toBe(false);
  expect(state.json.openings[0]).toMatchObject({
    status: 'undone',
    undoneBy: 'Administrator',
    undoReason: 'The stock sheet had last month’s count',
  });
  const nothing = await call('POST', '/api/v1/accounting/opening/undo', 'admin', {
    reason: 'again',
  });
  expect(nothing.status).toBe(409);
  expect(nothing.json.type).toContain('no-opening');

  // The corrected workbook loads, every check equal again.
  const loaded = await call('POST', '/api/v1/accounting/opening/load', 'admin', {
    content: filled().toString('base64'),
  });
  expect(loaded.status).toBe(200);
  expect(loaded.json.status, JSON.stringify(loaded.json)).toBe('loaded');
  expect(loaded.json.checks.every((c: { ok: boolean }) => c.ok)).toBe(true);
});

test('the first posting after the opening ends its undo', async () => {
  await system(async (env) => {
    const account = async (code: string) =>
      (await model(env, 'account.account').search({ where: { code } })).ids[0];
    const [{ currency_id: currency } = { currency_id: 0 }] = await env.sql<{ currency_id: number }>`
      SELECT currency_id FROM res_company WHERE id = ${company}`;
    const [journal] = (await model(env, 'account.journal').search({ where: { type: 'general' } }))
      .ids;
    const made = (await model(env, 'account.move').create([
      {
        kind: 'entry',
        journal,
        date: '2026-07-01',
        ref: 'The first day in Kosh',
        currency,
        lines: {
          create: [
            { account: await account('6100'), name: 'Rent', debit: '500', credit: '0' },
            { account: await account('1000'), name: 'Rent', debit: '0', credit: '500' },
          ],
        },
      },
    ])) as unknown as { post(): Promise<void> };
    await made.post();
    await env.flush();
  });
  const state = await call('GET', '/api/v1/accounting/opening', 'admin');
  expect(state.json).toMatchObject({ canUndo: false, postedAfter: 1 });
  const refused = await call('POST', '/api/v1/accounting/opening/undo', 'admin', {
    reason: 'too late',
  });
  expect(refused.status).toBe(409);
  expect(refused.json.type).toContain('posted-after');
  expect(refused.json.detail).toContain('1 entry was posted after the opening');
});

test('the opening is sealed and signed; the certificate verifies, and says when anything was changed', async () => {
  // The opening loaded through the API (after the undo) carries the installation's signature.
  const state = await call('GET', '/api/v1/accounting/opening', 'admin');
  const loaded = state.json.openings.find((o: { status: string }) => o.status === 'loaded');
  expect(loaded.seal).toMatch(/^[0-9a-f]{64}$/);
  expect(loaded.signed).toBe(true);

  const verified = await call('GET', '/api/v1/accounting/opening/verify', 'admin');
  expect(verified.status).toBe(200);
  expect(verified.json.ok, JSON.stringify(verified.json)).toBe(true);
  expect(verified.json.checks.map((c: { name: string }) => c.name)).toEqual([
    'seal',
    'record',
    'signature',
  ]);
  expect((await call('GET', '/api/v1/accounting/opening/verify', 'maria')).status).toBe(403);

  const verify = (options: { signingKey?: string; workbook?: Uint8Array } = {}) =>
    system((env) => verifyOpening(env, { id: loaded.id, signingKey: SIGNING_KEY, ...options }));
  const detail = (r: Awaited<ReturnType<typeof verify>>, name: string) =>
    r?.checks.find((c) => c.name === name);
  // The workbook that was loaded is recognised; another one is not.
  expect(detail(await verify({ workbook: filled() }), 'workbook')?.ok).toBe(true);
  const other = await verify({ workbook: filled({ receivable: '32000' }) });
  expect(detail(other, 'workbook')).toMatchObject({
    ok: false,
    detail: 'this is not the workbook that was loaded',
  });
  // Another installation's key, or none, does not verify the signature.
  expect(detail(await verify({ signingKey: 'another-key' }), 'signature')?.ok).toBe(false);
  expect(detail(await verify({ signingKey: '' }), 'signature')?.detail).toContain('no signing key');

  // A changed record no longer says what was sealed; a changed seal content loses its seal.
  await system(async (env) => {
    await env.sql`UPDATE account_opening SET documents = 99 WHERE id = ${loaded.id}`;
  });
  const changed = await verify();
  expect(changed?.ok).toBe(false);
  expect(detail(changed, 'record')?.ok).toBe(false);
  expect(detail(changed, 'seal')?.ok).toBe(true);
  await system(async (env) => {
    await env.sql`UPDATE account_opening SET documents = 4,
      sealed = replace(sealed, '"documents":4', '"documents":5') WHERE id = ${loaded.id}`;
  });
  const forged = await verify();
  expect(detail(forged, 'seal')?.ok).toBe(false);
  expect(detail(forged, 'signature')?.ok).toBe(false);
  await system(async (env) => {
    await env.sql`UPDATE account_opening
      SET sealed = replace(sealed, '"documents":5', '"documents":4') WHERE id = ${loaded.id}`;
  });
  expect((await verify())?.ok).toBe(true);

  // What was loaded from the command line, without a key, is sealed and says it is not signed.
  const first = state.json.openings.find((o: { status: string }) => o.status === 'undone');
  expect(first.signed).toBe(false);
  const unsigned = await system((env) =>
    verifyOpening(env, { id: first.id, signingKey: SIGNING_KEY }),
  );
  expect(unsigned?.ok).toBe(true);
  expect(detail(unsigned, 'signature')?.detail).toContain('not signed');
});

test('the certificate prints from the opening: the figures, every check, the seal and the signature', async () => {
  const state = await call('GET', '/api/v1/accounting/opening', 'admin');
  const loaded = state.json.openings.find((o: { status: string }) => o.status === 'loaded');
  const templates = await call('GET', '/api/v1/models/account.opening/documents', 'admin');
  const template = templates.json.templates.find(
    (t: { key: string | null }) => t.key === 'accounting.opening_certificate',
  );
  expect(template, JSON.stringify(templates.json)).toBeDefined();
  const token = tokens.get('admin');
  const printed = await host.server.app.inject({
    method: 'POST',
    url: `/api/v1/models/account.opening/documents/${template.id}?format=html`,
    headers: { authorization: `Bearer ${token}` },
    payload: { ids: [loaded.id] },
  });
  expect(printed.statusCode, printed.body.slice(0, 300)).toBe(200);
  const html = printed.body;
  expect(html).toContain('Opening certificate');
  expect(html).toContain('Padma Traders');
  for (const check of ['trial balance', 'total receivable', 'stock on hand', 'stock value'])
    expect(html, check).toContain(check);
  expect(html).toContain('Equal');
  expect(html).toContain(loaded.seal);
  expect(html).toContain(loaded.workbookHash);
});
