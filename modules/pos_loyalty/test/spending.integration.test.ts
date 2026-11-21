/**
 * Promotions, points and gift cards at the Counter on real PostgreSQL (RFC 0034 §2.6): a quote says what the
 * sale would come to and leaves nothing behind; the sale takes off what the till asked for, by the server's own
 * arithmetic, and holds the points and the gift card once; a sale that did not ask — one rung up offline — is
 * kept as it was paid; what cannot be taken stops the sale in words; a sale something was taken off is refunded
 * whole, and what it held goes back with it.
 */
import { type TestInstallation, testInstallation } from '@kosh/server/testing';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { posLoyaltyModule, posLoyaltyWorkers } from '../src/index.js';

let erp: TestInstallation;
let drain: () => Promise<void>;
const ids: Record<string, number> = {};
let giftCode = '';

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
const call = async (as: string, method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown) => {
  const res = await erp.call(method, url, as, body);
  return { status: res.status, json: res.json as Json };
};
const make = async (model: string, values: Record<string, unknown>) => {
  const made = await call('maria', 'POST', `/api/v1/models/${model}`, values);
  expect(made.status, `${model}: ${JSON.stringify(made.json)}`).toBe(201);
  return made.json.id as number;
};
const launch = async (model: string, id: number) =>
  expect(
    (await call('maria', 'POST', `/api/v1/models/${model}/${id}/transitions/launch`)).status,
  ).toBe(200);
const cart = (
  quantity: string,
  extras?: Record<string, unknown>,
  partner: number | null = ids['rina'] ?? null,
) => ({
  session: ids['session'],
  ...(partner === null ? {} : { partner }),
  lines: [{ product: ids['tea'], quantity }],
  ...(extras === undefined ? {} : { extras }),
});
const quote = (quantity: string, extras: Record<string, unknown> = {}, partner?: number | null) =>
  call('rahim', 'POST', '/api/v1/counter/quote', cart(quantity, extras, partner));
const sell = (
  quantity: string,
  paid: string,
  extras?: Record<string, unknown>,
  more: Record<string, unknown> = {},
) =>
  call('rahim', 'POST', '/api/v1/counter/orders', {
    ...cart(quantity, extras),
    payments: [{ method: ids['cash'], amount: paid }],
    ...more,
  });
const cardPoints = async (): Promise<number> =>
  (
    (await call('maria', 'GET', '/api/v1/models/loyalty.card?fields=points')).json.items as Json[]
  )[0]?.points ?? 0;
const giftBalance = async (): Promise<number> =>
  Number(
    (await call('maria', 'GET', `/api/v1/models/loyalty.voucher/${ids['gift']}?fields=balance`))
      .json.balance,
  );
const salesCount = async (): Promise<number> =>
  (await call('maria', 'GET', '/api/v1/models/pos.order?fields=name&limit=200')).json.items.length;
const offOf = async (sale: number): Promise<[string, number][]> =>
  (
    (
      await call(
        'maria',
        'GET',
        `/api/v1/models/pos.order.line?fields=extra,priceUnit,name&order=id&filter=${encodeURIComponent(JSON.stringify({ order: sale }))}`,
      )
    ).json.items as Json[]
  )
    .filter((l) => l.extra !== null)
    .map((l) => [l.extra, Number(l.priceUnit)]);

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  erp = await testInstallation({
    modules: [posLoyaltyModule({ workers: false })],
    users: {
      maria: [
        'pos.manager',
        'product.manager',
        'account.manager',
        'contacts.manager',
        'loyalty.manager',
      ],
      rahim: ['pos.cashier'],
      nadia: ['loyalty.user'],
    },
    company: { name: 'Padma Traders', currency: 'BDT' },
  });
  const workers = posLoyaltyWorkers({ shutro: erp.host.server.shutro });
  drain = async () => {
    for (const w of workers) await w.drain();
  };
  ids['tea'] = await make('product.product', { name: 'Tea 500 g', listPrice: '250' });
  ids['shop'] = await make('pos.shop', {
    name: 'Padma Shop',
    pricesIncludeTax: true,
    methods: { create: [{ name: 'Cash', kind: 'cash', sequence: 1 }] },
  });
  ids['cash'] = (await call('rahim', 'GET', '/api/v1/counter/shops')).json.shops[0].methods[0].id;
  ids['rina'] = await make('res.partner', { name: 'Rina Akter', email: 'rina@example.com' });
  // A point for every hundred; a point pays one taka, up to half of a sale.
  const program = await make('loyalty.program', {
    name: 'Padma Rewards',
    redeemable: true,
    pointValue: '1',
    redeemMaxPercent: 50,
    rules: { create: [{ name: 'A point for every 100', points: 1 }] },
  });
  await launch('loyalty.program', program);
  // Ten per cent off everything, by itself; fifty off with a code.
  await launch(
    'loyalty.promotion',
    await make('loyalty.promotion', { name: 'Tea week: 10 % off', kind: 'percent', value: '10' }),
  );
  await launch(
    'loyalty.promotion',
    await make('loyalty.promotion', {
      name: 'EID27: 50 off',
      kind: 'amount',
      value: '50',
      code: 'EID27',
    }),
  );
  ids['gift'] = await make('loyalty.voucher', { entries: { create: [{ amount: '300' }] } });
  giftCode = (
    await call('maria', 'GET', `/api/v1/models/loyalty.voucher/${ids['gift']}?fields=code`)
  ).json.code;
  const opened = await call('rahim', 'POST', '/api/v1/counter/sessions', {
    shop: ids['shop'],
    openingCash: '1000',
  });
  expect(opened.status, JSON.stringify(opened.json)).toBe(201);
  ids['session'] = opened.json.session.id;
}, 300_000);

