/**
 * Loyalty in the Shop on real PostgreSQL, through the shop's public API (RFC 0034 §2.6): running promotions are on
 * a visitor's cart by themselves and follow it as it changes — never twice —; a promotion code and a gift card
 * are typed, refused in words when they do not work; the gift card pays what the cart comes to with its delivery,
 * and follows the cart too; the placed order earns points on what was paid; a code that stops working is taken
 * off the cart rather than breaking it.
 */
import { loyaltyWorkers } from '@kosh/loyalty';
import { type TestInstallation, testInstallation } from '@kosh/server/testing';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { websiteSaleLoyalty } from '../src/index.js';

const SHOP = '/api/v1/public/shop/bazar';
let erp: TestInstallation;
let drain: () => Promise<void>;
const ids: Record<string, number> = {};

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
const call = async (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown) => {
  const res = await erp.call(method, url, 'dina', body);
  return { status: res.status, json: res.json as Json };
};
const make = async (model: string, values: Record<string, unknown>) => {
  const made = await call('POST', `/api/v1/models/${model}`, values);
  expect(made.status, `${model}: ${JSON.stringify(made.json)}`).toBe(201);
  return made.json.id as number;
};
/** A visitor's call: no sign-in, the cart's token if any. */
const visit = async (
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  cart?: string,
  body?: unknown,
) => {
  const res = await erp.host.server.app.inject({
    method,
    url,
    headers: cart === undefined ? {} : { 'x-cart-token': cart },
    ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
  });
  return { status: res.statusCode, json: (res.body === '' ? null : res.json()) as Json };
};
const newCart = async () => {
  const made = await visit('POST', `${SHOP}/cart`);
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  return made.json.token as string;
};
const put = async (cart: string, product: string, quantity: string) => {
  const res = await visit('PUT', `${SHOP}/cart/lines`, cart, { product: ids[product], quantity });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json as Json;
};
const balanceOf = async (voucher: number) =>
  Number(
    (await call('GET', `/api/v1/models/loyalty.voucher/${voucher}?fields=balance`)).json.balance,
  );
const launch = async (model: string, id: number) =>
  expect((await call('POST', `/api/v1/models/${model}/${id}/transitions/launch`)).status).toBe(200);

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  erp = await testInstallation({
    modules: [websiteSaleLoyalty],
    users: {
      dina: [
        'website_sale.manager',
        'product.manager',
        'account.manager',
        'contacts.manager',
        'loyalty.manager',
      ],
    },
    company: { name: 'Padma Traders', currency: 'BDT' },
  });
  const workers = loyaltyWorkers({ shutro: erp.host.server.shutro });
  drain = async () => {
    for (const w of workers) await w.drain();
  };
  expect(
    (await call('POST', '/api/v1/accounting/charts/install', { template: 'generic' })).status,
  ).toBe(200);
  await make('website.site', { name: 'Padma Traders', key: 'bazar', shop: true, codLimit: '5000' });
  ids['drinks'] = await make('product.category', { name: 'Drinks' });
  ids['rice'] = await make('product.product', {
    name: 'Rice 5 kg',
    listPrice: '500',
    published: true,
  });
  ids['tea'] = await make('product.product', {
    name: 'Tea 400 g',
    listPrice: '150',
    published: true,
    category: ids['drinks'],
  });
  ids['carrier'] = await make('delivery.carrier', {
    name: 'Home delivery',
    kind: 'zone',
    zoneCities: 'Dhaka',
    priceInside: '60',
    priceOutside: '120',
    cod: true,
  });
  // Running before any cart: 20 % off drinks; a point for every hundred paid.
  ids['drinksPromo'] = await make('loyalty.promotion', {
    name: 'Drinks week: 20 % off',
    kind: 'percent',
    value: '20',
    category: ids['drinks'],
  });
  await launch('loyalty.promotion', ids['drinksPromo']);
  ids['program'] = await make('loyalty.program', {
    name: 'Padma Rewards',
    rules: { create: [{ name: 'A point for every 100', points: 1 }] },
  });
  await launch('loyalty.program', ids['program']);
}, 300_000);

afterAll(async () => {
  await erp?.close();
});

test('running promotions are on the cart by themselves, and follow it — never twice', async () => {
  const cart = await newCart();
  await put(cart, 'rice', '1');
  // Two packs of tea: 20 % of 300.
  const two = await put(cart, 'tea', '2');
  expect([two.discount, two.total]).toEqual(['60.00', '740.00']);
  // The goods are the two products: what was taken off is not a line among them.
  expect(two.lines.map((l: Json) => l.name)).toEqual(['Rice 5 kg', 'Tea 400 g']);
  // Four packs: 120 off, not 60 and 120.
  const four = await put(cart, 'tea', '4');
  expect([four.discount, four.total]).toEqual(['120.00', '980.00']);
  const loyalty = await visit('GET', `${SHOP}/cart/loyalty`, cart);
  expect(loyalty.json).toEqual({
    promotions: [{ name: 'Drinks week: 20 % off', amount: '120.00' }],
    promoCode: null,
    giftCard: null,
    giftCardPaid: '0.00',
  });
  // No tea, no promotion.
  expect((await put(cart, 'tea', '0')).discount).toBe('0.00');
  // Without a cart there is nothing to read.
  expect((await visit('GET', `${SHOP}/cart/loyalty`, 'x'.repeat(40))).status).toBe(404);
});

