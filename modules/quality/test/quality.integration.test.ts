/**
 * Quality on real PostgreSQL (RFC 0038 §4): the checks of a document are made once from the control points that
 * apply — the operation, the product or its category, the vendor, one operation in n —; a measure decides itself
 * and the wrong verdict is refused; a photo check needs its photo; a failed check raises its alert and holds the
 * document until a manager releases it with a reason; alerts are closed by a manager with their root cause; who
 * may do what is decided by the server.
 */
import { type TestInstallation, testInstallation } from '@kosh/server/testing';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { blockingChecks, type CheckedDocument, checksFor, quality, within } from '../src/index.js';

const C = '/api/v1/models/quality.check';
const A = '/api/v1/models/quality.alert';
const P = '/api/v1/models/quality.point';
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
const system = <T>(fn: (env: never) => Promise<T>): Promise<T> =>
  erp.host.server.shutro.bootstrap({ reason: 'test', company: erp.company }, (env) =>
    fn(env as never),
  );
const receipt = (resId: number, products: string[], partner: string | null = 'vendor') =>
  system((env) =>
    checksFor(env, {
      operation: 'receipt',
      company: erp.company,
      partner: partner === null ? null : (ids[partner] as number),
      resModel: 'test.receipt',
      resId,
      resName: `WH/IN/${resId}`,
      lines: products.map((p) => ({ product: ids[p] as number, lot: `LOT-${resId}` })),
    } satisfies CheckedDocument),
  );
const checksOf = async (resId: number, resModel = 'test.receipt') =>
  (
    await call(
      'GET',
      `${C}?filter=${encodeURIComponent(JSON.stringify({ resModel, resId }))}&fields=title,kind,product,state,lot,released,alert,measure&limit=50&order=id%20asc`,
      'qam',
    )
  ).json.items as Json[];
const step = (model: string, id: number, name: string, as: string) =>
  call('POST', `/api/v1/models/${model}/${id}/transitions/${name}`, as);
const idOf = (v: Json) => (typeof v === 'object' && v !== null ? v.id : v);

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  erp = await testInstallation({
    modules: [quality],
    users: {
      qam: ['quality.manager'],
      quin: ['quality.user'],
      bob: ['base.user'],
    },
    company: { name: 'Padma Mills', currency: 'BDT' },
  });
  await system(async (env: Json) => {
    const [cat] = (await env.model('product.category').create([{ name: 'Raw material' }])).ids;
    const [rice, sugar, box] = (
      await env
        .model('product.product')
        .create([
          { name: 'Rice, 25 kg bag', category: cat },
          { name: 'Sugar, 50 kg bag', category: cat },
          { name: 'Carton box' },
        ])
    ).ids;
    const [vendor, other] = (
      await env.model('res.partner').create([{ name: 'Meghna Traders' }, { name: 'Other vendor' }])
    ).ids;
    Object.assign(ids, { cat, rice, sugar, box, vendor, other });
  });
}, 300_000);

afterAll(async () => {
  await erp?.close();
});

test('tolerances: a missing one does not limit', () => {
  const d = (n: string) => ({
    gte: (o: Json) => Number(n) >= Number(o),
    lte: (o: Json) => Number(n) <= Number(o),
  });
  expect(within(d('25') as never, '24.8' as never, '25.2' as never)).toBe(true);
  expect(within(d('24.7') as never, '24.8' as never, null)).toBe(false);
  expect(within(d('99') as never, '24.8' as never, null)).toBe(true);
});

test('control points are a manager’s; a measure needs a tolerance', async () => {
  expect(
    (await call('POST', P, 'quin', { name: 'Mine', kind: 'pass_fail', operation: 'receipt' }))
      .status,
  ).toBe(403);
  expect(
    (await call('POST', P, 'qam', { name: 'No limits', kind: 'measure', operation: 'receipt' }))
      .status,
  ).toBe(422);
  ids['visual'] = await make('quality.point', 'qam', {
    name: 'Visual inspection',
    kind: 'pass_fail',
    operation: 'receipt',
    category: ids['cat'],
  });
  ids['weight'] = await make('quality.point', 'qam', {
    name: 'Net weight',
    kind: 'measure',
    operation: 'receipt',
    product: ids['rice'],
    unit: 'kg',
    low: '24.8',
    high: '25.2',
  });
  ids['photo'] = await make('quality.point', 'qam', {
    name: 'Photo of the pallet',
    kind: 'photo',
    operation: 'delivery',
  });
  ids['fromOther'] = await make('quality.point', 'qam', {
    name: 'Certificate of the other vendor',
    kind: 'pass_fail',
    operation: 'receipt',
    partner: ids['other'],
  });
});

