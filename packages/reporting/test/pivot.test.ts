import { describe, expect, test } from 'vitest';
import { nextBucket, runReport, zonedStart } from '../src/index.js';
import { addDecimal } from '../src/pivot.js';

describe('runReport', () => {
  test('one aggregate over the leaf grouping; levels and totals rolled up exactly', async () => {
    const calls: unknown[] = [];
    const env = {
      tz: 'UTC',
      model: () => ({
        aggregate: async (q: unknown) => {
          calls.push(q);
          return [
            {
              partner: 1,
              state: 'sale',
              'dateOrder:month': '2026-09-01',
              n: 2,
              total: '0.1',
              avg: '10.00',
              $n: 2,
            },
            {
              partner: 1,
              state: 'draft',
              'dateOrder:month': '2026-09-01',
              n: 1,
              total: '0.2',
              avg: '40.00',
              $n: 1,
            },
            {
              partner: 2,
              state: 'sale',
              'dateOrder:month': '2026-10-01',
              n: 3,
              total: '5',
              avg: '1.00',
              $n: 3,
            },
          ];
        },
      }),
    };
    const result = await runReport(
      env as never,
      'sale.order',
      {
        rows: ['partner', 'state'],
        cols: ['dateOrder:month'],
        measures: { n: 'count', total: { sum: 'amount' }, avg: { avg: 'amount' } },
      },
      new Map(),
      async () => new Map(),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ groupBy: ['partner', 'state', 'dateOrder:month'] });
    expect(calls[0]).not.toHaveProperty('groupingSets');
    // Partner 1 across states and months: 3 rows, 0.1 + 0.2 exactly, weighted average (2×10 + 1×40) / 3.
    expect(result.cells['[1]']?.['[]']).toEqual({ n: 3, total: '0.3', avg: '20.0000' });
    expect(result.cells['[]']?.['[]']).toEqual({ n: 6, total: '5.3', avg: '10.5000' });
    expect(result.cells['[]']?.['["2026-09-01"]']?.['n']).toBe(3);
    expect(result.rows.children.map((h) => h.value)).toEqual([1, 2]);
    expect(result.rows.children[0]?.children.map((h) => h.value)).toEqual(['draft', 'sale']);
  });
});

describe('date buckets', () => {
  test('next bucket and zoned starts', () => {
    expect(nextBucket('2026-12-01', 'month')).toBe('2027-01-01');
    expect(nextBucket('2026-10-01', 'quarter')).toBe('2027-01-01');
    expect(nextBucket('2026-10-19', 'week')).toBe('2026-10-26');
    expect(zonedStart('2026-10-01', 'Asia/Dhaka').toISOString()).toBe('2026-09-30T18:00:00.000Z');
  });
});

test('exact decimal sums', () => {
  expect(addDecimal('0.1', '0.2')).toBe('0.3');
  expect(addDecimal('1350.00', '-1350.005')).toBe('-0.005');
  expect(addDecimal('99999999999999999999.99', '0.01')).toBe('100000000000000000000.00');
});
