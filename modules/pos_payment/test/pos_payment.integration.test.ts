/**
 * Payment providers at the Counter on real PostgreSQL (RFC 0021, Counter step 4), with the test provider: a method
 * given a provider is paid on the provider's page from a QR code; the sale counts the money only once the provider
 * confirmed it, for the amount asked, in the cashier's own session, and for one sale; a declined payment pays
 * nothing; the session's entry books it in the provider's journal and no payment of Accounting's is registered;
 * who may ask and follow a payment.
 */
import { type TestInstallation, testInstallation } from '@kosh/server/testing';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { PAID_PATH, posPayment } from '../src/index.js';

let erp: TestInstallation;
const ids: Record<string, number> = {};

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
/** The till asks the provider for a payment. */
const ask = (as: string, session: number, method: number, amount: string) =>
  call(as, 'POST', '/api/v1/counter/payments', { session, method, amount });
const follow = (as: string, session: number, reference: string) =>
  call(as, 'GET', `/api/v1/counter/payments/${reference}?session=${session}`);
/** The customer, on the provider's page: no session at all. */
const customer = async (url: string, outcome: 'paid' | 'declined') => {
  const path = new URL(url).pathname;
  const page = await erp.host.server.app.inject({ method: 'GET', url: path });
  expect(page.statusCode).toBe(200);
  const res = await erp.host.server.app.inject({
    method: 'POST',
    url: `${path}?outcome=${outcome}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: '',
  });
  // The provider sends them back to the server, which sends them on to where the payment was asked from.
  const back = await erp.host.server.app.inject({
    method: 'GET',
    url: new URL(String(res.headers.location ?? ''), 'http://localhost:3000').pathname,
  });
  return String(back.headers.location ?? '');
};
const sell = (as: string, session: number, payments: Record<string, unknown>[], quantity = '1') =>
  call(as, 'POST', '/api/v1/counter/orders', {
    session,
    lines: [{ product: ids['tea'], quantity }],
    payments,
  });
/** A payment asked for and paid by the customer. */
const paid = async (amount: string): Promise<string> => {
  const asked = await ask('rahim', ids['session'] as number, ids['bkash'] as number, amount);
  expect(asked.status, JSON.stringify(asked.json)).toBe(201);
  await customer(asked.json.url, 'paid');
  return asked.json.reference as string;
};

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  erp = await testInstallation({
    modules: [posPayment],
    users: {
      maria: ['pos.manager', 'product.manager', 'account.manager'],
      rahim: ['pos.cashier'],
      sam: ['pos.cashier'],
      nadia: ['account.user'],
    },
    company: { name: 'Padma Traders', currency: 'BDT' },
  });
  expect(
    (await call('maria', 'POST', '/api/v1/accounting/charts/install', { template: 'generic' }))
      .status,
  ).toBe(200);
  const journals = (
    await call('maria', 'GET', '/api/v1/models/account.journal?fields=id,code,type')
  ).json.items as { id: number; code: string; type: string }[];
  ids['bank'] = journals.find((j) => j.type === 'bank')?.id as number;
  ids['cashJournal'] = journals.find((j) => j.type === 'cash')?.id as number;
  ids['sales'] = journals.find((j) => j.type === 'sale')?.id as number;
  ids['provider'] = await make('payment.provider', {
    name: 'Test payments',
    code: 'fake',
    journal: ids['bank'],
  });
  ids['tea'] = await make('product.product', { name: 'Tea 500 g', listPrice: '250' });
  ids['shop'] = await make('pos.shop', {
    name: 'Padma Shop',
    pricesIncludeTax: true,
    salesJournal: ids['sales'],
    methods: {
      create: [
        { name: 'Cash', kind: 'cash', sequence: 1, journal: ids['cashJournal'] },
        {
          name: 'bKash',
          kind: 'mobile',
          sequence: 2,
          provider: ids['provider'],
          journal: ids['bank'],
        },
      ],
    },
  });
  const shops = await call('rahim', 'GET', '/api/v1/counter/shops');
  for (const m of shops.json.shops[0].methods as Json[]) ids[m.name.toLowerCase()] = m.id;
  for (const who of ['rahim', 'sam']) {
    const opened = await call(who, 'POST', '/api/v1/counter/sessions', {
      shop: ids['shop'],
      openingCash: '1000',
    });
    expect(opened.status, JSON.stringify(opened.json)).toBe(201);
    ids[who === 'rahim' ? 'session' : 'other'] = opened.json.session.id;
  }
}, 300_000);

afterAll(async () => {
  await erp?.close();
});

test('the till knows which methods are paid through a provider; such a method books in the provider’s journal', async () => {
  const shops = await call('rahim', 'GET', '/api/v1/counter/shops');
  expect((shops.json.shops[0].methods as Json[]).map((m) => [m.name, m.kind, m.provider])).toEqual([
    ['Cash', 'cash', false],
    ['bKash', 'mobile', true],
  ]);
  // Its money arrives where the provider's does.
  const wrong = await call('maria', 'PATCH', `/api/v1/models/pos.payment.method/${ids['bkash']}`, {
    journal: ids['cashJournal'],
  });
  expect(wrong.status).toBeGreaterThanOrEqual(400);
  expect(JSON.stringify(wrong.json)).toContain('books in the provider’s journal');
  // The page the provider sends the customer back to says nothing of the payment.
  const back = await erp.host.server.app.inject({ method: 'GET', url: PAID_PATH });
  expect(back.statusCode).toBe(200);
  expect(back.body).toContain('Go back to the counter');
});

test('asked, scanned, paid, confirmed: only then does the sale count it — once', async () => {
  const session = ids['session'] as number;
  const asked = await ask('rahim', session, ids['bkash'] as number, '250');
  expect(asked.status, JSON.stringify(asked.json)).toBe(201);
  expect(asked.json.url).toMatch(/^http:\/\/localhost:3000\/api\/v1\/payment\/fake\/checkout\//);
  expect(asked.json.qr).toMatch(/^data:image\/svg\+xml;base64,/);
  const reference = asked.json.reference as string;
  expect((await follow('rahim', session, reference)).json).toMatchObject({
    state: 'pending',
    amount: '250.00',
  });
  // Typed in without the customer paying, or before the provider confirmed: the sale is not made.
  const typed = await sell('rahim', session, [{ method: ids['bkash'], amount: '250' }]);
  expect(typed.status).toBe(409);
  expect(JSON.stringify(typed.json)).toContain('ask the customer to pay first');
  const early = await sell('rahim', session, [{ method: ids['bkash'], amount: '250', reference }]);
  expect(early.status).toBe(409);
  expect(JSON.stringify(early.json)).toContain('is not confirmed yet');
  // The customer pays on the provider's page, and is sent back to "go to the counter".
  expect(await customer(asked.json.url, 'paid')).toContain(PAID_PATH);
  // The provider's callback is on its way (a job): the sale does not wait for it, it asks the provider itself.
  const sold = await sell('rahim', session, [{ method: ids['bkash'], amount: '250', reference }]);
  expect(sold.status, JSON.stringify(sold.json)).toBe(201);
  expect(sold.json.order.state).toBe('paid');
  expect((await follow('rahim', session, reference)).json.state).toBe('done');
  // The payment is this sale's; Accounting registered no payment of its own for it.
  const [tx] = (
    await call(
      'maria',
      'GET',
      `/api/v1/models/payment.transaction?fields=state,posOrder,posSession,payment&filter=${encodeURIComponent(JSON.stringify({ reference }))}`,
    )
  ).json.items as Json[];
  expect(tx).toMatchObject({ state: 'done', payment: null });
  expect(tx.posOrder?.id ?? tx.posOrder).toBe(sold.json.order.id);
  // It pays no second sale.
  const again = await sell('rahim', session, [{ method: ids['bkash'], amount: '250', reference }]);
  expect(again.status).toBe(409);
  expect(JSON.stringify(again.json)).toContain('already paid another sale');
});

test('for the amount asked: a part by the provider and the rest in cash; never more than was paid', async () => {
  const session = ids['session'] as number;
  const part = await paid('100');
  const split = await sell('rahim', session, [
    { method: ids['bkash'], amount: '100', reference: part },
    { method: ids['cash'], amount: '150' },
  ]);
  expect(split.status, JSON.stringify(split.json)).toBe(201);
  // A hundred was paid: it does not pay two hundred and fifty.
  const small = await paid('100');
  const stretched = await sell('rahim', session, [
    { method: ids['bkash'], amount: '250', reference: small },
  ]);
  expect(stretched.status).toBe(409);
  expect(JSON.stringify(stretched.json)).toContain('was a payment of 100.00, not 250.00');
  // Refused: the payment is still there to be used as it was paid.
  const honest = await sell('rahim', session, [
    { method: ids['bkash'], amount: '100', reference: small },
    { method: ids['cash'], amount: '150' },
  ]);
  expect(honest.status, JSON.stringify(honest.json)).toBe(201);
  // A reference that is none.
  const none = await sell('rahim', session, [
    { method: ids['bkash'], amount: '250', reference: 'PAY-NOPE' },
  ]);
  expect(none.status).toBe(409);
  expect(JSON.stringify(none.json)).toContain('there is no payment PAY-NOPE here');
});

test('declined pays nothing; a payment is its session’s; who may ask', async () => {
  const session = ids['session'] as number;
  const asked = await ask('rahim', session, ids['bkash'] as number, '250');
  await customer(asked.json.url, 'declined');
  expect((await follow('rahim', session, asked.json.reference)).json.state).not.toBe('done');
  expect(
    (
      await sell('rahim', session, [
        { method: ids['bkash'], amount: '250', reference: asked.json.reference },
      ])
    ).status,
  ).toBe(409);
  // Paid in Rahim's session: Sam neither follows it from his, nor sells with it.
  const mine = await paid('250');
  expect((await follow('sam', ids['other'] as number, mine)).status).toBe(404);
  expect((await follow('sam', session, mine)).status).toBe(404);
  const stolen = await sell('sam', ids['other'] as number, [
    { method: ids['bkash'], amount: '250', reference: mine },
  ]);
  expect(stolen.status).toBe(409);
  expect(JSON.stringify(stolen.json)).toContain('there is no payment');
  // Sam cannot ask in Rahim's session either; nor somebody who is not of the Counter.
  expect((await ask('sam', session, ids['bkash'] as number, '250')).status).toBe(404);
  expect(
    (await ask('nadia', session, ids['bkash'] as number, '250')).status,
  ).toBeGreaterThanOrEqual(403);
  // Cash is not asked of a provider; an amount is an amount; a method is the shop's.
  expect((await ask('rahim', session, ids['cash'] as number, '250')).status).toBe(409);
  for (const amount of ['0', '-5', 'ten', '1.999'])
    expect((await ask('rahim', session, ids['bkash'] as number, amount)).status, amount).toBe(422);
  expect((await ask('rahim', session, 999_999, '250')).status).toBe(422);
  // What a payment paid is the server's to say.
  const [tx] = (
    await call(
      'maria',
      'GET',
      `/api/v1/models/payment.transaction?fields=reference&filter=${encodeURIComponent(JSON.stringify({ reference: mine }))}`,
    )
  ).json.items as Json[];
  expect(
    (
      await call('maria', 'PATCH', `/api/v1/models/payment.transaction/${tx.id}`, {
        posOrder: null,
      })
    ).status,
  ).toBeGreaterThanOrEqual(400);
  // Rahim still sells with it.
  expect(
    (await sell('rahim', session, [{ method: ids['bkash'], amount: '250', reference: mine }]))
      .status,
  ).toBe(201);
});

test('the closed session’s entry books the provider’s money in the provider’s journal', async () => {
  const session = ids['session'] as number;
  const state = await call('rahim', 'GET', `/api/v1/counter/session?shop=${ids['shop']}`);
  const closed = await call('rahim', 'POST', `/api/v1/counter/sessions/${session}/close`, {
    closingCash: state.json.session.expectedCash,
  });
  expect(closed.status, JSON.stringify(closed.json)).toBe(200);
  const entry = (await call('maria', 'GET', `/api/v1/models/pos.session/${session}?fields=entry`))
    .json.entry;
  expect(entry).not.toBeNull();
  // Four sales of 250: 700 through the provider (250, 100, 100, 250), 300 in cash.
  const lines = await erp.host.server.driver.query<{ account: string; debit: string }>({
    text: `SELECT a.code AS account, l.debit::text AS debit FROM account_move_line l
             JOIN account_account a ON a.id = l.account_id
            WHERE l.move_id = $1 AND l.debit > 0 ORDER BY l.debit DESC`,
    params: [entry?.id ?? entry],
  });
  expect(lines.map((l) => Number(l.debit))).toEqual([700, 300]);
  // No payment of Accounting's was registered for money the entry books.
  const registered = await erp.host.server.driver.query<{ n: string }>({
    text: 'SELECT count(*)::text AS n FROM payment_transaction WHERE payment_id IS NOT NULL',
    params: [],
  });
  expect(Number(registered[0]?.n)).toBe(0);
});
