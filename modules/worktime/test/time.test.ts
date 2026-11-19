/**
 * The working-time engine (RFC 0034 §2.4), without a database: days and minutes counted over a week of hours with a
 * lunch break, public holidays, a working Saturday and a half day; dates moved by working days in both directions;
 * moments in a time zone, across a weekend, a holiday and a daylight-saving change.
 */
import { expect, test } from 'vitest';
import {
  addDays,
  addWorkingDays,
  addWorkingMinutes,
  dateIn,
  hoursOn,
  instantOf,
  isWorkingDay,
  minutesOf,
  minutesOn,
  nextWorkingMoment,
  type Schedule,
  scheduleOfWeek,
  timeOf,
  weekdayOf,
  weekOf,
  workingDates,
  workingDays,
  workingDaysOfMonth,
  workingMinutesBetween,
} from '../src/time.js';

// Dhaka: Sunday to Thursday, 09:00–13:00 and 14:00–18:00 (8 hours with a lunch break).
const HOURS = [
  [540, 780],
  [840, 1080],
] as const;
const dhaka: Schedule = {
  tz: 'Asia/Dhaka',
  week: weekOf([5, 6], HOURS),
  // Victory Day (a Wednesday in 2026) and a company day off.
  off: new Set(['2026-12-16', '2026-12-24']),
  // A working Saturday, and a half day before the year ends.
  extra: new Map([
    ['2026-12-19', [[540, 780]]],
    ['2026-12-31', [[540, 780]]],
  ]),
};
const at = (date: string, time: string) => new Date(instantOf(date, minutesOf(time), 'Asia/Dhaka'));

test('times of day, dates and weekdays', () => {
  expect(minutesOf('09:30')).toBe(570);
  expect(minutesOf('24:00')).toBe(1440);
  expect(timeOf(570)).toBe('09:30');
  expect(() => minutesOf('9:30')).toThrow(RangeError);
  expect(() => minutesOf('25:00')).toThrow(RangeError);
  expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
  expect(weekdayOf('2026-12-18')).toBe(5); // a Friday
  expect(() => addDays('not a date', 1)).toThrow(RangeError);
});

test('a day’s hours: the week, a holiday, a day with hours of its own', () => {
  expect(minutesOn(dhaka, '2026-12-13')).toBe(480); // Sunday
  expect(isWorkingDay(dhaka, '2026-12-18')).toBe(false); // Friday
  expect(isWorkingDay(dhaka, '2026-12-16')).toBe(false); // Victory Day
  expect(hoursOn(dhaka, '2026-12-19')).toEqual([[540, 780]]); // the working Saturday
  expect(minutesOn(dhaka, '2026-12-31')).toBe(240); // the half day
  // A day with hours of its own wins over a holiday on the same date.
  const both: Schedule = { ...dhaka, off: new Set(['2026-12-19']) };
  expect(isWorkingDay(both, '2026-12-19')).toBe(true);
});

test('working days between two dates, holidays not counted', () => {
  // 13 (Sun) to 24 (Thu): Sun–Thu twice is 10, less Victory Day and the day off, plus the working Saturday.
  expect(workingDays(dhaka, '2026-12-13', '2026-12-24')).toBe(9);
  expect(workingDates(dhaka, '2026-12-15', '2026-12-20')).toEqual([
    '2026-12-15',
    '2026-12-17',
    '2026-12-19',
    '2026-12-20',
  ]);
  expect(workingDays(dhaka, '2026-12-18', '2026-12-18')).toBe(0);
  expect(workingDays(dhaka, '2026-12-20', '2026-12-13')).toBe(0);
});

test('a date moved by working days, forward and back', () => {
  // From Tuesday the 15th: Thu 17, Sat 19 (worked), Sun 20.
  expect(addWorkingDays(dhaka, '2026-12-15', 3)).toBe('2026-12-20');
  expect(addWorkingDays(dhaka, '2026-12-20', -3)).toBe('2026-12-15');
  // Zero: the day itself when worked, the next working day otherwise.
  expect(addWorkingDays(dhaka, '2026-12-15', 0)).toBe('2026-12-15');
  expect(addWorkingDays(dhaka, '2026-12-16', 0)).toBe('2026-12-17');
  expect(addWorkingDays(dhaka, '2026-12-25', 0)).toBe('2026-12-27'); // Friday → Sunday
  // A calendar that never works is said, not looped on.
  expect(() =>
    addWorkingDays(scheduleOfWeek(weekOf([0, 1, 2, 3, 4, 5, 6])), '2026-01-01', 1),
  ).toThrow('no working day');
});

