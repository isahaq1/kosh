/**
 * The arithmetic of subscriptions (RFC 0034 §2.5), without a database: where a billing period starts and ends,
 * what a recurring amount is worth a month (MRR), and the share of an amount for the days left in a period (a
 * change made in the middle of one). Dates are ISO (`2026-12-01`); amounts are decimal strings — never JavaScript
 * numbers for money: the arithmetic is on integers of the smallest unit asked for.
 */

export type PeriodUnit = 'day' | 'week' | 'month' | 'year';
/** How often a plan bills: every `interval` units. */
export interface Period {
  readonly unit: PeriodUnit;
  readonly interval: number;
}

const DAY = 86_400_000;
const utc = (date: string): number => {
  const t = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(t)) throw new RangeError(`'${date}' is not a date (YYYY-MM-DD).`);
  return t;
};
const iso = (t: number): string => new Date(t).toISOString().slice(0, 10);
export const addDays = (date: string, days: number): string => iso(utc(date) + days * DAY);
/** The days from `from` to `to`, `to` not included (0 when `to` is not after `from`). */
export const daysBetween = (from: string, to: string): number =>
  Math.max(0, Math.round((utc(to) - utc(from)) / DAY));

/**
 * The start of the `index`-th period of a subscription anchored on `anchor` (its first billing day): by months and
 * years the same day of the month as the anchor — the last day when the month is shorter, and back to the anchor's
 * day afterwards (31 January, 28 February, 31 March).
 */
export function periodStart(anchor: string, period: Period, index: number): string {
  const n = Math.trunc(index) * Math.max(1, Math.trunc(period.interval));
  if (period.unit === 'day') return addDays(anchor, n);
  if (period.unit === 'week') return addDays(anchor, n * 7);
  const [y, m, d] = anchor.split('-').map(Number) as [number, number, number];
  utc(anchor);
  const months = (period.unit === 'year' ? n * 12 : n) + (m - 1);
  const year = y + Math.floor(months / 12);
  const month = ((months % 12) + 12) % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return iso(Date.UTC(year, month, Math.min(d, last)));
}

/** A period: its first day, its last day, the first day of the next one, and its length in days. */
export function periodOf(
  anchor: string,
  period: Period,
  index: number,
): { start: string; end: string; next: string; days: number } {
  const start = periodStart(anchor, period, index);
  const next = periodStart(anchor, period, index + 1);
  return { start, end: addDays(next, -1), next, days: daysBetween(start, next) };
}

// ---- amounts: decimal strings, on integers

const SCALE = 6;
/** A decimal string as an integer of millionths. @throws {RangeError} for anything that is not a number */
function units(amount: string): bigint {
  const found = /^(-?)(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (found === null) throw new RangeError(`'${amount}' is not an amount.`);
  const fraction = (found[3] ?? '').padEnd(SCALE, '0').slice(0, SCALE);
  const value = BigInt(found[2] as string) * 10n ** BigInt(SCALE) + BigInt(fraction);
  return found[1] === '-' ? -value : value;
}
/** Millionths as a decimal string of `places` decimals, rounded half away from zero. */
function decimal(value: bigint, places = 2): string {
  const cut = 10n ** BigInt(SCALE - places);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const rounded = (abs + cut / 2n) / cut;
  const whole = rounded / 10n ** BigInt(places);
  const fraction = (rounded % 10n ** BigInt(places)).toString().padStart(places, '0');
  const out = places === 0 ? whole.toString() : `${whole}.${fraction}`;
  return negative && rounded !== 0n ? `-${out}` : out;
}
const divide = (a: bigint, b: bigint): bigint => {
  // Rounded half away from zero, on integers.
  const negative = a < 0n !== b < 0n;
  const x = a < 0n ? -a : a;
  const y = b < 0n ? -b : b;
  const q = (x * 2n + y) / (y * 2n);
  return negative ? -q : q;
};

/**
 * What an amount billed every period is worth a month (monthly recurring revenue): a year is twelve months, a week
 * 52 / 12 of a month, a day 365 / 12.
 */
export function mrrOf(amount: string, period: Period): string {
  const interval = BigInt(Math.max(1, Math.trunc(period.interval)));
  const a = units(amount);
  const value =
    period.unit === 'month'
      ? divide(a, interval)
      : period.unit === 'year'
        ? divide(a, interval * 12n)
        : period.unit === 'week'
          ? divide(a * 52n, interval * 12n)
          : divide(a * 365n, interval * 12n);
  return decimal(value);
}

/**
 * The share of `amount` (what a whole period costs) for the days from `from` to the period's end, both included:
 * a change made on `from` is owed, or given back, for the days that are left. Nothing before the period, the whole
 * amount at its first day, nothing after its last.
 */
export function prorate(
  amount: string,
  from: string,
  period: { readonly start: string; readonly end: string },
): { amount: string; days: number; of: number } {
  const of = daysBetween(period.start, addDays(period.end, 1));
  const first = from < period.start ? period.start : from;
  const days = first > period.end ? 0 : daysBetween(first, addDays(period.end, 1));
  if (of === 0 || days === 0) return { amount: decimal(0n), days: 0, of };
  return { amount: decimal(divide(units(amount) * BigInt(days), BigInt(of))), days, of };
}
