/**
 * Gift cards sold as a product on real PostgreSQL (RFC 0034 §2.6): a confirmed order makes one card per unit,
 * loaded with what the unit was sold for, valid for the product's months — once —, and emails their codes to the
 * customer once, in their language; promotions leave a gift card at what it is worth; the card then pays an
 * order like any other; a cancelled order's cards pay nothing more, what was spent stays spent; who may sell
 * them and who reads their codes.
 */
import { createMemoryMailer } from '@kosh/mail';
import { type TestInstallation, testInstallation } from '@kosh/server/testing';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { loyaltyModule, loyaltyWorkers } from '../src/index.js';

const O = '/api/v1/models/sale.order';
const V = '/api/v1/models/loyalty.voucher';
let erp: TestInstallation;
let drain: () => Promise<void>;
const mailer = createMemoryMailer();
const ids: Record<string, number> = {};

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
const call = async (
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  as: string,
  body?: unknown,
) => {
  const res = await erp.call(method, url, as, body);
  return { status: res.status, json: res.json as Json };
};
const make = async (model: string, as: string, values: Record<string, unknown>) => {
  const made = await call('POST', `/api/v1/models/${model}`, as, values);
  expect(made.status, `${model}: ${JSON.stringify(made.json)}`).toBe(201);
  return made.json.id as number;
};
const filter = (where: Record<string, unknown>) => encodeURIComponent(JSON.stringify(where));
const order = async (customer: string, lines: Record<string, unknown>[]) =>
  make('sale.order', 'rahim', {
    partner: ids[customer],
    currency: ids['currency'],
    lines: { create: lines },
  });
const confirm = async (id: number) => {
  expect((await call('POST', `${O}/${id}/transitions/confirm`, 'rahim')).status).toBe(200);
  await drain();
};
const cardsOf = async (sale: number): Promise<Json[]> =>
  (
    await call(
      'GET',
      `${V}?filter=${filter({ soldOn: sale })}&fields=code,balance,dateExpiry,kind,partner,note&order=id`,
      'lina',
    )
  ).json.items as Json[];
const monthsAhead = (months: number): string => {
  const d = new Date();
  const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(d.getUTCDate(), last));
  return first.toISOString().slice(0, 10);
};

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  erp = await testInstallation({
    modules: [loyaltyModule({ workers: false, mailer })],
    users: {
      mona: ['loyalty.manager', 'sales.manager', 'product.manager', 'contacts.manager'],
      lina: ['loyalty.user'],
      rahim: ['sales.user'],
      bob: ['base.user'],
    },
    company: { name: 'Padma Traders', currency: 'BDT' },
  });
  const workers = loyaltyWorkers({ shutro: erp.host.server.shutro }, { mailer });
  drain = async () => {
    for (const w of workers) await w.drain();
  };
  const [currency] = await erp.host.server.driver.query<{ id: number }>({
    text: `SELECT id FROM res_currency WHERE name = 'BDT' LIMIT 1`,
    params: [],
  });
  ids['currency'] = Number(currency?.id);
  ids['rice'] = await make('product.product', 'mona', { name: 'Rice', listPrice: '1000' });
  ids['card'] = await make('product.product', 'mona', {
    name: 'Gift card 500',
    listPrice: '500',
    kind: 'service',
    giftCard: true,
    giftCardMonths: 12,
  });
  ids['rina'] = await make('res.partner', 'mona', {
    name: 'Rina Akter',
    email: 'rina@example.com',
  });
  ids['karim'] = await make('res.partner', 'mona', {
    name: 'করিম উদ্দিন',
    email: 'karim@example.com',
    lang: 'bn',
  });
  ids['nobody'] = await make('res.partner', 'mona', { name: 'No Email' });
  // Ten per cent off everything, running.
  const promo = await make('loyalty.promotion', 'mona', {
    name: 'Ten per cent off',
    kind: 'percent',
    value: '10',
  });
  expect(
    (await call('POST', `/api/v1/models/loyalty.promotion/${promo}/transitions/launch`, 'mona'))
      .status,
  ).toBe(200);
}, 300_000);

afterAll(async () => {
  await erp?.close();
});

test('a confirmed order makes one card per unit, once, and emails the codes once', async () => {
  const sale = await order('rina', [
    { product: ids['card'], name: 'Gift card 500', quantity: '2', priceUnit: '500' },
    { product: ids['rice'], name: 'Rice', quantity: '1', priceUnit: '1000' },
  ]);
  // A quotation sells nothing yet.
  await drain();
  expect(await cardsOf(sale)).toEqual([]);
  await confirm(sale);
  const cards = await cardsOf(sale);
  expect(cards).toHaveLength(2);
  expect(cards.map((c) => [c.kind, Number(c.balance), c.dateExpiry])).toEqual([
    ['gift_card', 500, monthsAhead(12)],
    ['gift_card', 500, monthsAhead(12)],
  ]);
  expect(new Set(cards.map((c) => c.code)).size).toBe(2);
  expect(cards[0].partner?.id ?? cards[0].partner).toBe(ids['rina']);
  // The event read again, and the function called again: the same two cards, the same one email.
  await drain();
  await erp.host.server.shutro.bootstrap({ reason: 'test', company: erp.company }, async (env) => {
    const { issueGiftCards } = await import('../src/index.js');
    expect(await issueGiftCards(env as never, sale)).toHaveLength(2);
  });
  expect(await cardsOf(sale)).toHaveLength(2);
  expect(mailer.sent).toHaveLength(1);
  const [mail] = mailer.sent;
  expect(mail?.to).toBe('rina@example.com');
  expect(mail?.subject).toContain('Your gift cards');
  for (const c of cards) expect(String(mail?.html)).toContain(c.code);
  expect(String(mail?.html)).toContain('500.00 BDT');
  expect(String(mail?.html)).toContain(`valid until ${monthsAhead(12)}`);
  // The rice earned nothing here (no program runs); the order is marked as told.
  const told = await call('GET', `${O}/${sale}?fields=giftCardsSentAt`, 'rahim');
  expect(told.json.giftCardsSentAt).not.toBeNull();
});

