/**
 * The opening-balance kit (RFC 0036 §2.1): a company starts in Kosh from its own figures, whatever it used before.
 *
 * One workbook — made by {@link openingTemplate} with the company's accounts already listed — holds the trial
 * balance at the cut-off, the unpaid customer and vendor documents, the stock by location and lot with its cost,
 * and the old system's control totals. {@link loadOpening} turns it into:
 *
 * - one posted **opening entry**, dated the cut-off, with every account but receivables and payables at its balance;
 * - a posted invoice, credit note, bill or refund for what is left of each open document, so it is paid and followed
 *   up in Kosh; other open amounts (an advance) as lines of the entry with their partner;
 * - with Stockroom, one validated **inventory adjustment per location**, lots on their lines; with stock valuation,
 *   valued at the cost given and dated the cut-off (what it posts is taken into account by the opening entry);
 *
 * all meeting on an **Opening balances** account that nets to zero. Then **the proof**, read from Kosh's posted books
 * in the same transaction: the trial balance account by account, the control totals, the stock's quantities and
 * value. A check-only run does everything and rolls it back; a load is kept only when every check is equal.
 *
 * A load is recorded as an `account.opening` with what it made and the proof it passed; {@link undoOpening} reverses
 * all of it until the first posting after it.
 *
 * Stockroom's models are reached by name (Accounting does not depend on it): the stock sheet is refused with the
 * reason when Stockroom is not installed.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readXlsx, type XlsxCell, xlsxSheetNames } from '@kosh/import';
import { workbook } from '@kosh/reporting';
import type { Env as AnyEnv, Shutro } from '@kosh/server/orm';
import { orm } from '@kosh/server/orm';

type Decimal = ReturnType<typeof orm.toDecimal>;
const ZERO = orm.toDecimal(0);
const amount = (d: Decimal): string => d.toFixed(2);

export const OPENING_SHEETS = {
  balances: 'Trial balance',
  receivables: 'Receivables',
  payables: 'Payables',
  stock: 'Stock',
  totals: 'Control totals',
} as const;
type SheetKey = keyof typeof OPENING_SHEETS;

const HEADERS: Readonly<Record<SheetKey, readonly string[]>> = {
  balances: ['Account code', 'Account name', 'Debit', 'Credit'],
  receivables: ['Kind', 'Number', 'Customer', 'Date', 'Due date', 'Amount left'],
  payables: ['Kind', 'Number', 'Vendor', 'Date', 'Due date', 'Amount left'],
  stock: [
    'Product code',
    'Product',
    'Location',
    'Lot / serial number',
    'Expiry date',
    'Quantity',
    'Unit cost',
  ],
  totals: ['What', 'Value'],
};
const TOTALS = {
  cutoff: 'Cut-off date',
  receivable: 'Total receivable',
  payable: 'Total payable',
  stock: 'Stock value',
} as const;
const RECEIVABLE_KINDS: Readonly<Record<string, string>> = {
  invoice: 'out_invoice',
  'credit note': 'out_refund',
  other: 'other',
};
const PAYABLE_KINDS: Readonly<Record<string, string>> = {
  bill: 'in_invoice',
  refund: 'in_refund',
  other: 'other',
};

export interface OpeningError {
  readonly sheet: string;
  /** The row in the sheet as a spreadsheet shows it (1 is the header); 0: the sheet as a whole. */
  readonly row: number;
  readonly message: string;
}

interface BalanceRow {
  readonly row: number;
  readonly code: string;
  readonly balance: Decimal;
}
interface DocumentRow {
  readonly row: number;
  readonly side: 'receivables' | 'payables';
  /** `out_invoice`, `out_refund`, `in_invoice`, `in_refund`, or `other` (a line of the opening entry). */
  readonly kind: string;
  readonly number: string;
  readonly partner: string;
  readonly date: string | null;
  readonly dueDate: string | null;
  readonly left: Decimal;
}
interface StockRow {
  readonly row: number;
  readonly code: string;
  readonly product: string;
  readonly location: string;
  readonly lot: string;
  readonly expiry: string | null;
  readonly quantity: Decimal;
  readonly unitCost: Decimal | null;
}

/** A workbook as read: its rows, typed, and what could not be read (each with its row). */
export interface OpeningData {
  readonly cutoff: string | null;
  readonly balances: readonly BalanceRow[];
  readonly documents: readonly DocumentRow[];
  readonly stock: readonly StockRow[];
  readonly controls: {
    readonly receivable: Decimal | null;
    readonly payable: Decimal | null;
    readonly stock: Decimal | null;
  };
  readonly errors: readonly OpeningError[];
  /** SHA-256 of the workbook, kept with the opening. */
  readonly hash: string;
}

export interface OpeningCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly summary: string;
  /** What differs, with the workbook's figure and Kosh's. */
  readonly differences: readonly {
    readonly what: string;
    readonly workbook: string;
    readonly kosh: string;
  }[];
}

export interface OpeningReport {
  readonly cutoff: string | null;
  /**
   * `loaded`: kept. `checked`: a check-only run, rolled back. `refused`: errors in the workbook or a check that
   * differs — nothing kept. `already`: an opening at this cut-off was loaded before; only the checks ran.
   */
  readonly status: 'loaded' | 'checked' | 'refused' | 'already';
  readonly errors: readonly OpeningError[];
  readonly entryLines: number;
  readonly documents: number;
  readonly adjustments: number;
  readonly checks: readonly OpeningCheck[];
  readonly ok: boolean;
}

// ---- the workbook

type Recs = {
  readonly ids: readonly number[];
  readonly length: number;
  load(keys: unknown): Promise<Recs>;
  read(keys: string[]): Record<string, unknown>[];
  post(): Promise<void>;
  write(values: unknown): Promise<void>;
  reserve(): Promise<void>;
  confirm(): Promise<void>;
  validate(): Promise<void>;
};
interface Model {
  search(q: unknown): Promise<Recs>;
  browse(ids: readonly number[]): Recs;
  create(values: unknown): Promise<Recs>;
}
const model = (env: AnyEnv, name: string): Model => env.model(name as never) as unknown as Model;
const idOf = (v: unknown): number | null =>
  typeof v === 'number'
    ? v
    : typeof v === 'object' && v !== null && 'id' in v
      ? Number((v as { id: unknown }).id)
      : null;

