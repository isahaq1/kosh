/**
 * The loyalty engine (RFC 0034 §2.6), without a database: what an order earns by a program's rules, the tier a
 * customer's points put them in, and the points that have grown too old. Money is counted in hundredths and
 * points are whole numbers, so nothing drifts and a preview over a thousand past orders says exactly what the
 * live program would have given.
 */

/** A line of an order, as the engine reads it. */
export interface OrderLine {
  readonly product: number;
  readonly category: number | null;
  /** Before taxes, in hundredths; below zero for a discount line. */
  readonly amount: number;
}

export interface Order {
  /** `YYYY-MM-DD`. */
  readonly date: string;
  readonly lines: readonly OrderLine[];
}

/** So many points for every so much spent — on everything, or on a product or a category. */
export interface EarnRule {
  readonly id: number;
  /** The spend one step is worth, in hundredths; above zero. */
  readonly amountPer: number;
  /** The points a step gives. */
  readonly points: number;
  readonly product: number | null;
  readonly category: number | null;
  /** Orders below this amount (before taxes, in hundredths) earn nothing by this rule. */
  readonly minimumOrder: number;
  readonly dateFrom: string | null;
  readonly dateTo: string | null;
}

export interface Tier {
  readonly id: number;
  /** Points earned in the program's window to be in the tier. */
  readonly minPoints: number;
  /** What an order earns is multiplied by this, in hundredths (150: one and a half times). */
  readonly multiplier: number;
}

export interface Earned {
  readonly points: number;
  /** What each rule gave, before the tier's multiplier. */
  readonly byRule: readonly {
    readonly rule: number;
    readonly base: number;
    readonly points: number;
  }[];
  /** In hundredths: 100 when no tier multiplies. */
  readonly multiplier: number;
}

/** The order's amount before taxes, discounts included, in hundredths. */
export const orderAmount = (order: Order): number =>
  order.lines.reduce((sum, l) => sum + l.amount, 0);

/**
 * What an order earns (RFC 0034 §2.6): each rule in force on the order's day whose minimum the order meets gives
 * its points for every full step of what it applies to — the whole order with its discounts, or the lines of its
 * product or category —, and the sum is multiplied by the customer's tier, rounded down. An order worth nothing,
 * or less, earns nothing.
 */
export function earn(rules: readonly EarnRule[], order: Order, tier: Tier | null): Earned {
  const total = orderAmount(order);
  const byRule: { rule: number; base: number; points: number }[] = [];
  if (total > 0)
    for (const r of rules) {
      if (r.amountPer <= 0 || r.points <= 0) continue;
      if (r.dateFrom !== null && order.date < r.dateFrom) continue;
      if (r.dateTo !== null && order.date > r.dateTo) continue;
      if (total < r.minimumOrder) continue;
      const scoped = r.product !== null || r.category !== null;
      const base = scoped
        ? order.lines
            .filter(
              (l) =>
                (r.product === null || l.product === r.product) &&
                (r.category === null || l.category === r.category),
            )
            .reduce((sum, l) => sum + l.amount, 0)
        : total;
      // A rule on some products never gives more than the order is worth after its discounts.
      const counted = Math.min(Math.max(0, base), total);
      const points = Math.floor(counted / r.amountPer) * r.points;
      if (points > 0) byRule.push({ rule: r.id, base: counted, points });
    }
  const multiplier = tier === null ? 100 : tier.multiplier;
  const sum = byRule.reduce((s, x) => s + x.points, 0);
  return { points: Math.floor((sum * multiplier) / 100), byRule, multiplier };
}

/** The tier of so many points earned in the window: the highest whose threshold they reach, or none. */
export function tierOf(tiers: readonly Tier[], earned: number): Tier | null {
  let best: Tier | null = null;
  for (const t of tiers)
    if (earned >= t.minPoints && (best === null || t.minPoints > best.minPoints)) best = t;
  return best;
}

