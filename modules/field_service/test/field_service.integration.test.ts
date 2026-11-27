/**
 * Field service on real PostgreSQL (RFC 0038, step 8): a dispatcher plans visits; a technician sees and works only
 * their own and does not re-plan them; a visit starts with its technician and is done only with the checklist
 * ticked, the report written and the customer's signature — taken on site, once; the lines are frozen once signed;
 * the day's route in a short order.
 */
import { type TestInstallation, testInstallation } from '@kosh/server/testing';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { fieldService } from '../src/index.js';

const V = '/api/v1/models/field.visit';
let erp: TestInstallation;
const ids: Record<string, number> = {};
const users: Record<string, number> = {};
const SIGNATURE = `data:image/png;base64,${'iVBORw0KGgo'.repeat(20)}`;
const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const at = (hour: number) => `${tomorrow}T${String(hour).padStart(2, '0')}:00:00.000Z`;

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
const step = (id: number, name: string, as: string) =>
  call('POST', `${V}/${id}/transitions/${name}`, as);
const sign = (id: number, as: string, body: unknown = { name: 'Dr. Karim', image: SIGNATURE }) =>
  call('POST', `/api/v1/field-service/visits/${id}/sign`, as, body);
const visit = (partner: string, hour: number, extra: Record<string, unknown> = {}) =>
  make('field.visit', 'dia', {
    partner: ids[partner],
    technician: users['tom'],
    plannedStart: at(hour),
    problem: 'Not working.',
    ...extra,
  });

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  erp = await testInstallation({
    modules: [fieldService],
    users: {
      dia: ['field_service.manager', 'product.manager'],
      tom: ['field_service.user'],
      tim: ['field_service.user'],
      bob: ['base.user'],
    },
    company: { name: 'Padma Service', currency: 'BDT' },
  });
  for (const u of await erp.host.server.driver.query<{ id: number; login: string }>({
    text: 'SELECT id, login FROM res_users',
    params: [],
  }))
    users[u.login] = Number(u.id);
  for (const [key, name, lat, lon] of [
    ['clinic', 'Gulshan Clinic', '23.7925', '90.4078'],
    ['tower', 'Banani Tower', '23.7937', '90.4066'],
    ['bank', 'Motijheel Bank', '23.7330', '90.4172'],
  ] as const)
    ids[key] = await make('res.partner', 'dia', { name, latitude: lat, longitude: lon });
  ids['filter'] = await make('product.product', 'dia', { name: 'AC filter', listPrice: '450' });
}, 300_000);

afterAll(async () => {
  await erp?.close();
});

test('a dispatcher plans; a technician sees only their own and does not re-plan them', async () => {
  ids['clinicVisit'] = await visit('clinic', 3, {
    latitude: '23.7925',
    longitude: '90.4078',
    checks: { create: [{ name: 'Clean the drain' }, { name: 'Test for an hour' }] },
  });
  expect(
    (await call('POST', V, 'tom', { partner: ids['clinic'], plannedStart: at(4), problem: 'x' }))
      .status,
  ).toBe(403);
  expect((await call('GET', `${V}/${ids['clinicVisit']}`, 'tim')).status).toBeGreaterThanOrEqual(
    403,
  );
  expect((await call('GET', V, 'bob')).status).toBe(403);
  const mine = (await call('GET', V, 'tom')).json.items as Json[];
  expect(mine.map((v) => v.id)).toEqual([ids['clinicVisit']]);
  expect(
    (await call('PATCH', `${V}/${ids['clinicVisit']}`, 'tom', { plannedStart: at(9) })).status,
  ).toBe(422);
  expect(
    (await call('PATCH', `${V}/${ids['clinicVisit']}`, 'tom', { technician: users['tim'] })).status,
  ).toBe(422);
  // A visit with nobody to go does not start.
  const nobody = await make('field.visit', 'dia', {
    partner: ids['bank'],
    plannedStart: at(5),
    problem: 'x',
  });
  expect((await step(nobody, 'begin', 'dia')).status).toBe(409);
});