/** The workbook to fill: the company's accounts listed, the other sheets with their headers. */
export async function openingTemplate(env: AnyEnv): Promise<Buffer> {
  const accounts = (
    await (
      await model(env, 'account.account').search({ where: {}, order: ['code asc'] })
    ).load(['code', 'name'])
  ).read(['code', 'name']);
  const widths = (key: SheetKey) => HEADERS[key].map((h) => Math.max(14, h.length + 4));
  return workbook([
    {
      name: OPENING_SHEETS.balances,
      rows: [
        [...HEADERS.balances],
        ...accounts.map((a) => [String(a['code']), String(a['name']), null, null]),
      ],
      widths: [16, 44, 16, 16],
    },
    {
      name: OPENING_SHEETS.receivables,
      rows: [[...HEADERS.receivables]],
      widths: widths('receivables'),
    },
    { name: OPENING_SHEETS.payables, rows: [[...HEADERS.payables]], widths: widths('payables') },
    { name: OPENING_SHEETS.stock, rows: [[...HEADERS.stock]], widths: widths('stock') },
    {
      name: OPENING_SHEETS.totals,
      rows: [[...HEADERS.totals], ...Object.values(TOTALS).map((t) => [t, null])],
      widths: [24, 18],
    },
  ]);
}

const text = (c: XlsxCell | undefined): string =>
  c === null || c === undefined
    ? ''
    : c instanceof Date
      ? c.toISOString().slice(0, 10)
      : String(c).trim();
/** A cell as a date (`YYYY-MM-DD`), null when empty, undefined when it is not one. */
const dateOf = (c: XlsxCell | undefined): string | null | undefined => {
  if (c === null || c === undefined || c === '') return null;
  if (c instanceof Date) return c.toISOString().slice(0, 10);
  const t = String(c).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(t) && !Number.isNaN(Date.parse(t)) ? t : undefined;
};
/** A cell as an exact decimal with `scale` places, null when empty, undefined when it is not a number. */
const decimalOf = (c: XlsxCell | undefined, scale: number): Decimal | null | undefined => {
  if (c === null || c === undefined || c === '') return null;
  if (typeof c === 'number')
    return Number.isFinite(c) ? orm.toDecimal(c.toFixed(scale)) : undefined;
  const t = String(c).replaceAll(',', '').trim();
  return /^-?\d+(\.\d+)?$/.test(t) ? orm.toDecimal(t).toDecimalPlaces(scale) : undefined;
};

/** Reads a filled workbook: every row typed, every cell that cannot be read an error on its row. */
export function readOpeningWorkbook(bytes: Uint8Array): OpeningData {
  const errors: OpeningError[] = [];
  const names = new Set(xlsxSheetNames(bytes));
  const rowsOf = (key: SheetKey): XlsxCell[][] => {
    const name = OPENING_SHEETS[key];
    if (!names.has(name)) {
      if (key === 'balances' || key === 'totals')
        errors.push({
          sheet: name,
          row: 0,
          message: 'The sheet is missing: start from the template.',
        });
      return [];
    }
    const [header, ...rows] = readXlsx(bytes, name).rows;
    const expected = HEADERS[key];
    if (expected.some((h, i) => text(header?.[i]).toLowerCase() !== h.toLowerCase())) {
      errors.push({
        sheet: name,
        row: 1,
        message: `The columns must be: ${expected.join(', ')}.`,
      });
      return [];
    }
    return rows;
  };
  const filled = (r: XlsxCell[]) => r.some((c) => text(c) !== '');

  const balances: BalanceRow[] = [];
  for (const [i, r] of rowsOf('balances').entries()) {
    if (!filled(r)) continue;
    const row = i + 2;
    const debit = decimalOf(r[2], 2);
    const credit = decimalOf(r[3], 2);
    const sheet = OPENING_SHEETS.balances;
    if (
      debit === undefined ||
      credit === undefined ||
      debit?.isNegative() ||
      credit?.isNegative()
    ) {
      errors.push({
        sheet,
        row,
        message: 'Debit and Credit are amounts, zero or more.',
      });
      continue;
    }
    if (debit === null && credit === null) continue; // an account with no balance
    if (text(r[0]) === '') {
      errors.push({ sheet, row, message: 'The account code is missing.' });
      continue;
    }
    balances.push({ row, code: text(r[0]), balance: (debit ?? ZERO).minus(credit ?? ZERO) });
  }

  const documents: DocumentRow[] = [];
  for (const side of ['receivables', 'payables'] as const) {
    const sheet = OPENING_SHEETS[side];
    const kinds = side === 'receivables' ? RECEIVABLE_KINDS : PAYABLE_KINDS;
    for (const [i, r] of rowsOf(side).entries()) {
      if (!filled(r)) continue;
      const row = i + 2;
      const kind = kinds[text(r[0]).toLowerCase()];
      const date = dateOf(r[3]);
      const dueDate = dateOf(r[4]);
      const left = decimalOf(r[5], 2);
      const problems = [
        kind === undefined
          ? `Kind is one of: ${Object.keys(kinds)
              .map((k) => k[0]?.toUpperCase() + k.slice(1))
              .join(', ')}.`
          : null,
        text(r[1]) === '' ? 'The number is missing.' : null,
        text(r[2]) === ''
          ? `The ${side === 'receivables' ? 'customer' : 'vendor'} is missing.`
          : null,
        date === undefined || dueDate === undefined ? 'Dates are written YYYY-MM-DD.' : null,
        kind !== 'other' && date === null ? 'The date is missing.' : null,
        left === undefined || left === null || left.isZero()
          ? 'Amount left is an amount, not zero.'
          : kind !== 'other' && left.isNegative()
            ? 'Amount left is positive (a credit note or refund has its own kind).'
            : null,
      ].filter((p): p is string => p !== null);
      if (problems.length > 0 || kind === undefined || left === undefined || left === null) {
        errors.push({ sheet, row, message: problems.join(' ') });
        continue;
      }
      documents.push({
        row,
        side,
        kind,
        number: text(r[1]),
        partner: text(r[2]),
        date: date ?? null,
        dueDate: dueDate ?? null,
        left,
      });
    }
  }

  const stock: StockRow[] = [];
  for (const [i, r] of rowsOf('stock').entries()) {
    if (!filled(r)) continue;
    const row = i + 2;
    const sheet = OPENING_SHEETS.stock;
    const expiry = dateOf(r[4]);
    const quantity = decimalOf(r[5], 4);
    const unitCost = decimalOf(r[6], 6);
    const problems = [
      text(r[0]) === '' && text(r[1]) === '' ? 'The product code or name is missing.' : null,
      text(r[2]) === '' ? 'The location is missing.' : null,
      expiry === undefined ? 'The expiry date is written YYYY-MM-DD.' : null,
      quantity === undefined || quantity === null || !quantity.isPositive() || quantity.isZero()
        ? 'Quantity is more than zero.'
        : null,
      unitCost === undefined || unitCost?.isNegative()
        ? 'Unit cost is an amount, zero or more.'
        : null,
    ].filter((p): p is string => p !== null);
    if (
      problems.length > 0 ||
      quantity === undefined ||
      quantity === null ||
      unitCost === undefined
    ) {
      errors.push({ sheet, row, message: problems.join(' ') });
      continue;
    }
    stock.push({
      row,
      code: text(r[0]),
      product: text(r[1]),
      location: text(r[2]),
      lot: text(r[3]),
      expiry: expiry ?? null,
      quantity,
      unitCost,
    });
  }

  const totals = new Map<string, { row: number; cell: XlsxCell | undefined }>();
  rowsOf('totals').forEach((r, i) => {
    totals.set(text(r[0]).toLowerCase(), { row: i + 2, cell: r[1] });
  });
  const total = (label: string): Decimal | null => {
    const t = totals.get(label.toLowerCase());
    const value = decimalOf(t?.cell, 2);
    if (value === undefined)
      errors.push({
        sheet: OPENING_SHEETS.totals,
        row: t?.row ?? 0,
        message: `${label} is an amount.`,
      });
    return value ?? null;
  };
  const cutoffCell = totals.get(TOTALS.cutoff.toLowerCase());
  const cutoff = dateOf(cutoffCell?.cell);
  if (cutoff === undefined || cutoff === null)
    errors.push({
      sheet: OPENING_SHEETS.totals,
      row: cutoffCell?.row ?? 0,
      message: 'The cut-off date is needed, written YYYY-MM-DD.',
    });

  const debits = balances.reduce((s, b) => s.plus(b.balance), ZERO);
  if (balances.length === 0)
    errors.push({ sheet: OPENING_SHEETS.balances, row: 0, message: 'No account has a balance.' });
  else if (!debits.isZero())
    errors.push({
      sheet: OPENING_SHEETS.balances,
      row: 0,
      message: `The trial balance does not balance: debits less credits leave ${amount(debits)}.`,
    });

  return {
    cutoff: cutoff ?? null,
    balances,
    documents,
    stock,
    controls: {
      receivable: total(TOTALS.receivable),
      payable: total(TOTALS.payable),
      stock: total(TOTALS.stock),
    },
    errors,
    hash: createHash('sha256').update(bytes).digest('hex'),
  };
}

