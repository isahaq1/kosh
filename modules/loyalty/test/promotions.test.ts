/**
 * The promotion engine (RFC 0034 §2.6), without a database: each kind alone, which go together, the preview.
 */
import { expect, test } from 'vitest';
import {
  applyPromotions,
  discountOf,
  type PromoOrder,
  type Promotion,
  previewPromotion,
} from '../src/promotions.js';

const RICE = 1;
const TEA = 2;
const MUG = 3;
const GROCERY = 10;
const DRINKS = 20;

const promo = (id: number, more: Partial<Promotion> = {}): Promotion => ({
  id,
  kind: 'percent',
  value: 1000, // 10 %
  product: null,
  category: null,
  minimumOrder: 0,
  buy: 0,
  get: 0,
  rewardProduct: null,
  code: '',
  dateFrom: null,
  dateTo: null,
  exclusive: false,
  ...more,
});
const order = (
  lines: readonly [number, number | null, number, number][],
  more: Partial<PromoOrder> = {},
): PromoOrder => ({
  date: '2027-03-10',
  code: '',
  lines: lines.map(([product, category, quantity, amount]) => ({
    product,
    category,
    quantity,
    amount,
  })),
  ...more,
});
// 2 kg of rice for 300.00, 3 packs of tea at 150.00.
const BASKET = order([
  [RICE, GROCERY, 2, 30_000],
  [TEA, DRINKS, 3, 45_000],
]);

test('a percentage: of the order, or of the lines it applies to', () => {
  expect(discountOf(promo(1), BASKET)).toEqual({ promotion: 1, amount: 7_500, freeUnits: 0 });
  expect(discountOf(promo(1, { category: DRINKS, value: 2000 }), BASKET)?.amount).toBe(9_000);
  expect(discountOf(promo(1, { product: RICE, value: 1250 }), BASKET)?.amount).toBe(3_750);
  // Rounded to the hundredth: 33.33 % of 100.01.
  expect(discountOf(promo(1, { value: 3333 }), order([[RICE, GROCERY, 1, 10_001]]))?.amount).toBe(
    3_333,
  );
  // Nothing it applies to on the order: it does not apply.
  expect(discountOf(promo(1, { product: MUG }), BASKET)).toBeNull();
});

test('an amount off, from a minimum, never more than what it applies to is worth', () => {
  const fifty = promo(2, { kind: 'amount', value: 5_000, minimumOrder: 50_000 });
  expect(discountOf(fifty, BASKET)?.amount).toBe(5_000);
  expect(discountOf(fifty, order([[RICE, GROCERY, 1, 49_999]]))).toBeNull();
  expect(discountOf(promo(2, { kind: 'amount', value: 100_000 }), BASKET)?.amount).toBe(75_000);
  expect(
    discountOf(promo(2, { kind: 'amount', value: 40_000, product: RICE }), BASKET)?.amount,
  ).toBe(30_000);
});

test('dates and codes: outside them a promotion does not apply', () => {
  const march = promo(3, { dateFrom: '2027-03-01', dateTo: '2027-03-31' });
  expect(discountOf(march, BASKET)).not.toBeNull();
  expect(discountOf(march, { ...BASKET, date: '2027-02-28' })).toBeNull();
  expect(discountOf(march, { ...BASKET, date: '2027-04-01' })).toBeNull();
  const coded = promo(3, { code: 'EID27' });
  expect(discountOf(coded, BASKET)).toBeNull();
  expect(discountOf(coded, { ...BASKET, code: 'EID27' })?.amount).toBe(7_500);
  expect(discountOf(coded, { ...BASKET, code: 'OTHER' })).toBeNull();
});

