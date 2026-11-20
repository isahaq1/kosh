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
