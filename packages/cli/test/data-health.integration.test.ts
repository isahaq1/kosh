/**
 * Data health (RFC 0036 §2.3) on real PostgreSQL, with Accounting, Stockroom and its valuation: on a company whose
 * books and stock were loaded from an opening workbook, every check the modules declare holds; then each kind of
 * damage that can be done — stock that no transfer moved, a valuation the books do not hold — is found, named with
 * its records, and nothing is changed by looking; posted entries cannot be damaged at all (the database refuses).
 */
import {
  accounting,
  installChart,
  loadOpening,
  OPENING_SHEETS,
  readOpeningWorkbook,
} from '@kosh/accounting';
import { type Cell, workbook } from '@kosh/reporting';
import {
  base,
  checkData,
  type DataHealth,
  dataHealthText,
  lastDataHealth,
  runDataHealth,
} from '@kosh/server';
import type { Env } from '@kosh/server/orm';
import { type TestInstallation, testInstallation } from '@kosh/server/testing';
import { stock } from '@kosh/stock';
import { stockAccount } from '@kosh/stock_account';
import { afterAll, beforeAll, expect, test } from 'vitest';

let erp: TestInstallation;
type Model = {
  search(q: unknown): Promise<{ ids: number[] }>;
  create(v: unknown): Promise<unknown>;
};
const model = (env: Env, name: string) => env.model(name as never) as unknown as Model;
const system = <T>(fn: (env: Env) => Promise<T>) =>
  erp.host.server.shutro.bootstrap({ reason: 'test', company: erp.company }, fn);
const health = (): Promise<DataHealth> =>
  checkData(erp.host.server.shutro, erp.host.server.registry.loaded.modules, {
    company: erp.company,
  });
const check = (h: DataHealth, key: string) => {
  const found = h.checks.find((c) => c.key === key);
  if (found === undefined)
    throw new Error(`no check ${key}: ${h.checks.map((c) => c.key).join(', ')}`);
  return found;
};

beforeAll(async () => {
  erp = await testInstallation({ modules: [base, accounting, stock, stockAccount] });
  await system(async (env) => {
    await installChart(env as never, 'generic');
    await model(env, 'res.partner').create([
      { name: 'Meghna Stores', isCompany: true, isCustomer: true },
    ]);
    const [unit] = (await model(env, 'uom.uom').search({ where: {}, limit: 1 })).ids;
    await model(env, 'product.product').create([
      { name: 'Rice 50 kg', code: 'RICE50', kind: 'goods', uom: unit },
    ]);
    await env.flush();
  });
  // The company's books and stock: an opening, loaded and proved.
  const d = (decimal: string): Cell => ({ decimal });
  const opening = await loadOpening(
    erp.host.server.shutro,
    readOpeningWorkbook(
      workbook([
        {
          name: OPENING_SHEETS.balances,
          rows: [
            ['Account code', 'Account name', 'Debit', 'Credit'],
            ['1000', 'Cash', d('1000'), null],
            ['1100', 'Accounts receivable', d('700'), null],
            ['1200', 'Inventory', d('2400'), null],
            ['3000', 'Capital', null, d('4100')],
          ],
        },
        {
          name: OPENING_SHEETS.receivables,
          rows: [
            ['Kind', 'Number', 'Customer', 'Date', 'Due date', 'Amount left'],
            ['Invoice', 'INV-1', 'Meghna Stores', '2026-05-20', null, d('500')],
            ['Invoice', 'INV-2', 'Meghna Stores', '2026-06-01', null, d('200')],
          ],
        },
        {
          name: OPENING_SHEETS.payables,
          rows: [['Kind', 'Number', 'Vendor', 'Date', 'Due date', 'Amount left']],
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
            ['RICE50', null, 'WH/Stock', null, null, 1, d('2400')],
          ],
        },
        {
          name: OPENING_SHEETS.totals,
          rows: [
            ['What', 'Value'],
            ['Cut-off date', '2026-06-30'],
            ['Total receivable', d('700')],
            ['Total payable', null],
            ['Stock value', d('2400')],
          ],
        },
      ]),
    ),
    { company: erp.company, commit: true },
  );
  expect(opening.status, JSON.stringify(opening)).toBe('loaded');
}, 300_000);

afterAll(async () => {
  await erp?.close();
});

test('on sound data, every check the modules declare holds', async () => {
  const h = await health();
  expect(h.ok, dataHealthText(h)).toBe(true);
  expect(h.checks.map((c) => `${c.module}:${c.key}`)).toEqual([
    'base:archived_links',
    'accounting:entries_balanced',
    'accounting:documents_residual',
    'accounting:numbering',
    'stock:quants_ledger',
    'stock_account:stock_value_books',
    'stock_account:layers_quantity',
  ]);
  expect(dataHealthText(h)).toContain('✔ accounting: Every posted entry balances');
});

