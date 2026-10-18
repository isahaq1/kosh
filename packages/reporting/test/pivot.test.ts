import { describe, expect, test } from 'vitest';
import { nextBucket, runReport, zonedStart } from '../src/index.js';
import { addDecimal } from '../src/pivot.js';

describe('runReport', () => {
  test('one aggregate call with every row level × column level as grouping sets', async () => {
    const calls: unknown[] = [];
    const env = {
      tz: 'UTC',
      model: () => ({
        aggregate: async (q: unknown) => {
          calls.push(q);
          return [{ $groups: [], n: 3 }];
        },
      }),
    };
    const result = await runReport(
      env as never,
      'sale.order',
      { rows: ['partner', 'state'], cols: ['dateOrder:month'], measures: { n: 'count' } },
      new Map(),
      async () => new Map(),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      groupBy: ['partner', 'state', 'dateOrder:month'],
      groupingSets: [
        ['partner', 'state', 'dateOrder:month'],
        ['partner', 'state'],
        ['partner', 'dateOrder:month'],
        ['partner'],
        ['dateOrder:month'],
        [],
      ],
    });
    expect(result.cells['[]']?.['[]']).toEqual({ n: 3 });
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
