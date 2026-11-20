/**
 * Loyalty on real PostgreSQL with Sales (RFC 0034 §2.6): a program is previewed on past orders before it runs —
 * nothing is earned by looking —; launched, a confirmed order earns once on the customer's card, a cancelled one
 * gives the points back once; points earned lately make a tier that multiplies the next order; old points expire,
 * once; adjustments by hand never take a card below zero; one program runs at a time; who may do what.
 */
import { type TestInstallation, testInstallation } from '@kosh/server/testing';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { ageCards, loyaltyModule, loyaltyWorkers } from '../src/index.js';

const P = '/api/v1/models/loyalty.program';
const C = '/api/v1/models/loyalty.card';
const E = '/api/v1/models/loyalty.entry';
const O = '/api/v1/models/sale.order';
let erp: TestInstallation;
let drain: () => Promise<void>;
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
const day = (offset: number): string =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
/** A confirmed order of a customer: so much rice, so much tea, on a day. */
const sell = async (customer: string, rice: string, tea: string, date = day(0)) => {
  const lines = [];
  if (rice !== '0')
    lines.push({ product: ids['rice'], name: 'Rice', quantity: '1', priceUnit: rice });
  if (tea !== '0') lines.push({ product: ids['tea'], name: 'Tea', quantity: '1', priceUnit: tea });
  const id = await make('sale.order', 'rahim', {
    partner: ids[customer],
    currency: ids['currency'],
    dateOrder: date,
    lines: { create: lines },
  });
  expect((await call('POST', `${O}/${id}/transitions/confirm`, 'rahim')).status).toBe(200);
  await drain();
  return id;
};
/** A customer's card, as a Loyalty user reads it. */
const cardOf = async (customer: string) => {
  const [card] = (
    await call(
      'GET',
      `${C}?filter=${filter({ partner: ids[customer] })}&fields=code,points,earned,tier`,
      'lina',
    )
  ).json.items as Json[];
  if (card === undefined) return null;
  const tier = card.tier?.id ?? card.tier ?? null;
  return {
    id: card.id as number,
    code: card.code as string,
    points: card.points,
    earned: card.earned,
    tier:
      tier === null
        ? null
        : ((await call('GET', `/api/v1/models/loyalty.tier/${tier}?fields=name`, 'lina')).json
            .name as string),
  };
};
const ledger = async (card: number) =>
  (
    await erp.host.server.driver.query<{ kind: string; points: number }>({
      text: 'SELECT kind, points FROM loyalty_entry WHERE card_id = $1 ORDER BY id',
      params: [card],
    })
  ).map((e) => `${e.kind} ${e.points}`);

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  erp = await testInstallation({
    modules: [loyaltyModule({ workers: false })],
    users: {
      mona: ['loyalty.manager', 'sales.manager', 'product.manager', 'contacts.manager'],
      lina: ['loyalty.user'],
      rahim: ['sales.user'],
      bob: ['base.user'],
    },
    company: { name: 'Padma Traders', currency: 'BDT' },
  });
  const workers = loyaltyWorkers({ shutro: erp.host.server.shutro });
  drain = async () => {
    for (const w of workers) await w.drain();
  };
  const [currency] = await erp.host.server.driver.query<{ id: number }>({
    text: `SELECT id FROM res_currency WHERE name = 'BDT' LIMIT 1`,
    params: [],
  });
  ids['currency'] = Number(currency?.id);
  ids['drinks'] = await make('product.category', 'mona', { name: 'Drinks' });
  ids['rice'] = await make('product.product', 'mona', { name: 'Rice', listPrice: '100' });
  ids['tea'] = await make('product.product', 'mona', {
    name: 'Tea',
    listPrice: '100',
    category: ids['drinks'],
  });
  ids['rupali'] = await make('res.partner', 'mona', { name: 'Rupali Stores' });
  ids['shapla'] = await make('res.partner', 'mona', { name: 'Shapla Enterprise' });
}, 300_000);

afterAll(async () => {
  await erp?.close();
});