// ---- the load

export interface OpeningOptions {
  readonly company: number;
  /** Keep it (when every check is equal). Default false: a check-only run, rolled back. */
  readonly commit?: boolean;
  /** Who loads it (kept on the opening). */
  readonly user?: number;
  /** The installation's signing key (`KOSH_SIGNING_KEY`): the opening's seal is signed with it. */
  readonly signingKey?: string;
}

/** Thrown to roll a run back; never escapes. */
class RollBack extends Error {}

const RECEIVABLE_PAYABLE = ['asset_receivable', 'liability_payable'];

/** Checks a workbook and, with `commit`, loads it: as the system, with its reason in the audit log. */
export async function loadOpening(
  shutro: Shutro,
  data: OpeningData,
  options: OpeningOptions,
  errorText: (e: unknown) => string = (e) => (e instanceof Error ? e.message : String(e)),
): Promise<OpeningReport> {
  const commit = options.commit === true;
  const errors: OpeningError[] = [...data.errors];
  const cutoff = data.cutoff;
  const refused = (): OpeningReport => ({
    cutoff,
    status: 'refused',
    errors,
    entryLines: 0,
    documents: 0,
    adjustments: 0,
    checks: [],
    ok: false,
  });
  if (errors.length > 0 || cutoff === null) return refused();

  const registry = shutro.registry;
  const has = (name: string, field?: string): boolean => {
    const m = registry?.models.get(name);
    return m !== undefined && (field === undefined || field in m.fieldOrigins);
  };
  const stockroom = has('stock.picking') && has('stock.quant');
  const valued = has('stock.move', 'unitCost') && has('stock.picking', 'accountingDate');
  if (data.stock.length > 0 && !stockroom) {
    errors.push({
      sheet: OPENING_SHEETS.stock,
      row: 0,
      message: 'Stockroom is not installed: install it, or leave the Stock sheet empty.',
    });
    return refused();
  }

  let entryLines = 0;
  let documents = 0;
  let adjustments = 0;
  let checks: OpeningCheck[] = [];
  let already = false;
  const madeMoves: number[] = [];
  const madePickings: number[] = [];

  const run = async (env: AnyEnv): Promise<void> => {
    const company = env.companyId as number;
    already =
      (
        await model(env, 'account.opening').search({
          where: { cutoff, status: 'loaded' },
          limit: 1,
        })
      ).length > 0;

    // ---- look everything up, every miss an error on its row
    const accountRows = (
      await (await model(env, 'account.account').search({ where: {} })).load(['code', 'type'])
    ).read(['id', 'code', 'type']);
    const accounts = new Map(
      accountRows.map((a) => [
        String(a['code']),
        { id: a['id'] as number, type: String(a['type']) },
      ]),
    );
    const target = new Map<number, Decimal>();
    for (const b of data.balances) {
      const a = accounts.get(b.code);
      if (a === undefined) {
        errors.push({
          sheet: OPENING_SHEETS.balances,
          row: b.row,
          message: `No account ${b.code} in the chart: add it in Accounting, or correct the code.`,
        });
        continue;
      }
      target.set(a.id, (target.get(a.id) ?? ZERO).plus(b.balance));
    }
    const one = async (
      name: string,
      where: Record<string, unknown>,
      sheet: string,
      row: number,
      what: string,
    ): Promise<number | null> => {
      const found = await model(env, name).search({ where, limit: 2 });
      if (found.length === 1) return found.ids[0] as number;
      errors.push({
        sheet,
        row,
        message:
          found.length === 0 ? `No ${what}.` : `More than one ${what}: make the name unique.`,
      });
      return null;
    };
    const [companyRow] = (
      await model(env, 'res.company')
        .browse([company])
        .load(['currency', 'accountReceivable', 'accountPayable'])
    ).read(['currency', 'accountReceivable', 'accountPayable']);
    const currency = idOf(companyRow?.['currency']);
    const partners = new Map<
      string,
      { id: number; receivable: number | null; payable: number | null }
    >();
    for (const d of data.documents) {
      const sheet = OPENING_SHEETS[d.side];
      if (!partners.has(d.partner)) {
        const id = await one(
          'res.partner',
          { name: d.partner },
          sheet,
          d.row,
          `contact named ${d.partner}`,
        );
        if (id === null) continue;
        const [p] = (
          await model(env, 'res.partner').browse([id]).load(['receivableAccount', 'payableAccount'])
        ).read(['receivableAccount', 'payableAccount']);
        partners.set(d.partner, {
          id,
          receivable: idOf(p?.['receivableAccount']) ?? idOf(companyRow?.['accountReceivable']),
          payable: idOf(p?.['payableAccount']) ?? idOf(companyRow?.['accountPayable']),
        });
      }
    }
    const stockLines: {
      row: StockRow;
      product: number;
      location: number;
      tracked: boolean;
      label: string;
    }[] = [];
    for (const s of data.stock) {
      const sheet = OPENING_SHEETS.stock;
      const product =
        s.code !== ''
          ? await one(
              'product.product',
              { code: s.code },
              sheet,
              s.row,
              `product with the code ${s.code}`,
            )
          : await one(
              'product.product',
              { name: s.product },
              sheet,
              s.row,
              `product named ${s.product}`,
            );
      const location = await one(
        'stock.location',
        { fullName: s.location, usage: 'internal' },
        sheet,
        s.row,
        `internal location ${s.location}`,
      );
      if (product === null || location === null) continue;
      const [p] = (
        await model(env, 'product.product').browse([product]).load(['tracking', 'kind'])
      ).read(['tracking', 'kind']);
      const tracked = p?.['tracking'] === 'lot' || p?.['tracking'] === 'serial';
      if (p?.['kind'] !== 'goods')
        errors.push({ sheet, row: s.row, message: 'A service is not kept in stock.' });
      else if (tracked && s.lot === '')
        errors.push({
          sheet,
          row: s.row,
          message: 'The product is tracked: its lot or serial number is needed.',
        });
      else if (!tracked && s.lot !== '')
        errors.push({
          sheet,
          row: s.row,
          message:
            'The product is not tracked: set its tracking in Products, or leave the lot empty.',
        });
      else
        stockLines.push({
          row: s,
          product,
          location,
          tracked,
          label: [s.code || s.product, s.location, s.lot].filter((t) => t !== '').join(' · '),
        });
    }
    if (errors.length > 0) throw new RollBack();

    if (!already) {
      // ---- the stock first: its adjustments post at the cut-off, and the opening entry takes them into account
      const adjustment =
        stockLines.length === 0
          ? undefined
          : (
              await model(env, 'stock.location').search({
                where: { usage: 'adjustment', name: 'Inventory adjustment' },
                limit: 1,
              })
            ).ids[0];
      const byLocation = new Map<number, typeof stockLines>();
      for (const l of stockLines)
        byLocation.set(l.location, [...(byLocation.get(l.location) ?? []), l]);
      for (const [location, lines] of byLocation) {
        if (adjustment === undefined) {
          errors.push({
            sheet: OPENING_SHEETS.stock,
            row: 0,
            message: 'There is no inventory adjustment location: upgrade the Stockroom app.',
          });
          break;
        }
        try {
          await env.transaction(async (tx) => {
            const moves = new Map<number, { quantity: Decimal; value: Decimal; costed: boolean }>();
            const lotLines: { product: number; lot: number; quantity: string }[] = [];
            for (const l of lines) {
              const m = moves.get(l.product);
              moves.set(l.product, {
                quantity: (m?.quantity ?? ZERO).plus(l.row.quantity),
                value: (m?.value ?? ZERO).plus(l.row.quantity.times(l.row.unitCost ?? ZERO)),
                costed: (m?.costed ?? true) && l.row.unitCost !== null,
              });
              if (!l.tracked) continue;
              const found = await model(tx, 'stock.lot').search({
                where: { product: l.product, name: l.row.lot },
                limit: 1,
              });
              const lot =
                found.ids[0] ??
                (
                  await model(tx, 'stock.lot').create([
                    {
                      name: l.row.lot,
                      product: l.product,
                      company,
                      ...(l.row.expiry === null ? {} : { expiryDate: l.row.expiry }),
                    },
                  ])
                ).ids[0];
              lotLines.push({
                product: l.product,
                lot: lot as number,
                quantity: l.row.quantity.toString(),
              });
            }
            const made = await model(tx, 'stock.picking').create([
              {
                kind: 'adjustment',
                company,
                source: adjustment,
                destination: location,
                origin: `Opening stock at ${cutoff}`,
                ...(valued ? { accountingDate: cutoff } : {}),
                moves: {
                  create: [...moves].map(([product, m]) => ({
                    product,
                    quantity: m.quantity.toString(),
                    ...(valued && m.costed
                      ? { unitCost: m.value.div(m.quantity).toDecimalPlaces(6).toString() }
                      : {}),
                  })),
                },
                lotLines: { create: lotLines },
              },
            ]);
            await made.confirm();
            await made.validate();
            madePickings.push(made.ids[0] as number);
          });
          adjustments += 1;
        } catch (error) {
          errors.push({
            sheet: OPENING_SHEETS.stock,
            row: lines[0]?.row.row ?? 0,
            message: `${lines[0]?.row.location}: ${errorText(error)}`,
          });
        }
      }

      // ---- the account both sides meet on
      const clearing =
        accounts.get('OPENING')?.id ??
        ((
          await model(env, 'account.account').create([
            { code: 'OPENING', name: 'Opening balances', type: 'equity' },
          ])
        ).ids[0] as number);
      const journal = async (tx: AnyEnv, type: string): Promise<number> => {
        const found = await model(tx, 'account.journal').search({ where: { type }, limit: 1 });
        if (found.length === 0)
          throw new Error(`No ${type} journal: install a chart of accounts first.`);
        return found.ids[0] as number;
      };

      // ---- the opening entry: each account at its balance, less what Kosh already posted by the cut-off
      const typeOf = new Map(accountRows.map((a) => [a['id'] as number, String(a['type'])]));
      const posted = new Map<number, Decimal>();
      for (const r of await env.sql<{ account_id: number; balance: string }>`
        SELECT l.account_id, SUM(l.balance)::text AS balance
        FROM account_move_line l JOIN account_move m ON m.id = l.move_id
        WHERE l.posted AND m.company_id = ${company} AND l.date <= ${cutoff}::date
        GROUP BY l.account_id`)
        posted.set(r.account_id, orm.toDecimal(r.balance));
      const lines: { account: number; partner?: number; name: string; balance: Decimal }[] = [];
      for (const account of new Set([...target.keys(), ...posted.keys()])) {
        if (account === clearing || RECEIVABLE_PAYABLE.includes(typeOf.get(account) ?? ''))
          continue;
        const balance = (target.get(account) ?? ZERO).minus(posted.get(account) ?? ZERO);
        if (!balance.isZero()) lines.push({ account, name: 'Opening balance', balance });
      }
      for (const d of data.documents) {
        if (d.kind !== 'other') continue;
        const p = partners.get(d.partner);
        const account = d.side === 'receivables' ? p?.receivable : p?.payable;
        if (p === undefined || account === null || account === undefined) {
          errors.push({
            sheet: OPENING_SHEETS[d.side],
            row: d.row,
            message: `The company has no ${d.side === 'receivables' ? 'receivable' : 'payable'} account.`,
          });
          continue;
        }
        // A receivable left is a debit; a payable left a credit.
        lines.push({
          account,
          partner: p.id,
          name: `Open item ${d.number}`,
          balance: d.side === 'receivables' ? d.left : d.left.negated(),
        });
      }
      const total = lines.reduce((s, l) => s.plus(l.balance), ZERO);
      if (!total.isZero())
        lines.push({ account: clearing, name: 'Opening balances', balance: total.negated() });
      try {
        await env.transaction(async (tx) => {
          const made = await model(tx, 'account.move').create([
            {
              kind: 'entry',
              journal: await journal(tx, 'general'),
              date: cutoff,
              ref: `Opening balances at ${cutoff}`,
              currency,
              lines: {
                create: lines.map((l) => ({
                  account: l.account,
                  ...(l.partner === undefined ? {} : { partner: l.partner }),
                  name: l.name,
                  debit: amount(l.balance.isPositive() ? l.balance : ZERO),
                  credit: amount(l.balance.isNegative() ? l.balance.negated() : ZERO),
                })),
              },
            },
          ]);
          await made.post();
          madeMoves.unshift(made.ids[0] as number);
        });
        entryLines = lines.length;
      } catch (error) {
        errors.push({
          sheet: OPENING_SHEETS.balances,
          row: 0,
          message: `The opening entry: ${errorText(error)}`,
        });
      }

      // ---- the open documents, each for what is left
      for (const d of data.documents) {
        if (d.kind === 'other') continue;
        const p = partners.get(d.partner);
        if (p === undefined) continue;
        try {
          await env.transaction(async (tx) => {
            const made = await model(tx, 'account.move').create([
              {
                kind: d.kind,
                journal: await journal(tx, d.side === 'receivables' ? 'sale' : 'purchase'),
                partner: p.id,
                date: d.date,
                ...(d.dueDate === null ? {} : { dateDue: d.dueDate }),
                ref: d.number,
                currency,
                lines: {
                  create: [
                    {
                      lineKind: 'product',
                      name: `Open balance of ${d.number}`,
                      quantity: '1',
                      priceUnit: amount(d.left),
                      account: clearing,
                    },
                  ],
                },
              },
            ]);
            await made.post();
            madeMoves.push(made.ids[0] as number);
          });
          documents += 1;
        } catch (error) {
          errors.push({
            sheet: OPENING_SHEETS[d.side],
            row: d.row,
            message: `${d.number}: ${errorText(error)}`,
          });
        }
      }
      if (errors.length > 0) throw new RollBack();
    }

    // ---- the proof, from Kosh's posted books
    checks = await prove(env, data, cutoff, target, stockLines, stockroom, valued);
    if (already || !commit || checks.some((c) => !c.ok)) throw new RollBack();

    // ---- kept: the opening on record, with what it made
    const [last] = await env.sql<{ id: number | null }>`
      SELECT max(id) AS id FROM account_move WHERE company_id = ${company}`;
    // The seal: what was loaded and proved, fixed as text; signed when the installation has a key.
    const loadedAt = env.now();
    const sealed = JSON.stringify({
      company,
      cutoff,
      workbook: data.hash,
      entryLines,
      documents,
      adjustments,
      checks: checks.map((c) => ({ name: c.name, ok: c.ok, summary: c.summary })),
      loadedAt: loadedAt.toISOString(),
      loadedBy: options.user ?? null,
    });
    await model(env, 'account.opening').create([
      {
        sealed,
        seal: sealOf(sealed),
        signature: signatureOf(sealed, options.signingKey),
        lines: {
          create: checks.map((c, i) => ({
            sequence: (i + 1) * 10,
            name: c.name,
            result: c.ok ? 'Equal' : 'Differs',
            summary: c.summary,
          })),
        },
        name: `Opening balances at ${cutoff}`,
        cutoff,
        company,
        user: options.user ?? null,
        loadedAt,
        entry: entryLines > 0 ? (madeMoves[0] ?? null) : null,
        entryLines,
        documents,
        adjustments,
        workbookHash: data.hash,
        checks,
        made: { moves: madeMoves, pickings: madePickings },
        lastMove: last?.id ?? 0,
      },
    ]);
    await env.flush();
  };

  try {
    await shutro.bootstrap(
      {
        reason: commit ? 'opening balances' : 'opening balances (check)',
        company: options.company,
      },
      run,
    );
  } catch (error) {
    if (!(error instanceof RollBack)) throw error;
  }
  const ok = errors.length === 0 && checks.length > 0 && checks.every((c) => c.ok);
  return {
    cutoff,
    status: already ? 'already' : !ok ? 'refused' : commit ? 'loaded' : 'checked',
    errors,
    entryLines,
    documents,
    adjustments,
    checks,
    ok,
  };
}