test('buy two, get one free: the cheapest units are the free ones', () => {
  const b2g1 = promo(4, { kind: 'buy_get', category: DRINKS, buy: 2, get: 1 });
  // Three packs of tea at 150: one free.
  expect(discountOf(b2g1, BASKET)).toEqual({ promotion: 4, amount: 15_000, freeUnits: 1 });
  // Two packs: not yet. Seven: two free.
  expect(discountOf(b2g1, order([[TEA, DRINKS, 2, 30_000]]))).toBeNull();
  expect(discountOf(b2g1, order([[TEA, DRINKS, 7, 105_000]]))?.freeUnits).toBe(2);
  // Mixed prices in the category: of six units — 200, 200, 150, 150, 150, 90 — the two cheapest are free.
  const mixed = order([
    [TEA, DRINKS, 3, 45_000],
    [5, DRINKS, 2, 40_000],
    [6, DRINKS, 1, 9_000],
  ]);
  expect(discountOf(b2g1, mixed)).toEqual({ promotion: 4, amount: 9_000 + 15_000, freeUnits: 2 });
  // Half a unit is not a unit: 2.5 packs are two.
  expect(discountOf(b2g1, order([[TEA, DRINKS, 2.5, 37_500]]))).toBeNull();
  // Without numbers it is no promotion.
  expect(discountOf(promo(4, { kind: 'buy_get', buy: 0, get: 1 }), BASKET)).toBeNull();
});

test('buy tea, get a mug: free units of another product, as many as are on the order', () => {
  const mug = promo(5, { kind: 'buy_get', product: TEA, buy: 3, get: 1, rewardProduct: MUG });
  // Three packs and one mug at 120: the mug is free.
  expect(
    discountOf(
      mug,
      order([
        [TEA, DRINKS, 3, 45_000],
        [MUG, null, 1, 12_000],
      ]),
    ),
  ).toEqual({ promotion: 5, amount: 12_000, freeUnits: 1 });
  // Six packs earn two mugs, but only one is on the order: one is free.
  expect(
    discountOf(
      mug,
      order([
        [TEA, DRINKS, 6, 90_000],
        [MUG, null, 1, 12_000],
      ]),
    )?.freeUnits,
  ).toBe(1);
  // No mug on the order, or not enough tea: nothing.
  expect(discountOf(mug, order([[TEA, DRINKS, 3, 45_000]]))).toBeNull();
  expect(
    discountOf(
      mug,
      order([
        [TEA, DRINKS, 2, 30_000],
        [MUG, null, 1, 12_000],
      ]),
    ),
  ).toBeNull();
});

test('promotions together; one that goes alone is taken when it is better, never both', () => {
  const ten = promo(1); // 75.00
  const drinks = promo(2, { category: DRINKS, value: 2000 }); // 90.00
  const big = promo(3, { value: 2500, exclusive: true }); // 187.50, alone
  const small = promo(4, { value: 500, exclusive: true }); // 37.50, alone
  expect(applyPromotions([ten, drinks], BASKET).map((d) => [d.promotion, d.amount])).toEqual([
    [1, 7_500],
    [2, 9_000],
  ]);
  // Alone it gives more than the two together: it is taken, alone.
  expect(applyPromotions([ten, drinks, big], BASKET).map((d) => d.promotion)).toEqual([3]);
  // Alone it gives less: the others stay.
  expect(applyPromotions([ten, drinks, small], BASKET).map((d) => d.promotion)).toEqual([1, 2]);
  // Of two that go alone, the better one.
  expect(applyPromotions([small, big], BASKET).map((d) => d.promotion)).toEqual([3]);
  // Never more than the goods are worth: the last is cut to fit.
  const all = promo(5, { kind: 'amount', value: 70_000 });
  expect(applyPromotions([all, ten], BASKET).map((d) => d.amount)).toEqual([70_000, 5_000]);
  expect(applyPromotions([], BASKET)).toEqual([]);
  expect(applyPromotions([ten], order([]))).toEqual([]);
});

test('the preview: what a promotion would have taken off past orders, as if its code were always typed', () => {
  const coded = promo(1, { code: 'EID27', category: DRINKS, value: 2000 });
  const past = [
    BASKET, // 90.00 off 750.00
    order([[RICE, GROCERY, 5, 75_000]]), // no drinks
    order([[TEA, DRINKS, 1, 15_000]]), // 30.00 off 150.00
  ];
  expect(previewPromotion(coded, past)).toEqual({
    orders: 3,
    applied: 2,
    discount: 12_000,
    revenue: 165_000,
    share: 727, // 7.27 %
    freeUnits: 0,
  });
  const b2g1 = promo(4, { kind: 'buy_get', category: DRINKS, buy: 2, get: 1 });
  expect(previewPromotion(b2g1, past)).toMatchObject({
    applied: 1,
    discount: 15_000,
    freeUnits: 1,
  });
  expect(previewPromotion(coded, [])).toMatchObject({ orders: 0, discount: 0, share: 0 });
});