test('a program is previewed on past orders before it runs: nothing is earned by looking', async () => {
  // Three orders this month, before any program: 1,250 + 380.50, 90, and 4,000.
  ids['first'] = await sell('rupali', '1250', '380.50');
  await sell('shapla', '0', '90');
  await sell('shapla', '4000', '0');
  expect((await call('POST', P, 'lina', { name: 'Not mine to write' })).status).toBe(403);
  const id = await make('loyalty.program', 'mona', {
    name: 'Padma Rewards',
    pointValue: '0.50',
    expireMonths: 12,
    previewFrom: day(-1),
    previewTo: day(1),
    tiers: { create: [{ name: 'Silver', minPoints: 50, multiplier: '1.5' }] },
  });
  // Without a rule it does not run; with none it previews to nothing.
  expect((await call('POST', `${P}/${id}/transitions/launch`, 'mona')).status).toBe(409);
  await make('loyalty.rule', 'mona', { program: id, name: 'A point for every 100', points: 1 });
  await make('loyalty.rule', 'mona', {
    program: id,
    name: 'Drinks: three more',
    points: 3,
    category: ids['drinks'],
  });
  const looked = await call('POST', `${P}/${id}/transitions/look`, 'mona');
  expect(looked.status, JSON.stringify(looked.json)).toBe(200);
  const p = (
    await call(
      'GET',
      `${P}/${id}?fields=state,previewOrders,previewEarning,previewPoints,previewRevenue,previewCost,previewShare`,
      'mona',
    )
  ).json as Json;
  // 16 + 9 and 40 points on 5,720.50 of sales; at 0.50 a point: 32.50, or 0.57 %.
  expect([
    p.state,
    p.previewOrders,
    p.previewEarning,
    p.previewPoints,
    Number(p.previewRevenue),
    Number(p.previewCost),
    Number(p.previewShare),
  ]).toEqual(['draft', 3, 2, 65, 5720.5, 32.5, 0.57]);
  // Looking gave nobody a card or a point.
  expect((await call('GET', C, 'lina')).json.items).toEqual([]);
  expect((await call('PATCH', `${P}/${id}`, 'mona', { previewPoints: 1 })).status).toBe(403);
  ids['program'] = id;
});

test('launched: a confirmed order earns once; a cancelled one gives the points back once', async () => {
  expect((await call('POST', `${P}/${ids['program']}/transitions/launch`, 'lina')).status).toBe(
    403,
  );
  expect((await call('POST', `${P}/${ids['program']}/transitions/launch`, 'mona')).status).toBe(
    200,
  );
  // One program runs at a time; a running one is not previewed.
  const second = await make('loyalty.program', 'mona', {
    name: 'Another',
    rules: { create: [{ name: 'Two for every 100', points: 2 }] },
  });
  expect((await call('POST', `${P}/${second}/transitions/launch`, 'mona')).status).toBe(409);
  expect((await call('POST', `${P}/${ids['program']}/transitions/look`, 'mona')).status).toBe(409);
  // Orders confirmed before the launch earned nothing.
  expect(await cardOf('rupali')).toBeNull();

  // 1,250 of rice and 380.50 of tea: 16 for the order and 9 for the drinks.
  const order = await sell('rupali', '1250', '380.50');
  const card = await cardOf('rupali');
  expect(card).toMatchObject({ points: 25, earned: 25, tier: null });
  expect(card?.code).toMatch(/^LC\d{7}$/);
  expect(
    (await call('GET', `${O}/${order}?fields=loyaltyPoints`, 'rahim')).json.loyaltyPoints,
  ).toBe(25);
  // Asked again (a retry, a second server): nothing more.
  await drain();
  expect(await ledger(card?.id as number)).toEqual(['earn 25']);
  // Cancelled: taken back, once.
  expect((await call('POST', `${O}/${order}/transitions/cancel`, 'rahim')).status).toBe(200);
  await drain();
  await drain();
  expect(await ledger(card?.id as number)).toEqual(['earn 25', 'reverse -25']);
  expect(await cardOf('rupali')).toMatchObject({ points: 0, earned: 0 });
  // An order worth less than a hundred earns nothing, and writes nothing.
  await sell('rupali', '99', '0');
  expect(await ledger(card?.id as number)).toHaveLength(2);
  ids['card'] = card?.id as number;
});