async function prove(
  env: AnyEnv,
  data: OpeningData,
  cutoff: string,
  target: ReadonlyMap<number, Decimal>,
  stockLines: readonly { row: StockRow; product: number; location: number; label: string }[],
  stockroom: boolean,
  valued: boolean,
): Promise<OpeningCheck[]> {
  const company = env.companyId as number;
  const rows = await env.sql<{
    account_id: number;
    code: string;
    account_type: string;
    balance: string;
  }>`
    SELECT l.account_id, a.code, a.type AS account_type, SUM(l.balance)::text AS balance
    FROM account_move_line l JOIN account_move m ON m.id = l.move_id JOIN account_account a ON a.id = l.account_id
    WHERE l.posted AND m.company_id = ${company} AND l.date <= ${cutoff}::date
    GROUP BY l.account_id, a.code, a.type`;
  const kosh = new Map(rows.map((r) => [r.account_id, orm.toDecimal(r.balance)]));
  const codes = new Map(rows.map((r) => [r.account_id, r.code]));
  const clearing = rows.find((r) => r.code === 'OPENING');

  const accountDiffs: OpeningCheck['differences'][number][] = [];
  for (const account of new Set([...target.keys(), ...kosh.keys()])) {
    if (account === clearing?.account_id) continue;
    const want = target.get(account) ?? ZERO;
    const have = kosh.get(account) ?? ZERO;
    if (!want.equals(have))
      accountDiffs.push({
        what: `account ${codes.get(account) ?? `#${account}`}`,
        workbook: amount(want),
        kosh: amount(have),
      });
  }
  const checks: OpeningCheck[] = [
    {
      name: 'trial balance',
      ok: accountDiffs.length === 0,
      summary: `${target.size} accounts at ${cutoff}${accountDiffs.length === 0 ? ', every one equal' : `, ${accountDiffs.length} different`}`,
      differences: accountDiffs,
    },
  ];

  // The control totals: what the old system says against Kosh's books.
  const sumOf = (type: string) =>
    rows
      .filter((r) => r.account_type === type)
      .reduce((s, r) => s.plus(orm.toDecimal(r.balance)), ZERO);
  for (const [name, control, have] of [
    ['total receivable', data.controls.receivable, sumOf('asset_receivable')],
    ['total payable', data.controls.payable, sumOf('liability_payable').negated()],
  ] as const) {
    if (control === null) continue;
    checks.push({
      name,
      ok: control.equals(have),
      summary: control.equals(have)
        ? `${amount(have)}, equal to the control total`
        : 'differs from the control total',
      differences: control.equals(have)
        ? []
        : [{ what: name, workbook: amount(control), kosh: amount(have) }],
    });
  }

  const clearingBalance = orm.toDecimal(clearing?.balance ?? '0');
  checks.push({
    name: 'opening balances account',
    ok: clearingBalance.isZero(),
    summary: clearingBalance.isZero() ? 'nets to zero' : `left with ${amount(clearingBalance)}`,
    differences: clearingBalance.isZero()
      ? []
      : [{ what: 'OPENING', workbook: '0.00', kosh: amount(clearingBalance) }],
  });

  if (!stockroom || stockLines.length === 0) return checks;

  // The stock: each product, location and lot's quantity.
  const key = (product: number, location: number, lot: string) => `${product}:${location}:${lot}`;
  const expected = new Map<string, { quantity: Decimal; label: string }>();
  let expectedValue: Decimal | null = ZERO;
  for (const l of stockLines) {
    const k = key(l.product, l.location, l.row.lot);
    expected.set(k, {
      quantity: (expected.get(k)?.quantity ?? ZERO).plus(l.row.quantity),
      label: l.label,
    });
    expectedValue =
      expectedValue === null || l.row.unitCost === null
        ? null
        : expectedValue.plus(l.row.quantity.times(l.row.unitCost));
  }
  const quants = await env.sql<{
    product_id: number;
    location_id: number;
    lot: string | null;
    quantity: string;
  }>`
    SELECT q.product_id, q.location_id, t.name AS lot, SUM(q.quantity)::text AS quantity
    FROM stock_quant q JOIN stock_location l ON l.id = q.location_id LEFT JOIN stock_lot t ON t.id = q.lot_id
    WHERE q.company_id = ${company} AND l.usage = 'internal' AND q.quantity <> 0
    GROUP BY q.product_id, q.location_id, t.name`;
  const have = new Map(
    quants.map((q) => [key(q.product_id, q.location_id, q.lot ?? ''), orm.toDecimal(q.quantity)]),
  );
  const quantityDiffs: OpeningCheck['differences'][number][] = [];
  for (const k of new Set([...expected.keys(), ...have.keys()])) {
    const want = expected.get(k)?.quantity ?? ZERO;
    const got = have.get(k) ?? ZERO;
    if (!want.equals(got))
      quantityDiffs.push({
        what: expected.get(k)?.label ?? `stock in Kosh ${k}`,
        workbook: want.toString(),
        kosh: got.toString(),
      });
  }
  checks.push({
    name: 'stock on hand',
    ok: quantityDiffs.length === 0,
    summary: `${expected.size} products, locations and lots${quantityDiffs.length === 0 ? ', every quantity equal' : `, ${quantityDiffs.length} different`}`,
    differences: quantityDiffs,
  });
  if (!valued) return checks;

  const [layers] = await env.sql<{ value: string | null }>`
    SELECT SUM(value)::text AS value FROM stock_valuation_layer
    WHERE company_id = ${company} AND date <= ${cutoff}::date`;
  const value = orm.toDecimal(layers?.value ?? '0').toDecimalPlaces(2);
  const wanted = data.controls.stock ?? expectedValue?.toDecimalPlaces(2) ?? null;
  if (wanted !== null)
    checks.push({
      name: 'stock value',
      ok: wanted.equals(value),
      summary: wanted.equals(value)
        ? `${amount(value)}, equal to ${data.controls.stock === null ? 'the sheet' : 'the control total'}`
        : 'differs',
      differences: wanted.equals(value)
        ? []
        : [{ what: 'stock value', workbook: amount(wanted), kosh: amount(value) }],
    });

  // The stock accounts against the stock's value: named, not refused (an old system may not value stock in its books).
  const [books] = await env.sql<{ balance: string | null }>`
    SELECT SUM(l.balance)::text AS balance
    FROM account_move_line l JOIN account_move m ON m.id = l.move_id
    WHERE l.posted AND m.company_id = ${company} AND l.date <= ${cutoff}::date AND l.account_id IN (
      SELECT stock_valuation_account_id FROM res_company WHERE id = ${company}
      UNION SELECT stock_valuation_account_id FROM product_category WHERE stock_valuation_account_id IS NOT NULL)`;
  const inBooks = orm.toDecimal(books?.balance ?? '0');
  checks.push({
    name: 'stock in the books',
    ok: true,
    summary: inBooks.equals(value)
      ? `the stock accounts hold ${amount(inBooks)}, the stock's value`
      : `the stock accounts hold ${amount(inBooks)} as in your trial balance; the stock is worth ${amount(value)} — the difference of ${amount(value.minus(inBooks))} is for your accountant to post`,
    differences: [],
  });
  return checks;
}

