/**
 * Fleet on real PostgreSQL (RFC 0038, step 2): a vehicle's figures follow its fills, services and trips — the
 * odometer, the distance, kilometres per litre between full tanks, the cost per kilometre, the next service —; a
 * reading does not go back; papers are valid, expiring or expired by the calendar and announced once; a trip
 * starts at the vehicle's reading, one at a time, never on a retired vehicle; who may do what.
 */
import { type TestInstallation, testInstallation } from '@kosh/server/testing';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { fleet } from '../src/index.js';

const V = '/api/v1/models/fleet.vehicle';
const F = '/api/v1/models/fleet.fuel';
const D = '/api/v1/models/fleet.document';
const T = '/api/v1/models/fleet.trip';
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
const step = (id: number, name: string, as: string) =>
  call('POST', `${T}/${id}/transitions/${name}`, as);
const van = async () =>
  (
    await call(
      'GET',
      `${V}/${ids['van']}?fields=odometer,distance,fuelCost,serviceCost,kmPerLitre,costPerKm,serviceDueOn,serviceDueAt`,
      'fay',
    )
  ).json;
/** A day some days from today, as the server counts them (a day's slack either way is left in the test's figures). */
const day = (offset: number): string =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  erp = await testInstallation({
    modules: [fleet],
    users: { fay: ['fleet.manager'], dev: ['fleet.user'], bob: ['base.user'] },
    company: { name: 'Padma Mills', currency: 'BDT' },
  });
}, 300_000);

afterAll(async () => {
  await erp?.close();
});

test('vehicles are a manager’s; a plate is one vehicle’s', async () => {
  const mine = await call('POST', V, 'dev', { name: 'Mine', plate: 'X-1' });
  expect(mine.status).toBe(403);
  ids['van'] = await make('fleet.vehicle', 'fay', {
    name: 'DM-MA 51-2040 Hiace',
    plate: 'DM-MA 51-2040',
    kind: 'pickup',
    fuel: 'diesel',
    initialOdometer: '41000',
  });
  const twin = await call('POST', V, 'fay', { name: 'Twin', plate: 'DM-MA 51-2040' });
  expect(twin.status).toBeGreaterThanOrEqual(400);
  expect((await call('GET', V, 'bob')).status).toBe(403);
  // It came with 41 000 km: that is its reading until something is logged.
  expect(Number((await van()).odometer)).toBe(41000);
});

test('fills: the odometer, the distance, kilometres per litre between full tanks, the cost per kilometre', async () => {
  for (const [date, odometer, litres, amount] of [
    ['2026-10-01', '41200', '48', '5184'],
    ['2026-10-09', '41680', '45', '4860'],
    ['2026-10-17', '42150', '44', '4752'],
  ] as const)
    await make('fleet.fuel', 'dev', { vehicle: ids['van'], date, odometer, litres, amount });
  let seen = await van();
  expect([Number(seen.odometer), Number(seen.distance), Number(seen.fuelCost)]).toEqual([
    42150, 1150, 14796,
  ]);
  // 950 km on 89 litres; 14 796 over 1 150 km.
  expect(Number(seen.kmPerLitre)).toBe(10.67);
  expect(Number(seen.costPerKm)).toBe(12.87);

  // A reading does not go back: below an earlier one, or above a later one.
  const lower = await call('POST', F, 'dev', {
    vehicle: ids['van'],
    date: '2026-10-20',
    odometer: '42000',
    litres: '10',
    amount: '1080',
  });
  expect(lower.status).toBe(422);
  expect(JSON.stringify(lower.json)).toContain('does not go back');
  expect(
    (
      await call('POST', F, 'dev', {
        vehicle: ids['van'],
        date: '2026-10-05',
        odometer: '41900',
        litres: '10',
        amount: '1080',
      })
    ).status,
  ).toBe(422);

  // A fill that did not fill the tank, between two that did: its litres count.
  await make('fleet.fuel', 'dev', {
    vehicle: ids['van'],
    date: '2026-10-13',
    odometer: '41900',
    litres: '20',
    amount: '2160',
    fullTank: false,
  });
  seen = await van();
  expect(Number(seen.kmPerLitre)).toBe(8.72);
  expect(Number(seen.fuelCost)).toBe(16956);
});

test('a service: its cost in the cost per kilometre, and when the next is due', async () => {
  await make('fleet.service', 'dev', {
    vehicle: ids['van'],
    date: '2026-10-10',
    odometer: '41700',
    kind: 'service',
    description: 'Engine oil and filters',
    amount: '6500',
    nextDueOn: '2027-01-10',
    nextDueAt: '46700',
  });
  const seen = await van();
  expect(Number(seen.serviceCost)).toBe(6500);
  // (16 956 + 6 500) over 1 150 km.
  expect(Number(seen.costPerKm)).toBe(20.4);
  expect(String(seen.serviceDueOn).slice(0, 10)).toBe('2027-01-10');
  expect(Number(seen.serviceDueAt)).toBe(46700);
  // The next service is not due before this one.
  expect(
    (
      await call('POST', '/api/v1/models/fleet.service', 'dev', {
        vehicle: ids['van'],
        date: '2026-10-18',
        description: 'Back in time',
        nextDueOn: '2026-10-01',
      })
    ).status,
  ).toBe(422);
});

