/**
 * Repeating events (RFC 0034 §2.4): the dates a rule gives — every day, every second week on Tuesday and Thursday,
 * the 15th of each month, the second Tuesday, the last Friday, the first or the last **working day** of the month,
 * every year — until a date or for so many times. A date that falls on a day off (a weekend, a holiday of the
 * working calendar) is kept, skipped, or moved to the working day before or after. Pure functions over ISO dates;
 * what a working day is comes from the caller (Working time).
 */

export type Frequency = 'daily' | 'weekly' | 'monthly' | 'yearly';
/** Which day of a month a monthly rule means. */
export type MonthlyOn =
  | 'day' // the same day of the month as the first (the last day when the month is shorter)
  | 'weekday' // the same weekday in the same week of the month (the 2nd Tuesday; the last when there is no 5th)
  | 'last_weekday' // the last such weekday of the month
  | 'first_working' // the first working day of the month
  | 'last_working'; // the last working day of the month
/** What becomes of an occurrence on a day off. */
export type OnDayOff = 'keep' | 'skip' | 'before' | 'after';

export interface Rule {
  readonly freq: Frequency;
  /** Every `interval` days, weeks, months or years. */
  readonly interval: number;
  /** Weekly: the weekdays (0: Sunday); none: the first date's weekday. */
  readonly weekdays?: readonly number[];
  readonly monthlyOn?: MonthlyOn;
  readonly onDayOff?: OnDayOff;
  /** Ends after so many occurrences… */
  readonly count?: number | null;
  /** …or on this date (included). One of the two is needed. */
  readonly until?: string | null;
}

/** The most occurrences a series may have, whatever its rule says. */
export const MAX_OCCURRENCES = 366;
const DAY = 86_400_000;
const utc = (date: string): number => Date.parse(`${date}T00:00:00Z`);
const iso = (t: number): string => new Date(t).toISOString().slice(0, 10);
const day = (date: string, days: number): string => iso(utc(date) + days * DAY);
const weekdayOf = (date: string): number => new Date(utc(date)).getUTCDay();
const ymd = (y: number, m: number, d: number): string => iso(Date.UTC(y, m, d));
const lastDayOf = (y: number, m: number): number => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/** The day of month `m` (0-based) of year `y` that a monthly rule means, given the first date. */
function monthlyDate(
  y: number,
  m: number,
  first: string,
  on: MonthlyOn,
  working: (date: string) => boolean,
): string | null {
  const last = lastDayOf(y, m);
  const firstDay = Number(first.slice(8, 10));
  const wd = weekdayOf(first);
  switch (on) {
    case 'day':
      return ymd(y, m, Math.min(firstDay, last));
    case 'weekday':
    case 'last_weekday': {
      const all: number[] = [];
      for (let d = 1; d <= last; d += 1) if (weekdayOf(ymd(y, m, d)) === wd) all.push(d);
      const nth = Math.ceil(firstDay / 7);
      const chosen = on === 'last_weekday' ? all.at(-1) : (all[nth - 1] ?? all.at(-1));
      return chosen === undefined ? null : ymd(y, m, chosen);
    }
    case 'first_working':
      for (let d = 1; d <= last; d += 1) if (working(ymd(y, m, d))) return ymd(y, m, d);
      return null;
    case 'last_working':
      for (let d = last; d >= 1; d -= 1) if (working(ymd(y, m, d))) return ymd(y, m, d);
      return null;
  }
}

/** A date on a day off, by the rule: itself, nothing, or the nearest working day before or after (within a month). */
function settle(date: string, policy: OnDayOff, working: (date: string) => boolean): string | null {
  if (policy === 'keep' || working(date)) return date;
  if (policy === 'skip') return null;
  const step = policy === 'before' ? -1 : 1;
  for (let i = 1; i <= 31; i += 1) if (working(day(date, i * step))) return day(date, i * step);
  return null;
}

/**
 * The dates of a series that starts on `first` (itself the first candidate), in order and without repeats; at most
 * {@link MAX_OCCURRENCES}, and never past ten years. @throws {RangeError} for a rule without an end or with an
 * interval below one.
 */
