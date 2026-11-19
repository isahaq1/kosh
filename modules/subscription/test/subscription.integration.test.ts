/**
 * Subscriptions on real PostgreSQL with Accounting (RFC 0034 §2.5): a started subscription is invoiced once per
 * period — asked twice, left behind, or after a crash in the middle —; a trial delays the first invoice; usage is
 * billed once, in the next invoice; a change in the middle of a period is invoiced or credited for the days left;
 * pause, resume and close with a reason; what it is worth a month; who may do what.
 */
import { type TestInstallation, testInstallation } from '@kosh/server/testing';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { applyChanges, invoiceDue, invoiceSubscription, subscription } from '../src/index.js';

const S = '/api/v1/models/subscription.subscription';
const U = '/api/v1/models/subscription.usage';
let erp: TestInstallation;
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
const system = <T>(fn: (env: never) => Promise<T>): Promise<T> =>
  erp.host.server.shutro.bootstrap({ reason: 'test', company: erp.company }, (env) =>
    fn(env as never),
  );
/** A subscription made and started by a user. */
const start = async (values: Record<string, unknown>, lines: Record<string, unknown>[]) => {
  const made = await call('POST', S, 'rafi', {
    partner: ids['customer'],
    plan: ids['monthly'],
    ...values,
    lines: { create: lines },
  });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  const begun = await call('POST', `${S}/${made.json.id}/transitions/begin`, 'rafi');
  expect(begun.status, JSON.stringify(begun.json)).toBe(200);
  return made.json.id as number;
};
/** A subscription's fields; amounts with two decimals, as money is written. */
const read = async (id: number, fields: string) => {
  const json = (await call('GET', `${S}/${id}?fields=${fields}`, 'rafi')).json as Json;
  for (const key of ['recurring', 'mrr'])
    if (json[key] !== undefined && json[key] !== null) json[key] = Number(json[key]).toFixed(2);
  return json;
};
/** A subscription's documents, oldest first: kind, period, untaxed amount, state, reference. */
const documents = async (id: number) =>
  (
    await erp.host.server.driver.query<{
      kind: string;
      period: string | null;
      untaxed: string;
      state: string;
      ref: string;
    }>({
      text: `SELECT kind, to_char(subscription_period, 'YYYY-MM-DD') AS period, amount_untaxed::text AS untaxed,
                    state, ref
               FROM account_move WHERE subscription_id = $1 ORDER BY id`,
      params: [id],
    })
  ).map((d) => ({ ...d, untaxed: Number(d.untaxed).toFixed(2) }));

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  erp = await testInstallation({
    modules: [subscription],
    users: {
      mona: ['subscription.manager', 'account.manager'],
      rafi: ['subscription.user'],
      bob: ['base.user'],
    },
    company: { name: 'Padma Traders', currency: 'BDT' },
  });
  expect(
    (await call('POST', '/api/v1/accounting/charts/install', 'mona', { template: 'generic' }))
      .status,
  ).toBe(200);
  const make = async (model: string, values: Record<string, unknown>) => {
    const made = await call('POST', `/api/v1/models/${model}`, 'mona', values);
    expect(made.status, `${model}: ${JSON.stringify(made.json)}`).toBe(201);
    return made.json.id as number;
  };
  ids['monthly'] = await make('subscription.plan', { name: 'Monthly', unit: 'month', interval: 1 });
  ids['yearly'] = await make('subscription.plan', {
    name: 'Yearly with a trial',
    unit: 'year',
    interval: 1,
    trialDays: 14,
    autoPost: true,
  });
  ids['support'] = await make('product.product', {
    name: 'Support plan',
    kind: 'service',
    listPrice: '5000',
  });
  ids['seat'] = await make('product.product', {
    name: 'Software seat',
    kind: 'service',
    listPrice: '1200',
  });
  ids['sms'] = await make('product.product', {
    name: 'SMS sent',
    kind: 'service',
    listPrice: '0.50',
  });
  ids['customer'] = await make('res.partner', { name: 'Meghna Textiles' });
}, 300_000);

afterAll(async () => {
  await erp?.close();
});

