/**
 * The arithmetic of leave accruals (RFC 0034 §2.5), without a database: months, service, probation, the cap, the
 * year's carry-over and the expiry of what was carried.
 */
import { expect, test } from 'vitest';
import {
  type AccrualRules,
  expireLots,
  type MonthInput,
  monthEnd,
  monthsBetween,
  nextMonth,
  serviceMonthsAt,
  stepMonth,
  stepMonths,
} from '../src/accrual.js';

const OPEN: AccrualRules = {
  probationMonths: 0,
  cap: null,
  carryOver: null,
  carryExpiryMonth: null,
};
const month = (m: string, accrued: number, taken = 0, serviceMonths = 99): MonthInput => ({
  month: m,
  accrued,
  taken,
  serviceMonths,
});

test('months and service', () => {
  expect(monthEnd('2027-02')).toBe('2027-02-28');
  expect(monthEnd('2028-02')).toBe('2028-02-29');
  expect(monthEnd('2027-12')).toBe('2027-12-31');
  expect(() => monthEnd('2027-13')).toThrow(RangeError);
  expect(nextMonth('2027-12')).toBe('2028-01');
  expect(monthsBetween('2027-11', '2028-02')).toEqual(['2027-11', '2027-12', '2028-01', '2028-02']);
  expect(monthsBetween('2027-03', '2027-02')).toEqual([]);
  // Joined on the 1st: January is a full month at its end. Joined on the 15th: not yet.
  expect(serviceMonthsAt('2027-01-01', '2027-01')).toBe(1);
  expect(serviceMonthsAt('2027-01-15', '2027-01')).toBe(0);
  expect(serviceMonthsAt('2027-01-15', '2027-03')).toBe(2);
  expect(serviceMonthsAt('2026-07-01', '2027-06')).toBe(12);
  expect(serviceMonthsAt('2027-05-10', '2027-03')).toBe(0);
});

test('a month accrues at its end, after probation, and never above the cap', () => {
  const rules: AccrualRules = { ...OPEN, probationMonths: 3, cap: 300 };
  // In probation: nothing.
  expect(stepMonth({ balance: 0, carried: 0 }, rules, month('2027-02', 100, 0, 2))).toEqual({
    state: { balance: 0, carried: 0 },
    movements: [],
  });
  // After it: the month's days, dated its last day.
  const first = stepMonth({ balance: 0, carried: 0 }, rules, month('2027-03', 100, 0, 3));
  expect(first.state.balance).toBe(100);
  expect(first.movements).toEqual([
    { kind: 'accrual', date: '2027-03-31', days: 100, period: '2027-03', note: '' },
  ]);
  // At 250 of 300: only the 50 that fit, and it says so; at the cap, nothing.
  const capped = stepMonth({ balance: 250, carried: 0 }, rules, month('2027-04', 100));
  expect(capped.state.balance).toBe(300);
  expect(capped.movements[0]).toMatchObject({ days: 50, note: 'Up to the cap of 3.00 days.' });
  expect(stepMonth({ balance: 300, carried: 0 }, rules, month('2027-05', 100)).movements).toEqual(
    [],
  );
  // Leave taken in the month makes room again.
  expect(
    stepMonth({ balance: 300, carried: 0 }, rules, month('2027-06', 100, 200)).state.balance,
  ).toBe(200);
});

test('twelve months of 0.83 are 9.96 days: nothing drifts', () => {
  const months = monthsBetween('2027-01', '2027-12').map((m) => month(m, 83));
  const year = stepMonths({ balance: 0, carried: 0 }, OPEN, months);
  expect(year.state.balance).toBe(996);
  expect(year.movements).toHaveLength(12);
});