test('on site: the checklist, the report and the signature — then done, and not before', async () => {
  const id = ids['clinicVisit'] as number;
  // Not on site yet: no signature.
  expect((await sign(id, 'tom')).status).toBe(409);
  expect((await step(id, 'begin', 'tom')).status).toBe(200);
  const lines = await call('PATCH', `${V}/${id}`, 'tom', {
    lines: {
      create: [
        {
          kind: 'part',
          product: ids['filter'],
          name: 'AC filter',
          quantity: '2',
          priceUnit: '450',
        },
        { kind: 'labour', name: 'Service', quantity: '1.5', priceUnit: '800' },
      ],
    },
  });
  expect(lines.status, JSON.stringify(lines.json)).toBe(200);
  expect(Number((await call('GET', `${V}/${id}?fields=amountTotal`, 'tom')).json.amountTotal)).toBe(
    2100,
  );
  // Nothing ticked, no report, no signature.
  expect((await step(id, 'finish', 'tom')).status).toBe(409);
  const checks = (
    await call(
      'GET',
      `/api/v1/models/field.visit.check?filter=${encodeURIComponent(JSON.stringify({ visit: id }))}`,
      'tom',
    )
  ).json.items as Json[];
  for (const c of checks)
    expect(
      (await call('PATCH', `/api/v1/models/field.visit.check/${c.id}`, 'tom', { done: true }))
        .status,
    ).toBe(200);
  expect(
    (await call('PATCH', `${V}/${id}`, 'tom', { report: 'Drain cleaned, filters changed.' }))
      .status,
  ).toBe(200);
  expect((await step(id, 'finish', 'tom')).status).toBe(409);
  // Only a drawing, only the visit's technician, once.
  expect(
    (await sign(id, 'tom', { name: 'Dr. Karim', image: 'data:image/svg+xml;base64,AAAA' })).status,
  ).toBe(400);
  expect((await sign(id, 'tom', { image: SIGNATURE })).status).toBe(400);
  expect((await sign(id, 'tim')).status).toBe(404);
  expect((await sign(id, 'tom')).status).toBe(200);
  expect((await sign(id, 'tom')).status).toBe(409);
  // Signed for: the lines stand.
  const [line] = (
    await call(
      'GET',
      `/api/v1/models/field.visit.line?filter=${encodeURIComponent(JSON.stringify({ visit: id }))}`,
      'tom',
    )
  ).json.items as Json[];
  expect(
    (await call('PATCH', `/api/v1/models/field.visit.line/${line.id}`, 'tom', { quantity: '5' }))
      .status,
  ).toBe(422);
  // Nobody writes the signature by hand.
  expect(
    (await call('PATCH', `${V}/${id}`, 'dia', { signedBy: 'Someone else' })).status,
  ).toBeGreaterThanOrEqual(400);
  expect((await step(id, 'finish', 'tom')).status).toBe(200);
  const done = (
    await call('GET', `${V}/${id}?fields=state,signedBy,signedAt,startedAt,finishedAt`, 'tom')
  ).json as Json;
  expect(done).toMatchObject({ state: 'done', signedBy: 'Dr. Karim' });
  for (const key of ['signedAt', 'startedAt', 'finishedAt']) expect(done[key]).not.toBeNull();
});

test('without a signature asked, the checklist and the report are enough', async () => {
  const id = await visit('bank', 6, { signatureRequired: false });
  expect((await step(id, 'begin', 'tom')).status).toBe(200);
  expect(
    (await call('PATCH', `${V}/${id}`, 'tom', { report: 'Nobody there; meter read.' })).status,
  ).toBe(200);
  expect((await step(id, 'finish', 'tom')).status).toBe(200);
});

test('the day’s route: nearest next, with the distance of each leg', async () => {
  // Tomorrow: the clinic (done) is out; the tower and the bank wait, and one more at the clinic.
  await visit('tower', 8, { latitude: '23.7937', longitude: '90.4066' });
  await visit('bank', 7, { latitude: '23.7330', longitude: '90.4172' });
  await visit('clinic', 9, { latitude: '23.7925', longitude: '90.4078' });
  const route = (await call('GET', `/api/v1/field-service/route?date=${tomorrow}`, 'tom'))
    .json as Json;
  // From the first planned (the bank at 7) to the tower or the clinic — next door to each other.
  expect(route.stops.map((s: Json) => s.customer)).toEqual([
    'Motijheel Bank',
    'Gulshan Clinic',
    'Banani Tower',
  ]);
  expect(route.stops[0].legKm).toBeNull();
  expect(route.stops[1].legKm).toBeGreaterThan(6);
  expect(route.stops[2].legKm).toBeLessThan(0.3);
  expect(route.totalKm).toBeGreaterThan(6);
  // Another technician's day is their own; a dispatcher reads anyone's.
  expect(
    (await call('GET', `/api/v1/field-service/route?date=${tomorrow}`, 'tim')).json.stops,
  ).toEqual([]);
  const forTom = (
    await call(
      'GET',
      `/api/v1/field-service/route?date=${tomorrow}&technician=${users['tom']}`,
      'dia',
    )
  ).json as Json;
  expect(forTom.stops).toHaveLength(3);
  expect((await call('GET', '/api/v1/field-service/route?date=tomorrow', 'tom')).status).toBe(400);
});