test('a promotion code is typed: refused in words when wrong, taken off the cart when its promotion ends', async () => {
  const coded = await make('loyalty.promotion', {
    name: 'EID27: 100 off',
    kind: 'amount',
    value: '100',
    minimumOrder: '500',
    code: 'EID27',
  });
  await launch('loyalty.promotion', coded);
  const cart = await newCart();
  await put(cart, 'rice', '1');
  await put(cart, 'tea', '2');
  const wrong = await visit('PUT', `${SHOP}/cart/promotion`, cart, { code: 'nope' });
  expect(wrong.status).toBe(422);
  expect(JSON.stringify(wrong.json)).toContain('No running promotion has this code');
  // The cart is as it was: its own promotion, no code kept.
  expect((await visit('GET', `${SHOP}/cart/loyalty`, cart)).json.promoCode).toBeNull();
  const right = await visit('PUT', `${SHOP}/cart/promotion`, cart, { code: ' eid27 ' });
  expect(right.status, JSON.stringify(right.json)).toBe(200);
  expect([right.json.discount, right.json.total]).toEqual(['160.00', '640.00']);
  expect(right.json.loyalty.promotions.map((p: Json) => p.amount)).toEqual(['60.00', '100.00']);
  expect(right.json.loyalty.promoCode).toBe('EID27');
  // The promotion ends while the cart is open: the next change of the cart drops the code, and works.
  expect(
    (await call('POST', `/api/v1/models/loyalty.promotion/${coded}/transitions/finish`)).status,
  ).toBe(200);
  const after = await put(cart, 'rice', '2');
  expect([after.discount, after.total]).toEqual(['60.00', '1240.00']);
  expect((await visit('GET', `${SHOP}/cart/loyalty`, cart)).json.promoCode).toBeNull();
  // Taken off by the visitor: an empty code.
  expect((await visit('PUT', `${SHOP}/cart/promotion`, cart, { code: '' })).status).toBe(200);
});

test('a gift card pays what the cart comes to, follows the cart, and the placed order earns points', async () => {
  const gift = await make('loyalty.voucher', { entries: { create: [{ amount: '500' }] } });
  const code = (await call('GET', `/api/v1/models/loyalty.voucher/${gift}?fields=code`)).json
    .code as string;
  const cart = await newCart();
  await put(cart, 'rice', '1');
  const wrong = await visit('PUT', `${SHOP}/cart/gift-card`, cart, { code: 'GC-NOPE' });
  expect(wrong.status).toBe(422);
  expect(JSON.stringify(wrong.json)).toContain('No gift card or wallet has this code');
  // 500 of rice: the card pays 500, and is empty for now.
  const paid = await visit('PUT', `${SHOP}/cart/gift-card`, cart, { code: code.toLowerCase() });
  expect(paid.status, JSON.stringify(paid.json)).toBe(200);
  expect([paid.json.total, paid.json.loyalty.giftCardPaid]).toEqual(['0.00', '500.00']);
  expect(await balanceOf(gift)).toBe(0);
  // Rice taken out, two packs of tea in: 300 less 60 — the card pays 240 and holds 260 again. Never both.
  await put(cart, 'rice', '0');
  const tea = await put(cart, 'tea', '2');
  expect(tea.total).toBe('0.00');
  expect(await balanceOf(gift)).toBe(260);
  // More than the card holds: 2 × 500 + 300 − 60 = 1,240; it pays 500, and 740 is left.
  const more = await put(cart, 'rice', '2');
  expect(more.total).toBe('740.00');
  expect(await balanceOf(gift)).toBe(0);
  // Checked out with delivery (60): the card was empty, so the fee is to pay as well.
  const placed = await visit('POST', `${SHOP}/checkout`, cart, {
    name: 'Rina Akter',
    email: 'rina@example.com',
    phone: '01700000000',
    street: 'House 12, Road 5',
    city: 'Dhaka',
    carrier: ids['carrier'],
    payment: 'cod',
  });
  expect(placed.status, JSON.stringify(placed.json)).toBe(201);
  expect([placed.json.state, placed.json.total]).toEqual(['sale', '800.00']);
  expect(await balanceOf(gift)).toBe(0);
  // The order earns on the goods as paid — 1,300 less 60 and 500: 740 — not on the delivery fee.
  await drain();
  const [card] = (await call('GET', '/api/v1/models/loyalty.card?fields=points,partner')).json
    .items as Json[];
  expect(card.points).toBe(7);
  // What Loyalty put on the order is marked as its own.
  const lines = await erp.host.server.driver.query<{ kind: string; discount: boolean }>({
    text: `SELECT l.loyalty_kind AS kind, l.is_discount AS discount FROM sale_order_line l
             JOIN sale_order o ON o.id = l.order_id
            WHERE o.name = $1 AND l.loyalty_kind IS NOT NULL ORDER BY l.id`,
    params: [placed.json.order],
  });
  expect(lines.map((l) => [l.kind, l.discount])).toEqual([
    ['promotion', true],
    ['voucher', true],
  ]);
});

test('a gift card that stops paying is taken off the cart: the cart goes on, and nothing stays held', async () => {
  const gift = await make('loyalty.voucher', { entries: { create: [{ amount: '300' }] } });
  const code = (await call('GET', `/api/v1/models/loyalty.voucher/${gift}?fields=code`)).json
    .code as string;
  const cart = await newCart();
  await put(cart, 'rice', '1');
  expect((await visit('PUT', `${SHOP}/cart/gift-card`, cart, { code })).json.total).toBe('200.00');
  expect(await balanceOf(gift)).toBe(0);
  // The card's last day passes.
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  expect(
    (await call('PATCH', `/api/v1/models/loyalty.voucher/${gift}`, { dateExpiry: yesterday }))
      .status,
  ).toBe(200);
  const after = await put(cart, 'rice', '2');
  expect(after.total).toBe('1000.00');
  expect((await visit('GET', `${SHOP}/cart/loyalty`, cart)).json).toMatchObject({
    giftCard: null,
    giftCardPaid: '0.00',
  });
  // What it held is back on the card.
  expect(await balanceOf(gift)).toBe(300);
});
