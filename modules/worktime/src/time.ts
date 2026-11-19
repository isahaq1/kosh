/**
 * The working-time engine (RFC 0034 §2.4): one answer, for every app, to "is this a working day", "how many working
 * days between", "what is the date five working days later", "how many working minutes between two moments" and
 * "when is it, 90 working minutes from now". Pure functions over a {@link Schedule} — a week of hours, the days
 * off, the days with hours of their own — without a database.
 *
 * Dates are ISO strings (`2026-11-19`), weekdays are JavaScript's (0: Sunday), times are minutes after local
 * midnight in the schedule's time zone.
 */

/** Hours of a day: `[from, to)` in minutes after midnight. */
export type Interval = readonly [from: number, to: number];

export interface Schedule {
  /** IANA time zone the hours are in. */
  readonly tz: string;
  /** The working hours of each weekday (0: Sunday); a missing or empty day is not worked. */
  readonly week: Readonly<Record<number, readonly Interval[]>>;
  /** Days nobody works: public holidays, and a person's days off. */
  readonly off: ReadonlySet<string>;
  /** Days with hours of their own, whatever the week and the holidays say (a working Saturday, a half day). */
  readonly extra: ReadonlyMap<string, readonly Interval[]>;
}

const DAY = 86_400_000;
/** Enough days to look ahead for anything a business schedules (ten years). */
const HORIZON = 3660;

/** `09:30` → 570. @throws {RangeError} for anything that is not a time of day. */
export function minutesOf(hhmm: string): number {
  const found = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (found === null) {
    if (hhmm === '24:00') return 1440;
    throw new RangeError(`'${hhmm}' is not a time of day (HH:MM).`);
  }
  return Number(found[1]) * 60 + Number(found[2]);
}
/** 570 → `09:30`. */
export const timeOf = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

const utc = (date: string): number => {
  const t = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(t)) throw new RangeError(`'${date}' is not a date (YYYY-MM-DD).`);
  return t;
};
const isoOf = (t: number): string => new Date(t).toISOString().slice(0, 10);
/** The date `days` days after `date` (before, when negative). */
export const addDays = (date: string, days: number): string => isoOf(utc(date) + days * DAY);
/** The weekday of a date (0: Sunday). */
export const weekdayOf = (date: string): number => new Date(utc(date)).getUTCDay();

/** A week that works the same hours every day outside its weekend. */
export function weekOf(
  weekend: readonly number[],
  hours: readonly Interval[] = [[540, 1020]],
): Record<number, readonly Interval[]> {
  const week: Record<number, readonly Interval[]> = {};
  for (let day = 0; day < 7; day += 1) week[day] = weekend.includes(day) ? [] : hours;
  return week;
}
/** A schedule from a week alone. */
export const scheduleOfWeek = (week: Schedule['week'], tz = 'UTC'): Schedule => ({
  tz,
  week,
  off: new Set(),
  extra: new Map(),
});

/** The hours worked on a date: its own if it has some, none on a day off, the weekday's otherwise. */
export function hoursOn(schedule: Schedule, date: string): readonly Interval[] {
  const own = schedule.extra.get(date);
  if (own !== undefined) return own;
  if (schedule.off.has(date)) return [];
  return schedule.week[weekdayOf(date)] ?? [];
}
const minutesIn = (hours: readonly Interval[]): number =>
  hours.reduce((sum, [from, to]) => sum + Math.max(0, to - from), 0);
/** The working minutes of a date. */
export const minutesOn = (schedule: Schedule, date: string): number =>
  minutesIn(hoursOn(schedule, date));
export const isWorkingDay = (schedule: Schedule, date: string): boolean =>
  minutesOn(schedule, date) > 0;

/** The working days from `from` to `to`, both included (0 when `to` is before `from`). */
export function workingDays(schedule: Schedule, from: string, to: string): number {
  let days = 0;
  for (let t = utc(from), end = utc(to); t <= end; t += DAY)
    if (isWorkingDay(schedule, isoOf(t))) days += 1;
  return days;
}
/** Those days, one by one. */
export function workingDates(schedule: Schedule, from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = utc(from), end = utc(to); t <= end; t += DAY)
    if (isWorkingDay(schedule, isoOf(t))) out.push(isoOf(t));
  return out;
}