/** The report as text, for the command line. */
export function openingReportText(report: OpeningReport): string {
  const lines: string[] = [
    {
      loaded: `Opening balances at ${report.cutoff}: loaded.`,
      checked: `Opening balances at ${report.cutoff}: checked, nothing was kept.`,
      refused: 'Opening balances: refused, nothing was kept.',
      already: `Opening balances at ${report.cutoff} were loaded before: nothing was changed.`,
    }[report.status],
    '',
  ];
  for (const e of report.errors)
    lines.push(`✖ ${e.sheet}${e.row > 0 ? `, row ${e.row}` : ''}: ${e.message}`);
  if (report.status !== 'already' && report.errors.length === 0)
    lines.push(
      `An opening entry of ${report.entryLines} lines, ${report.documents} open documents, ${report.adjustments} stock adjustments.`,
      '',
    );
  for (const c of report.checks) {
    lines.push(`${c.ok ? '✔' : '✖'} ${c.name}: ${c.summary}`);
    for (const d of c.differences.slice(0, 20))
      lines.push(`    ${d.what}: the workbook ${d.workbook}, Shutro ERP ${d.kosh}`);
    if (c.differences.length > 20) lines.push(`    … and ${c.differences.length - 20} more`);
  }
  return `${lines.join('\n')}\n`;
}

