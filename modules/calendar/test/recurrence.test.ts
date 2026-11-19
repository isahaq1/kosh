/**
 * Repeating events (RFC 0034 §2.4), without a database: the dates each kind of rule gives, the end by a number of
 * times or a date, months that are shorter, the first and last working day, days off kept, skipped or moved, and
 * the rule said in words.
 */
import { expect, test } from 'vitest';
import { describeRule, MAX_OCCURRENCES, occurrences, type Rule } from '../src/recurrence.js';

// Sunday to Thursday, with Victory Day (16 December 2026) and New Year's Eve off.
const OFF = new Set(['2026-12-16', '2026-12-31']);
const working = (date: string): boolean => {
  const wd = new Date(`${date}T00:00:00Z`).getUTCDay();
  return wd !== 5 && wd !== 6 && !OFF.has(date);
};
const rule = (r: Partial<Rule> & Pick<Rule, 'freq'>): Rule => ({ interval: 1, ...r });

test('every day, every third day; ended by a number of times or by a date', () => {
  expect(occurrences(rule({ freq: 'daily', count: 3 }), '2026-12-30')).toEqual([
    '2026-12-30',
    '2026-12-31',
    '2027-01-01',
  ]);
  expect(
    occurrences(rule({ freq: 'daily', interval: 3, until: '2026-12-10' }), '2026-12-01'),
  ).toEqual(['2026-12-01', '2026-12-04', '2026-12-07', '2026-12-10']);
  // Both: whichever comes first.
  expect(
    occurrences(rule({ freq: 'daily', count: 10, until: '2026-12-02' }), '2026-12-01'),
  ).toHaveLength(2);
});

test('weekly: its weekday, several weekdays, every second week', () => {
  // Tuesday 1 December 2026.
  expect(occurrences(rule({ freq: 'weekly', count: 3 }), '2026-12-01')).toEqual([
    '2026-12-01',
    '2026-12-08',
    '2026-12-15',
  ]);
  // Tuesdays and Thursdays, every second week: the first week counts from the first date.
  expect(
    occurrences(rule({ freq: 'weekly', interval: 2, weekdays: [4, 2], count: 5 }), '2026-12-01'),
  ).toEqual(['2026-12-01', '2026-12-03', '2026-12-15', '2026-12-17', '2026-12-29']);
  // Started on a Thursday with Tuesday and Thursday: that week's Tuesday is before the start, and is not taken.
  expect(occurrences(rule({ freq: 'weekly', weekdays: [2, 4], count: 3 }), '2026-12-03')).toEqual([
    '2026-12-03',
    '2026-12-08',
    '2026-12-10',
  ]);
  // A Sunday belongs to the week that started the Monday before it.
  expect(
    occurrences(rule({ freq: 'weekly', interval: 2, weekdays: [0, 1], count: 4 }), '2026-12-06'),
  ).toEqual(['2026-12-06', '2026-12-14', '2026-12-20', '2026-12-28']);
});

test('monthly: the same day (the last when the month is shorter), the second Tuesday, the last Friday', () => {
  expect(occurrences(rule({ freq: 'monthly', count: 4 }), '2027-01-31')).toEqual([
    '2027-01-31',
    '2027-02-28',
    '2027-03-31',
    '2027-04-30',
  ]);
  // 8 December 2026 is the second Tuesday.
  expect(
    occurrences(rule({ freq: 'monthly', monthlyOn: 'weekday', count: 3 }), '2026-12-08'),
  ).toEqual(['2026-12-08', '2027-01-12', '2027-02-09']);
  // A fifth Thursday (31 December 2026): the last Thursday in months that have four.
  expect(
    occurrences(rule({ freq: 'monthly', monthlyOn: 'weekday', count: 3 }), '2026-12-31'),
  ).toEqual(['2026-12-31', '2027-01-28', '2027-02-25']);
  expect(
    occurrences(
      rule({ freq: 'monthly', monthlyOn: 'last_weekday', interval: 2, count: 3 }),
      '2026-12-25',
    ),
  ).toEqual(['2026-12-25', '2027-02-26', '2027-04-30']);
});

test('the first and the last working day of the month, through the working calendar', () => {
  // December 2026 ends on Thursday the 31st, which is off: the last working day is Wednesday the 30th.
  expect(
    occurrences(
      rule({ freq: 'monthly', monthlyOn: 'last_working', count: 3 }),
      '2026-12-01',
      working,
    ),
  ).toEqual(['2026-12-30', '2027-01-31', '2027-02-28']);
  // January 2027 starts on a Friday: its first working day is Sunday the 3rd.
  expect(
    occurrences(
      rule({ freq: 'monthly', monthlyOn: 'first_working', count: 3 }),
      '2026-12-01',
      working,
    ),
  ).toEqual(['2026-12-01', '2027-01-03', '2027-02-01']);
});