test('papers: valid, expiring or expired by the calendar; announced once, and again once renewed', async () => {
  expect(
    (await call('POST', D, 'dev', { vehicle: ids['van'], name: 'X', expiresOn: day(100) })).status,
  ).toBe(403);
  const paper = (kind: string, name: string, offset: number) =>
    make('fleet.document', 'fay', { vehicle: ids['van'], kind, name, expiresOn: day(offset) });
  const registration = await paper('registration', 'REG-2040', 400);
  const fitness = await paper('fitness', 'FIT-88213', 12);
  const token = await paper('tax_token', 'TT-7781', -5);
  const statusOf = async (id: number) =>
    (await call('GET', `${D}/${id}?fields=status`, 'dev')).json.status;
  expect([await statusOf(registration), await statusOf(fitness), await statusOf(token)]).toEqual([
    'valid',
    'expiring',
    'expired',
  ]);
  // Announced by the server's round — a manager may ask for it —, once.
  expect((await call('POST', '/api/v1/fleet/papers/refresh', 'dev')).status).toBe(403);
  const first = await call('POST', '/api/v1/fleet/papers/refresh', 'fay');
  expect(first.status, JSON.stringify(first.json)).toBe(200);
  expect(first.json.announced).toBe(2);
  expect((await call('POST', '/api/v1/fleet/papers/refresh', 'fay')).json.announced).toBe(0);
  // The registration's date brought near: expiring at once, and announced at the next round.
  expect((await call('PATCH', `${D}/${registration}`, 'fay', { expiresOn: day(10) })).status).toBe(
    200,
  );
  expect(await statusOf(registration)).toBe('expiring');
  expect((await call('POST', '/api/v1/fleet/papers/refresh', 'fay')).json.announced).toBe(1);
  // The fitness certificate renewed for a year: valid again, nothing to announce.
  await call('PATCH', `${D}/${fitness}`, 'fay', { expiresOn: day(377) });
  expect(await statusOf(fitness)).toBe('valid');
  expect((await call('POST', '/api/v1/fleet/papers/refresh', 'fay')).json.announced).toBe(0);
});

test('a trip starts at the vehicle’s reading, one at a time; its distance; none for a retired vehicle', async () => {
  const trip = (destination: string) =>
    make('fleet.trip', 'dev', { vehicle: ids['van'], origin: 'Head office', destination });
  const first = await trip('Gazipur depot');
  const started = await step(first, 'start', 'dev');
  expect(started.status, JSON.stringify(started.json)).toBe(200);
  const read = async (id: number) =>
    (await call('GET', `${T}/${id}?fields=name,state,odometerStart,odometerEnd,distance`, 'dev'))
      .json;
  expect((await read(first)).name).toMatch(/^TRIP\/\d{4}\/\d{5}$/);
  expect(Number((await read(first)).odometerStart)).toBe(42150);
  // The van is on the road: a second trip does not start.
  const second = await trip('Narayanganj');
  const busy = await step(second, 'start', 'dev');
  expect(busy.status).toBe(422);
  expect(JSON.stringify(busy.json)).toContain('already on the road');
  // Finished with the reading at the end, not below the start.
  expect((await step(first, 'finish', 'dev')).status).toBeGreaterThanOrEqual(400);
  expect(
    (await call('PATCH', `${T}/${first}`, 'dev', { odometerEnd: '42000' })).status,
  ).toBeGreaterThanOrEqual(400);
  expect((await call('PATCH', `${T}/${first}`, 'dev', { odometerEnd: '42230' })).status).toBe(200);
  expect((await step(first, 'finish', 'dev')).status).toBe(200);
  expect(Number((await read(first)).distance)).toBe(80);
  expect(Number((await van()).odometer)).toBe(42230);
  // Now the second may go.
  expect((await step(second, 'start', 'dev')).status).toBe(200);
  expect((await step(second, 'cancel', 'dev')).status).toBe(200);

  // Retired: no more trips.
  expect((await call('PATCH', `${V}/${ids['van']}`, 'fay', { status: 'retired' })).status).toBe(
    200,
  );
  const refused = await call('POST', T, 'dev', {
    vehicle: ids['van'],
    origin: 'Head office',
    destination: 'Anywhere',
  });
  expect(refused.status).toBe(422);
  expect(JSON.stringify(refused.json)).toContain('retired');
});