// ---- undo

/** Why an opening cannot be undone. */
export class OpeningUndoError extends Error {
  override readonly name = 'OpeningUndoError';
  readonly code: 'no-opening' | 'posted-after' | 'stock-moved';
  constructor(code: 'no-opening' | 'posted-after' | 'stock-moved', message: string) {
    super(message);
    this.code = code;
  }
}

export interface OpeningUndone {
  readonly cutoff: string;
  /** Entries and documents reversed. */
  readonly reversed: number;
  /** Stock adjustments taken back out. */
  readonly returned: number;
}

/** What {@link undoOpening} needs from Accounting's own functions (index.ts), given by the caller. */
export interface UndoTools {
  /** Reverses a posted entry at a date, posted; returns the reversal's id. */
  reverse(env: AnyEnv, move: number, date: string): Promise<number>;
  /** Reconciles lines of one account. */
  reconcile(env: AnyEnv, lines: readonly number[]): Promise<unknown>;
}

/** Entries posted in the company after its loaded opening: the undo ends with the first one. */
export async function postedAfterOpening(env: AnyEnv, lastMove: number): Promise<number> {
  const [row] = await env.sql<{ n: number }>`
    SELECT count(*)::int AS n FROM account_move
    WHERE company_id = ${env.companyId as number} AND state = 'posted' AND id > ${lastMove}`;
  return row?.n ?? 0;
}