afterAll(async () => {
  await erp?.close();
});

test('a quote says what the sale would come to, and leaves nothing behind', async () => {
  const before = await salesCount();
  const quoted = await quote('4');
  expect(quoted.status, JSON.stringify(quoted.json)).toBe(200);
  expect(quoted.json).toMatchObject({
    subtotal: '1000.00',
    total: '900.00',
    lines: [{ product: ids['tea'], quantity: '4', priceUnit: '250', amount: '1000.00' }],
    extras: {
      lines: [{ kind: 'promotion', name: 'Tea week: 10 % off', amount: '100.00' }],
      problems: [],
    },
  });
  // The inputs the till offers: a code (a promotion has one), a gift card; no points — the customer has no card.
  expect(quoted.json.extras.fields.map((f: Json) => [f.key, f.kind])).toEqual([
    ['promoCode', 'text'],
    ['giftCard', 'text'],
  ]);
  // A code that is none: said in words, and the quote goes on without it.
  const wrong = await quote('4', { promoCode: 'nope', giftCard: 'GC-NOPE' });
  expect(wrong.status).toBe(200);
  expect(wrong.json.total).toBe('900.00');
  expect(wrong.json.extras.problems).toEqual([
    { field: 'promoCode', say: 'No running promotion has this code.' },
    { field: 'giftCard', say: 'No gift card or wallet has this code.' },
  ]);
  // The right ones, however typed: 100 and 50 off, the gift card pays 300 of the 850 left.
  const both = await quote('4', { promoCode: ' eid27 ', giftCard: giftCode.toLowerCase() });
  expect(both.json.extras.lines.map((l: Json) => [l.kind, l.amount])).toEqual([
    ['promotion', '100.00'],
    ['promotion', '50.00'],
    ['voucher', '300.00'],
  ]);
  expect(both.json.total).toBe('550.00');
  // Nothing was made, nothing is held, and the next sale's number follows the last one's.
  expect(await salesCount()).toBe(before);
  expect(await giftBalance()).toBe(300);
  // A quote is the Counter's: in the cashier's own session.
  expect(
    (await call('nadia', 'POST', '/api/v1/counter/quote', cart('1', {}))).status,
  ).toBeGreaterThanOrEqual(403);
});

test('the sale takes off what the till asked for; one that did not ask is kept as it was paid', async () => {
  // Rung up offline at the prices the till showed, sent later: no promotion is put on it after the fact.
  const offline = await sell('4', '1000', undefined, { clientId: 'till-1-0001' });
  expect(offline.status, JSON.stringify(offline.json)).toBe(201);
  expect([Number(offline.json.order.total), Number(offline.json.order.change)]).toEqual([1000, 0]);
  expect(await offOf(offline.json.order.id)).toEqual([]);
  // Asked: the running promotion comes off by itself; what the till showed is what is charged.
  const first = await sell('4', '900', {});
  expect(first.status, JSON.stringify(first.json)).toBe(201);
  expect([Number(first.json.order.total), Number(first.json.order.change)]).toEqual([900, 0]);
  expect(await offOf(first.json.order.id)).toEqual([['promotion', -100]]);
  // The two sales' numbers follow each other: the quotes before them took none.
  const number = (name: string): number => Number(name.split('/').at(-1));
  expect(number(first.json.order.name) - number(offline.json.order.name)).toBe(1);
  // Paid as if nothing came off: the sale stands, and the cashier gives the change.
  // Less than it comes to: refused, as any sale.
  expect((await sell('4', '800', {})).status).toBe(409);
  // They earn on what was paid: ten points, and nine.
  await drain();
  expect(await cardPoints()).toBe(19);
});