test('the first and last working day of a month', () => {
  // December 2026: the 1st is a Tuesday; the 31st is the half day.
  expect(workingDaysOfMonth(dhaka, 2026, 12)).toMatchObject({
    first: '2026-12-01',
    last: '2026-12-31',
  });
  // January 2027 starts on a Friday: the first working day is Sunday the 3rd; the 31st is a Sunday.
  expect(workingDaysOfMonth(dhaka, 2027, 1)).toEqual({
    first: '2027-01-03',
    last: '2027-01-31',
    count: 21,
  });
  expect(workingDaysOfMonth(scheduleOfWeek(weekOf([0, 1, 2, 3, 4, 5, 6])), 2027, 1)).toBeNull();
});

test('working minutes between two moments: breaks, nights, weekends and holidays are not counted', () => {
  // The same morning.
  expect(workingMinutesBetween(dhaka, at('2026-12-13', '09:30'), at('2026-12-13', '11:00'))).toBe(
    90,
  );
  // Across lunch: 12:30–13:00 and 14:00–14:30.
  expect(workingMinutesBetween(dhaka, at('2026-12-13', '12:30'), at('2026-12-13', '14:30'))).toBe(
    60,
  );
  // Thursday 17:00 to Sunday 10:00, over the working Saturday morning: 60 + 240 + 60.
  expect(workingMinutesBetween(dhaka, at('2026-12-17', '17:00'), at('2026-12-20', '10:00'))).toBe(
    360,
  );
  // Over Victory Day: Tuesday 17:00 to Thursday 10:00 is two hours.
  expect(workingMinutesBetween(dhaka, at('2026-12-15', '17:00'), at('2026-12-17', '10:00'))).toBe(
    120,
  );
  // Starting in the night counts from the morning.
  expect(workingMinutesBetween(dhaka, at('2026-12-13', '03:00'), at('2026-12-13', '10:00'))).toBe(
    60,
  );
  expect(workingMinutesBetween(dhaka, at('2026-12-13', '11:00'), at('2026-12-13', '10:00'))).toBe(
    0,
  );
});

test('a moment so many working minutes later: the clock waits outside working hours', () => {
  // 90 minutes from 12:00: an hour before lunch, half an hour after.
  expect(addWorkingMinutes(dhaka, at('2026-12-13', '12:00'), 90)).toEqual(
    at('2026-12-13', '14:30'),
  );
  // Four hours from Thursday 17:00: one that day, three on the working Saturday.
  expect(addWorkingMinutes(dhaka, at('2026-12-17', '17:00'), 240)).toEqual(
    at('2026-12-19', '12:00'),
  );
  // Asked on a Friday night, an hour of work ends on Saturday at 10:00.
  expect(addWorkingMinutes(dhaka, at('2026-12-18', '22:00'), 60)).toEqual(
    at('2026-12-19', '10:00'),
  );
  // What it adds is what the count between the two gives back.
  const from = at('2026-12-10', '16:20');
  const later = addWorkingMinutes(dhaka, from, 1000);
  expect(workingMinutesBetween(dhaka, from, later)).toBe(1000);
  expect(addWorkingMinutes(dhaka, from, 0)).toEqual(from);
  expect(() => addWorkingMinutes(scheduleOfWeek(weekOf([0, 1, 2, 3, 4, 5, 6])), from, 1)).toThrow(
    'too little working time',
  );
});

test('the next moment inside working hours', () => {
  expect(nextWorkingMoment(dhaka, at('2026-12-13', '10:00'))).toEqual(at('2026-12-13', '10:00'));
  expect(nextWorkingMoment(dhaka, at('2026-12-13', '13:20'))).toEqual(at('2026-12-13', '14:00'));
  expect(nextWorkingMoment(dhaka, at('2026-12-15', '19:00'))).toEqual(at('2026-12-17', '09:00'));
});

test('hours follow the time zone, daylight saving included', () => {
  // Dhaka is UTC+6 all year: 09:00 there is 03:00 UTC.
  expect(new Date(instantOf('2026-12-13', 540, 'Asia/Dhaka')).toISOString()).toBe(
    '2026-12-13T03:00:00.000Z',
  );
  expect(dateIn(new Date('2026-12-13T19:30:00Z'), 'Asia/Dhaka')).toBe('2026-12-14');
  // London, Monday to Friday 09:00–17:00: the clocks go forward on Sunday 29 March 2026.
  const london: Schedule = scheduleOfWeek(weekOf([6, 0], [[540, 1020]]), 'Europe/London');
  expect(new Date(instantOf('2026-03-27', 540, 'Europe/London')).toISOString()).toBe(
    '2026-03-27T09:00:00.000Z',
  );
  expect(new Date(instantOf('2026-03-30', 540, 'Europe/London')).toISOString()).toBe(
    '2026-03-30T08:00:00.000Z',
  );
  // Friday 16:00 to Monday 10:00 is two working hours, whatever the clocks did in between.
  expect(
    workingMinutesBetween(
      london,
      new Date('2026-03-27T16:00:00Z'),
      new Date('2026-03-30T09:00:00Z'),
    ),
  ).toBe(120);
});