/**
 * Undoes the company's loaded opening, until the first posting after it: every entry and document of it is
 * reversed at the cut-off and reconciled with its reversal (nothing stays open), and each stock adjustment is taken
 * back out as its return, at the value it came in at. Nothing is deleted; the opening is kept as undone.
 */
export async function undoOpening(
  shutro: Shutro,
  options: { readonly company: number; readonly user?: number; readonly reason: string },
  tools: UndoTools,
): Promise<OpeningUndone> {
  const dated =
    'accountingDate' in (shutro.registry?.models.get('stock.picking')?.fieldOrigins ?? {});
  return shutro.bootstrap(
    { reason: 'opening balances undone', company: options.company },
    async (env) => {
      const found = await model(env, 'account.opening').search({
        where: { status: 'loaded' },
        order: ['cutoff desc'],
        limit: 1,
      });
      const [opening] = (await found.load(['cutoff', 'made', 'lastMove'])).read([
        'id',
        'cutoff',
        'made',
        'lastMove',
      ]);
      if (opening === undefined)
        throw new OpeningUndoError('no-opening', 'There is no loaded opening to undo.');
      const cutoff = String(opening['cutoff']);
      const made = (opening['made'] ?? {}) as { moves?: number[]; pickings?: number[] };
      const after = await postedAfterOpening(env, Number(opening['lastMove'] ?? 0));
      if (after > 0)
        throw new OpeningUndoError(
          'posted-after',
          `${after} ${after === 1 ? 'entry was' : 'entries were'} posted after the opening: it can no longer be undone. Correct it with entries instead.`,
        );

      // The stock, back out of each location as the return of its adjustment.
      let returned = 0;
      for (const picking of made.pickings ?? []) {
        const [p] = await env.sql<{ source_id: number; destination_id: number; name: string }>`
          SELECT source_id, destination_id, name FROM stock_picking WHERE id = ${picking}`;
        if (p === undefined) continue;
        const moves = await env.sql<{ id: number; product_id: number; done_qty: string }>`
          SELECT id, product_id, done_qty::text AS done_qty FROM stock_move WHERE picking_id = ${picking}`;
        const lots = await env.sql<{ product_id: number; lot_id: number; quantity: string }>`
          SELECT product_id, lot_id, quantity::text AS quantity FROM stock_lot_line
          WHERE picking_id = ${picking} AND lot_id IS NOT NULL`;
        const back = await model(env, 'stock.picking').create([
          {
            kind: 'adjustment',
            company: options.company,
            source: p.destination_id,
            destination: p.source_id,
            origin: `Undo of ${p.name}`,
            returnOf: picking,
            ...(dated ? { accountingDate: cutoff } : {}),
            moves: {
              create: moves.map((m) => ({
                product: m.product_id,
                quantity: m.done_qty,
                returnOf: m.id,
              })),
            },
            lotLines: {
              create: lots.map((l) => ({
                product: l.product_id,
                lot: l.lot_id,
                quantity: l.quantity,
              })),
            },
          },
        ]);
        await back.confirm();
        await back.reserve();
        const [state] = (await back.load(['availability'])).read(['availability']);
        if (state?.['availability'] !== 'full')
          throw new OpeningUndoError(
            'stock-moved',
            `Some of the opening stock of ${p.name} has moved or is reserved: it can no longer be undone.`,
          );
        await back.validate();
        returned += 1;
      }

      // The books: each entry and document reversed at the cut-off, and closed against its reversal.
      let reversed = 0;
      for (const move of made.moves ?? []) {
        const reversal = await tools.reverse(env, move, cutoff);
        const lines = await env.sql<{ id: number; account_id: number; partner_id: number | null }>`
          SELECT l.id, l.account_id, l.partner_id
          FROM account_move_line l JOIN account_account a ON a.id = l.account_id
          WHERE l.move_id IN (${move}, ${reversal}) AND a.type IN ('asset_receivable', 'liability_payable')`;
        const groups = new Map<string, number[]>();
        for (const l of lines) {
          const k = `${l.account_id}:${l.partner_id ?? ''}`;
          groups.set(k, [...(groups.get(k) ?? []), l.id]);
        }
        for (const ids of groups.values()) if (ids.length > 1) await tools.reconcile(env, ids);
        reversed += 1;
      }

      await model(env, 'account.opening')
        .browse([opening['id'] as number])
        .write({
          status: 'undone',
          undoneBy: options.user ?? null,
          undoneAt: env.now(),
          undoReason: options.reason,
        });
      await env.flush();
      return { cutoff, reversed, returned };
    },
  );
}

