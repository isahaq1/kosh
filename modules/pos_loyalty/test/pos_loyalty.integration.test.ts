/**
 * Loyalty at the Counter on real PostgreSQL (RFC 0034 §2.6): the cashier names the customer by a phone number,
 * an email address or their loyalty card's number — one contact or none, never a list, and only with a role at
 * the Counter —; a paid sale with a customer earns once, however often the device sends it; a sale without a
 * customer earns nothing; goods that come back give back the share of the points they were, and all of them once
 * everything is back.
 */
import { type TestInstallation, testInstallation } from '@kosh/server/testing';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { posLoyaltyModule, posLoyaltyWorkers } from '../src/index.js';

let erp: TestInstallation;
let drain: () => Promise<void>;
const ids: Record<string, number> = {};

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
const call = async (
  as: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  body?: unknown,
) => {
  const res = await erp.call(method, url, as, body);
  return { status: res.status, json: res.json as Json };
};
const make = async (model: string, values: Record<string, unknown>) => {
  const made = await call('maria', 'POST', `/api/v1/models/${model}`, values);
  expect(made.status, `${model}: ${JSON.stringify(made.json)}`).toBe(201);
  return made.json.id as number;
};
const find = (as: string, q: string) =>
  call(as, 'GET', `/api/v1/counter/customers?shop=${ids['shop']}&q=${encodeURIComponent(q)}`);
const sell = async (quantity: string, extra: Record<string, unknown> = {}) => {
  const sold = await call('rahim', 'POST', '/api/v1/counter/orders', {
    session: ids['session'],
    lines: [{ product: ids['tea'], quantity }],
    payments: [{ method: ids['cash'], amount: String(250 * Number(quantity)) }],
    ...extra,
  });
  expect([200, 201], JSON.stringify(sold.json)).toContain(sold.status);
  return sold.json.order.id as number;
};
const card = async (): Promise<Json> => {
  const found = await call(
    'maria',
    'GET',
    '/api/v1/models/loyalty.card?fields=code,points,partner',
  );
  return (found.json.items as Json[])[0] ?? null;
};
const pointsOn = async (sale: number) =>
  (await call('maria', 'GET', `/api/v1/models/pos.order/${sale}?fields=loyaltyPoints`)).json
    .loyaltyPoints as number | null;

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
      // Sells, but not at the Counter.
      nadia: ['contacts.user', 'loyalty.user'],
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
  const shops = await call('rahim', 'GET', '/api/v1/counter/shops');
  ids['cash'] = shops.json.shops[0].methods[0].id;
  ids['rina'] = await make('res.partner', {
    name: 'Rina Akter',
    email: 'rina@example.com',
    mobile: '+880 1711-000111',
  });
  // Two people of one household, one number.
  await make('res.partner', { name: 'Karim Uddin', phone: '01999 555 444' });
  await make('res.partner', { name: 'Salma Uddin', mobile: '01999-555444' });
  const program = await make('loyalty.program', {
    name: 'Padma Rewards',
    rules: { create: [{ name: 'A point for every 100', points: 1 }] },
  });
  expect(
    (await call('maria', 'POST', `/api/v1/models/loyalty.program/${program}/transitions/launch`))
      .status,
  ).toBe(200);
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

test('the customer is named by a phone number or an email: one contact or none, and only at the Counter', async () => {
  // However the number was written down, and however it is typed.
  const byPhone = await find('rahim', '8801711000111');
  expect(byPhone.status, JSON.stringify(byPhone.json)).toBe(200);
  expect(byPhone.json.customer).toEqual({
    partner: ids['rina'],
    name: 'Rina Akter',
    note: null,
    ownPrices: false,
  });
  expect((await find('rahim', '+880 1711 000 111')).json.customer.partner).toBe(ids['rina']);
  expect((await find('rahim', 'RINA@example.com')).json.customer.partner).toBe(ids['rina']);
  // A part of a number is not a customer: the till is no way to browse them.
  expect((await find('rahim', '1711000111')).status).toBe(404);
  expect((await find('rahim', 'nobody@example.com')).status).toBe(404);
  // Two contacts have the number: the till cannot tell which.
  expect((await find('rahim', '01999555444')).status).toBe(404);
  // Too little to look for.
  expect((await find('rahim', '017')).status).toBe(400);
  // Without a role at the Counter there is no shop to look from — and no contact.
  const outsider = await find('nadia', '8801711000111');
  expect([403, 404]).toContain(outsider.status);
  expect(JSON.stringify(outsider.json)).not.toContain('Rina');
});

