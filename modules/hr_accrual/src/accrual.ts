/**
 * The arithmetic of leave accruals (RFC 0034 §2.5), without a database: a balance moved month by month — what the
 * plan's formula gives at the month's end, after probation and up to the cap; at the year's start what is above
 * the carry-over is lost; what was carried and not used by the expiry month is lost at its end. The same steps
 * run for the past (what is written to the ledger) and for the future (a balance projected to any date).
 *
 * Days are counted in hundredths (integers), so that nothing drifts: 0.83 a month is 83, twelve times is 9.96.
 */

/** A plan's rules, in hundredths of a day. */
export interface AccrualRules {
  /** Nothing accrues before this many months of service. */
  readonly probationMonths: number;
  /** The balance never accrues above this; `null`: no cap. */
  readonly cap: number | null;
  /** The most carried into a new year; `null`: everything. */
  readonly carryOver: number | null;
  /** Carried days not used by the end of this month of the new year (1: January) are lost; `null`: never. */
  readonly carryExpiryMonth: number | null;
}

/** What is known of a month before it is stepped through. */
export interface MonthInput {
  /** `YYYY-MM`. */
  readonly month: string;
  /** What the plan's formula gives for the month, in hundredths (before probation and the cap). */
  readonly accrued: number;
  /** Leave days of the type that start in the month, in hundredths. */
  readonly taken: number;
  /** Full months of service at the month's end. */
  readonly serviceMonths: number;
}

/** Where a person's balance stands between two months. */
export interface AccrualState {
  /** Everything accrued, lost and adjusted, less everything taken, in hundredths. */
  readonly balance: number;
  /** Of the days carried into this year, those neither used nor lost yet. */
  readonly carried: number;
}

export type MovementKind = 'accrual' | 'lapse' | 'expiry';

/** A line for the ledger: signed hundredths, dated, and keyed so that it is written once. */
export interface Movement {
  readonly kind: MovementKind;
  readonly date: string;
  readonly days: number;
  /** `2027-03` for an accrual or an expiry, `2027` for a year's lapse. */
  readonly period: string;
  readonly note: string;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** The last day of a month `YYYY-MM`. */
export function monthEnd(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12)
    throw new RangeError(`“${month}” is not a month (YYYY-MM).`);
  return `${month}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
}

/** The month after `YYYY-MM`. */
export function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`;
}

/** The months from `from` to `to`, both included (`YYYY-MM`); none when `to` is before `from`. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = from; m <= to; m = nextMonth(m)) out.push(m);
  return out;
}

/** Full months from a day to the end of a month: joined on 15 January, at the end of March it is 2. */
export function serviceMonthsAt(joined: string, month: string): number {
  const [jy, jm, jd] = joined.split('-').map(Number) as [number, number, number];
  // Counted to the first day of the month after: a month is full once its day of the month comes round.
  const [ny, nm] = nextMonth(month).split('-').map(Number) as [number, number];
  return Math.max(0, (ny - jy) * 12 + (nm - jm) - (jd > 1 ? 1 : 0));
}

const days = (hundredths: number): string => (hundredths / 100).toFixed(2);

/**
 * One month: the year's lapse (January), the leave taken, the expiry of what was carried, then the accrual at the
 * month's end. Returns the new state and what goes to the ledger.
 */
export function stepMonth(
  state: AccrualState,
  rules: AccrualRules,
  input: MonthInput,
): { readonly state: AccrualState; readonly movements: readonly Movement[] } {
  const movements: Movement[] = [];
  let { balance, carried } = state;
  const [year, monthNumber] = input.month.split('-').map(Number) as [number, number];
  // The year turns: what is above the carry-over is lost; the rest is what was carried.
  if (monthNumber === 1) {
    const kept = Math.max(0, balance);
    carried = rules.carryOver === null ? kept : Math.min(kept, rules.carryOver);
    const lost = kept - carried;
    if (lost > 0) {
      balance -= lost;
      movements.push({
        kind: 'lapse',
        date: `${year}-01-01`,
        days: -lost,
        period: String(year),
        note: `Above the ${days(rules.carryOver ?? 0)} days carried into ${year}.`,
      });
    }
  }
  // Leave uses what was carried first.
  balance -= input.taken;
  carried = Math.max(0, carried - input.taken);
  const end = monthEnd(input.month);
  if (rules.carryExpiryMonth !== null && monthNumber === rules.carryExpiryMonth && carried > 0) {
    balance -= carried;
    movements.push({
      kind: 'expiry',
      date: end,
      days: -carried,
      period: input.month,
      note: `Carried from ${year - 1} and not used by ${end}.`,
    });
    carried = 0;
  }
  if (rules.carryExpiryMonth !== null && monthNumber > rules.carryExpiryMonth) carried = 0;
  // The month's accrual: after probation, up to the cap.
  let accrued = input.serviceMonths < rules.probationMonths ? 0 : Math.max(0, input.accrued);
  let capped = false;
  if (rules.cap !== null && balance + accrued > rules.cap) {
    accrued = Math.max(0, rules.cap - balance);
    capped = true;
  }
  if (accrued > 0) {
    balance += accrued;
    movements.push({
      kind: 'accrual',
      date: end,
      days: accrued,
      period: input.month,
      note: capped ? `Up to the cap of ${days(rules.cap ?? 0)} days.` : '',
    });
  }
  return { state: { balance, carried }, movements };
}

/** Several months in a row. */
export function stepMonths(
  state: AccrualState,
  rules: AccrualRules,
  inputs: readonly MonthInput[],
): { readonly state: AccrualState; readonly movements: readonly Movement[] } {
  const movements: Movement[] = [];
  let current = state;
  for (const input of inputs) {
    const stepped = stepMonth(current, rules, input);
    current = stepped.state;
    movements.push(...stepped.movements);
  }
  return { state: current, movements };
}
