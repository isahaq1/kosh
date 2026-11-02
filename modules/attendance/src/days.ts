/**
 * Attendance computed (RFC 0024 §2.2): the day of each person from their punches, their shift (the roster's, else
 * their usual one), the weekend (Workforce's setting), public holidays and approved leave — in the installation's
 * time zone (App settings › Attendance). Approved days are never recomputed.
 *
 * Also here: a punch from the phone or the kiosk (check in, or out when checked in), the geofence, and device files
 * (ZKTeco's attendance log and a plain CSV) turned into punches, each once.
 */
import { weekendOf } from '@kosh/hr';
import { installationSetting } from '@kosh/server';
import { type Decimal, type Id, orm } from '@kosh/server/orm';
import type { Env } from './.kosh/bindings.js';

const DAY = 86_400_000;

// ---- time zones: dates and minutes of the day where the people work.

/** The installation's time zone for attendance; a wrong one falls back to Asia/Dhaka. */
export async function timeZoneOf(env: Env): Promise<string> {
  const tz = String(await installationSetting(env, 'attendance.timezone', 'Asia/Dhaka'));
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'Asia/Dhaka';
  }
}

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

/** The date of an instant where the people work, `YYYY-MM-DD`. */
export function localDate(at: Date, tz: string): string {
  const p = parts(at, tz);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** The instant of `minutes` after midnight of `date` in `tz` (minutes may pass 1 440: the next day). */
export function instantOf(date: string, minutes: number, tz: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  const offset = (t: number) => {
    const p = parts(new Date(t), tz);
    return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - t;
  };
  const first = guess - offset(guess);
  return new Date(guess - offset(first));
}

/** `YYYY-MM-DD` plus `days`. */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}

/** `HH:MM` as minutes after midnight. */
export const minutesOf = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return h * 60 + m;
};

// ---- one day, computed (pure).

export interface ShiftRule {
  readonly start: string;
  readonly end: string;
  readonly breakMinutes: number;
  readonly graceMinutes: number;
  readonly overtimeAfter: number;
  readonly overtimeStep: number;
}

export interface DayInput {
  readonly date: string;
  readonly tz: string;
  readonly shift: ShiftRule | null;
  readonly weekend: boolean;
  readonly holiday: boolean;
  readonly leave: boolean;
  readonly punches: readonly { readonly checkIn: Date; readonly checkOut: Date | null }[];
}

export interface DayResult {
  readonly status: 'present' | 'absent' | 'leave' | 'holiday' | 'weekend' | 'incomplete' | 'off';
  readonly firstIn: Date | null;
  readonly lastOut: Date | null;
  readonly workedMinutes: number;
  readonly expectedMinutes: number;
  readonly lateMinutes: number;
  readonly earlyMinutes: number;
  readonly overtimeMinutes: number;
}

/** The day: what the punches, the shift and the calendar say. */
export function computeDay(input: DayInput): DayResult {
  const { shift, punches } = input;
  const workday = shift !== null && !input.weekend && !input.holiday && !input.leave;
  const span = shift === null ? 0 : shiftMinutes(shift);
  const expected = workday && shift !== null ? Math.max(0, span - shift.breakMinutes) : 0;
  const sorted = [...punches].sort((a, b) => a.checkIn.getTime() - b.checkIn.getTime());
  if (sorted.length === 0)
    return {
      status: input.leave
        ? 'leave'
        : input.holiday
          ? 'holiday'
          : input.weekend
            ? 'weekend'
            : shift === null
              ? 'off'
              : 'absent',
      firstIn: null,
      lastOut: null,
      workedMinutes: 0,
      expectedMinutes: expected,
      lateMinutes: 0,
      earlyMinutes: 0,
      overtimeMinutes: 0,
    };
  const present = sorted.reduce(
    (sum, p) =>
      sum + (p.checkOut === null ? 0 : (p.checkOut.getTime() - p.checkIn.getTime()) / 60_000),
    0,
  );
  // The shift's break is not work: deducted, less the breaks the punches already show (their gaps).
  let gaps = 0;
  for (let i = 1; i < sorted.length; i += 1) {
    const before = sorted[i - 1]?.checkOut;
    const next = sorted[i]?.checkIn;
    if (before != null && next !== undefined)
      gaps += Math.max(0, (next.getTime() - before.getTime()) / 60_000);
  }
  const unpaidBreak = shift === null ? 0 : Math.max(0, shift.breakMinutes - gaps);
  const worked = present > unpaidBreak ? present - unpaidBreak : present;
  const firstIn = sorted[0]?.checkIn ?? null;
  const closed = sorted.filter((p) => p.checkOut !== null);
  const lastOut = closed.length === 0 ? null : (closed[closed.length - 1]?.checkOut ?? null);
  const open = sorted.some((p) => p.checkOut === null);
  const midnight = instantOf(input.date, 0, input.tz).getTime();
  const sinceMidnight = (d: Date) => Math.round((d.getTime() - midnight) / 60_000);
  let late = 0;
  let early = 0;
  let overtime = 0;
  if (workday && shift !== null) {
    const start = minutesOf(shift.start);
    const end = start + span;
    if (firstIn !== null) late = Math.max(0, sinceMidnight(firstIn) - (start + shift.graceMinutes));
    if (lastOut !== null && !open) early = Math.max(0, end - sinceMidnight(lastOut));
    const extra = worked - expected;
    if (extra > shift.overtimeAfter) overtime = floorTo(extra, shift.overtimeStep);
  } else if (shift !== null && (input.weekend || input.holiday)) {
    // Every hour worked on a weekend or a holiday is overtime.
    overtime = floorTo(worked, shift.overtimeStep);
  }
  return {
    status: open ? 'incomplete' : 'present',
    firstIn,
    lastOut,
    workedMinutes: Math.round(worked),
    expectedMinutes: expected,
    lateMinutes: Math.round(late),
    earlyMinutes: Math.round(early),
    overtimeMinutes: overtime,
  };
}

