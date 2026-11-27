/**
 * Repairs on real PostgreSQL (RFC 0038, step 4): an item is taken in, diagnosed, quoted with its parts and
 * labour, accepted, repaired and handed back — each step only when it is its turn —; a declined repair goes back
 * as it came, with the reason; under warranty the repair starts from the diagnosis and nothing is charged; an
 * item is in repair once at a time; who may do what.
 */
import { type TestInstallation, testInstallation } from '@kosh/server/testing';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { repair } from '../src/index.js';

const O = '/api/v1/models/repair.order';
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
const make = async (model: string, as: string, values: Record<string, unknown>) => {
  const made = await call('POST', `/api/v1/models/${model}`, as, values);
  expect(made.status, `${model}: ${JSON.stringify(made.json)}`).toBe(201);
  return made.json.id as number;
};
const step = (id: number, name: string, as = 'ron') =>
  call('POST', `${O}/${id}/transitions/${name}`, as);
const ok = async (id: number, name: string, as = 'ron') => {
  const done = await step(id, name, as);
  expect(done.status, `${name}: ${JSON.stringify(done.json)}`).toBe(200);
};
const order = async (id: number) =>
  (
    await call(
      'GET',
      `${O}/${id}?fields=name,state,partsTotal,labourTotal,amountTotal,amountDue,startedAt,repairedAt,returnedOn`,
      'ron',
    )
  ).json as Json;
const takeIn = (values: Record<string, unknown> = {}) =>
  make('repair.order', 'ron', {
    partner: ids['customer'],
    itemName: 'HP LaserJet 1020',
    problem: 'Grey streaks down the page.',
    ...values,
  });

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  erp = await testInstallation({
    modules: [repair],
    users: {
      tia: ['repair.manager', 'product.manager'],
      ron: ['repair.user'],
      bob: ['base.user'],
    },
    company: { name: 'Padma Service', currency: 'BDT' },
  });
  ids['customer'] = await make('res.partner', 'ron', { name: 'Shapla Printers Ltd' });
  ids['roller'] = await make('product.product', 'tia', { name: 'Pickup roller', listPrice: '350' });
}, 300_000);

afterAll(async () => {
  await erp?.close();
});

test('taken in, diagnosed, quoted, accepted, repaired, handed back — each step in its turn', async () => {
  const id = await takeIn({ serial: 'CNB9K41276', accessories: 'Power cable' });
  expect((await order(id)).name).toMatch(/^RO\/\d{4}\/\d{5}$/);
  // No diagnosis, no step.
  expect((await step(id, 'diagnose')).status).toBe(409);
  expect(
    (await call('PATCH', `${O}/${id}`, 'ron', { diagnosis: 'The pickup roller is worn.' })).status,
  ).toBe(200);
  await ok(id, 'diagnose');
  // A charged repair is accepted by the customer first; and a quotation lists something.
  expect((await step(id, 'begin')).status).toBe(409);
  expect((await step(id, 'quote')).status).toBe(409);
  const lines = await call('PATCH', `${O}/${id}`, 'ron', {
    lines: {
      create: [
        {
          kind: 'part',
          product: ids['roller'],
          name: 'Pickup roller',
          quantity: '2',
          priceUnit: '350',
        },
        { kind: 'labour', name: 'Rollers fitted and cleaned', quantity: '1.5', priceUnit: '800' },
      ],
    },
  });
  expect(lines.status, JSON.stringify(lines.json)).toBe(200);
  const quoted = await order(id);
  expect(
    [quoted.partsTotal, quoted.labourTotal, quoted.amountTotal, quoted.amountDue].map(Number),
  ).toEqual([700, 1200, 1900, 1900]);
  await ok(id, 'quote');
  expect((await step(id, 'begin')).status).toBe(409);
  await ok(id, 'approve');
  await ok(id, 'begin');
  expect((await step(id, 'deliver')).status).toBe(409);
  await ok(id, 'finish');
  await ok(id, 'deliver');
  const done = await order(id);
  expect(done.state).toBe('returned');
  expect(done.startedAt).not.toBeNull();
  expect(done.repairedAt).not.toBeNull();
  expect(done.returnedOn).not.toBeNull();
  // The server's dates are not typed in.
  ids['first'] = id;
});

