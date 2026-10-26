/** Quiet hours (RFC 0006 §8.2): local hours across midnight, days off, time zones, when the period ends. */
import { expect, test } from 'vitest';
import { isQuiet, localTime, minutesOf, quietUntil, zoneOf } from '../src/quiet.js';

const DHAKA = 'Asia/Dhaka'; // UTC+6, no daylight saving
const night = { quietFrom: '22:00', quietTo: '07:00' };

test('times and zones', () => {
  expect(minutesOf('07:30')).toBe(450);
  expect(minutesOf('24:00')).toBeNull();
  expect(minutesOf(null)).toBeNull();
  expect(zoneOf('Mars/Olympus')).toBe('UTC');
  // 2026-10-27 is a Tuesday; 18:30 UTC is 00:30 on Wednesday in Dhaka.
  expect(localTime(new Date('2026-10-27T18:30:00Z'), DHAKA)).toEqual({ day: 3, minutes: 30 });
});

test('quiet hours across midnight, in the user’s time zone', () => {
  // 23:00 in Dhaka (17:00 UTC): quiet until 07:00 Dhaka = 01:00 UTC.
  expect(isQuiet(new Date('2026-10-27T17:00:00Z'), night, DHAKA)).toBe(true);
  expect(quietUntil(new Date('2026-10-27T17:00:00Z'), night, DHAKA)?.toISOString()).toBe(
    '2026-10-28T01:00:00.000Z',
  );
  // 06:59:30 Dhaka: still quiet, ends at 07:00.
  expect(quietUntil(new Date('2026-10-28T00:59:30Z'), night, DHAKA)?.toISOString()).toBe(
    '2026-10-28T01:00:00.000Z',
  );
  // 12:00 Dhaka: not quiet.
  expect(quietUntil(new Date('2026-10-28T06:00:00Z'), night, DHAKA)).toBeNull();
  // The same instant in UTC is 17:00: not quiet there.
  expect(isQuiet(new Date('2026-10-27T17:00:00Z'), night, 'UTC')).toBe(false);
  // Hours within a day; empty or equal bounds mean no quiet hours.
  expect(
    isQuiet(new Date('2026-10-27T13:30:00Z'), { quietFrom: '13:00', quietTo: '14:00' }, 'UTC'),
  ).toBe(true);
  expect(
    isQuiet(new Date('2026-10-27T13:30:00Z'), { quietFrom: '13:00', quietTo: '13:00' }, 'UTC'),
  ).toBe(false);
  expect(isQuiet(new Date('2026-10-27T13:30:00Z'), {}, 'UTC')).toBe(false);
});

test('days off, chained with the quiet morning that follows', () => {
  const weekend = { ...night, quietDays: ['fri', 'sat'] };
  // Friday 2026-10-30, 12:00 Dhaka (06:00 UTC): quiet through Friday and Saturday, then until 07:00 on Sunday.
  expect(quietUntil(new Date('2026-10-30T06:00:00Z'), weekend, DHAKA)?.toISOString()).toBe(
    '2026-11-01T01:00:00.000Z',
  );
  // Without night hours: until Sunday midnight Dhaka.
  expect(
    quietUntil(
      new Date('2026-10-30T06:00:00Z'),
      { quietDays: ['fri', 'sat'] },
      DHAKA,
    )?.toISOString(),
  ).toBe('2026-10-31T18:00:00.000Z');
  // Every day off: never ends, so nothing is held for ever (the caller sends now).
  expect(
    quietUntil(
      new Date('2026-10-30T06:00:00Z'),
      { quietDays: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] },
      DHAKA,
    ),
  ).toBeNull();
});