test('a subscription starts with lines, is worth so much a month, and is invoiced once per period', async () => {
  // Nothing to bill: it does not start.
  const empty = await call('POST', S, 'rafi', { partner: ids['customer'], plan: ids['monthly'] });
  expect(empty.status, JSON.stringify(empty.json)).toBe(201);
  expect((await call('POST', `${S}/${empty.json.id}/transitions/begin`, 'rafi')).status).toBe(409);

  const id = await start({ dateStart: '2027-01-31' }, [
    { product: ids['support'], quantity: '1' },
    { product: ids['seat'], quantity: '8', discount: '10' },
  ]);
  const s = await read(id, 'name,recurring,mrr,nextInvoiceDate,state');
  expect(s.name).toMatch(/^SUB\/\d{4}\/\d{5}$/);
  // 5000 + 8 × 1200 less 10 %.
  expect(s).toMatchObject({
    recurring: '13640.00',
    mrr: '13640.00',
    nextInvoiceDate: '2027-01-31',
    state: 'active',
  });

  // Not due the day before; due on the day; asked again the same day, nothing more.
  expect(await system((env) => invoiceSubscription(env, id, '2027-01-30'))).toEqual([]);
  expect(await system((env) => invoiceSubscription(env, id, '2027-01-31'))).toHaveLength(1);
  expect(await system((env) => invoiceSubscription(env, id, '2027-01-31'))).toEqual([]);
  expect(await documents(id)).toEqual([
    {
      kind: 'out_invoice',
      period: '2027-01-31',
      untaxed: '13640.00',
      state: 'draft',
      ref: `${s.name}: 2027-01-31 – 2027-02-27`,
    },
  ]);
  // The month's last day is followed: 28 February, then 31 March.
  expect(await read(id, 'nextInvoiceDate,periodStart,periodEnd,periodsBilled')).toMatchObject({
    nextInvoiceDate: '2027-02-28',
    periodStart: '2027-01-31',
    periodEnd: '2027-02-27',
    periodsBilled: 1,
  });
  const lines = await erp.host.server.driver.query<{ name: string; quantity: string }>({
    text: `SELECT l.name, l.quantity::text AS quantity FROM account_move_line l
             JOIN account_move m ON m.id = l.move_id
            WHERE m.subscription_id = $1 AND l.line_kind = 'product' ORDER BY l.id`,
    params: [id],
  });
  expect(lines.map((l) => [l.name, Number(l.quantity)])).toEqual([
    ['Support plan (2027-01-31 – 2027-02-27)', 1],
    ['Software seat (2027-01-31 – 2027-02-27)', 8],
  ]);

  // As after a crash between the invoice and the count: the period is found invoiced, not invoiced again.
  await erp.host.server.driver.query({
    text: `UPDATE subscription_subscription SET periods_billed = 0, next_invoice_date = '2027-01-31' WHERE id = $1`,
    params: [id],
  });
  expect(await system((env) => invoiceSubscription(env, id, '2027-01-31'))).toEqual([]);
  expect(await documents(id)).toHaveLength(1);
  expect((await read(id, 'periodsBilled,nextInvoiceDate')).nextInvoiceDate).toBe('2027-02-28');

  // Left behind for three months, it catches up: one invoice a period.
  expect(await system((env) => invoiceDue(env, '2027-04-30'))).toBe(3);
  expect((await documents(id)).map((d) => d.period)).toEqual([
    '2027-01-31',
    '2027-02-28',
    '2027-03-31',
    '2027-04-30',
  ]);
  ids['first'] = id;
});

test('a trial delays the first invoice; a plan may post its invoices; a year is twelve months of revenue', async () => {
  const id = await start({ plan: ids['yearly'], dateStart: '2027-01-01' }, [
    { product: ids['seat'], quantity: '25', manualPrice: '1000' },
  ]);
  // 25 000 a year is 2 083.33 a month.
  expect(await read(id, 'recurring,mrr,nextInvoiceDate')).toMatchObject({
    recurring: '25000.00',
    mrr: '2083.33',
    nextInvoiceDate: '2027-01-15',
  });
  expect(await system((env) => invoiceSubscription(env, id, '2027-01-14'))).toEqual([]);
  expect(await system((env) => invoiceSubscription(env, id, '2027-01-15'))).toHaveLength(1);
  expect(await documents(id)).toMatchObject([
    { kind: 'out_invoice', period: '2027-01-15', untaxed: '25000.00', state: 'posted' },
  ]);
  expect((await read(id, 'nextInvoiceDate')).nextInvoiceDate).toBe('2028-01-15');
});