test('stock that no transfer moved is found, with its product', { retry: 0 }, async () => {
  await system(async (env) => {
    await env.sql`UPDATE stock_quant SET quantity = quantity + 5`;
  });
  const h = await health();
  expect(h.ok).toBe(false);
  expect(check(h, 'quants_ledger').findings).toEqual([
    expect.objectContaining({
      what: 'Rice 50 kg',
      detail: expect.stringMatching(/^6(\.0+)? on hand, but its transfers moved 1(\.0+)?$/),
      records: { model: 'product.product', ids: [expect.any(Number)] },
    }),
  ]);
  expect(check(h, 'layers_quantity').ok).toBe(false);
  expect(dataHealthText(h)).toContain(
    '✖ stock: The stock on hand is what the validated transfers moved — 1 finding(s)',
  );
  await system(async (env) => {
    await env.sql`UPDATE stock_quant SET quantity = quantity - 5`;
  });
  expect((await health()).ok).toBe(true);
});

test('a valuation the books do not hold is found', async () => {
  await system(async (env) => {
    await env.sql`UPDATE stock_valuation_layer SET value = value + 10 WHERE quantity > 0`;
  });
  const h = await health();
  expect(check(h, 'stock_value_books').findings[0]?.detail).toMatch(
    /the stock is worth 2410(\.0+)?, the stock accounts hold 2400(\.0+)?/,
  );
  await system(async (env) => {
    await env.sql`UPDATE stock_valuation_layer SET value = value - 10 WHERE quantity > 0`;
  });
});

test('a document that disagrees with its lines is found; a posted number cannot be changed at all', {
  retry: 0,
}, async () => {
  await system(async (env) => {
    await env.sql`UPDATE account_move SET amount_residual = amount_residual + 1 WHERE ref = 'INV-1'`;
  });
  const residual = check(await health(), 'documents_residual');
  expect(residual.findings).toHaveLength(1);
  expect(residual.findings[0]?.detail).toMatch(
    /the document says 501(\.0+)? is left, its lines 500(\.0+)?/,
  );
  expect(residual.findings[0]?.records).toEqual({
    model: 'account.move',
    ids: [expect.any(Number)],
  });
  await system(async (env) => {
    await env.sql`UPDATE account_move SET amount_residual = amount_residual - 1 WHERE ref = 'INV-1'`;
  });

  // What the numbering check guards against cannot be done with a plain UPDATE: a posted entry's number is
  // immutable in the database itself.
  await expect(
    system(async (env) => {
      await env.sql`UPDATE account_move SET name = 'INV/0000/00001' WHERE ref = 'INV-2'`;
    }),
  ).rejects.toThrow();
  const h = await health();
  expect(h.ok, dataHealthText(h)).toBe(true);
  expect(check(h, 'numbering').ok).toBe(true);
});

test('a draft that points at an archived contact is found; the result is kept for the doctor and Settings', {
  retry: 0,
}, async () => {
  const modules = erp.host.server.registry.loaded.modules;
  // Nothing recorded yet; a run records that every check holds.
  expect(await lastDataHealth(erp.host.server.driver)).toEqual([]);
  await runDataHealth(erp.host.server.shutro, modules, { company: erp.company });
  expect(await lastDataHealth(erp.host.server.driver)).toEqual([
    expect.objectContaining({ company: erp.company, ok: true, failing: [] }),
  ]);

  // A draft invoice of a customer who is then archived.
  await system(async (env) => {
    const made = (await model(env, 'res.partner').create([
      { name: 'Old Customer', isCompany: true },
    ])) as { ids: number[] };
    const [journal] = (await model(env, 'account.journal').search({ where: { type: 'sale' } })).ids;
    const [income] = (await model(env, 'account.account').search({ where: { code: '4000' } })).ids;
    const [{ currency_id: currency } = { currency_id: 0 }] = await env.sql<{ currency_id: number }>`
      SELECT currency_id FROM res_company WHERE id = ${erp.company}`;
    await model(env, 'account.move').create([
      {
        kind: 'out_invoice',
        journal,
        partner: made.ids[0],
        currency,
        date: '2026-11-01',
        lines: {
          create: [
            { lineKind: 'product', name: 'Rice', quantity: '1', priceUnit: '10', account: income },
          ],
        },
      },
    ]);
    await env.flush();
    await env.sql`UPDATE res_partner SET active = false WHERE id = ${made.ids[0] ?? 0}`;
  });
  const h = await runDataHealth(erp.host.server.shutro, modules, {
    company: erp.company,
    notify: true,
  });
  const archived = check(h, 'archived_links');
  expect(archived.ok, dataHealthText(h)).toBe(false);
  expect(archived.findings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        detail: expect.stringMatching(/^1 in Draft points at an archived Contact \(/),
        records: { model: 'account.move', ids: [expect.any(Number)] },
      }),
    ]),
  );
  expect(await lastDataHealth(erp.host.server.driver)).toEqual([
    expect.objectContaining({
      ok: false,
      failing: [expect.objectContaining({ module: 'base', key: 'archived_links' })],
    }),
  ]);
});
