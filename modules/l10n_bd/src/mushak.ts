/**
 * The Mushak registers and the monthly return (RFC 0016 §5.3), from the posted documents of a month: the purchase
 * register (Mushak 6.1) and the sales register (Mushak 6.2), a row per product line, and the summary of the
 * monthly return (Mushak 9.1): supplies and purchases by VAT band with their SD and VAT, the adjustments (VAT
 * deducted at source, advance tax) and the net tax. Filing stays on the NBR's online system: these prepare what is
 * entered there. Amounts are in the company's currency (taka): a foreign-currency line converts at its document's
 * rate, through its posted balance. Credit notes count negative. The stock columns of the registers wait for
 * Inventory.
 */
import { orm } from '@kosh/server/orm';
import type { Env } from './.kosh/bindings.js';

type Decimal = ReturnType<typeof orm.toDecimal>;
const ZERO = orm.toDecimal(0);

export type Side = 'sales' | 'purchases';
/** A line's VAT band, from the Mushak kind of its VAT tax (`unclassified`: no VAT tax with a kind). */
export type VatCategory = 'standard' | 'reduced' | 'zero' | 'exempt' | 'unclassified';
export const VAT_CATEGORIES: readonly VatCategory[] = [
  'standard',
  'reduced',
  'zero',
  'exempt',
  'unclassified',
];

type MoveKind = 'out_invoice' | 'out_refund' | 'in_invoice' | 'in_refund';
const KINDS: Record<Side, { readonly invoice: MoveKind; readonly refund: MoveKind }> = {
  sales: { invoice: 'out_invoice', refund: 'out_refund' },
  purchases: { invoice: 'in_invoice', refund: 'in_refund' },
};

export interface RegisterRow {
  readonly date: string;
  readonly number: string;
  /** A credit note (its amounts are negative). */
  readonly refund: boolean;
  readonly partner: string;
  readonly bin: string | null;
  readonly description: string;
  readonly quantity: Decimal;
  readonly value: Decimal;
  readonly sd: Decimal;
  readonly vat: Decimal;
  readonly total: Decimal;
  readonly category: VatCategory;
}

export class MonthError extends Error {}

