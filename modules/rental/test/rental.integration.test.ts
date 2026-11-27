/**
 * Rental on real PostgreSQL (RFC 0038, step 6): a product is for rent or it is not offered; the rent is the
 * units of the period at the product's price, frozen when the order is reserved; reserving is refused when more
 * would be out at once than there are — and allowed again beside a period that only touches —; a reserved order
 * keeps its period and its products; a late return has its fee, and holds the product until it is back; the
 * availability route; who may do what.
 */
import { type TestInstallation, testInstallation } from '@kosh/server/testing';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { rental } from '../src/index.js';

const O = '/api/v1/models/rental.order';
let erp: TestInstallation;
const ids: Record<string, number> = {};
const H = 3_600_000;
const D = 24 * H;
/** An instant so many hours from now, at the top of an hour. */
const at = (hours: number): string =>
  new Date(Math.floor(Date.now() / H) * H + hours * H).toISOString();

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
const step = (id: number, name: string, as = 'rita') =>
  call('POST', `${O}/${id}/transitions/${name}`, as);
const order = (start: string, stop: string, product: string, quantity: string) =>
  make('rental.order', 'rita', {
    partner: ids['customer'],
    start,
    stop,
    lines: { create: [{ product: ids[product], quantity }] },
  });
const seen = async (id: number) =>
  (
    await call(
      'GET',
      `${O}/${id}?fields=name,state,rentTotal,depositTotal,lateFee,amountDue,pickedAt,returnedAt`,
      'rita',
    )
  ).json as Json;