test('usage is recorded on a usage line and billed once, in the next invoice', async () => {
  const id = await start({ dateStart: '2027-03-01' }, [
    { product: ids['support'], quantity: '1' },
    { product: ids['sms'], kind: 'usage', quantity: '0' },
  ]);
  expect((await read(id, 'recurring')).recurring).toBe('5000.00'); // usage is on top, as it comes
  const lines = (
    await call(
      'GET',
      `/api/v1/models/subscription.line?filter=${encodeURIComponent(JSON.stringify({ subscription: id }))}&fields=kind`,
      'rafi',
    )
  ).json.items as Json[];
  const metered = lines.find((l) => l.kind === 'usage').id;
  const fixed = lines.find((l) => l.kind === 'fixed').id;
  const record = (line: number, date: string, quantity: string) =>
    call('POST', U, 'rafi', { line, date, quantity, note: 'messages' });
  expect((await record(metered, '2027-03-10', '1840')).status).toBe(201);
  const late = await record(metered, '2027-03-20', '620');
  expect((await record(metered, '2027-04-02', '100')).status).toBe(201); // of the next period
  // Not on a line billed every period; not zero.
  expect((await record(fixed, '2027-03-10', '5')).status).toBe(422);
  expect((await record(metered, '2027-03-10', '0')).status).toBe(422);

  expect(await system((env) => invoiceDue(env, '2027-04-01'))).toBe(2);
  const docs = await documents(id);
  // March: the plan alone (nothing had been used before it). April: the plan and March's 2 460 messages at 0.50.
  expect(docs.map((d) => [d.period, d.untaxed])).toEqual([
    ['2027-03-01', '5000.00'],
    ['2027-04-01', '6230.00'],
  ]);
  const usage = (
    await call(
      'GET',
      `${U}?filter=${encodeURIComponent(JSON.stringify({ line: metered }))}&fields=date,quantity,invoice&order=date%20asc`,
      'rafi',
    )
  ).json.items as Json[];
  expect(usage.map((u) => [u.date, (u.invoice?.id ?? u.invoice) !== null])).toEqual([
    ['2027-03-10', true],
    ['2027-03-20', true],
    ['2027-04-02', false], // waits for May's invoice
  ]);
  // What is invoiced is not changed.
  expect((await call('PATCH', `${U}/${late.json.id}`, 'rafi', { quantity: '1' })).status).toBe(422);
  expect(await system((env) => invoiceDue(env, '2027-05-01'))).toBe(1);
  expect((await documents(id)).at(-1)).toMatchObject({ period: '2027-05-01', untaxed: '5050.00' });
});

test('a change in the middle of a period: invoiced for the days left when it grows, credited when it shrinks', async () => {
  const id = await start({ dateStart: '2027-05-01' }, [{ product: ids['seat'], quantity: '10' }]);
  // Before the first invoice there is no paid period to share.
  expect(await system((env) => applyChanges(env, id, '2027-05-01'))).toBeNull();
  await system((env) => invoiceSubscription(env, id, '2027-05-01'));
  const [line] = (
    await call(
      'GET',
      `/api/v1/models/subscription.line?filter=${encodeURIComponent(JSON.stringify({ subscription: id }))}&fields=quantity`,
      'rafi',
    )
  ).json.items as Json[];
  const seats = (quantity: string) =>
    call('PATCH', `/api/v1/models/subscription.line/${line.id}`, 'rafi', { quantity });

  // Five more seats on the 16th: 6 000 for 16 of May's 31 days.
  expect((await seats('15')).status).toBe(200);
  expect(await system((env) => applyChanges(env, id, '2027-05-16'))).not.toBeNull();
  // Ten fewer, the same day: 12 000 for the same share, credited.
  expect((await seats('5')).status).toBe(200);
  expect(await system((env) => applyChanges(env, id, '2027-05-16'))).not.toBeNull();
  // Nothing changed: nothing made.
  expect(await system((env) => applyChanges(env, id, '2027-05-20'))).toBeNull();
  const s = await read(id, 'name,recurring,mrr');
  expect(await documents(id)).toEqual([
    {
      kind: 'out_invoice',
      period: '2027-05-01',
      untaxed: '12000.00',
      state: 'draft',
      ref: `${s.name}: 2027-05-01 – 2027-05-31`,
    },
    {
      kind: 'out_invoice',
      period: null,
      untaxed: '3096.77',
      state: 'draft',
      ref: `${s.name}: change from 2027-05-16 to 2027-05-31`,
    },
    {
      kind: 'out_refund',
      period: null,
      untaxed: '6193.55',
      state: 'draft',
      ref: `${s.name}: change from 2027-05-16 to 2027-05-31`,
    },
  ]);
  // The next period is simply the new amount.
  expect(s).toMatchObject({ recurring: '6000.00', mrr: '6000.00' });
  expect(await system((env) => invoiceSubscription(env, id, '2027-06-01'))).toHaveLength(1);
  expect((await documents(id)).at(-1)).toMatchObject({ period: '2027-06-01', untaxed: '6000.00' });

  // From the form: Apply changes on a subscription billed today shares the whole period.
  const today = new Date().toISOString().slice(0, 10);
  const live = await start({ dateStart: today }, [{ product: ids['seat'], quantity: '1' }]);
  expect(
    (await call('POST', '/api/v1/subscriptions/run', 'mona')).json.invoices,
  ).toBeGreaterThanOrEqual(1);
  const [liveLine] = (
    await call(
      'GET',
      `/api/v1/models/subscription.line?filter=${encodeURIComponent(JSON.stringify({ subscription: live }))}&fields=quantity`,
      'rafi',
    )
  ).json.items as Json[];
  await call('PATCH', `/api/v1/models/subscription.line/${liveLine.id}`, 'rafi', { quantity: '3' });
  expect((await call('POST', `${S}/${live}/transitions/amend`, 'rafi')).status).toBe(200);
  expect((await documents(live)).map((d) => [d.kind, d.untaxed])).toEqual([
    ['out_invoice', '1200.00'],
    ['out_invoice', '2400.00'],
  ]);
});