test('points earned lately make a tier, and the tier multiplies the next order', async () => {
  // 5,000 of rice: fifty points — Silver from here on.
  await sell('rupali', '5000', '0');
  expect(await cardOf('rupali')).toMatchObject({ points: 50, earned: 50, tier: 'Silver' });
  // The next 1,000 earns ten, one and a half times.
  await sell('rupali', '1000', '0');
  expect(await cardOf('rupali')).toMatchObject({ points: 65, earned: 65 });
  expect((await ledger(ids['card'] as number)).slice(-2)).toEqual(['earn 50', 'earn 15']);
});

test('adjustments by hand: given by a manager, never below zero, never changed', async () => {
  const given = await call('POST', E, 'mona', {
    card: ids['card'],
    points: 100,
    note: 'From the old card',
  });
  expect(given.status, JSON.stringify(given.json)).toBe(201);
  expect((await call('GET', `${E}/${given.json.id}?fields=kind`, 'mona')).json.kind).toBe('adjust');
  // Not as earned points; not by a user; not more than the card holds; not changed or deleted.
  expect(
    (await call('POST', E, 'mona', { card: ids['card'], points: 5, kind: 'earn' })).status,
  ).toBe(403);
  expect((await call('POST', E, 'lina', { card: ids['card'], points: 5 })).status).toBe(403);
  expect(
    (await call('POST', E, 'mona', { card: ids['card'], points: -1000 })).status,
  ).toBeGreaterThanOrEqual(400);
  expect((await call('PATCH', `${E}/${given.json.id}`, 'mona', { points: 1 })).status).toBe(403);
  expect((await call('DELETE', `${E}/${given.json.id}`, 'mona')).status).toBe(403);
  expect((await call('PATCH', `${C}/${ids['card']}`, 'mona', { points: 9999 })).status).toBe(403);
  // A customer has one card of a program.
  expect(
    (await call('POST', C, 'lina', { program: ids['program'], partner: ids['rupali'] })).status,
  ).toBeGreaterThanOrEqual(400);
  // Someone without the app reads no card.
  expect((await call('GET', C, 'bob')).status).toBe(403);
});

test('old points expire, the oldest first, once', async () => {
  // Shapla was given 200 points fourteen months ago and 80 a month ago, and spent nothing.
  const card = await make('loyalty.card', 'lina', {
    program: ids['program'],
    partner: ids['shapla'],
  });
  for (const [date, points] of [
    [day(-430), 200],
    [day(-30), 80],
  ] as const)
    await make('loyalty.entry', 'mona', { card, date, points, note: 'Opening' });
  const run = () =>
    erp.host.server.shutro.bootstrap({ reason: 'test', company: erp.company }, (env) =>
      ageCards(env as never),
    );
  // After twelve months: the 200 are lost; the 80 stay.
  expect(await run()).toBe(200);
  expect(await ledger(card)).toEqual(['adjust 200', 'adjust 80', 'expire -200']);
  expect(await cardOf('shapla')).toMatchObject({ points: 80 });
  // Again the same day: nothing more.
  expect(await run()).toBe(0);
  expect(await ledger(card)).toHaveLength(3);
  // By hand, for managers only.
  expect((await call('POST', '/api/v1/loyalty/age', 'lina')).status).toBe(403);
  const byHand = await call('POST', '/api/v1/loyalty/age', 'mona');
  expect([byHand.status, byHand.json.expired]).toEqual([200, 0]);
});

test('an ended program gives nothing more; cards keep their points', async () => {
  expect((await call('POST', `${P}/${ids['program']}/transitions/finish`, 'mona')).status).toBe(
    200,
  );
  const before = await cardOf('rupali');
  await sell('rupali', '3000', '0');
  expect(await cardOf('rupali')).toEqual(before);
});