/**
 * The date `days` working days after `date` (before it, when negative). With 0: `date` itself when it is worked,
 * the next working day otherwise. @throws {RangeError} when the schedule has no working day within ten years.
 */
export function addWorkingDays(schedule: Schedule, date: string, days: number): string {
  const step = days < 0 ? -1 : 1;
  let left = Math.abs(Math.trunc(days));
  let current = date;
  if (left === 0) {
    for (let i = 0; i < HORIZON; i += 1, current = addDays(current, 1))
      if (isWorkingDay(schedule, current)) return current;
    throw new RangeError('The calendar has no working day.');
  }
  for (let i = 0; i < HORIZON && left > 0; i += 1) {
    current = addDays(current, step);
    if (isWorkingDay(schedule, current)) left -= 1;
  }
  if (left > 0) throw new RangeError('The calendar has no working day.');
  return current;
}

/** The first and the last working day of a month (`month`: 1 to 12); null when the month has none. */
export function workingDaysOfMonth(
  schedule: Schedule,
  year: number,
  month: number,
): { first: string; last: string; count: number } | null {
  const from = isoOf(Date.UTC(year, month - 1, 1));
  const to = isoOf(Date.UTC(year, month, 0));
  const all = workingDates(schedule, from, to);
  const first = all[0];
  const last = all.at(-1);
  return first === undefined || last === undefined ? null : { first, last, count: all.length };
}

// ---- moments: hours in the schedule's time zone

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
/** The local date of a moment in a time zone. */
export function dateIn(at: Date, tz: string): string {
  const p = parts(at, tz);
  return isoOf(Date.UTC(p.y, p.m - 1, p.d));
}
/** The instant of `minutes` after midnight of a local date in a time zone (daylight saving included). */
export function instantOf(date: string, minutes: number, tz: string): number {
  const guess = utc(date) + minutes * 60_000;
  const offset = (t: number) => {
    const p = parts(new Date(t), tz);
    return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - t;
  };
  const first = guess - offset(guess);
  return guess - offset(first);
}

/** Each working window from the local day of `from` on, as instants, in order. */
function* windows(schedule: Schedule, from: Date): Generator<[number, number]> {
  let date = dateIn(from, schedule.tz);
  for (let i = 0; i < HORIZON; i += 1, date = addDays(date, 1))
    for (const [a, b] of [...hoursOn(schedule, date)].sort((x, y) => x[0] - y[0]))
      if (b > a) yield [instantOf(date, a, schedule.tz), instantOf(date, b, schedule.tz)];
}

/** The working minutes between two moments (0 when `to` is not after `from`). */
export function workingMinutesBetween(schedule: Schedule, from: Date, to: Date): number {
  if (to <= from) return 0;
  let total = 0;
  for (const [a, b] of windows(schedule, from)) {
    if (a >= to.getTime()) break;
    const start = Math.max(a, from.getTime());
    const end = Math.min(b, to.getTime());
    if (end > start) total += end - start;
  }
  return Math.round(total / 60_000);
}

/**
 * The moment `minutes` working minutes after `from`: outside working hours the clock waits for the next window.
 * @throws {RangeError} when the schedule has too little working time within ten years.
 */
export function addWorkingMinutes(schedule: Schedule, from: Date, minutes: number): Date {
  let left = Math.max(0, minutes) * 60_000;
  const start = from.getTime();
  if (left === 0) return new Date(start);
  for (const [a, b] of windows(schedule, from)) {
    const s = Math.max(a, start);
    if (s >= b) continue;
    if (s + left <= b) return new Date(s + left);
    left -= b - s;
  }
  throw new RangeError('The calendar has too little working time.');
}

/** The next moment that is inside working hours: `from` itself when it is, the next window's start otherwise. */
export function nextWorkingMoment(schedule: Schedule, from: Date): Date | null {
  for (const [a, b] of windows(schedule, from)) {
    if (from.getTime() < b) return new Date(Math.max(a, from.getTime()));
  }
  return null;
}
