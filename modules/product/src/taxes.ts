/**
 * The tax engine (RFC 0016 §5.1), shared by Sales, Purchase and Accounting: the taxes of a line, in order. A tax is
 * a percentage of its base or a fixed amount per unit; a tax that `affectsBase` adds its amount to the base of the
 * taxes after it (supplementary duty before VAT); taxes `priceIncluded` are inside the unit price, which is then
 * gross. Exact decimals throughout; rounding is the caller's (per document at posting).
 */
import { orm } from '@kosh/server/orm';

type Decimal = ReturnType<typeof orm.toDecimal>;

/** What the engine needs of a tax. */
export interface TaxRule {
  readonly id: number;
  readonly sequence: number;
  readonly amountType: 'percent' | 'fixed';
  /** 0.15 for 15 % (percent taxes). */
  readonly rate: Decimal;
  /** Per unit, in the document currency (fixed taxes). */
  readonly fixedAmount: Decimal;
  readonly affectsBase: boolean;
  readonly priceIncluded: boolean;
}

export interface TaxLine {
  readonly tax: number;
  /** What the tax was computed on (the untaxed amount, plus the taxes before it that affect the base). */
  readonly base: Decimal;
  readonly amount: Decimal;
}

export interface TaxResult {
  /** The amount without taxes. */
  readonly untaxed: Decimal;
  /** Each tax, in order. */
  readonly taxes: readonly TaxLine[];
  readonly taxTotal: Decimal;
  readonly total: Decimal;
}

const ZERO = orm.toDecimal(0);

/** The rules in the order they apply: by sequence, then as given. */
export function ordered(rules: readonly TaxRule[]): TaxRule[] {
  return rules
    .map((rule, index) => ({ rule, index }))
    .sort((a, b) => a.rule.sequence - b.rule.sequence || a.index - b.index)
    .map(({ rule }) => rule);
}

/** The taxes applied in order on `untaxed`. */
function apply(untaxed: Decimal, quantity: Decimal, rules: readonly TaxRule[]): TaxLine[] {
  let base = untaxed;
  const out: TaxLine[] = [];
  for (const rule of rules) {
    const amount =
      rule.amountType === 'fixed' ? quantity.times(rule.fixedAmount) : base.times(rule.rate);
    out.push({ tax: rule.id, base, amount });
    if (rule.affectsBase) base = base.plus(amount);
  }
  return out;
}

/**
 * The taxes of a line whose price amounts to `amount` (quantity × unit price, after discount) for `quantity` units.
 * With taxes included in the price, `amount` is gross: the untaxed amount is what, taxed by the included taxes,
 * gives it back.
 */
export function computeTaxes(
  amount: Decimal,
  quantity: Decimal,
  rules: readonly TaxRule[],
): TaxResult {
  const all = ordered(rules);
  const included = all.filter((r) => r.priceIncluded);
  let untaxed = amount;
  if (included.length > 0) {
    // The included taxes are linear in their base: total(b) = c + k·b. Solve total(b) = amount.
    const total = (b: Decimal) =>
      apply(b, quantity, included).reduce((s, t) => s.plus(t.amount), b);
    const c = total(ZERO);
    const k = total(orm.toDecimal(1)).minus(c);
    untaxed = k.isZero() ? amount : amount.minus(c).div(k);
  }
  const taxes = apply(untaxed, quantity, all);
  const taxTotal = taxes.reduce((s, t) => s.plus(t.amount), ZERO);
  return { untaxed, taxes, taxTotal, total: untaxed.plus(taxTotal) };
}

/** A tax record (as loaded) as the engine's rule. */
export function taxRule(tax: {
  readonly id: number;
  readonly sequence?: number | null;
  readonly amountType?: string | null;
  readonly rate?: Decimal | null;
  readonly fixedAmount?: Decimal | null;
  readonly affectsBase?: boolean | null;
  readonly priceIncluded?: boolean | null;
}): TaxRule {
  return {
    id: tax.id,
    sequence: tax.sequence ?? 10,
    amountType: tax.amountType === 'fixed' ? 'fixed' : 'percent',
    rate: tax.rate ?? ZERO,
    fixedAmount: tax.fixedAmount ?? ZERO,
    affectsBase: tax.affectsBase === true,
    priceIncluded: tax.priceIncluded === true,
  };
}