const V = '/api/v1/models/loyalty.voucher';
/** A draft quotation of a customer for so much rice. */
const quote = async (customer: string, rice: string, more: Record<string, unknown> = {}) =>
  make('sale.order', 'rahim', {
    partner: ids[customer],
    currency: ids['currency'],
    lines: { create: [{ product: ids['rice'], name: 'Rice', quantity: '1', priceUnit: rice }] },
    ...more,
  });
const total = async (order: number) =>
  Number(
    ((await call('GET', `${O}/${order}?fields=amountTotal`, 'rahim')).json.amountTotal?.amount ??
      (await call('GET', `${O}/${order}?fields=amountTotal`, 'rahim')).json.amountTotal) as string,
  );
const credit = (order: number) => call('POST', `${O}/${order}/transitions/credit`, 'rahim');

test('points are spent on a quotation: held at once, limited, and given back when it is cancelled', async () => {
  // A new program: a point is worth 2.00, and points pay at most half an order.
  const program = await make('loyalty.program', 'mona', {
    name: 'Rewards with spending',
    pointValue: '2',
    redeemMaxPercent: 50,
    redeemMinPoints: 10,
    rules: { create: [{ name: 'A point for every 100', points: 1 }] },
  });
  expect((await call('POST', `${P}/${program}/transitions/launch`, 'mona')).status).toBe(200);
  ids['spending'] = program;
  const card = await make('loyalty.card', 'lina', { program, partner: ids['rupali'] });
  await make('loyalty.entry', 'mona', { card, points: 300, note: 'Opening' });
  const order = await quote('rupali', '1000', { loyaltyRedeem: 400 });
  // More than the card holds, more than half the order (250 points), fewer than ten: refused, in words.
  const tooMany = await credit(order);
  expect(tooMany.status).toBe(422);
  expect(JSON.stringify(tooMany.json)).toContain('Only 250 point(s)');
  expect((await call('PATCH', `${O}/${order}`, 'rahim', { loyaltyRedeem: 5 })).status).toBe(200);
  expect(JSON.stringify((await credit(order)).json)).toContain('from 10 at a time');
  // A hundred points: 200.00 off, and off the card at once.
  expect((await call('PATCH', `${O}/${order}`, 'rahim', { loyaltyRedeem: 100 })).status).toBe(200);
  const applied = await credit(order);
  expect(applied.status, JSON.stringify(applied.json)).toBe(200);
  expect(await total(order)).toBe(800);
  expect(
    (await call('GET', `${O}/${order}?fields=loyaltyRedeemed`, 'rahim')).json.loyaltyRedeemed,
  ).toBe(100);
  expect(await ledger(card)).toEqual(['adjust 300', 'redeem -100']);
  // Changed to 150: what was held is given back first — never both.
  expect((await call('PATCH', `${O}/${order}`, 'rahim', { loyaltyRedeem: 150 })).status).toBe(200);
  expect((await credit(order)).status).toBe(200);
  expect(await total(order)).toBe(700);
  expect(await ledger(card)).toEqual(['adjust 300', 'redeem -100', 'refund 100', 'redeem -150']);
  // Another quotation cannot spend what this one holds.
  const other = await quote('rupali', '1000', { loyaltyRedeem: 200 });
  expect(JSON.stringify((await credit(other)).json)).toContain('the card holds 150');
  // What is spent is the server's to say.
  expect((await call('PATCH', `${O}/${order}`, 'rahim', { loyaltyRedeemed: 0 })).status).toBe(403);
  // Confirmed: it earns on what is left to pay — 700 — and keeps what it spent.
  expect((await call('POST', `${O}/${order}/transitions/confirm`, 'rahim')).status).toBe(200);
  await drain();
  expect((await ledger(card)).slice(-1)).toEqual(['earn 7']);
  // Cancelled: the points spent come back, and the points earned go, once each.
  expect((await call('POST', `${O}/${order}/transitions/cancel`, 'rahim')).status).toBe(200);
  await drain();
  await drain();
  expect((await ledger(card)).slice(-2).sort()).toEqual(['refund 150', 'reverse -7']);
  expect(
    (
      await erp.host.server.driver.query<{ n: string }>({
        text: 'SELECT coalesce(sum(points), 0)::text AS n FROM loyalty_entry WHERE card_id = $1',
        params: [card],
      })
    )[0]?.n,
  ).toBe('300');
});

