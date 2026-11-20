/**
 * The promotion engine (RFC 0034 §2.6), without a database: what each promotion takes off an order — a percentage
 * of the order or of some products, an amount off from a minimum, *buy X get Y* —, which promotions go together,
 * and what a promotion would have cost over past orders. Money in hundredths, as everywhere in Loyalty.
 */

/** A goods line of an order. */
export interface PromoLine {
  readonly product: number;
  readonly category: number | null;
  /** Units, as sold (2.5 kg is 2.5). */
  readonly quantity: number;
  /** Before taxes, after the line's own discount, in hundredths. */
  readonly amount: number;
}

export interface PromoOrder {
  /** `YYYY-MM-DD`. */
  readonly date: string;
  /** The code typed on the order, upper case; empty: none. */
  readonly code: string;
  readonly lines: readonly PromoLine[];
}

export const PROMOTION_KINDS = ['percent', 'amount', 'buy_get'] as const;
export type PromotionKind = (typeof PROMOTION_KINDS)[number];

export interface Promotion {
  readonly id: number;
  readonly kind: PromotionKind;
  /** `percent`: hundredths of a percent (1500: 15 %). `amount`: hundredths of money. */
  readonly value: number;
  /** What it applies to: these lines only; both empty: every line. */
  readonly product: number | null;
  readonly category: number | null;
  /** The order's goods must be worth this, in hundredths. */
  readonly minimumOrder: number;
  /** `buy_get`: for every `buy` units bought, `get` units are free. */
  readonly buy: number;
  readonly get: number;
  /** `buy_get`: the free units are of this product; `null`: of what was bought, the cheapest ones. */
  readonly rewardProduct: number | null;
  /** Applies only to orders that carry this code (upper case); empty: by itself. */
  readonly code: string;
  readonly dateFrom: string | null;
  readonly dateTo: string | null;
  /** Not together with other promotions: it applies alone, when that is better for the customer. */
  readonly exclusive: boolean;
}

export interface Discount {
  readonly promotion: number;
  /** In hundredths, above zero. */
  readonly amount: number;
  /** `buy_get`: the units given free. */
  readonly freeUnits: number;
}

const goodsTotal = (order: PromoOrder): number =>
  order.lines.reduce((sum, l) => sum + Math.max(0, l.amount), 0);

const matches = (p: Promotion, l: PromoLine): boolean =>
  (p.product === null || l.product === p.product) &&
  (p.category === null || l.category === p.category);

/** The price of each whole unit of some lines, dearest first. */
function unitsOf(lines: readonly PromoLine[]): number[] {
  const units: number[] = [];
  for (const l of lines) {
    const whole = Math.floor(l.quantity);
    if (whole <= 0 || l.amount <= 0) continue;
    const each = Math.floor(l.amount / l.quantity);
    for (let n = 0; n < whole; n += 1) units.push(each);
  }
  return units.sort((a, b) => b - a);
}

/**
 * What one promotion takes off an order, alone (RFC 0034 §2.6); `null` when it does not apply — out of its dates,
 * without its code, below its minimum, or with nothing it applies to.
 *
 * - `percent`: its share of the lines it applies to.
 * - `amount`: its amount, never more than those lines are worth.
 * - `buy_get`: for every `buy` + `get` units of what it applies to, the `get` **cheapest** are free; with a
 *   reward product, for every `buy` units bought, `get` units of the reward that are on the order are free.
 */
export function discountOf(p: Promotion, order: PromoOrder): Discount | null {
  if (p.dateFrom !== null && order.date < p.dateFrom) return null;
  if (p.dateTo !== null && order.date > p.dateTo) return null;
  if (p.code !== '' && p.code !== order.code) return null;
  const total = goodsTotal(order);
  if (total <= 0 || total < p.minimumOrder) return null;
  const lines = order.lines.filter((l) => l.amount > 0 && matches(p, l));
  const base = lines.reduce((sum, l) => sum + l.amount, 0);
  let amount = 0;
  let freeUnits = 0;
  if (p.kind === 'percent') amount = Math.round((base * p.value) / 10_000);
  else if (p.kind === 'amount') amount = Math.min(p.value, base);
  else if (p.buy > 0 && p.get > 0) {
    if (p.rewardProduct === null) {
      const units = unitsOf(lines);
      freeUnits = Math.floor(units.length / (p.buy + p.get)) * p.get;
      amount = units.slice(units.length - freeUnits).reduce((sum, u) => sum + u, 0);
    } else {
      const bought = lines
        .filter((l) => l.product !== p.rewardProduct)
        .reduce((sum, l) => sum + Math.floor(l.quantity), 0);
      const reward = unitsOf(
        order.lines.filter((l) => l.product === p.rewardProduct && l.amount > 0),
      );
      freeUnits = Math.min(reward.length, Math.floor(bought / p.buy) * p.get);
      // The cheapest of the reward's units, when they were sold at different prices.
      amount = reward.slice(reward.length - freeUnits).reduce((sum, u) => sum + u, 0);
    }
  }
  return amount > 0 ? { promotion: p.id, amount, freeUnits } : null;
}

/**
 * The promotions of an order (RFC 0034 §2.6): every one that applies and goes with others is taken together;
 * one that does not go with others is taken **alone** when it gives the customer more than all of those — never
 * both. What is taken off never passes what the goods are worth: the last discounts are cut to fit.
 */
export function applyPromotions(
  promotions: readonly Promotion[],
  order: PromoOrder,
): readonly Discount[] {
  const found = promotions
    .map((p) => ({ p, d: discountOf(p, order) }))
    .filter((x): x is { p: Promotion; d: Discount } => x.d !== null);
  const together = found.filter((x) => !x.p.exclusive).map((x) => x.d);
  const alone = found
    .filter((x) => x.p.exclusive)
    .map((x) => x.d)
    .sort((a, b) => b.amount - a.amount)[0];
  const sum = together.reduce((s, d) => s + d.amount, 0);
  const chosen = alone !== undefined && alone.amount > sum ? [alone] : together;
  let left = goodsTotal(order);
  const out: Discount[] = [];
  for (const d of chosen) {
    const amount = Math.min(d.amount, left);
    if (amount <= 0) continue;
    out.push({ ...d, amount });
    left -= amount;
  }
  return out;
}

export interface PromotionPreview {
  readonly orders: number;
  /** Orders it would have applied to. */
  readonly applied: number;
  /** What it would have taken off, in hundredths. */
  readonly discount: number;
  /** What the orders' goods were worth, in hundredths. */
  readonly revenue: number;
  /** The discount as a share of the revenue, in hundredths of a percent. */
  readonly share: number;
  readonly freeUnits: number;
}

/**
 * A promotion over past orders (RFC 0034 §2.6): what it would have taken off each, alone — a promotion with a
 * code is counted as if every customer had typed it, the most it can cost.
 */
export function previewPromotion(p: Promotion, orders: readonly PromoOrder[]): PromotionPreview {
  let applied = 0;
  let discount = 0;
  let revenue = 0;
  let freeUnits = 0;
  for (const order of orders) {
    revenue += goodsTotal(order);
    const d = discountOf(p, { ...order, code: p.code });
    if (d === null) continue;
    applied += 1;
    discount += Math.min(d.amount, goodsTotal(order));
    freeUnits += d.freeUnits;
  }
  return {
    orders: orders.length,
    applied,
    discount,
    revenue,
    share: revenue <= 0 ? 0 : Math.round((discount * 10_000) / revenue),
    freeUnits,
  };
}
