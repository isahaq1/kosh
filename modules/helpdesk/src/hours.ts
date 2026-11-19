/**
 * Business hours (RFC 0024 §2.4): a team works from `open` to `close` (`HH:MM`) on the days outside its weekend, in
 * a time zone — or by a **working calendar** (Working time, RFC 0034 §2.4), with its breaks and its holidays. SLA
 * targets count only those minutes. The counting itself is Working time's engine: one for every app.
 */
import {
  addWorkingMinutes,
  minutesOf,
  type Schedule,
  scheduleOfWeek,
  weekOf,
  workingMinutesBetween,
} from '@kosh/worktime';

/** A team's own hours: the same every day outside its weekend. */
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

/** A team's own hours as a schedule (no holidays: a team that keeps them works by a calendar). */
export function scheduleOfHours(hours: Hours): Schedule {
  const open = minutesOf(hours.open);
  const close = minutesOf(hours.close);
  return scheduleOfWeek(weekOf(hours.weekend, close > open ? [[open, close]] : []), hours.tz);
}
const scheduleOf = (hours: Hours | Schedule): Schedule =>
  'week' in hours ? hours : scheduleOfHours(hours);

/** The moment `minutes` working minutes after `from` (plain minutes later for hours that never open). */
export function addBusinessMinutes(from: Date, minutes: number, hours: Hours | Schedule): Date {
  try {
    return addWorkingMinutes(scheduleOf(hours), from, minutes);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return new Date(from.getTime() + minutes * 60_000);
  }
}

/** The working minutes between two moments (0 when `to` is not after `from`). */
export function businessMinutesBetween(from: Date, to: Date, hours: Hours | Schedule): number {
  return workingMinutesBetween(scheduleOf(hours), from, to);
}