test('the checks of a document: the points that apply, once', async () => {
  // Rice and a carton box from Meghna: the visual inspection is for the category (rice), the weight for rice,
  // nothing for the box; the photo is for deliveries, the certificate for another vendor.
  expect(await receipt(1, ['rice', 'box'])).toBe(2);
  const made = await checksOf(1);
  expect(made.map((c) => [c.title, idOf(c.product), c.state, c.lot])).toEqual([
    ['Visual inspection', ids['rice'], 'todo', 'LOT-1'],
    ['Net weight', ids['rice'], 'todo', 'LOT-1'],
  ]);
  // Asked again — a line added, the transfer confirmed twice —: nothing twice.
  expect(await receipt(1, ['rice', 'box'])).toBe(0);
  expect(await checksOf(1)).toHaveLength(2);
  const held = await system((env) => blockingChecks(env, 'test.receipt', 1));
  expect(held.map((c) => c.state)).toEqual(['todo', 'todo']);
  // Somebody without the app reads none of it.
  expect((await call('GET', C, 'bob')).status).toBe(403);
});

test('a measure decides itself; a failed check raises its alert and holds the document', async () => {
  const [visual, weight] = await checksOf(1);
  // The checker passes what they looked at.
  const passed = await step('quality.check', visual.id, 'pass', 'quin');
  expect(passed.status, JSON.stringify(passed.json)).toBe(200);
  const read = (await call('GET', `${C}/${visual.id}?fields=state,checkedBy,checkedAt`, 'quin'))
    .json;
  expect(read.state).toBe('passed');
  expect(read.checkedBy).not.toBeNull();
  // Decided once.
  expect((await step('quality.check', visual.id, 'fail', 'quin')).status).toBeGreaterThanOrEqual(
    400,
  );

  // A measure without its value is neither; 24.5 kg is below 24.8: it cannot pass, it fails.
  expect((await step('quality.check', weight.id, 'pass', 'quin')).status).toBeGreaterThanOrEqual(
    400,
  );
  expect((await step('quality.check', weight.id, 'fail', 'quin')).status).toBeGreaterThanOrEqual(
    400,
  );
  expect((await call('PATCH', `${C}/${weight.id}`, 'quin', { measure: '24.5' })).status).toBe(200);
  const wrong = await step('quality.check', weight.id, 'pass', 'quin');
  expect(wrong.status).toBeGreaterThanOrEqual(400);
  expect(JSON.stringify(wrong.json)).toContain('passes by its value');
  const failed = await step('quality.check', weight.id, 'fail', 'quin');
  expect(failed.status, JSON.stringify(failed.json)).toBe(200);

  // Its alert: the product, the lot, the vendor and what was measured.
  const after = (await call('GET', `${C}/${weight.id}?fields=state,alert`, 'qam')).json;
  const alert = (
    await call(
      'GET',
      `${A}/${idOf(after.alert)}?fields=name,title,product,lot,partner,description,state`,
      'quin',
    )
  ).json;
  expect(alert.name).toMatch(/^QA\/\d{4}\/\d{4}$/);
  expect([idOf(alert.product), alert.lot, idOf(alert.partner), alert.state]).toEqual([
    ids['rice'],
    'LOT-1',
    ids['vendor'],
    'new',
  ]);
  expect(alert.description).toContain('Measured 24.5');
  ids['alert'] = alert.id;

  // The document is held by the failed check, until a manager releases it — saying why.
  const held = async () =>
    (await system((env) => blockingChecks(env, 'test.receipt', 1))).map((c) => c.state);
  expect(await held()).toEqual(['failed']);
  expect((await step('quality.check', weight.id, 'release', 'quin')).status).toBe(403);
  expect((await step('quality.check', weight.id, 'release', 'qam')).status).toBeGreaterThanOrEqual(
    400,
  );
  expect(
    (await call('PATCH', `${C}/${weight.id}`, 'qam', { reason: 'Accepted at a lower price' }))
      .status,
  ).toBe(200);
  expect((await step('quality.check', weight.id, 'release', 'qam')).status).toBe(200);
  expect(await held()).toEqual([]);
  // A checker cannot mark it released themselves.
  expect(
    (await call('PATCH', `${C}/${visual.id}`, 'quin', { released: true })).status,
  ).toBeGreaterThanOrEqual(400);

  // Done again by a manager: to do, no longer released, holding again.
  expect((await step('quality.check', weight.id, 'redo', 'quin')).status).toBe(403);
  expect((await step('quality.check', weight.id, 'redo', 'qam')).status).toBe(200);
  expect(await held()).toEqual(['todo']);
  // Within the tolerances it passes, and cannot fail.
  await call('PATCH', `${C}/${weight.id}`, 'quin', { measure: '25.1' });
  expect((await step('quality.check', weight.id, 'fail', 'quin')).status).toBeGreaterThanOrEqual(
    400,
  );
  expect((await step('quality.check', weight.id, 'pass', 'quin')).status).toBe(200);
  expect(await held()).toEqual([]);
});