/** A shift's length in minutes; a night shift ends the next day. */
export function shiftMinutes(shift: Pick<ShiftRule, 'start' | 'end'>): number {
  const start = minutesOf(shift.start);
  let end = minutesOf(shift.end);
  if (end <= start) end += 1440;
  return end - start;
}

const floorTo = (minutes: number, step: number) =>
  Math.floor(minutes / Math.max(1, step)) * Math.max(1, step);
const hours = (minutes: number): string =>
  orm.toDecimal(minutes).div(60).toDecimalPlaces(2).toString();

// ---- days written for people and dates.

/** Recomputes the days of `employees` from `from` to `to` (inclusive); approved days stay as they are. */
export async function recomputeDays(
  env: Env,
  employees: readonly number[],
  from: string,
  to: string,
): Promise<number> {
  if (employees.length === 0 || to < from) return 0;
  const tz = await timeZoneOf(env);
  const weekend = await weekendOf(env as never);
  let written = 0;
  for (const e of await env
    .model('hr.employee')
    .browse(employees as never)
    .load({ attendanceShift: true, company: true })) {
    const rosters = await (
      await env.model('attendance.roster').search({
        where: { employee: e.id, dateFrom: { lte: to }, dateTo: { gte: from } },
      })
    ).load({ shift: true });
    const holidays = new Set(
      [
        ...(await (
          await env.model('attendance.holiday').search({
            where: { company: e.company.id, date: { gte: from, lte: to } },
          })
        ).load(['date'])),
      ].map((h) => isoDate(h.date)),
    );
    const leaves = [
      ...(await (
        await env.model('hr.leave').search({
          where: {
            employee: e.id,
            state: 'approved',
            dateFrom: { lte: to },
            dateTo: { gte: from },
          },
        })
      ).load(['dateFrom', 'dateTo'])),
    ].map((l) => [isoDate(l.dateFrom), isoDate(l.dateTo)] as const);
    const punches = [
      ...(await (
        await env.model('attendance.record').search({
          where: {
            employee: e.id,
            checkIn: { gte: instantOf(from, 0, tz), lt: instantOf(addDays(to, 1), 0, tz) },
          },
        })
      ).load(['checkIn', 'checkOut'])),
    ];
    const existing = new Map(
      [
        ...(await (
          await env.model('attendance.day').search({
            where: { employee: e.id, date: { gte: from, lte: to } },
          })
        ).load(['date', 'state'])),
      ].map((d) => [isoDate(d.date), d] as const),
    );
    for (let date = from; date <= to; date = addDays(date, 1)) {
      const old = existing.get(date);
      if (old?.state === 'approved') continue;
      const roster = [...rosters].find(
        (r) => isoDate(r.dateFrom) <= date && isoDate(r.dateTo) >= date,
      );
      const shift = roster?.shift ?? e.attendanceShift ?? null;
      const mine = punches.filter((p) => localDate(p.checkIn, tz) === date);
      const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
      const result = computeDay({
        date,
        tz,
        shift,
        weekend: weekend.includes(dow),
        holiday: holidays.has(date),
        leave: leaves.some(([a, b]) => a <= date && b >= date),
        punches: mine,
      });
      // Nothing to say about a weekend, a holiday or a day without a shift nobody worked.
      if (
        old === undefined &&
        mine.length === 0 &&
        ['weekend', 'holiday', 'off'].includes(result.status)
      )
        continue;
      const values = {
        employee: e.id,
        date,
        company: e.company.id,
        shift: shift?.id ?? null,
        status: result.status,
        firstIn: result.firstIn,
        lastOut: result.lastOut,
        workedHours: hours(result.workedMinutes),
        expectedHours: hours(result.expectedMinutes),
        lateMinutes: result.lateMinutes,
        earlyMinutes: result.earlyMinutes,
        overtimeHours: hours(result.overtimeMinutes),
        overtimeApproved: hours(result.overtimeMinutes),
        overtimeRate: (shift?.overtimeRate ?? orm.toDecimal(2)).toString(),
      };
      if (old === undefined) await env.model('attendance.day').create([values as never]);
      else
        await env
          .model('attendance.day')
          .browse([old.id])
          .write(values as never);
      written += 1;
    }
  }
  return written;
}