/** A movement of a card's ledger. */
export interface Movement {
  readonly date: string;
  /** Above zero: earned or given; below: redeemed, reversed, expired or taken back. */
  readonly points: number;
}

/**
 * The points that are too old on a day (RFC 0034 §2.6): of what was earned before `cutoff`, what nothing has used
 * up since — the oldest points are spent first, so every point taken off the card counts against them. Writing the
 * result to the ledger as an expiry makes the next answer zero.
 */
export function expiredPoints(ledger: readonly Movement[], cutoff: string): number {
  const old = ledger
    .filter((m) => m.points > 0 && m.date < cutoff)
    .reduce((s, m) => s + m.points, 0);
  const used = ledger.filter((m) => m.points < 0).reduce((s, m) => s - m.points, 0);
  return Math.max(0, old - used);
}

/** `months` before a day, as `YYYY-MM-DD`: the last day of the month when that month is shorter. */
export function monthsBefore(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const first = new Date(Date.UTC(y, m - 1 - months, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(d, last));
  return first.toISOString().slice(0, 10);
}

/** What a program would have given over some orders: the preview before it goes live. */
export interface Preview {
  readonly orders: number;
  /** Orders that would have earned something. */
  readonly earning: number;
  readonly points: number;
  /** What the orders were worth before taxes, in hundredths. */
  readonly revenue: number;
  /** The points at the program's value of a point, in hundredths. */
  readonly cost: number;
  /** The cost as a share of the revenue, in hundredths of a percent. */
  readonly share: number;
  readonly byRule: readonly { readonly rule: number; readonly points: number }[];
}

/**
 * A program over past orders (RFC 0034 §2.6): what each would have earned — without tiers, as nobody has one
 * before the program starts —, what that is worth at the value of a point, and how much of the revenue it is.
 */
export function preview(
  rules: readonly EarnRule[],
  orders: readonly Order[],
  pointValue: number,
): Preview {
  const byRule = new Map<number, number>();
  let points = 0;
  let revenue = 0;
  let earning = 0;
  for (const order of orders) {
    revenue += Math.max(0, orderAmount(order));
    const earned = earn(rules, order, null);
    if (earned.points > 0) earning += 1;
    points += earned.points;
    for (const r of earned.byRule) byRule.set(r.rule, (byRule.get(r.rule) ?? 0) + r.points);
  }
  const cost = points * pointValue;
  return {
    orders: orders.length,
    earning,
    points,
    revenue,
    cost,
    share: revenue <= 0 ? 0 : Math.round((cost * 10_000) / revenue),
    byRule: [...byRule].map(([rule, p]) => ({ rule, points: p })),
  };
}

/** How many points an order may take, and what they are worth. */
export interface Redeemable {
  readonly points: number;
  /** In hundredths. */
  readonly amount: number;
}

/**
 * The most points an order may take (RFC 0034 §2.6): no more than the card holds, and no more than the share of
 * the order the program lets points pay — whole points, so the amount never passes that share. A point worth
 * nothing pays nothing.
 */
export function redeemLimit(input: {
  readonly balance: number;
  /** What a point is worth, in hundredths. */
  readonly pointValue: number;
  /** What the order comes to, taxes included, before anything is taken off, in hundredths. */
  readonly orderTotal: number;
  /** The share of the order points may pay, 0 to 100. */
  readonly maxPercent: number;
}): Redeemable {
  if (input.pointValue <= 0 || input.orderTotal <= 0 || input.balance <= 0)
    return { points: 0, amount: 0 };
  const share = Math.floor((input.orderTotal * Math.min(100, Math.max(0, input.maxPercent))) / 100);
  const points = Math.min(input.balance, Math.floor(share / input.pointValue));
  return { points, amount: points * input.pointValue };
}

/** What a wallet or a gift card pays of what is still due: all of it, or all it holds. In hundredths. */
export const voucherUse = (balance: number, due: number): number =>
  Math.max(0, Math.min(balance, due));
