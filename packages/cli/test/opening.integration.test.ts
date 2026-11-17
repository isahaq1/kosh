/**
 * The opening-balance kit (RFC 0036 §2.1) on real PostgreSQL, with Accounting, Stockroom and its valuation: the
 * template lists the company's accounts; a workbook with a wrong row is refused with every error on its row; a
 * check-only run proves the figures and keeps nothing; a load keeps the opening entry, the open documents and the
 * stock, every check equal; a second load changes nothing; a control total that differs refuses the load.
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
} from '@kosh/server';
import { type Driver, type Env, orm, pg } from '@kosh/server/orm';
import { type TestDatabase, testDatabase } from '@kosh/server/testing';
import { settings } from '@kosh/settings';
import { stock } from '@kosh/stock';
import { stockAccount } from '@kosh/stock_account';
import { afterAll, beforeAll, expect, test } from 'vitest';

const catalogue = [base, settings, accounting, stock, stockAccount];
const CUTOFF = '2026-06-30';

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
    admin: { login: 'admin', name: 'Administrator', password: 'correct horse battery' },
  }));
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
