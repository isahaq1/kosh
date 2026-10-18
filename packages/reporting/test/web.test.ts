import { describe, expect, test } from 'vitest';
import type { Header, ReportResult } from '../src/index.js';
import { cohortTable, gridDays, periodsBetween, windowOf } from '../src/web/index.js';

const h = (key: string, value: unknown, children: Header[] = []): Header => ({
  key,
  group: value === undefined ? null : 'g',
  value: value ?? null,
  label: String(value),
  depth: 1,
  domain: {},
  children,
});

describe('cohorts', () => {
  test('shares open / closed per period; records without a start are no cohort', () => {
    const report: ReportResult = {
      rows: h('[]', undefined, [h('["2026-09-01"]', '2026-09-01'), h('[null]', null)]),
      cols: h('[]', undefined, [
        h('["2026-09-01"]', '2026-09-01'),
        h('["2026-10-01"]', '2026-10-01'),
        h('[null]', null),
      ]),
      cells: {
        '["2026-09-01"]': {
          '[]': { n: 4 },
          '["2026-09-01"]': { n: 1 },
          '["2026-10-01"]': { n: 2 },
          '[null]': { n: 1 },
        },
        '[null]': { '[]': { n: 3 } },
      },
      statements: 1,
    };
    const churn = cohortTable(report, 'month', 'churn');
    expect(churn).toHaveLength(1);
    expect(churn[0]?.size).toBe(4);
    expect(churn[0]?.shares).toEqual([0.25, 0.75]);
    expect(cohortTable(report, 'month', 'retention')[0]?.shares).toEqual([0.75, 0.25]);
    expect(periodsBetween('2026-09-07', '2026-09-21', 'week')).toBe(2);
  });
});

describe('calendar and gantt windows', () => {
  test('whole weeks from Monday; month, week and day windows', () => {
    const days = gridDays(new Date('2026-10-18T00:00:00Z'), 'month');
    expect(days[0]?.toISOString().slice(0, 10)).toBe('2026-09-28');
    expect(days.length % 7).toBe(0);
    expect(gridDays(new Date('2026-10-18T00:00:00Z'), 'week')).toHaveLength(7);
    const month = windowOf(new Date('2026-10-18T00:00:00Z'), 'month');
    expect([month.from.toISOString().slice(0, 10), month.to.toISOString().slice(0, 10)]).toEqual([
      '2026-10-01',
      '2026-11-01',
    ]);
    expect(windowOf(new Date('2026-10-18T00:00:00Z'), 'week').from.toISOString().slice(0, 10)).toBe(
      '2026-10-12',
    );
  });
});
