/**
 * The tax engine (RFC 0016 §5.1): taxes in order, supplementary duty in the VAT's base, fixed taxes per unit, taxes
 * included in the price, exact decimals.
 */
import { orm } from '@kosh/server/orm';
import { expect, test } from 'vitest';
import { computeTaxes, type TaxRule } from '../src/taxes.js';

const d = (v: string) => orm.toDecimal(v);
const rule = (id: number, over: Partial<TaxRule> = {}): TaxRule => ({
  id,
  sequence: 10,
  amountType: 'percent',
  rate: d('0'),
  fixedAmount: d('0'),
  affectsBase: false,
  priceIncluded: false,
  ...over,
});
const show = (r: ReturnType<typeof computeTaxes>) => ({
  untaxed: r.untaxed.toFixed(),
  taxes: r.taxes.map((t) => [t.tax, t.base.toFixed(), t.amount.toFixed()]),
  total: r.total.toFixed(),
});

test('one percent tax; none', () => {
  expect(show(computeTaxes(d('1000'), d('1'), [rule(1, { rate: d('0.15') })]))).toEqual({
    untaxed: '1000',
    taxes: [[1, '1000', '150']],
    total: '1150',
  });
  expect(show(computeTaxes(d('1000'), d('1'), []))).toEqual({
    untaxed: '1000',
    taxes: [],
    total: '1000',
  });
});

test('supplementary duty before VAT: VAT is on the price plus SD', () => {
  const sd = rule(1, { rate: d('0.2'), affectsBase: true, sequence: 1 });
  const vat = rule(2, { rate: d('0.15'), sequence: 2 });
  // Given in any order, applied by sequence.
  expect(show(computeTaxes(d('1000'), d('1'), [vat, sd]))).toEqual({
    untaxed: '1000',
    taxes: [
      [1, '1000', '200'],
      [2, '1200', '180'],
    ],
    total: '1380',
  });
});

test('a fixed tax per unit', () => {
  const duty = rule(1, { amountType: 'fixed', fixedAmount: d('2.5') });
  expect(show(computeTaxes(d('100'), d('10'), [duty]))).toEqual({
    untaxed: '100',
    taxes: [[1, '100', '25']],
    total: '125',
  });
});

test('taxes included in the price: the untaxed amount gives the price back', () => {
  const vat = rule(1, { rate: d('0.15'), priceIncluded: true });
  expect(show(computeTaxes(d('1150'), d('1'), [vat]))).toEqual({
    untaxed: '1000',
    taxes: [[1, '1000', '150']],
    total: '1150',
  });
  const sd = rule(1, { rate: d('0.2'), affectsBase: true, priceIncluded: true, sequence: 1 });
  const vatIncl = rule(2, { rate: d('0.15'), priceIncluded: true, sequence: 2 });
  const r = computeTaxes(d('1380'), d('1'), [sd, vatIncl]);
  expect(show(r)).toEqual({
    untaxed: '1000',
    taxes: [
      [1, '1000', '200'],
      [2, '1200', '180'],
    ],
    total: '1380',
  });
});

test('exact decimals: no float rounding', () => {
  const vat = rule(1, { rate: d('0.075') });
  expect(computeTaxes(d('0.1'), d('3'), [vat]).total.toFixed()).toBe('0.1075');
});