test('a photo check passes with its photo; another vendor’s point; one operation in n', async () => {
  const made = await system((env) =>
    checksFor(env, {
      operation: 'delivery',
      company: erp.company,
      partner: null,
      resModel: 'test.delivery',
      resId: 7,
      resName: 'WH/OUT/7',
      lines: [{ product: ids['box'] as number }],
    }),
  );
  expect(made).toBe(1);
  const [photo] = await checksOf(7, 'test.delivery');
  expect(photo.kind).toBe('photo');
  const without = await step('quality.check', photo.id, 'pass', 'quin');
  expect(without.status).toBeGreaterThanOrEqual(400);
  expect(JSON.stringify(without.json)).toContain('with its photo');

  // The other vendor's certificate is asked only on their receipts.
  expect(await receipt(2, ['box'], 'other')).toBe(1);
  expect((await checksOf(2)).map((c) => c.title)).toEqual(['Certificate of the other vendor']);

  // One receipt in two: the first, the third — not the second.
  ids['sample'] = await make('quality.point', 'qam', {
    name: 'Sample to the laboratory',
    kind: 'pass_fail',
    operation: 'receipt',
    product: ids['sugar'],
    every: 2,
  });
  const sampled: boolean[] = [];
  for (const resId of [11, 12, 13]) {
    await receipt(resId, ['sugar']);
    sampled.push((await checksOf(resId)).some((c) => c.title === 'Sample to the laboratory'));
  }
  expect(sampled).toEqual([true, false, true]);
});

test('an alert is closed by a manager, with its root cause and what was done', async () => {
  const id = ids['alert'] as number;
  expect((await step('quality.alert', id, 'investigate', 'quin')).status).toBe(200);
  expect((await step('quality.alert', id, 'resolve', 'quin')).status).toBe(403);
  const bare = await step('quality.alert', id, 'resolve', 'qam');
  expect(bare.status).toBeGreaterThanOrEqual(400);
  expect(JSON.stringify(bare.json)).toContain('root cause');
  expect(
    (
      await call('PATCH', `${A}/${id}`, 'quin', {
        rootCause: 'The vendor’s filling machine was set for 24.5 kg.',
        corrective: 'The lot was accepted at a lower price; the vendor reset the machine.',
      })
    ).status,
  ).toBe(200);
  expect((await step('quality.alert', id, 'resolve', 'qam')).status).toBe(200);
  const read = (await call('GET', `${A}/${id}?fields=state,resolvedAt`, 'qam')).json;
  expect(read.state).toBe('resolved');
  expect(read.resolvedAt).not.toBeNull();
  // A resolved alert keeps its cause.
  expect((await call('PATCH', `${A}/${id}`, 'qam', { rootCause: '' })).status).toBe(422);
  // Anybody in Quality raises an alert by hand.
  expect(
    (await call('POST', A, 'quin', { title: 'Torn bags in the store', priority: 'high' })).status,
  ).toBe(201);
});