/** The first and last day of `month` (`2026-10`). */
export function monthRange(month: string): { readonly from: string; readonly to: string } {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (match === null) throw new MonthError('A month is written 2026-10.');
  const [y, m] = [Number(match[1]), Number(match[2])];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

const round = (d: Decimal) => d.toDecimalPlaces(2);

/** The posted invoices and credit notes of `side` in `month`, with what the registers read. */
async function documentsOf(env: Env, side: Side, month: string) {
  const { from, to } = monthRange(month);
  const kinds = KINDS[side];
  const moves = await env.model('account.move').search({
    where: {
      kind: { in: [kinds.invoice, kinds.refund] },
      state: 'posted',
      date: { gte: from, lte: to },
    },
    order: ['date asc', 'name asc'],
  });
  return moves.load({
    partner: ['name', 'bin'],
    invoiceLines: { taxes: ['mushak'] },
    lines: { taxLineOf: ['mushak'] },
  });
}

/** The register of `side` (Mushak 6.1 for purchases, 6.2 for sales) for `month`. */
export async function register(env: Env, side: Side, month: string): Promise<RegisterRow[]> {
  const rows: RegisterRow[] = [];
  for (const move of await documentsOf(env, side, month)) {
    const refund = move.kind === KINDS[side].refund;
    const sign = refund ? -1 : 1;
    for (const line of move.invoiceLines) {
      if (line.lineKind !== 'product') continue;
      const subtotal = line.subtotal?.amount ?? ZERO;
      // The value in taka is the posted balance (credit on sales, debit on purchases); taxes follow its rate.
      const value = (line.balance?.amount ?? ZERO).abs();
      const rate = subtotal.isZero() ? orm.toDecimal(1) : value.div(subtotal.abs());
      const sd = round((line.sdAmount?.amount ?? ZERO).times(rate));
      const vat = round((line.vatAmount?.amount ?? ZERO).times(rate));
      const kinds = [...line.taxes].map((t) => t.mushak);
      const category =
        (VAT_CATEGORIES.find((c) => c !== 'unclassified' && kinds.includes(c)) as VatCategory) ??
        'unclassified';
      rows.push({
        date: String(move.date),
        number: move.name ?? '',
        refund,
        partner: move.partner?.name ?? '',
        bin: move.partner?.bin ?? null,
        description: line.name ?? '',
        quantity: (line.quantity ?? ZERO).times(sign),
        value: value.times(sign),
        sd: sd.times(sign),
        vat: vat.times(sign),
        total: value.plus(sd).plus(vat).times(sign),
        category,
      });
    }
  }
  return rows;
}

export interface Band {
  readonly value: Decimal;
  readonly sd: Decimal;
  readonly vat: Decimal;
}

/** The summary of the monthly return (Mushak 9.1). */
export interface Return91 {
  readonly month: string;
  /** Part 3: supplies, by VAT band. */
  readonly supplies: Readonly<Record<VatCategory, Band>>;
  /** Part 4: purchases, by VAT band. */
  readonly purchases: Readonly<Record<VatCategory, Band>>;
  /** Part 5: increasing adjustments — VAT we deducted at source from our suppliers. */
  readonly vdsDeducted: Decimal;
  /** Part 6: decreasing adjustments — VAT our customers deducted at source, advance tax paid on imports. */
  readonly vdsByCustomers: Decimal;
  readonly advanceTax: Decimal;
  /** Part 7: the net tax. */
  readonly outputVat: Decimal;
  readonly inputVat: Decimal;
  readonly sdPayable: Decimal;
  /** Output VAT − input VAT + increasing − decreasing adjustments (negative: carried forward). */
  readonly netVat: Decimal;
}

function bands(rows: readonly RegisterRow[]): Record<VatCategory, Band> {
  const out = Object.fromEntries(
    VAT_CATEGORIES.map((c) => [c, { value: ZERO, sd: ZERO, vat: ZERO }]),
  ) as Record<VatCategory, Band>;
  for (const r of rows) {
    const b = out[r.category];
    out[r.category] = { value: b.value.plus(r.value), sd: b.sd.plus(r.sd), vat: b.vat.plus(r.vat) };
  }
  return out;
}

const sum = (bs: Readonly<Record<VatCategory, Band>>, key: keyof Band) =>
  VAT_CATEGORIES.reduce((s, c) => s.plus(bs[c][key]), ZERO);

/** The monthly return's summary for `month`. */
export async function return91(env: Env, month: string): Promise<Return91> {
  const { from, to } = monthRange(month);
  const supplies = bands(await register(env, 'sales', month));
  const purchases = bands(await register(env, 'purchases', month));
  // Advance tax: the posted AT tax lines of the month's bills (net of credit notes).
  let advanceTax = ZERO;
  for (const move of await documentsOf(env, 'purchases', month))
    for (const line of move.lines)
      if (line.lineKind === 'tax' && line.taxLineOf?.mushak === 'at')
        advanceTax = advanceTax.plus(line.balance?.amount ?? ZERO);
  // VAT deducted at source: withholdings on the VAT of the month's posted payments, by direction.
  let vdsDeducted = ZERO;
  let vdsByCustomers = ZERO;
  const payments = await env.model('account.payment').search({
    where: { state: 'posted', date: { gte: from, lte: to } },
  });
  for (const p of await payments.load({ withholdings: { withholding: ['base', 'direction'] } }))
    for (const w of p.withholdings) {
      if (w.withholding.base !== 'tax') continue;
      const amount = w.amount?.amount ?? ZERO;
      if (w.withholding.direction === 'vendor') vdsDeducted = vdsDeducted.plus(amount);
      else vdsByCustomers = vdsByCustomers.plus(amount);
    }
  const outputVat = sum(supplies, 'vat');
  const inputVat = sum(purchases, 'vat');
  return {
    month,
    supplies,
    purchases,
    vdsDeducted,
    vdsByCustomers,
    advanceTax,
    outputVat,
    inputVat,
    sdPayable: sum(supplies, 'sd'),
    netVat: outputVat.minus(inputVat).plus(vdsDeducted).minus(vdsByCustomers).minus(advanceTax),
  };
}