/** A date-only value as `YYYY-MM-DD` (PostgreSQL dates read as local midnights). */
export function isoDate(v: unknown): string {
  if (!(v instanceof Date)) return String(v ?? '').slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
}

// ---- punches.

/** The distance in metres between two points (haversine). */
export function distanceMetres(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * 6_371_000 * Math.asin(Math.sqrt(h)));
}

export interface PunchInput {
  readonly source: 'phone' | 'kiosk' | 'device' | 'manual';
  readonly site?: number | null;
  readonly inside?: boolean | null;
  readonly distance?: number | null;
}

/** Checks the employee in, or out when checked in; recomputes the day. */
export async function punch(
  env: Env,
  employee: number,
  at: Date,
  input: PunchInput,
): Promise<{ action: 'in' | 'out'; record: number; at: string }> {
  const open = await env
    .model('attendance.record')
    .search({ where: { employee: employee as never, checkOut: { isNull: true } }, limit: 1 });
  const [e] = await env
    .model('hr.employee')
    .browse([employee as never])
    .load({ company: true });
  if (e === undefined)
    throw new orm.ValidationError(
      'attendance.record',
      ['employee'],
      'No such employee.',
      'Choose an employee.',
    );
  let action: 'in' | 'out';
  let id: number;
  let checkIn = at;
  if (open.length > 0) {
    const [current] = await open.load(['checkIn']);
    checkIn = current?.checkIn ?? at;
    if (at.getTime() - checkIn.getTime() < 60_000)
      throw new orm.ValidationError(
        'attendance.record',
        ['checkOut'],
        'Checked in less than a minute ago.',
        'A second tap is not a check-out: wait a minute.',
      );
    await open.write({ checkOut: at } as never);
    action = 'out';
    id = open.ids[0] as number;
  } else {
    const made = await env.model('attendance.record').create([
      {
        employee,
        company: e.company.id,
        checkIn: at,
        source: input.source,
        site: input.site ?? null,
        ...(input.inside == null ? {} : { inside: input.inside }),
        distance: input.distance ?? null,
      } as never,
    ]);
    action = 'in';
    id = made.ids[0] as number;
  }
  await env.flush();
  const tz = await timeZoneOf(env);
  await recomputeDays(env, [employee], localDate(checkIn, tz), localDate(at, tz));
  return { action, record: id, at: at.toISOString() };
}

// ---- device files.

/** A punch read from a device file: the person's number on the device and the local time. */
export interface DevicePunch {
  readonly user: string;
  /** `YYYY-MM-DD HH:MM[:SS]`, in the installation's time zone. */
  readonly at: string;
}

/** A device file format (RFC 0024 §3: an adapter; ZKTeco's log and a CSV ship). */
export interface DeviceFormat {
  readonly key: string;
  readonly label: string;
  readonly parse: (text: string) => DevicePunch[];
}

const LOCAL = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(:\d{2})?$/;