export function occurrences(
  rule: Rule,
  first: string,
  working: (date: string) => boolean = () => true,
): string[] {
  if (Number.isNaN(utc(first))) throw new RangeError(`'${first}' is not a date.`);
  const interval = Math.trunc(rule.interval);
  if (!(interval >= 1)) throw new RangeError('A series repeats every 1 or more.');
  const count = rule.count == null ? null : Math.trunc(rule.count);
  const until = rule.until ?? null;
  if (count === null && until === null)
    throw new RangeError('A series ends: after a number of times, or on a date.');
  if (count !== null && count < 1) throw new RangeError('A series happens at least once.');
  const limit = Math.min(count ?? MAX_OCCURRENCES, MAX_OCCURRENCES);
  const horizon = day(first, 3660);
  const stop = until !== null && until < horizon ? until : horizon;
  const policy = rule.onDayOff ?? 'keep';
  const out: string[] = [];
  const seen = new Set<string>();
  /** Takes a candidate; false once the series is over. */
  const take = (candidate: string | null): boolean => {
    if (candidate === null) return true;
    if (candidate < first) return true;
    if (candidate > stop) return false;
    const date = settle(candidate, policy, working);
    if (date === null || date < first || date > stop || seen.has(date)) return true;
    seen.add(date);
    out.push(date);
    return out.length < limit;
  };

  if (rule.freq === 'daily') {
    for (let i = 0; i < 4000; i += 1) if (!take(day(first, i * interval))) break;
  } else if (rule.freq === 'weekly') {
    const days = [...new Set(rule.weekdays?.length ? rule.weekdays : [weekdayOf(first)])].sort(
      (a, b) => ((a + 6) % 7) - ((b + 6) % 7), // Monday first, as the weeks are counted
    );
    // The Monday of the first date's week: every `interval` weeks from there.
    const monday = day(first, -((weekdayOf(first) + 6) % 7));
    outer: for (let w = 0; w < 600; w += 1)
      for (const d of days) if (!take(day(monday, w * interval * 7 + ((d + 6) % 7)))) break outer;
  } else {
    const y0 = Number(first.slice(0, 4));
    const m0 = Number(first.slice(5, 7)) - 1;
    const months = rule.freq === 'yearly' ? interval * 12 : interval;
    // A yearly rule is a monthly one twelve months apart: 29 February becomes the 28th in other years.
    const on = rule.monthlyOn ?? 'day';
    for (let i = 0; i < 1500; i += 1) {
      const m = m0 + i * months;
      if (!take(monthlyDate(y0 + Math.floor(m / 12), ((m % 12) + 12) % 12, first, on, working)))
        break;
    }
  }
  return out.sort();
}

const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];
const ORDINALS = ['first', 'second', 'third', 'fourth', 'last'];

/** The rule in words: "Every 2 weeks on Tuesday and Thursday, 10 times". */
export function describeRule(rule: Rule, first: string): string {
  const n = Math.max(1, Math.trunc(rule.interval));
  const unit = { daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year' }[rule.freq];
  let text = n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`;
  const wd = WEEKDAY_NAMES[weekdayOf(first)] as string;
  if (rule.freq === 'weekly') {
    const days = [...new Set(rule.weekdays?.length ? rule.weekdays : [weekdayOf(first)])]
      .sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
      .map((d) => WEEKDAY_NAMES[d] as string);
    text += ` on ${days.length > 1 ? `${days.slice(0, -1).join(', ')} and ${days.at(-1)}` : days[0]}`;
  } else if (rule.freq === 'monthly' || rule.freq === 'yearly') {
    const dayOfMonth = Number(first.slice(8, 10));
    const month = new Date(utc(first)).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
    const on = rule.monthlyOn ?? 'day';
    const which =
      on === 'day'
        ? `on the ${dayOfMonth}${['th', 'st', 'nd', 'rd'][dayOfMonth % 10 > 3 || Math.floor(dayOfMonth / 10) === 1 ? 0 : dayOfMonth % 10]}`
        : on === 'weekday'
          ? `on the ${ORDINALS[Math.min(4, Math.ceil(dayOfMonth / 7) - 1)]} ${wd}`
          : on === 'last_weekday'
            ? `on the last ${wd}`
            : on === 'first_working'
              ? 'on the first working day'
              : 'on the last working day';
    text += rule.freq === 'yearly' ? ` ${which} of ${month}` : ` ${which}`;
  }
  const off = {
    keep: '',
    skip: ', skipping days off',
    before: ', moved before a day off',
    after: ', moved after a day off',
  }[rule.onDayOff ?? 'keep'];
  const end =
    rule.count != null
      ? `, ${rule.count} time${rule.count === 1 ? '' : 's'}`
      : rule.until
        ? `, until ${rule.until}`
        : '';
  return `${text}${off}${end}`;
}
