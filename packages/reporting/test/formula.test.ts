import { describe, expect, test } from 'vitest';
import { columnName, evaluateSheet, reportCalls, reportKey } from '../src/web/formula.js';

describe('formulas', () => {
  test('arithmetic, references, ranges and functions', () => {
    const v = evaluateSheet(
      {
        A1: '10',
        A2: '20',
        A3: '=A1+A2*2',
        B1: '=SUM(A1:A3)',
        B2: '=AVERAGE(A1:A2)',
        B3: '=ROUND(A1/3, 2)',
        C1: '=IF(A1>5, "big", "small")',
        C2: '=MAX(A1:A3)-MIN(A1:A3)',
        C3: '="Total: "&B1',
        D1: '=COUNT(A1:C3)',
        D2: '=-A1^2',
      },
      new Map(),
    );
    expect(v).toMatchObject({
      A3: 50,
      B1: 80,
      B2: 15,
      B3: 3.33,
      C1: 'big',
      C2: 40,
      C3: 'Total: 80',
      D2: -100,
    });
    expect(v['D1']).toBe(7);
  });

  test('errors are values and propagate; cycles are detected', () => {
    const v = evaluateSheet(
      { A1: '=1/0', A2: '=A1+1', B1: '=B2', B2: '=B1', C1: '=NOPE(1)', C2: '=1+' },
      new Map(),
    );
    expect(v).toMatchObject({ A1: '#DIV/0!', A2: '#DIV/0!', C1: '#NAME?', C2: '#VALUE!' });
    expect([v['B1'], v['B2']]).toContain('#CYCLE!');
  });

  test('REPORT calls are collected, then resolved by the caller', () => {
    const cells = {
      A1: '=REPORT("sale.order", "sum:amount")',
      A2: '=REPORT("sale.order", "count", "{\\"state\\":\\"sale\\"}")',
      A3: '=A1/A2',
    };
    const calls = reportCalls(cells);
    expect(calls).toEqual([
      {
        key: reportKey('sale.order', 'sum:amount', undefined),
        model: 'sale.order',
        measure: 'sum:amount',
        domain: undefined,
      },
      {
        key: reportKey('sale.order', 'count', { state: 'sale' }),
        model: 'sale.order',
        measure: 'count',
        domain: { state: 'sale' },
      },
    ]);
    const v = evaluateSheet(
      cells,
      new Map<string, number | string>([
        [calls[0]?.key as string, '1350.00'],
        [calls[1]?.key as string, 6],
      ]),
    );
    expect(v).toMatchObject({ A1: 1350, A2: 6, A3: 225 });
    expect(evaluateSheet(cells, new Map())['A1']).toBe('#N/A'); // not resolved yet
  });

  test('column names', () => {
    expect([0, 25, 26, 701].map(columnName)).toEqual(['A', 'Z', 'AA', 'ZZ']);
  });
});
