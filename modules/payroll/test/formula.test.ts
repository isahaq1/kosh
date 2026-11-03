/**
 * The payroll formula language (RFC 0024 §2.3): arithmetic in Decimals, comparisons and logic as 1 or 0, the
 * functions, progressive slabs, unset inputs as zero, the explanation, and mistakes refused with a reason.
 */
import { orm } from '@kosh/server/orm';
import { describe, expect, test } from 'vitest';
import {
  evaluate,
  explain,
  FormulaError,
  parse,
  type Scope,
  slabTax,
  variablesOf,
} from '../src/formula.js';

const d = orm.toDecimal;
const scope = (vars: Record<string, string>, extra: Partial<Scope> = {}): Scope => ({
  variables: new Map(Object.entries(vars).map(([k, v]) => [k, d(v)])),
  slabs: new Map([
    [
      'TAX',
      {
        bands: [
          { upTo: d('350000'), rate: d('0') },
          { upTo: d('450000'), rate: d('5') },
          { upTo: d('850000'), rate: d('10') },
          { upTo: null, rate: d('15') },
        ],
      },
    ],
  ]),
  ...extra,
});
const run = (text: string, vars: Record<string, string> = {}, extra: Partial<Scope> = {}) =>
  evaluate(parse(text), scope(vars, extra)).toString();

describe('the language', () => {
  test('exact arithmetic, precedence and parentheses', () => {
    expect(run('0.1 + 0.2')).toBe('0.3');
    expect(run('WAGE * 0.6', { WAGE: '45000' })).toBe('27000');
    expect(run('2 + 3 * 4')).toBe('14');
    expect(run('(2 + 3) * 4')).toBe('20');
    expect(run('-BASIC / 30', { BASIC: '27000' })).toBe('-900');
  });
  test('comparisons, logic and if', () => {
    expect(run('SERVICE_MONTHS >= 12', { SERVICE_MONTHS: '12' })).toBe('1');
    expect(run('A > 1 and not B', { A: '2', B: '0' })).toBe('1');
    expect(run('A > 5 or B == 1', { A: '2', B: '0' })).toBe('0');
    expect(run('if(ABSENT_DAYS > 0, 100, 0)', { ABSENT_DAYS: '0' })).toBe('0');
  });
  test('functions', () => {
    expect(run('min(1500, 900, 1200)')).toBe('900');
    expect(run('max(0, -3)')).toBe('0');
    expect(run('round(10 / 3, 2)')).toBe('3.33');
    expect(run('floor(2.7) + ceil(2.1) + abs(-1)')).toBe('6');
  });
  test('a progressive slab', () => {
    // 3.5 lakh free, 1 lakh at 5%, 4 lakh at 10%, the rest at 15%.
    expect(
      slabTax({ bands: scope({}).slabs.get('TAX')?.bands ?? [] }, d('300000')).toString(),
    ).toBe('0');
    expect(run("slab('TAX', 1000000)")).toBe('67500');
  });
  test('unset inputs and year-to-date read as zero only where allowed', () => {
    const zero = (n: string) => n.startsWith('INPUT_');
    expect(run('INPUT_BONUS + 1', {}, { zero })).toBe('1');
    expect(() => run('NOT_THERE + 1', {}, { zero })).toThrow(/Unknown variable NOT_THERE/);
  });
  test('the explanation writes the values in', () => {
    expect(
      explain(
        'WAGE * 0.6 * CONTRACT_DAYS / PERIOD_DAYS',
        scope({ WAGE: '45000', CONTRACT_DAYS: '31', PERIOD_DAYS: '31' }),
      ),
    ).toBe('45000 × 0.6 × 31 ÷ 31');
    expect(variablesOf(parse('max(0, A - B) * C'))).toEqual(['A', 'B', 'C']);
  });
  test('mistakes are refused with a reason', () => {
    for (const [text, reason] of [
      ['WAGE *', /ends too early/],
      ['wage * 2', /capitals/],
      ['sqrt(4)', /no function/],
      ['min()', /takes 1 to 20/],
      ['(1 + 2', /“\)” expected/],
      ['1 ; 2', /Unexpected/],
      ['x'.repeat(501), /at most 500/],
    ] as const)
      expect(() => parse(text)).toThrow(reason);
    expect(() => run('1 / ZERO', { ZERO: '0' })).toThrow(FormulaError);
    expect(() => run("slab('NOPE', 1)")).toThrow(/No slab table NOPE/);
  });
});
