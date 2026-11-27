/**
 * Repairs ↔ Stockroom on real PostgreSQL (RFC 0038 step 4): a repair's parts are reserved when it starts, taken
 * out of stock when the item is repaired — refused while some are short —, released when the order is cancelled;
 * labour moves nothing; a technician needs no stock rights for any of it.
 */
import { type TestInstallation, testInstallation } from '@kosh/server/testing';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { repairStock } from '../src/index.js';

const O = '/api/v1/models/repair.order';
const T = '/api/v1/models/stock.picking';
let erp: TestInstallation;
const ids: Record<string, number> = {};

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
const call = async (method: 'GET' | 'POST' | 'PATCH', url: string, as: string, body?: unknown) => {
  const res = await erp.call(method, url, as, body);
  return { status: res.status, json: res.json as Json };
};
const make = async (model: string, as: string, values: Record<string, unknown>) => {
  const made = await call('POST', `/api/v1/models/${model}`, as, values);
  expect(made.status, `${model}: ${JSON.stringify(made.json)}`).toBe(201);
  return made.json.id as number;
};
const step = (id: number, name: string) => call('POST', `${O}/${id}/transitions/${name}`, 'ron');
const receive = async (quantity: string) => {
  const id = await make('stock.picking', 'maria', {
    kind: 'receipt',
    source: ids['vendors'],
    destination: ids['stock'],
    moves: { create: [{ product: ids['roller'], quantity }] },
  });
  await call('POST', `${T}/${id}/transitions/confirm`, 'maria');
  expect((await call('POST', `${T}/${id}/transitions/validate`, 'maria')).status).toBe(200);
};
const roller = async () =>
  (
    await call(
      'GET',
      `/api/v1/models/product.product/${ids['roller']}?fields=qtyOnHand,qtyReserved`,
      'maria',
    )
  ).json as Json;
/** An order under warranty with its diagnosis and two rollers: the repair can start at once. */
const underRepair = async () => {
  const id = await make('repair.order', 'ron', {
    partner: ids['customer'],
    itemName: 'HP LaserJet 1020',
    problem: 'Does not pick paper.',
    diagnosis: 'Both pickup rollers are worn.',
    warranty: true,
    lines: {
      create: [
        {
          kind: 'part',
          product: ids['roller'],
          name: 'Pickup roller',
          quantity: '2',
          priceUnit: '350',
        },
        { kind: 'labour', name: 'Rollers fitted', priceUnit: '400' },
      ],
    },
  });
  expect((await step(id, 'diagnose')).status).toBe(200);
  const begun = await step(id, 'begin');
  expect(begun.status, JSON.stringify(begun.json)).toBe(200);
  return id;
};

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  erp = await testInstallation({
    modules: [repairStock],
    users: {
      maria: ['repair.manager', 'stock.manager', 'product.manager'],
      ron: ['repair_stock.user'],
    },
    company: { name: 'Padma Service', currency: 'BDT' },
  });
  const locations = (
    await call('GET', '/api/v1/models/stock.location?fields=usage,name&limit=100', 'maria')
  ).json.items as Json[];
  for (const l of locations)
    ids[
      l.usage === 'internal'
        ? 'stock'
        : l.usage === 'vendor'
          ? 'vendors'
          : String(l.name).toLowerCase()
    ] = l.id;
  ids['customer'] = await make('res.partner', 'maria', { name: 'Shapla Printers Ltd' });
  ids['roller'] = await make('product.product', 'maria', {
    name: 'Pickup roller',
    listPrice: '350',
    standardPrice: '120',
  });
  await receive('1');
}, 300_000);

afterAll(async () => {
  await erp?.close();
});

test('parts reserved when the repair starts, taken out when it is repaired — not while short', async () => {
  const id = await underRepair();
  // One of the two is there: reserved, and the order cannot be finished.
  expect(Number((await roller()).qtyReserved)).toBe(1);
  const short = await step(id, 'finish');
  expect(short.status).toBe(422);
  expect(JSON.stringify(short.json)).toContain('Parts are short: Pickup roller (1)');
  expect(Number((await roller()).qtyOnHand)).toBe(1);

  await receive('1');
  const finished = await step(id, 'finish');
  expect(finished.status, JSON.stringify(finished.json)).toBe(200);
  expect(Number((await roller()).qtyOnHand)).toBe(0);
  const seen = (await call('GET', `${O}/${id}?fields=state,partsTransfer`, 'maria')).json as Json;
  expect(seen.state).toBe('repaired');
  const transfer = (
    await call('GET', `${T}/${seen.partsTransfer?.id ?? seen.partsTransfer}`, 'maria')
  ).json as Json;
  expect(transfer).toMatchObject({ kind: 'adjustment', state: 'done' });
  expect(transfer.destination?.id ?? transfer.destination).toBe(ids['repairs']);
  // The technician did all of it without a right on the stock.
  expect((await call('GET', T, 'ron')).status).toBe(403);
});

test('cancelling the order releases its parts', async () => {
  await receive('3');
  const id = await underRepair();
  expect(Number((await roller()).qtyReserved)).toBe(2);
  expect((await step(id, 'cancel')).status).toBe(200);
  expect(Number((await roller()).qtyReserved)).toBe(0);
  expect(Number((await roller()).qtyOnHand)).toBe(3);
});

test('a repair with labour only moves nothing', async () => {
  const id = await make('repair.order', 'ron', {
    partner: ids['customer'],
    itemName: 'Laptop',
    problem: 'Slow.',
    diagnosis: 'Dust in the fan.',
    warranty: true,
    lines: { create: [{ kind: 'labour', name: 'Cleaned', priceUnit: '500' }] },
  });
  await step(id, 'diagnose');
  await step(id, 'begin');
  expect((await step(id, 'finish')).status).toBe(200);
  const seen = (await call('GET', `${O}/${id}?fields=partsTransfer`, 'maria')).json as Json;
  expect(seen.partsTransfer).toBeNull();
});