test('paused, it is not invoiced; resumed, it bills from today; closed with a reason, for good', async () => {
  const id = ids['first'] as number;
  expect((await call('POST', `${S}/${id}/transitions/pause`, 'rafi')).status).toBe(200);
  expect((await read(id, 'mrr')).mrr).toBe('0.00'); // not revenue while it does not run
  const before = (await documents(id)).length;
  expect(await system((env) => invoiceSubscription(env, id, '2027-12-31'))).toEqual([]);
  expect(await documents(id)).toHaveLength(before);

  expect((await call('POST', `${S}/${id}/transitions/resume`, 'rafi')).status).toBe(200);
  const today = new Date().toISOString().slice(0, 10);
  const resumed = await read(id, 'nextInvoiceDate,mrr,state');
  // The next invoice was still ahead (2027): it stays; the months it was paused are not billed.
  expect(resumed).toMatchObject({
    state: 'active',
    mrr: '13640.00',
    nextInvoiceDate: '2027-05-31',
  });
  expect(today < '2027-05-31').toBe(true);

  // Closing needs its reason.
  expect((await call('POST', `${S}/${id}/transitions/close`, 'rafi')).status).toBe(409);
  expect((await call('PATCH', `${S}/${id}`, 'rafi', { closeReason: 'price' })).status).toBe(200);
  expect((await call('POST', `${S}/${id}/transitions/close`, 'rafi')).status).toBe(200);
  expect(await read(id, 'state,mrr,dateEnd,nextInvoiceDate,closeReason')).toEqual(
    expect.objectContaining({
      state: 'closed',
      mrr: '0.00',
      dateEnd: today,
      nextInvoiceDate: null,
      closeReason: 'price',
    }),
  );
  expect(await system((env) => invoiceDue(env, '2030-01-01'))).toBeGreaterThanOrEqual(0);
  expect(await documents(id)).toHaveLength(before);
  expect((await call('POST', `${S}/${id}/transitions/resume`, 'rafi')).status).toBe(409); // closed is closed
});

test('who may do what: plans and the run for managers, subscriptions for users, nothing for others', async () => {
  expect((await call('GET', S, 'bob')).status).toBe(403);
  expect((await call('POST', '/api/v1/subscriptions/run', 'bob')).status).toBe(403);
  expect((await call('POST', '/api/v1/subscriptions/run', 'rafi')).status).toBe(403);
  expect(
    (
      await call('POST', '/api/v1/models/subscription.plan', 'rafi', {
        name: 'Mine',
        unit: 'month',
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await call('POST', '/api/v1/models/subscription.plan', 'mona', {
        name: 'Never',
        unit: 'month',
        interval: 0,
      })
    ).status,
  ).toBe(422);
  // What billing keeps is not typed in by anyone.
  const id = await start({ dateStart: '2027-08-01' }, [{ product: ids['seat'], quantity: '1' }]);
  const forged = await call('PATCH', `${S}/${id}`, 'mona', {
    periodsBilled: 99,
    nextInvoiceDate: '2099-01-01',
  });
  // Refused, or left out of what is written: either way it does not get in.
  expect([200, 400, 403, 422]).toContain(forged.status);
  expect((await read(id, 'nextInvoiceDate')).nextInvoiceDate).toBe('2027-08-01');
});