test('at the year’s start what is above the carry-over is lost', () => {
  const rules: AccrualRules = { ...OPEN, carryOver: 500 };
  const january = stepMonth({ balance: 1200, carried: 0 }, rules, month('2028-01', 100));
  expect(january.movements).toEqual([
    {
      kind: 'lapse',
      date: '2028-01-01',
      days: -700,
      period: '2028',
      note: 'Above the 5.00 days carried into 2028.',
    },
    { kind: 'accrual', date: '2028-01-31', days: 100, period: '2028-01', note: '' },
  ]);
  expect(january.state).toEqual({ balance: 600, carried: 500 });
  // Within the carry-over: nothing is lost. Nothing carried over at all: everything is.
  expect(stepMonth({ balance: 300, carried: 0 }, rules, month('2028-01', 0)).movements).toEqual([]);
  expect(
    stepMonth({ balance: 300, carried: 0 }, { ...OPEN, carryOver: 0 }, month('2028-01', 0)).state,
  ).toEqual({ balance: 0, carried: 0 });
  // A balance below zero (leave taken ahead) is not "carried": nothing to lose.
  expect(stepMonth({ balance: -200, carried: 0 }, rules, month('2028-01', 100)).state).toEqual({
    balance: -100,
    carried: 0,
  });
});

test('what was carried and not used by the expiry month is lost at its end; leave uses it first', () => {
  const rules: AccrualRules = { ...OPEN, carryOver: 500, carryExpiryMonth: 3 };
  const quarter = stepMonths({ balance: 800, carried: 0 }, rules, [
    month('2028-01', 100), // 300 lost at once; 500 carried; +1
    month('2028-02', 100, 200), // two days taken: from the carried ones
    month('2028-03', 100), // the 3 carried days left expire on 31 March
    month('2028-04', 100),
  ]);
  expect(quarter.movements.map((m) => [m.kind, m.date, m.days])).toEqual([
    ['lapse', '2028-01-01', -300],
    ['accrual', '2028-01-31', 100],
    ['accrual', '2028-02-29', 100],
    ['expiry', '2028-03-31', -300],
    ['accrual', '2028-03-31', 100],
    ['accrual', '2028-04-30', 100],
  ]);
  // 800 − 300 + 100 − 200 + 100 − 300 + 100 + 100.
  expect(quarter.state).toEqual({ balance: 400, carried: 0 });
  // Everything carried was used in time: nothing expires.
  const used = stepMonths({ balance: 500, carried: 0 }, rules, [
    month('2028-01', 0, 300),
    month('2028-02', 0, 200),
    month('2028-03', 0),
  ]);
  expect(used.movements).toEqual([]);
  expect(used.state).toEqual({ balance: 0, carried: 0 });
});

test('a formula that gives less than nothing accrues nothing', () => {
  expect(stepMonth({ balance: 100, carried: 0 }, OPEN, month('2027-05', -50)).state.balance).toBe(
    100,
  );
});

test('compensatory days: the oldest credit is used first; what is left after its last day is lost the day after', () => {
  const lots = [
    { key: 1, date: '2027-10-01', days: 100 },
    { key: 2, date: '2027-10-08', days: 100 },
  ];
  // Nothing used: each is lost the day after its thirtieth day, once that day has come.
  expect(expireLots(lots, [], 30, '2027-10-31')).toEqual([]);
  expect(expireLots(lots, [], 30, '2027-11-01')).toEqual([{ key: 1, on: '2027-11-01', days: 100 }]);
  expect(expireLots(lots, [], 30, '2027-12-01')).toEqual([
    { key: 1, on: '2027-11-01', days: 100 },
    { key: 2, on: '2027-11-08', days: 100 },
  ]);
  // A day and a half taken on the 12th: the first credit whole, half the second.
  expect(expireLots(lots, [{ date: '2027-10-12', days: 150 }], 30, '2027-12-01')).toEqual([
    { key: 2, on: '2027-11-08', days: 50 },
  ]);
  // Leave after a credit's last day cannot use it; nor leave before it was earned.
  expect(expireLots(lots, [{ date: '2027-11-03', days: 100 }], 30, '2027-12-01')).toEqual([
    { key: 1, on: '2027-11-01', days: 100 },
  ]);
  expect(expireLots(lots, [{ date: '2027-10-05', days: 200 }], 30, '2027-12-01')).toEqual([
    { key: 2, on: '2027-11-08', days: 100 },
  ]);
});