// ---- the certificate's seal

const sealOf = (sealed: string): string => createHash('sha256').update(sealed).digest('hex');
const signatureOf = (sealed: string, key: string | undefined): string | null =>
  key === undefined || key === '' ? null : createHmac('sha256', key).update(sealed).digest('hex');

export interface OpeningVerification {
  readonly cutoff: string;
  readonly status: string;
  readonly checks: readonly {
    readonly name: string;
    readonly ok: boolean;
    readonly detail: string;
  }[];
  readonly ok: boolean;
}

/**
 * Verifies an opening's certificate: the sealed content still has its seal, the record still says what was sealed,
 * the signature is the installation's (with its key), and — given the workbook — it is the file that was loaded.
 */
export async function verifyOpening(
  env: AnyEnv,
  options: {
    /** The opening (default: the company's latest). */
    readonly id?: number;
    readonly signingKey?: string;
    readonly workbook?: Uint8Array;
  } = {},
): Promise<OpeningVerification | null> {
  const found = await model(env, 'account.opening').search({
    where: options.id === undefined ? {} : { id: options.id },
    order: ['id desc'],
    limit: 1,
  });
  const keys = [
    'cutoff',
    'status',
    'sealed',
    'seal',
    'signature',
    'workbookHash',
    'entryLines',
    'documents',
    'adjustments',
  ];
  const [o] = (await found.load(keys)).read(keys);
  if (o === undefined) return null;
  const sealed = typeof o['sealed'] === 'string' ? o['sealed'] : '';
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  const sealOk = sealed !== '' && sealOf(sealed) === o['seal'];
  checks.push({
    name: 'seal',
    ok: sealOk,
    detail: sealOk
      ? 'the sealed content has its seal'
      : 'the sealed content or its seal was changed',
  });
  let content: Record<string, unknown> = {};
  try {
    content = JSON.parse(sealed) as Record<string, unknown>;
  } catch {
    // an unreadable seal: the record check below says so
  }
  const same =
    content['cutoff'] === String(o['cutoff']) &&
    content['workbook'] === o['workbookHash'] &&
    content['entryLines'] === o['entryLines'] &&
    content['documents'] === o['documents'] &&
    content['adjustments'] === o['adjustments'];
  checks.push({
    name: 'record',
    ok: same,
    detail: same
      ? 'the opening says what was sealed'
      : 'the opening no longer says what was sealed (its cut-off, workbook or counts)',
  });
  const signature = typeof o['signature'] === 'string' ? o['signature'] : '';
  if (signature === '')
    checks.push({
      name: 'signature',
      ok: true,
      detail:
        'not signed: the installation had no signing key (KOSH_SIGNING_KEY) when it was loaded',
    });
  else if (options.signingKey === undefined || options.signingKey === '')
    checks.push({
      name: 'signature',
      ok: false,
      detail:
        'signed, but this installation has no signing key (KOSH_SIGNING_KEY) to verify it with',
    });
  else {
    const expected = Buffer.from(signatureOf(sealed, options.signingKey) ?? '', 'hex');
    const given = Buffer.from(signature, 'hex');
    const valid = expected.length === given.length && timingSafeEqual(expected, given);
    checks.push({
      name: 'signature',
      ok: valid,
      detail: valid
        ? 'signed with this installation’s key'
        : 'not signed with this installation’s key',
    });
  }
  if (options.workbook !== undefined) {
    const hash = createHash('sha256').update(options.workbook).digest('hex');
    checks.push({
      name: 'workbook',
      ok: hash === o['workbookHash'],
      detail:
        hash === o['workbookHash']
          ? 'this is the workbook that was loaded'
          : 'this is not the workbook that was loaded',
    });
  }
  return {
    cutoff: String(o['cutoff']),
    status: String(o['status']),
    checks,
    ok: checks.every((c) => c.ok),
  };
}
