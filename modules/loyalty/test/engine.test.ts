/**
 * The loyalty engine (RFC 0034 §2.6), without a database: what an order earns, tiers, old points, the preview.
 */
import { expect, test } from 'vitest';
import {
  type EarnRule,
  earn,
  expiredPoints,
  monthsBefore,
  type Order,
  preview,
  type Tier,
  tierOf,
} from '../src/engine.js';

const RICE = 1;
const TEA = 2;
const GROCERY = 10;
const DRINKS = 20;

const rule = (id: number, more: Partial<EarnRule> = {}): EarnRule => ({
  id,
  amountPer: 10_000, // every 100.00
  points: 1,
  product: null,
  category: null,
  minimumOrder: 0,
  dateFrom: null,
  dateTo: null,
  ...more,
});
const order = (lines: readonly [number, number | null, number][], date = '2027-03-10'): Order => ({
  date,
  lines: lines.map(([product, category, amount]) => ({ product, category, amount })),
});
const SILVER: Tier = { id: 1, minPoints: 500, multiplier: 125 };
const GOLD: Tier = { id: 2, minPoints: 2000, multiplier: 150 };

test('a point for every full hundred of the order, discounts included', () => {
  const everything = [rule(1)];
  // 1,250.00 of rice and 380.50 of tea: sixteen full hundreds.
  expect(
    earn(
      everything,
      order([
        [RICE, GROCERY, 125_000],
        [TEA, DRINKS, 38_050],
      ]),
      null,
    ),
  ).toEqual({
    points: 16,
    byRule: [{ rule: 1, base: 163_050, points: 16 }],
    multiplier: 100,
  });
  // A discount line of 200.00 takes two points away.
  expect(
    earn(
      everything,
      order([
        [RICE, GROCERY, 125_000],
        [TEA, DRINKS, 38_050],
        [99, null, -20_000],
      ]),
      null,
    ).points,
  ).toBe(14);
  // Below a hundred: nothing. Worth nothing, or less (a return): nothing.
  expect(earn(everything, order([[TEA, DRINKS, 9_999]]), null).points).toBe(0);
  expect(
    earn(
      everything,
      order([
        [TEA, DRINKS, 5_000],
        [99, null, -5_000],
      ]),
      null,
    ).points,
  ).toBe(0);
  expect(earn(everything, order([[TEA, DRINKS, -30_000]]), null).points).toBe(0);
  expect(earn(everything, order([]), null).points).toBe(0);
});

test('rules on a product or a category, a minimum order, dates: each gives its own', () => {
  const rules = [
    rule(1),
    rule(2, { category: DRINKS, points: 3 }), // drinks: three more for every hundred
    rule(3, { product: RICE, amountPer: 50_000, points: 10 }), // ten for every 500 of rice
    rule(4, { minimumOrder: 500_000, points: 5 }), // big orders
    rule(5, { dateFrom: '2027-04-01', dateTo: '2027-04-30', points: 2 }), // April only
  ];
  const basket = order([
    [RICE, GROCERY, 125_000],
    [TEA, DRINKS, 38_050],
  ]);
  expect(earn(rules, basket, null)).toMatchObject({
    points: 16 + 9 + 20,
    byRule: [
      { rule: 1, base: 163_050, points: 16 },
      { rule: 2, base: 38_050, points: 9 },
      { rule: 3, base: 125_000, points: 20 },
    ],
  });
  // In April the fifth rule gives too; a big order meets the fourth.
  expect(earn(rules, { ...basket, date: '2027-04-01' }, null).points).toBe(45 + 32);
  expect(earn(rules, { ...basket, date: '2027-05-01' }, null).points).toBe(45);
  expect(
    earn(rules, order([[RICE, GROCERY, 500_000]]), null).byRule.map((r) => [r.rule, r.points]),
  ).toEqual([
    [1, 50],
    [3, 100],
    [4, 250],
  ]);
  // A rule on a product gives no more than the order is worth after its discounts.
  expect(
    earn(
      [rule(3, { product: RICE, points: 1 })],
      order([
        [RICE, GROCERY, 100_000],
        [99, null, -60_000],
      ]),
      null,
    ).points,
  ).toBe(4);
  // A rule that gives nothing, or for nothing, is no rule.
  expect(earn([rule(1, { amountPer: 0 }), rule(2, { points: 0 })], basket, null).points).toBe(0);
});

test('tiers: the highest reached multiplies what an order earns, rounded down', () => {
  const tiers = [GOLD, SILVER];
  expect(tierOf(tiers, 0)).toBeNull();
  expect(tierOf(tiers, 499)).toBeNull();
  expect(tierOf(tiers, 500)).toBe(SILVER);
  expect(tierOf(tiers, 1999)).toBe(SILVER);
  expect(tierOf(tiers, 2000)).toBe(GOLD);
  expect(tierOf([], 9999)).toBeNull();
  const basket = order([[RICE, GROCERY, 130_000]]); // 13 points
  expect(earn([rule(1)], basket, SILVER)).toMatchObject({ points: 16, multiplier: 125 }); // 16.25
  expect(earn([rule(1)], basket, GOLD).points).toBe(19); // 19.5
});

test('points grow old: what was earned before the cutoff and never used is lost, once', () => {
  const ledger = [
    { date: '2026-01-10', points: 100 },
    { date: '2026-06-01', points: 50 },
    { date: '2026-08-15', points: -30 }, // redeemed: the oldest points go first
    { date: '2027-02-01', points: 40 },
  ];
  // On 1 March 2027 with twelve months: what was earned before 1 March 2026 is 100, of which 30 were used.
  expect(expiredPoints(ledger, '2026-03-01')).toBe(70);
  // Written to the ledger, nothing more is lost that day.
  expect(expiredPoints([...ledger, { date: '2027-03-01', points: -70 }], '2026-03-01')).toBe(0);
  // Later the 50 of June grow old too: 150 old, 100 gone already.
  expect(expiredPoints([...ledger, { date: '2027-03-01', points: -70 }], '2026-07-01')).toBe(50);
  // Nothing old, or everything used: nothing.
  expect(expiredPoints(ledger, '2026-01-01')).toBe(0);
  expect(
    expiredPoints(
      [
        { date: '2026-01-10', points: 100 },
        { date: '2026-02-01', points: -100 },
      ],
      '2027-01-01',
    ),
  ).toBe(0);
  expect(monthsBefore('2027-03-31', 1)).toBe('2027-02-28');
  expect(monthsBefore('2027-03-15', 12)).toBe('2026-03-15');
  expect(monthsBefore('2027-01-31', 2)).toBe('2026-11-30');
});

test('the preview: what a program would have given over past orders, and what share of them', () => {
  const rules = [rule(1), rule(2, { category: DRINKS, points: 3 })];
  const past = [
    order([
      [RICE, GROCERY, 125_000],
      [TEA, DRINKS, 38_050],
    ]), // 16 + 9
    order([[TEA, DRINKS, 9_000]]), // nothing
    order([[RICE, GROCERY, 400_000]]), // 40
    order([[RICE, GROCERY, -50_000]]), // a return
  ];
  // A point is worth 1.00: 65 points on 572,050 of revenue.
  expect(preview(rules, past, 100)).toEqual({
    orders: 4,
    earning: 2,
    points: 65,
    revenue: 572_050,
    cost: 6_500,
    share: 114, // 1.14 %
    byRule: [
      { rule: 1, points: 56 },
      { rule: 2, points: 9 },
    ],
  });
  expect(preview(rules, [], 100)).toMatchObject({ orders: 0, points: 0, cost: 0, share: 0 });
});