test('points: within what the card holds and the share the program allows; held once for the sale', async () => {
  const offered = await quote('1');
  // 250 less 25: points may pay half of 225 — 112 —, the card holds 19.
  expect(offered.json.extras.fields.find((f: Json) => f.key === 'points')).toMatchObject({
    kind: 'number',
    max: 19,
    hint: 'The card holds 19',
  });
  for (const [points, say] of [
    ['20', 'Only 19 point(s) can be spent'],
    ['1.5', 'Points are a whole number'],
    ['-3', 'Points are a whole number'],
  ] as const) {
    const refused = await sell('1', '225', { points });
    expect(refused.status, points).toBe(422);
    expect(JSON.stringify(refused.json)).toContain(say);
  }
  expect(await cardPoints()).toBe(19);
  const quoted = await quote('1', { points: '15' });
  expect(quoted.json).toMatchObject({ total: '210.00' });
  const sold = await sell('1', '210', { points: '15' }, { clientId: 'till-1-0002' });
  expect(sold.status, JSON.stringify(sold.json)).toBe(201);
  expect(Number(sold.json.order.total)).toBe(210);
  expect(await offOf(sold.json.order.id)).toEqual([
    ['promotion', -25],
    ['points', -15],
  ]);
  expect(await cardPoints()).toBe(4);
  // The device sends it again: the same sale, the points taken once.
  const again = await sell('1', '210', { points: '15' }, { clientId: 'till-1-0002' });
  expect(again.json).toMatchObject({ repeated: true, order: { id: sold.json.order.id } });
  expect(await cardPoints()).toBe(4);
  // It earns on what was paid: 210 — two points.
  await drain();
  expect(await cardPoints()).toBe(6);
  // Points are the customer's: a sale nobody is named on has none to spend.
  const anonymous = await call('rahim', 'POST', '/api/v1/counter/orders', {
    ...cart('1', { points: '2' }, null),
    payments: [{ method: ids['cash'], amount: '225' }],
  });
  expect(anonymous.status).toBe(422);
});

test('a gift card pays what is left, held once; the whole sale refunded gives everything back', async () => {
  // 500 less 50 and the coded 50: 400; the card pays 300, 100 in cash.
  const asked = { promoCode: 'EID27', giftCard: giftCode, points: '6' };
  // Six points first: 400 − 6 = 394, the card pays 300, 94 in cash.
  const quoted = await quote('2', asked);
  expect(quoted.json.total).toBe('94.00');
  const sold = await sell('2', '94', asked);
  expect(sold.status, JSON.stringify(sold.json)).toBe(201);
  const sale = sold.json.order.id as number;
  expect(await offOf(sale)).toEqual([
    ['promotion', -50],
    ['promotion', -50],
    ['points', -6],
    ['voucher', -300],
  ]);
  expect(await giftBalance()).toBe(0);
  expect(await cardPoints()).toBe(0);
  // The card is empty now: a second sale cannot use it.
  const empty = await sell('1', '225', { giftCard: giftCode });
  expect(empty.status).toBe(422);
  expect(JSON.stringify(empty.json)).toContain('It holds nothing');
  await drain();
  // It earns on what its lines come to — 94, as on a Sales order paid by a gift card: no point.
  expect(await cardPoints()).toBe(0);
  // A part of it cannot come back alone: what was taken off would not go back with it.
  const part = await call('rahim', 'POST', `/api/v1/counter/orders/${sale}/refund`, {
    session: ids['session'],
    reason: 'One pack broken',
    lines: [{ product: ids['tea'], quantity: '1' }],
  });
  expect(part.status).toBe(409);
  expect(JSON.stringify(part.json)).toContain('refunded whole');
  // Whole: the cashier gives back the 94 that were paid in money…
  const refund = await call('rahim', 'POST', `/api/v1/counter/orders/${sale}/refund`, {
    session: ids['session'],
    reason: 'Changed their mind',
  });
  expect(refund.status, JSON.stringify(refund.json)).toBe(201);
  expect(Number(refund.json.order.total)).toBe(-94);
  await drain();
  // …the gift card holds its 300 again, and the six points are back.
  expect(await giftBalance()).toBe(300);
  expect(await cardPoints()).toBe(6);
  // The event read again gives nothing twice.
  await drain();
  await erp.host.server.shutro.bootstrap({ reason: 'test', company: erp.company }, async (env) => {
    const { loyaltyOfSale } = await import('../src/index.js');
    await loyaltyOfSale(env as never, refund.json.order.id);
  });
  expect(await giftBalance()).toBe(300);
  expect(await cardPoints()).toBe(6);
  // A sale nothing was taken off still comes back in part.
  const plain = await sell('2', '500', undefined);
  expect(plain.status).toBe(201);
  expect(
    (
      await call('rahim', 'POST', `/api/v1/counter/orders/${plain.json.order.id}/refund`, {
        session: ids['session'],
        reason: 'One pack broken',
        lines: [{ product: ids['tea'], quantity: '1' }],
      })
    ).status,
  ).toBe(201);
});