test('promotions leave a gift card at what it is worth; a discounted card holds what was paid', async () => {
  const sale = await order('karim', [
    { product: ids['card'], name: 'Gift card 500', quantity: '1', priceUnit: '500' },
    { product: ids['rice'], name: 'Rice', quantity: '1', priceUnit: '1000' },
  ]);
  expect((await call('POST', `${O}/${sale}/transitions/promote`, 'rahim')).status).toBe(200);
  // Ten per cent of the rice only: 100, not 150.
  const promoted = await call('GET', `${O}/${sale}?fields=promotionAmount,amountUntaxed`, 'rahim');
  expect(Number(promoted.json.promotionAmount)).toBe(100);
  await confirm(sale);
  expect((await cardsOf(sale)).map((c) => Number(c.balance))).toEqual([500]);
  // In the customer's language.
  const mail = mailer.sent.at(-1);
  expect(mail?.to).toBe('karim@example.com');
  expect(mail?.subject).toContain('আপনার গিফট কার্ড');
  // Sold by hand at 20 % off, three of them, with a part of a unit typed: three cards of 400 — what was paid.
  const cheap = await order('nobody', [
    {
      product: ids['card'],
      name: 'Gift card 500',
      quantity: '3.5',
      priceUnit: '500',
      discount: '20',
    },
  ]);
  const before = mailer.sent.length;
  await confirm(cheap);
  const cards = await cardsOf(cheap);
  expect(cards.map((c) => Number(c.balance))).toEqual([466.66, 466.66, 466.66]);
  // Nobody to write to: no email, the codes are read on the order's tile.
  expect(mailer.sent).toHaveLength(before);
});

test('a card that was sold pays an order; a cancelled order’s cards pay nothing more', async () => {
  const sale = await order('rina', [
    { product: ids['card'], name: 'Gift card 500', quantity: '2', priceUnit: '500' },
  ]);
  await confirm(sale);
  const [first, second] = await cardsOf(sale);
  // The first pays 300 of another order.
  const spent = await order('karim', [
    { product: ids['rice'], name: 'Rice', quantity: '1', priceUnit: '300' },
  ]);
  expect((await call('PATCH', `${O}/${spent}`, 'rahim', { voucherCode: first.code })).status).toBe(
    200,
  );
  expect((await call('POST', `${O}/${spent}/transitions/credit`, 'rahim')).status).toBe(200);
  const balance = async (id: number) =>
    Number((await call('GET', `${V}/${id}?fields=balance`, 'lina')).json.balance);
  expect(await balance(first.id)).toBe(200);
  // The order the cards were sold on is cancelled: what they still hold is taken off, once.
  expect((await call('POST', `${O}/${sale}/transitions/cancel`, 'rahim')).status).toBe(200);
  await drain();
  await drain();
  expect([await balance(first.id), await balance(second.id)]).toEqual([0, 0]);
  // What was spent stays spent: the other order keeps its 300.
  expect(
    Number((await call('GET', `${O}/${spent}?fields=voucherUsed`, 'rahim')).json.voucherUsed),
  ).toBe(300);
  // An empty card pays nothing.
  const late = await order('karim', [
    { product: ids['rice'], name: 'Rice', quantity: '1', priceUnit: '300' },
  ]);
  await call('PATCH', `${O}/${late}`, 'rahim', { voucherCode: second.code });
  const refused = await call('POST', `${O}/${late}/transitions/credit`, 'rahim');
  expect(refused.status).toBeGreaterThanOrEqual(400);
  expect(JSON.stringify(refused.json)).toContain('It holds nothing');
});

test('who says a product is a gift card, who reads the codes, and what nobody writes', async () => {
  // A salesperson does not make products gift cards.
  expect(
    (
      await call('PATCH', `/api/v1/models/product.product/${ids['rice']}`, 'rahim', {
        giftCard: true,
      })
    ).status,
  ).toBe(403);
  // Valid for a number of months that makes sense.
  expect(
    (
      await call('PATCH', `/api/v1/models/product.product/${ids['card']}`, 'mona', {
        giftCardMonths: 0,
      })
    ).status,
  ).toBeGreaterThanOrEqual(400);
  // Without a role of Loyalty, no codes.
  expect((await call('GET', `${V}?fields=code`, 'bob')).status).toBe(403);
  const [card] = (await call('GET', `${V}?fields=code,soldOn&limit=1`, 'lina')).json
    .items as Json[];
  // Where a card was sold is the server's to say, and so is that the codes were sent.
  expect(
    (await call('PATCH', `${V}/${card.id}`, 'mona', { soldOn: null, soldLine: 1 })).status,
  ).toBeGreaterThanOrEqual(400);
  const sale = card.soldOn?.id ?? card.soldOn;
  expect(
    (await call('PATCH', `${O}/${sale}`, 'rahim', { giftCardsSentAt: null })).status,
  ).toBeGreaterThanOrEqual(400);
});
