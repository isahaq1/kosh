/**
 * Business hours (RFC 0024 §2.4): a team works from `open` to `close` (`HH:MM`) on the days outside its weekend, in
 * a time zone; SLA targets count only those minutes. Pure functions, without a database.
 */

export interface Hours {
  readonly open: string;
  readonly close: string;
  /** JavaScript day numbers off (0: Sunday). */
  readonly weekend: readonly number[];
  readonly tz: string;
}

/** The weekend of each choice, as JavaScript day numbers. */
export const WEEKENDS: Readonly<Record<string, readonly number[]>> = {
  fri_sat: [5, 6],
  sat_sun: [6, 0],
  fri: [5],
  none: [],
};

const DAY = 86_400_000;
const minutesOf = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return h * 60 + m;
};

function parts(at: Date, tz: string): { y: number; m: number; d: number; h: number; min: number } {
  const out: Record<string, number> = {};
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(at))
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  return {
    y: out['year'] ?? 0,
    m: out['month'] ?? 1,
    d: out['day'] ?? 1,
    h: out['hour'] ?? 0,
    min: out['minute'] ?? 0,
  };
}

/** The instant of `minutes` after midnight of the local date `y-m-d` in `tz`. */
function instant(y: number, m: number, d: number, minutes: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  const offset = (t: number) => {
    const p = parts(new Date(t), tz);
    return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - t;
  };
  const first = guess - offset(guess);
  return guess - offset(first);
}

/** The working window of each local day from the one of `from`, as instants, for at most `days` days. */
function* windows(from: Date, hours: Hours, days = 3660): Generator<[number, number]> {
  const p = parts(from, hours.tz);
  let day = Date.UTC(p.y, p.m - 1, p.d);
  const open = minutesOf(hours.open);
  const close = minutesOf(hours.close);
  if (close <= open) return;
  for (let i = 0; i < days; i += 1, day += DAY) {
    const date = new Date(day);
    if (hours.weekend.includes(date.getUTCDay())) continue;
    const y = date.getUTCFullYear();
    const m = date.getUTCMonth() + 1;
    const d = date.getUTCDate();
    yield [instant(y, m, d, open, hours.tz), instant(y, m, d, close, hours.tz)];
  }
}

/** The moment `minutes` working minutes after `from`. */
export function addBusinessMinutes(from: Date, minutes: number, hours: Hours): Date {
  let left = Math.max(0, minutes) * 60_000;
  const start = from.getTime();
  for (const [a, b] of windows(from, hours)) {
    const s = Math.max(a, start);
    if (s >= b) continue;
    if (s + left <= b) return new Date(s + left);
    left -= b - s;
  }
  return new Date(start + minutes * 60_000);
}

/** The working minutes between two moments (0 when `to` is not after `from`). */
export function businessMinutesBetween(from: Date, to: Date, hours: Hours): number {
  if (to <= from) return 0;
  let total = 0;
  for (const [a, b] of windows(from, hours)) {
    if (a >= to.getTime()) break;
    const s = Math.max(a, from.getTime());
    const e = Math.min(b, to.getTime());
    if (e > s) total += e - s;
  }
  return Math.round(total / 60_000);
}