test('a paid sale with a customer earns once; the card names its customer at the till', async () => {
  // Four packs: 1,000 — ten points, on a card made for the customer.
  const sale = await sell('4', { partner: ids['rina'], clientId: 'till-1-0001' });
  await drain();
  const first = await card();
  expect(first).toMatchObject({ points: 10 });
  expect(await pointsOn(sale)).toBe(10);
  // The device sends the sale again, and the event is read again: the same sale, the same ten points.
  expect(await sell('4', { partner: ids['rina'], clientId: 'till-1-0001' })).toBe(sale);
  await drain();
  await erp.host.server.shutro.bootstrap({ reason: 'test', company: erp.company }, async (env) => {
    const { loyaltyOfSale } = await import('../src/index.js');
    expect(await loyaltyOfSale(env as never, sale)).toBe(0);
  });
  expect((await card()).points).toBe(10);
  // A sale nobody is named on earns nothing.
  const anonymous = await sell('2');
  await drain();
  expect(await pointsOn(anonymous)).toBeNull();
  expect((await card()).points).toBe(10);
  // The card's number, however its letters are typed, names its customer and says what the card holds.
  const byCard = await find('rahim', String(first.code).toLowerCase());
  expect(byCard.status, JSON.stringify(byCard.json)).toBe(200);
  expect(byCard.json.customer).toEqual({
    partner: ids['rina'],
    name: 'Rina Akter',
    note: `${first.code} · 10 points`,
    ownPrices: false,
  });
  // Found by phone, the till says the same.
  expect((await find('rahim', '8801711000111')).json.customer.note).toBe(
    `${first.code} · 10 points`,
  );
  // A cashier cannot write the points of a sale.
  const forged = await call('rahim', 'PATCH', `/api/v1/models/pos.order/${sale}`, {
    loyaltyPoints: 9999,
  });
  expect(forged.status).toBeGreaterThanOrEqual(400);
  expect(await pointsOn(sale)).toBe(10);
});

test('goods that come back give back their share of the points, and all of them once everything is back', async () => {
  const sale = await sell('4', { partner: ids['rina'] });
  await drain();
  expect((await card()).points).toBe(20);
  const back = async (quantity: string) => {
    const refund = await call('rahim', 'POST', `/api/v1/counter/orders/${sale}/refund`, {
      session: ids['session'],
      reason: 'Broken seal',
      lines: [{ product: ids['tea'], quantity }],
    });
    expect(refund.status, JSON.stringify(refund.json)).toBe(201);
    await drain();
    return refund.json.order.id as number;
  };
  // One pack of four: a quarter of ten points, rounded — three.
  const one = await back('1');
  expect(await pointsOn(one)).toBe(-3);
  expect((await card()).points).toBe(17);
  // The event read again takes nothing more.
  await drain();
  expect((await card()).points).toBe(17);
  // The other three: everything is back, so the seven that were left of the sale's ten.
  const rest = await back('3');
  expect(await pointsOn(rest)).toBe(-7);
  expect((await card()).points).toBe(10);
  // The ledger says what happened, each line about its own sale.
  const ledger = await call(
    'maria',
    'GET',
    '/api/v1/models/loyalty.entry?fields=kind,points,resModel,resId&order=id',
  );
  expect(
    (ledger.json.items as Json[])
      .filter((e) => e.resId === sale || e.resId === one || e.resId === rest)
      .map((e) => [e.kind, e.points, e.resModel]),
  ).toEqual([
    ['earn', 10, 'pos.order'],
    ['reverse', -3, 'pos.order'],
    ['reverse', -7, 'pos.order'],
  ]);
});

test('a customer with prices of their own: the till is told, shows them, and the sale charges them', async () => {
  const list = await make('product.pricelist', {
    name: 'Wholesale',
    rules: { create: [{ appliesTo: 'all', compute: 'discount', discount: '20' }] },
  });
  await make('res.partner', {
    name: 'Meghna Stores',
    email: 'meghna@example.com',
    pricelist: list,
  });
  const found = await find('rahim', 'meghna@example.com');
  expect(found.status, JSON.stringify(found.json)).toBe(200);
  expect(found.json.customer).toMatchObject({ name: 'Meghna Stores', ownPrices: true });
  const priceOf = async (partner?: number) => {
    const catalogue = await call(
      'rahim',
      'GET',
      `/api/v1/counter/catalogue?shop=${ids['shop']}${partner === undefined ? '' : `&partner=${partner}`}`,
    );
    expect(catalogue.status, JSON.stringify(catalogue.json)).toBe(200);
    return Number((catalogue.json.products as Json[]).find((p) => p.id === ids['tea']).price);
  };
  // Everybody's price, a customer without a list, and theirs.
  expect(await priceOf()).toBe(250);
  expect(await priceOf(ids['rina'])).toBe(250);
  expect(await priceOf(found.json.customer.partner)).toBe(200);
  // What the till showed is what the sale charges: 200 covers it, with no change to give.
  const sold = await call('rahim', 'POST', '/api/v1/counter/orders', {
    session: ids['session'],
    partner: found.json.customer.partner,
    lines: [{ product: ids['tea'], quantity: '1' }],
    payments: [{ method: ids['cash'], amount: '200' }],
  });
  expect(sold.status, JSON.stringify(sold.json)).toBe(201);
  expect([Number(sold.json.order.total), Number(sold.json.order.change)]).toEqual([200, 0]);
  // And it earns on what was paid: two points, on a card of their own.
  await drain();
  expect(await pointsOn(sold.json.order.id)).toBe(2);
});