test('a date on a day off: kept, skipped, or moved to the working day before or after', () => {
  // Every Wednesday from 9 December 2026: the 16th is Victory Day.
  const weekly = (onDayOff: NonNullable<Rule['onDayOff']>) =>
    occurrences(rule({ freq: 'weekly', count: 3, onDayOff }), '2026-12-09', working);
  expect(weekly('keep')).toEqual(['2026-12-09', '2026-12-16', '2026-12-23']);
  expect(weekly('skip')).toEqual(['2026-12-09', '2026-12-23', '2026-12-30']); // three all the same
  expect(weekly('before')).toEqual(['2026-12-09', '2026-12-15', '2026-12-23']);
  expect(weekly('after')).toEqual(['2026-12-09', '2026-12-17', '2026-12-23']);
  // The 25th of each month, moved after: Friday 25 December → Sunday the 27th.
  expect(
    occurrences(rule({ freq: 'monthly', count: 2, onDayOff: 'after' }), '2026-12-25', working),
  ).toEqual(['2026-12-27', '2027-01-25']);
  // Two dates moved onto the same day are one occurrence.
  expect(
    occurrences(rule({ freq: 'daily', count: 3, onDayOff: 'after' }), '2026-12-17', working),
  ).toEqual(['2026-12-17', '2026-12-20', '2026-12-21']); // Fri and Sat both move to Sunday the 20th
});

test('yearly: the same date, 29 February in other years; the second Tuesday of a month', () => {
  expect(occurrences(rule({ freq: 'yearly', count: 3 }), '2028-02-29')).toEqual([
    '2028-02-29',
    '2029-02-28',
    '2030-02-28',
  ]);
  expect(
    occurrences(rule({ freq: 'yearly', monthlyOn: 'weekday', count: 2 }), '2026-12-08'),
  ).toEqual(['2026-12-08', '2027-12-14']);
});

test('a series has an end and a limit', () => {
  expect(() => occurrences(rule({ freq: 'daily' }), '2026-12-01')).toThrow('A series ends');
  expect(() => occurrences(rule({ freq: 'daily', interval: 0, count: 2 }), '2026-12-01')).toThrow(
    'every 1 or more',
  );
  expect(() => occurrences(rule({ freq: 'daily', count: 0 }), '2026-12-01')).toThrow(
    'at least once',
  );
  expect(() => occurrences(rule({ freq: 'daily', count: 2 }), 'tomorrow')).toThrow('not a date');
  expect(occurrences(rule({ freq: 'daily', count: 5000 }), '2026-12-01')).toHaveLength(
    MAX_OCCURRENCES,
  );
  expect(occurrences(rule({ freq: 'daily', until: '2099-01-01' }), '2026-12-01')).toHaveLength(
    MAX_OCCURRENCES,
  );
  // A calendar that never works gives nothing rather than looping.
  expect(
    occurrences(
      rule({ freq: 'monthly', monthlyOn: 'last_working', count: 3 }),
      '2026-12-01',
      () => false,
    ),
  ).toEqual([]);
});

test('the rule in words', () => {
  expect(
    describeRule(rule({ freq: 'weekly', interval: 2, weekdays: [4, 2], count: 10 }), '2026-12-01'),
  ).toBe('Every 2 weeks on Tuesday and Thursday, 10 times');
  expect(describeRule(rule({ freq: 'daily', until: '2026-12-31' }), '2026-12-01')).toBe(
    'Every day, until 2026-12-31',
  );
  expect(
    describeRule(rule({ freq: 'monthly', monthlyOn: 'weekday', count: 1 }), '2026-12-08'),
  ).toBe('Every month on the second Tuesday, 1 time');
  expect(
    describeRule(
      rule({ freq: 'monthly', monthlyOn: 'last_working', onDayOff: 'keep', count: 12 }),
      '2026-12-01',
    ),
  ).toBe('Every month on the last working day, 12 times');
  expect(describeRule(rule({ freq: 'monthly', count: 3, onDayOff: 'after' }), '2026-12-22')).toBe(
    'Every month on the 22nd, moved after a day off, 3 times',
  );
  expect(describeRule(rule({ freq: 'monthly', count: 3 }), '2026-12-11')).toBe(
    'Every month on the 11th, 3 times',
  );
  expect(describeRule(rule({ freq: 'yearly', count: 5 }), '2026-03-26')).toBe(
    'Every year on the 26th of March, 5 times',
  );
});