const free = async (product: string, from: string, to: string) =>
  (
    await call(
      'GET',
      `/api/v1/rental/availability?product=${ids[product]}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      'rita',
    )
  ).json as Json;

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  erp = await testInstallation({
    modules: [rental],
    users: {
      mona: ['rental.manager', 'product.manager'],
      rita: ['rental.user'],
      bob: ['base.user'],
    },
    company: { name: 'Padma Rentals', currency: 'BDT' },
  });
  ids['customer'] = await make('res.partner', 'rita', { name: 'Sonali Events' });
  ids['generator'] = await make('product.product', 'mona', {
    name: 'Generator 5 kVA',
    rentable: true,
    rentUnit: 'day',
    rentPrice: '2500',
    rentDeposit: '10000',
    rentLateFee: '3000',
    rentQuantity: '3',
  });
  ids['projector'] = await make('product.product', 'mona', {
    name: 'Projector',
    rentable: true,
    rentUnit: 'hour',
    rentPrice: '300',
    rentDeposit: '5000',
    rentLateFee: '400',
    rentQuantity: '2',
  });
  ids['chair'] = await make('product.product', 'mona', { name: 'Chair', listPrice: '900' });
}, 300_000);

afterAll(async () => {
  await erp?.close();
});

test('what is not for rent is not offered; a rental ends after it starts', async () => {
  const notForRent = await call('POST', O, 'rita', {
    partner: ids['customer'],
    start: at(24),
    stop: at(48),
    lines: { create: [{ product: ids['chair'], quantity: '1' }] },
  });
  expect(notForRent.status).toBe(422);
  const backwards = await call('POST', O, 'rita', {
    partner: ids['customer'],
    start: at(48),
    stop: at(24),
  });
  expect(backwards.status).toBeGreaterThanOrEqual(400);
  const empty = await make('rental.order', 'rita', {
    partner: ids['customer'],
    start: at(24),
    stop: at(48),
  });
  expect((await step(empty, 'confirm')).status).toBe(409);
});

test('the rent is the units of the period; reserving freezes the product’s terms', async () => {
  // Two generators for two days and an hour: three days begun.
  const id = await order(at(100), at(100 + 49), 'generator', '2');
  let o = await seen(id);
  expect(o.name).toMatch(/^RN\/\d{4}\/\d{5}$/);
  expect([o.rentTotal, o.depositTotal, o.amountDue].map(Number)).toEqual([15000, 20000, 15000]);
  const reserved = await step(id, 'confirm');
  expect(reserved.status, JSON.stringify(reserved.json)).toBe(200);
  // The product's price changes afterwards: the order keeps what it was reserved at.
  expect(
    (
      await call('PATCH', `/api/v1/models/product.product/${ids['generator']}`, 'mona', {
        rentPrice: '4000',
      })
    ).status,
  ).toBe(200);
  o = await seen(id);
  expect(Number(o.rentTotal)).toBe(15000);
  expect(
    (
      await call('PATCH', `/api/v1/models/product.product/${ids['generator']}`, 'mona', {
        rentPrice: '2500',
      })
    ).status,
  ).toBe(200);
  // Reserved: its period and its products stay as they were checked.
  expect((await call('PATCH', `${O}/${id}`, 'rita', { stop: at(400) })).status).toBe(422);
  const [line] = (
    await call(
      'GET',
      `/api/v1/models/rental.line?filter=${encodeURIComponent(JSON.stringify({ order: id }))}`,
      'rita',
    )
  ).json.items as Json[];
  expect(
    (await call('PATCH', `/api/v1/models/rental.line/${line.id}`, 'rita', { quantity: '3' }))
      .status,
  ).toBe(422);
  ids['held'] = id;
});

test('never more out at once than there are; a period that only touches is free', async () => {
  // Two of three generators are held from hour 100 to hour 149.
  expect(await free('generator', at(100), at(149))).toMatchObject({ total: 3, free: 1 });
  const two = await order(at(120), at(140), 'generator', '2');
  const refused = await step(two, 'confirm');
  expect(refused.status).toBe(422);
  expect(JSON.stringify(refused.json)).toContain('Generator 5 kVA (1 free, 2 asked)');
  expect((await seen(two)).state).toBe('draft');
  // One is free then.
  const one = await order(at(120), at(140), 'generator', '1');
  expect((await step(one, 'confirm')).status).toBe(200);
  expect((await free('generator', at(100), at(149))).free).toBe(0);
  // From the moment the first comes back, two are free again.
  const after = await order(at(149), at(170), 'generator', '2');
  expect((await step(after, 'confirm')).status).toBe(200);
  // Cancelling gives them back.
  expect((await step(one, 'cancel')).status).toBe(200);
  expect((await free('generator', at(100), at(149))).free).toBe(1);
});

test('picked up and returned on time: no fee; the hours are the server’s', async () => {
  const id = await order(at(-2), at(3), 'projector', '1');
  expect((await step(id, 'receive')).status).toBe(409);
  expect((await step(id, 'confirm')).status).toBe(200);
  expect((await step(id, 'pickup')).status).toBe(200);
  expect((await step(id, 'cancel')).status).toBe(409);
  expect((await step(id, 'receive')).status).toBe(200);
  const o = await seen(id);
  // Five hours at 300.
  expect([o.rentTotal, o.lateFee, o.amountDue].map(Number)).toEqual([1500, 0, 1500]);
  expect(o.state).toBe('returned');
  expect(o.pickedAt).not.toBeNull();
  expect(o.returnedAt).not.toBeNull();
  expect(
    (await call('PATCH', `${O}/${id}`, 'mona', { lateFee: '0.01' })).status,
  ).toBeGreaterThanOrEqual(400);
});

test('a late return has its fee, and holds the product until it is back', async () => {
  // Due two and a half hours ago: three hours begun late, for two projectors.
  const dueAgo = new Date(Date.now() - 2.5 * H).toISOString();
  const id = await order(new Date(Date.now() - 6 * H).toISOString(), dueAgo, 'projector', '2');
  expect((await step(id, 'confirm')).status).toBe(200);
  expect((await step(id, 'pickup')).status).toBe(200);
  // Its time is over, but both projectors are still out: none is free now.
  expect((await free('projector', at(1), at(2))).free).toBe(0);
  const blocked = await order(at(1), at(2), 'projector', '1');
  expect((await step(blocked, 'confirm')).status).toBe(422);
  expect((await step(id, 'receive')).status).toBe(200);
  const o = await seen(id);
  expect(Number(o.lateFee)).toBe(3 * 400 * 2);
  expect(Number(o.amountDue)).toBe(Number(o.rentTotal) + 2400);
  // Back: free again.
  expect((await step(blocked, 'confirm')).status).toBe(200);
});

test('who may do what', async () => {
  expect((await call('GET', O, 'bob')).status).toBe(403);
  expect(
    (
      await call(
        'GET',
        `/api/v1/rental/availability?product=${ids['generator']}&from=${encodeURIComponent(at(1))}&to=${encodeURIComponent(at(2))}`,
        'bob',
      )
    ).status,
  ).toBeGreaterThanOrEqual(403);
  expect(
    (
      await call(
        'GET',
        `/api/v1/rental/availability?product=${ids['generator']}&from=x&to=y`,
        'rita',
      )
    ).status,
  ).toBe(400);
  const id = await order(at(500), at(500 + D / H), 'generator', '1');
  expect((await call('DELETE', `${O}/${id}`, 'rita')).status).toBe(403);
  expect((await call('DELETE', `${O}/${id}`, 'mona')).status).toBeLessThan(300);
});