export const DEVICE_FORMATS: readonly DeviceFormat[] = [
  {
    key: 'zkteco',
    label: 'ZKTeco attendance log (attlog.dat)',
    // `   12\t2026-10-20 08:58:12\t1\t0\t1\t0`: the user ID, the date and time, then flags.
    parse: (text) =>
      text
        .split(/\r?\n/)
        .map((line) => line.trim().split(/\s+/))
        .filter((cols) => cols.length >= 3 && LOCAL.test(`${cols[1]} ${cols[2]}`))
        .map((cols) => ({ user: cols[0] as string, at: `${cols[1]} ${cols[2]}` })),
  },
  {
    key: 'csv',
    label: 'CSV: employee code and time',
    // A header with `employee` (the badge or device user ID) and `time` (or `timestamp`) columns.
    parse: (text) => {
      const rows = text
        .split(/\r?\n/)
        .filter((l) => l.trim() !== '')
        .map((l) => l.split(',').map((c) => c.trim().replace(/^"|"$/g, '')));
      const header = (rows[0] ?? []).map((h) => h.toLowerCase());
      const who = header.findIndex((h) => h === 'employee' || h === 'code' || h === 'user');
      const when = header.findIndex((h) => h === 'time' || h === 'timestamp' || h === 'datetime');
      if (who < 0 || when < 0) return [];
      return rows
        .slice(1)
        .map((r) => ({ user: r[who] ?? '', at: r[when] ?? '' }))
        .filter((p) => p.user !== '' && LOCAL.test(p.at));
    },
  },
];

export interface ImportResult {
  readonly imported: number;
  readonly skipped: number;
  readonly unpaired: number;
  readonly unknown: readonly string[];
}

/**
 * Device punches into check-ins and check-outs: each person's punches of a day in pairs (in, out); a punch left
 * alone stays a check-in on the person's last day, and is reported as unpaired before it. A punch already imported
 * (the same person and time) is skipped.
 */
export async function importPunches(
  env: Env,
  punches: readonly DevicePunch[],
): Promise<ImportResult> {
  const tz = await timeZoneOf(env);
  const codes = [...new Set(punches.map((p) => p.user))];
  const people = new Map<string, number>();
  if (codes.length > 0) {
    for (const e of await (
      await env.model('hr.employee').search({
        where: { or: [{ deviceUserId: { in: codes } }, { attendanceBadge: { in: codes } }] },
      })
    ).load(['deviceUserId', 'attendanceBadge'])) {
      if (e.deviceUserId !== null) people.set(e.deviceUserId, e.id);
      if (e.attendanceBadge !== null && !people.has(e.attendanceBadge))
        people.set(e.attendanceBadge, e.id);
    }
  }
  const unknown = codes.filter((c) => !people.has(c));
  const toInstant = (at: string) => {
    const m = LOCAL.exec(at) as RegExpExecArray;
    const [hh, mm] = (m[2] as string).split(':').map(Number) as [number, number];
    const ss = m[3] === undefined ? 0 : Number(m[3].slice(1));
    return new Date(instantOf(m[1] as string, hh * 60 + mm, tz).getTime() + ss * 1000);
  };
  let imported = 0;
  let skipped = 0;
  let unpaired = 0;
  const touched = new Map<number, { from: string; to: string }>();
  const byPerson = new Map<number, Date[]>();
  for (const p of punches) {
    const id = people.get(p.user);
    if (id === undefined) continue;
    const list = byPerson.get(id) ?? [];
    list.push(toInstant(p.at));
    byPerson.set(id, list);
  }
  for (const [employee, times] of byPerson) {
    const [e] = await env
      .model('hr.employee')
      .browse([employee as never])
      .load({ company: true });
    if (e === undefined) continue;
    const sorted = [...new Set(times.map((t) => t.getTime()))]
      .sort((a, b) => a - b)
      .map((t) => new Date(t));
    const days = new Map<string, Date[]>();
    for (const t of sorted) {
      const d = localDate(t, tz);
      days.set(d, [...(days.get(d) ?? []), t]);
    }
    const dates = [...days.keys()].sort();
    for (const date of dates) {
      const list = days.get(date) as Date[];
      for (let i = 0; i < list.length; i += 2) {
        const checkIn = list[i] as Date;
        const checkOut = list[i + 1] ?? null;
        const exists = await env
          .model('attendance.record')
          .search({ where: { employee: employee as never, checkIn }, limit: 1 });
        if (exists.length > 0) {
          skipped += 1;
          continue;
        }
        if (checkOut === null) {
          const open = await env.model('attendance.record').search({
            where: { employee: employee as never, checkOut: { isNull: true } },
            limit: 1,
          });
          if (date !== dates[dates.length - 1] || open.length > 0) {
            unpaired += 1;
            continue;
          }
        }
        await env
          .model('attendance.record')
          .create([
            { employee, company: e.company.id, checkIn, checkOut, source: 'device' } as never,
          ]);
        imported += 1;
      }
    }
    if (dates.length > 0)
      touched.set(employee, { from: dates[0] as string, to: dates[dates.length - 1] as string });
  }
  await env.flush();
  for (const [employee, span] of touched) await recomputeDays(env, [employee], span.from, span.to);
  return { imported, skipped, unpaired, unknown };
}

export type { Decimal, Id };
