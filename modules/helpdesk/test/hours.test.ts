/**
 * Business hours (RFC 0024 §2.4), without a database: working minutes added across a Friday–Saturday weekend, from
 * before the opening, every day of the week; and the working minutes between two moments.
 */
import { describe, expect, test } from 'vitest';
import { addBusinessMinutes, businessMinutesBetween, type Hours, WEEKENDS } from '../src/hours.js';

const DHAKA: Hours = {
  open: '09:00',
  close: '18:00',
  weekend: WEEKENDS['fri_sat'] ?? [],
  tz: 'Asia/Dhaka',
};
/** A Dhaka wall-clock time as an instant (UTC+6, no daylight saving). */
const dhaka = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+06:00`);

describe('adding working minutes', () => {
  test('Thursday 16:00 plus four hours: two on Thursday, the weekend skipped, two on Sunday', () => {
    expect(addBusinessMinutes(dhaka('2026-10-22', '16:00'), 240, DHAKA)).toEqual(
      dhaka('2026-10-25', '11:00'),
    );
  });
  test('before the opening, the clock starts at 09:00', () => {
    expect(addBusinessMinutes(dhaka('2026-10-20', '07:00'), 60, DHAKA)).toEqual(
      dhaka('2026-10-20', '10:00'),
    );
  });
  test('after the closing, it starts the next working day', () => {
    expect(addBusinessMinutes(dhaka('2026-10-20', '20:00'), 30, DHAKA)).toEqual(
      dhaka('2026-10-21', '09:30'),
    );
  });
  test('a team without a weekend counts every day', () => {
    const everyDay = { ...DHAKA, weekend: WEEKENDS['none'] ?? [] };
    expect(addBusinessMinutes(dhaka('2026-10-22', '17:00'), 120, everyDay)).toEqual(
      dhaka('2026-10-23', '10:00'),
    );
  });
});

describe('working minutes between', () => {
  test('Thursday 17:00 to Sunday 10:00 is two working hours', () => {
    expect(
      businessMinutesBetween(dhaka('2026-10-22', '17:00'), dhaka('2026-10-25', '10:00'), DHAKA),
    ).toBe(120);
  });
  test('nothing at night, nothing backwards', () => {
    expect(
      businessMinutesBetween(dhaka('2026-10-20', '19:00'), dhaka('2026-10-20', '23:00'), DHAKA),
    ).toBe(0);
    expect(
      businessMinutesBetween(dhaka('2026-10-21', '10:00'), dhaka('2026-10-20', '10:00'), DHAKA),
    ).toBe(0);
  });
});

describe('a working calendar instead of a team’s own hours', () => {
  // 09:00–13:00 and 14:00–18:00, Friday and Saturday off, Wednesday 21 October a holiday.
  const calendar = {
    tz: 'Asia/Dhaka',
    week: Object.fromEntries(
      [0, 1, 2, 3, 4, 5, 6].map((d) => [
        d,
        d === 5 || d === 6
          ? []
          : ([
              [540, 780],
              [840, 1080],
            ] as [number, number][]),
      ]),
    ),
    off: new Set(['2026-10-21']),
    extra: new Map<string, [number, number][]>(),
  };
  test('the lunch break and a holiday are not counted', () => {
    // Tuesday 12:00 plus two hours: one before lunch, one after.
    expect(addBusinessMinutes(dhaka('2026-10-20', '12:00'), 120, calendar)).toEqual(
      dhaka('2026-10-20', '15:00'),
    );
    // Tuesday 17:00 plus two hours: one on Tuesday, the holiday skipped, one on Thursday.
    expect(addBusinessMinutes(dhaka('2026-10-20', '17:00'), 120, calendar)).toEqual(
      dhaka('2026-10-22', '10:00'),
    );
    expect(
      businessMinutesBetween(dhaka('2026-10-20', '17:00'), dhaka('2026-10-22', '10:00'), calendar),
    ).toBe(120);
  });
});
