/**
 * The arithmetic of subscriptions (RFC 0034 §2.5), without a database: billing periods by day, week, month and
 * year — month ends included —, monthly recurring revenue, and the share of an amount for the days left in a period.
 */
import { expect, test } from 'vitest';
import { daysBetween, mrrOf, periodOf, periodStart, prorate } from '../src/billing.js';

test('periods by month keep the anchor’s day, the month’s last day when it is shorter', () => {
  const monthly = { unit: 'month', interval: 1 } as const;
  expect([0, 1, 2, 3, 12].map((i) => periodStart('2026-12-15', monthly, i))).toEqual([
    '2026-12-15',
    '2027-01-15',
    '2027-02-15',
    '2027-03-15',
    '2027-12-15',
  ]);
  // Anchored on the 31st: 28 February, then the 31st again — not drifting to the 28th.
  expect([0, 1, 2, 3, 4].map((i) => periodStart('2027-01-31', monthly, i))).toEqual([
    '2027-01-31',
    '2027-02-28',
    '2027-03-31',
    '2027-04-30',
    '2027-05-31',
  ]);
  expect(periodOf('2027-01-31', monthly, 1)).toEqual({
    start: '2027-02-28',
    end: '2027-03-30',
    next: '2027-03-31',
    days: 31,
  });
  // Every quarter.
  expect(periodOf('2026-11-01', { unit: 'month', interval: 3 }, 1)).toEqual({
    start: '2027-02-01',
    end: '2027-04-30',
    next: '2027-05-01',
    days: 89,
  });
});

test('periods by year, week and day', () => {
  expect(periodOf('2028-02-29', { unit: 'year', interval: 1 }, 1)).toEqual({
    start: '2029-02-28',
    end: '2030-02-27',
    next: '2030-02-28',
    days: 365,
  });
  expect(periodStart('2028-02-29', { unit: 'year', interval: 1 }, 4)).toBe('2032-02-29');
  expect(periodOf('2026-12-28', { unit: 'week', interval: 2 }, 1)).toEqual({
    start: '2027-01-11',
    end: '2027-01-24',
    next: '2027-01-25',
    days: 14,
  });
  expect(periodOf('2026-12-31', { unit: 'day', interval: 10 }, 0)).toMatchObject({
    start: '2026-12-31',
    end: '2027-01-09',
    days: 10,
  });
  expect(() => periodStart('soon', { unit: 'month', interval: 1 }, 0)).toThrow(RangeError);
  expect(daysBetween('2026-12-01', '2027-01-01')).toBe(31);
  expect(daysBetween('2027-01-01', '2026-12-01')).toBe(0);
});

test('monthly recurring revenue: what an amount per period is worth a month', () => {
  expect(mrrOf('1500.00', { unit: 'month', interval: 1 })).toBe('1500.00');
  expect(mrrOf('1500.00', { unit: 'month', interval: 3 })).toBe('500.00');
  expect(mrrOf('12000', { unit: 'year', interval: 1 })).toBe('1000.00');
  expect(mrrOf('1000.00', { unit: 'year', interval: 1 })).toBe('83.33');
  expect(mrrOf('300.00', { unit: 'week', interval: 1 })).toBe('1300.00'); // 52 weeks over 12 months
  expect(mrrOf('10.00', { unit: 'day', interval: 1 })).toBe('304.17'); // 365 days over 12 months
  expect(mrrOf('0', { unit: 'month', interval: 1 })).toBe('0.00');
  expect(mrrOf('-120.00', { unit: 'year', interval: 1 })).toBe('-10.00');
  expect(() => mrrOf('a lot', { unit: 'month', interval: 1 })).toThrow(RangeError);
});

test('the share of an amount for the days left in a period', () => {
  const december = { start: '2026-12-01', end: '2026-12-31' };
  // From the 16th: 16 days of 31.
  expect(prorate('3100.00', '2026-12-16', december)).toEqual({
    amount: '1600.00',
    days: 16,
    of: 31,
  });
  // The whole period at its first day (and before it); its last day is one day; nothing after.
  expect(prorate('3100.00', '2026-12-01', december)).toEqual({
    amount: '3100.00',
    days: 31,
    of: 31,
  });
  expect(prorate('3100.00', '2026-11-20', december).amount).toBe('3100.00');
  expect(prorate('3100.00', '2026-12-31', december)).toEqual({ amount: '100.00', days: 1, of: 31 });
  expect(prorate('3100.00', '2027-01-01', december)).toEqual({ amount: '0.00', days: 0, of: 31 });
  // Rounded to the paisa, half away from zero, both ways; a credit is the same share, negative.
  expect(prorate('1000.00', '2026-12-11', december).amount).toBe('677.42'); // 21 / 31
  expect(prorate('-1000.00', '2026-12-11', december).amount).toBe('-677.42');
  expect(prorate('0.01', '2026-12-17', december).amount).toBe('0.00'); // 15 / 31 of a paisa
  expect(prorate('0.01', '2026-12-16', december).amount).toBe('0.01'); // 16 / 31: more than half
  // Exact on large amounts: no floating point.
  expect(prorate('999999999999.99', '2026-12-02', december).amount).toBe('967741935483.86');
});
