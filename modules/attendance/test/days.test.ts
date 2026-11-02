/**
 * The attendance day rule (RFC 0024 §2.2), without a database: lateness after the grace, early leave, overtime past
 * its threshold in whole steps, a night shift across midnight, every hour on a weekend as overtime, absence, leave,
 * holidays, a missing check-out; the time zone's day boundaries; ZKTeco's log; distances.
 */
import { describe, expect, test } from 'vitest';
import { computeDay, DEVICE_FORMATS, distanceMetres, instantOf, localDate } from '../src/days.js';

const TZ = 'Asia/Dhaka';
const GENERAL = {
  start: '09:00',
  end: '18:00',
  breakMinutes: 60,
  graceMinutes: 10,
  overtimeAfter: 30,
  overtimeStep: 30,
};
const at = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return instantOf(date, h * 60 + m, TZ);
};
const day = (
  punches: [string, string | null][],
  extra: Partial<Parameters<typeof computeDay>[0]> = {},
  date = '2026-10-20',
) =>
  computeDay({
    date,
    tz: TZ,
    shift: GENERAL,
    weekend: false,
    holiday: false,
    leave: false,
    punches: punches.map(([a, b]) => ({
      checkIn: at(date, a),
      checkOut: b === null ? null : at(date, b),
    })),
    ...extra,
  });

describe('time zones', () => {
  test('09:00 in Dhaka is 03:00 UTC, and its date is Dhaka’s', () => {
    expect(at('2026-10-20', '09:00').toISOString()).toBe('2026-10-20T03:00:00.000Z');
    expect(localDate(new Date('2026-10-20T19:30:00Z'), TZ)).toBe('2026-10-21');
  });
});

describe('a day shift', () => {
  test('on time, an hour of overtime in half-hour steps', () => {
    const d = day([['08:55', '19:07']]);
    expect(d).toMatchObject({
      status: 'present',
      lateMinutes: 0,
      earlyMinutes: 0,
      expectedMinutes: 480,
    });
    // 612 minutes there, the hour's break off: 552, 72 beyond the 480 expected — two half hours.
    expect(d.workedMinutes).toBe(552);
    expect(d.overtimeMinutes).toBe(60);
  });
  test('late after the grace, early leave, no overtime under the threshold', () => {
    const d = day([['09:45', '17:00']]);
    expect(d.lateMinutes).toBe(35);
    expect(d.earlyMinutes).toBe(60);
    expect(d.overtimeMinutes).toBe(0);
    expect(day([['09:00', '18:25']]).overtimeMinutes).toBe(0); // 25 minutes past: under 30
    expect(day([['09:00', '18:00']]).workedMinutes).toBe(480); // the break is not work
  });
  test('within the grace is not late; two punches with a break add up', () => {
    const d = day([
      ['09:08', '13:00'],
      ['14:00', '18:00'],
    ]);
    expect(d.lateMinutes).toBe(0);
    expect(d.workedMinutes).toBe(472); // the hour away was the break
  });
  test('absent, on leave, a holiday; a missing check-out', () => {
    expect(day([]).status).toBe('absent');
    expect(day([], { leave: true }).status).toBe('leave');
    expect(day([], { holiday: true }).status).toBe('holiday');
    expect(day([], { weekend: true }).status).toBe('weekend');
    expect(day([], { shift: null }).status).toBe('off');
    expect(day([['09:00', null]]).status).toBe('incomplete');
  });
  test('every hour on a weekend is overtime', () => {
    const d = day([['10:00', '15:10']], { weekend: true }); // 310 minutes, the break off: 250
    expect(d).toMatchObject({ status: 'present', expectedMinutes: 0, lateMinutes: 0 });
    expect(d.overtimeMinutes).toBe(240);
  });
});

describe('a night shift', () => {
  test('22:00 to 06:00 the next day', () => {
    const night = { ...GENERAL, start: '22:00', end: '06:00', breakMinutes: 30 };
    const d = computeDay({
      date: '2026-10-20',
      tz: TZ,
      shift: night,
      weekend: false,
      holiday: false,
      leave: false,
      punches: [{ checkIn: at('2026-10-20', '21:58'), checkOut: at('2026-10-21', '06:30') }],
    });
    expect(d).toMatchObject({
      status: 'present',
      lateMinutes: 0,
      earlyMinutes: 0,
      expectedMinutes: 450,
    });
    // 512 minutes there, the half hour's break off: 32 past the 450 expected — one half hour.
    expect(d.overtimeMinutes).toBe(30);
  });
});

describe('device files and distances', () => {
  test('ZKTeco’s log and a CSV', () => {
    const zk = DEVICE_FORMATS.find((f) => f.key === 'zkteco');
    expect(
      zk?.parse(
        '   12\t2026-10-20 08:58:12\t1\t0\t1\t0\n   7\t2026-10-20 09:01:00\t1\t0\t1\t0\nnoise\n',
      ),
    ).toEqual([
      { user: '12', at: '2026-10-20 08:58:12' },
      { user: '7', at: '2026-10-20 09:01:00' },
    ]);
    const csv = DEVICE_FORMATS.find((f) => f.key === 'csv');
    expect(csv?.parse('Employee,Time\nB-1,2026-10-20 08:59\n,2026-10-20 09:00\n')).toEqual([
      { user: 'B-1', at: '2026-10-20 08:59' },
    ]);
  });
  test('a hundred-odd metres apart in Dhaka', () => {
    const d = distanceMetres({ lat: 23.7806, lon: 90.4078 }, { lat: 23.7816, lon: 90.4078 });
    expect(d).toBeGreaterThan(100);
    expect(d).toBeLessThan(120);
  });
});