test('a gift card and a wallet pay what an order comes to, or all they hold', async () => {
  // A gift card of 500.00 and a wallet of Shapla's with 2,000.00.
  const gift = await make('loyalty.voucher', 'mona', {
    entries: { create: [{ amount: '500', note: 'Sold at the counter' }] },
  });
  const wallet = await make('loyalty.voucher', 'mona', {
    kind: 'wallet',
    partner: ids['shapla'],
    entries: { create: [{ amount: '2000', note: 'A refund kept as credit' }] },
  });
  const read = async (id: number) =>
    (await call('GET', `${V}/${id}?fields=code,balance`, 'lina')).json as Json;
  const g = await read(gift);
  expect(g.code).toMatch(/^GC-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  expect(Number(g.balance)).toBe(500);
  // A wallet needs its customer; the code is the server's; a user loads nothing.
  expect((await call('POST', V, 'mona', { kind: 'wallet' })).status).toBeGreaterThanOrEqual(400);
  expect((await call('PATCH', `${V}/${gift}`, 'mona', { code: 'GC-MINE' })).status).toBe(403);
  expect(
    (
      await call('POST', '/api/v1/models/loyalty.voucher.entry', 'lina', {
        voucher: gift,
        amount: '50',
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await call('POST', '/api/v1/models/loyalty.voucher.entry', 'mona', {
        voucher: gift,
        amount: '-9000',
      })
    ).status,
  ).toBeGreaterThanOrEqual(400);

  // An order of 300: the gift card pays it all and keeps 200.
  const small = await quote('rupali', '300', { voucherCode: g.code.toLowerCase() });
  expect((await credit(small)).status).toBe(200);
  expect(await total(small)).toBe(0);
  expect(Number((await read(gift)).balance)).toBe(200);
  // An order of 1,000: the 200 left, and 800 still to pay.
  const big = await quote('rupali', '1000', { voucherCode: g.code });
  expect((await credit(big)).status).toBe(200);
  expect(await total(big)).toBe(800);
  expect(Number((await read(gift)).balance)).toBe(0);
  // Empty now; a code that is nobody's; another customer's wallet.
  const third = await quote('rupali', '100', { voucherCode: g.code });
  expect(JSON.stringify((await credit(third)).json)).toContain('holds nothing');
  expect((await call('PATCH', `${O}/${third}`, 'rahim', { voucherCode: 'GC-NOPE' })).status).toBe(
    200,
  );
  expect(JSON.stringify((await credit(third)).json)).toContain('No gift card or wallet');
  const w = await read(wallet);
  expect((await call('PATCH', `${O}/${third}`, 'rahim', { voucherCode: w.code })).status).toBe(200);
  expect(JSON.stringify((await credit(third)).json)).toContain('another customer');
  // Its owner's order: paid from the wallet.
  const own = await quote('shapla', '750', { voucherCode: w.code });
  expect((await credit(own)).status).toBe(200);
  expect(await total(own)).toBe(0);
  expect(Number((await read(wallet)).balance)).toBe(1250);
  // The first order cancelled: its 300 are back on the gift card, once.
  expect((await call('POST', `${O}/${small}/transitions/cancel`, 'rahim')).status).toBe(200);
  await drain();
  await drain();
  expect(Number((await read(gift)).balance)).toBe(300);
  // An expired card pays nothing.
  expect((await call('PATCH', `${V}/${gift}`, 'mona', { dateExpiry: day(-1) })).status).toBe(200);
  const late = await quote('rupali', '100', { voucherCode: g.code });
  expect(JSON.stringify((await credit(late)).json)).toContain('valid until');
});