test('a part is a product; a line has a quantity', async () => {
  const id = await takeIn();
  const noProduct = await call('PATCH', `${O}/${id}`, 'ron', {
    lines: { create: [{ kind: 'part', name: 'Some part', priceUnit: '10' }] },
  });
  expect(noProduct.status).toBe(422);
  const none = await call('PATCH', `${O}/${id}`, 'ron', {
    lines: { create: [{ kind: 'labour', name: 'Work', quantity: '0', priceUnit: '10' }] },
  });
  expect(none.status).toBeGreaterThanOrEqual(400);
});

test('declined: the reason is asked, and the item goes back as it came', async () => {
  const id = await takeIn({ diagnosis: 'The mainboard is dead.' });
  await call('PATCH', `${O}/${id}`, 'ron', {
    lines: { create: [{ kind: 'labour', name: 'Mainboard replaced', priceUnit: '9000' }] },
  });
  await ok(id, 'diagnose');
  await ok(id, 'quote');
  expect((await step(id, 'decline')).status).toBe(409);
  expect(
    (await call('PATCH', `${O}/${id}`, 'ron', { declineReason: 'Costs more than a new one' }))
      .status,
  ).toBe(200);
  await ok(id, 'decline');
  expect((await step(id, 'begin')).status).toBe(409);
  await ok(id, 'deliver');
  const back = await order(id);
  expect(back.state).toBe('returned');
  expect(back.repairedAt).toBeNull();
});

test('under warranty: no quotation, the repair starts from the diagnosis, nothing is charged', async () => {
  const id = await takeIn({
    itemName: 'Walton fridge WFC-3D8',
    warranty: true,
    diagnosis: 'The start relay has failed.',
    lines: { create: [{ kind: 'labour', name: 'Relay replaced', priceUnit: '600' }] },
  });
  await ok(id, 'diagnose');
  expect((await step(id, 'quote')).status).toBe(409);
  await ok(id, 'begin');
  const now = await order(id);
  expect(Number(now.amountTotal)).toBe(600);
  expect(Number(now.amountDue)).toBe(0);
  await ok(id, 'finish');
  // Decided before the repair ends, not after.
  expect((await call('PATCH', `${O}/${id}`, 'ron', { warranty: false })).status).toBe(422);
});

test('an item is in repair once at a time, by its serial number', async () => {
  const one = await takeIn({ serial: 'R58W30QZ1KD', itemName: 'Samsung Galaxy A15' });
  const twice = await call('POST', O, 'ron', {
    partner: ids['customer'],
    itemName: 'Samsung Galaxy A15',
    serial: 'R58W30QZ1KD',
    problem: 'Again.',
  });
  expect(twice.status).toBe(422);
  await ok(one, 'cancel');
  // Out of the workshop: it may come in again. So may the printer that was handed back.
  await takeIn({ serial: 'R58W30QZ1KD', itemName: 'Samsung Galaxy A15' });
  await takeIn({ serial: 'CNB9K41276' });
});

test('technicians work the orders; only a manager deletes; others see nothing', async () => {
  expect((await call('GET', O, 'bob')).status).toBe(403);
  const id = await takeIn();
  expect((await call('DELETE', `${O}/${id}`, 'ron')).status).toBe(403);
  expect((await call('DELETE', `${O}/${id}`, 'tia')).status).toBeLessThan(300);
  // The dates the server keeps are refused to a technician's hand.
  const first = ids['first'] as number;
  expect(
    (await call('PATCH', `${O}/${first}`, 'tia', { returnedOn: '2020-01-01' })).status,
  ).toBeGreaterThanOrEqual(400);
});
