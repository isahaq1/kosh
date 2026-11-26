/**
 * The Quality ↔ Stockroom bridge on real PostgreSQL (RFC 0038 §4.3): the two apps propose it; a receipt confirmed
 * by somebody of the warehouse — without Quality rights — gets its checks; validating it is refused by the server
 * while a check is to do or failed, and goes through once the check passed or a manager released it.
 */
import { planApps } from '@kosh/modules-sdk';
import { quality } from '@kosh/quality';
import { base } from '@kosh/server';
import { type TestInstallation, testInstallation } from '@kosh/server/testing';
import { stock } from '@kosh/stock';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { qualityStock } from '../src/index.js';

const T = '/api/v1/models/stock.picking';
const C = '/api/v1/models/quality.check';
let erp: TestInstallation;
const ids: Record<string, number> = {};

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
const call = async (method: 'GET' | 'POST' | 'PATCH', url: string, as: string, body?: unknown) => {
  const res = await erp.call(method, url, as, body);
  return { status: res.status, json: res.json as Json };
};
const find = async (model: string, as: string, filter: unknown, fields: string) =>
  (
    await call(
      'GET',
      `/api/v1/models/${model}?filter=${encodeURIComponent(JSON.stringify(filter))}&fields=${fields}&order=id+asc&limit=50`,
      as,
    )
  ).json.items as Json[];
const step = (model: string, id: number, name: string, as: string) =>
  call('POST', `/api/v1/models/${model}/${id}/transitions/${name}`, as);
/** A receipt of rice made and confirmed by the warehouse. */
async function receipt(): Promise<number> {
  const made = await call('POST', T, 'wali', {
    kind: 'receipt',
    source: ids['vendors'],
    destination: ids['stock'],
    moves: { create: [{ product: ids['rice'], quantity: '10' }] },
  });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  const confirmed = await step('stock.picking', made.json.id, 'confirm', 'wali');
  expect(confirmed.status, JSON.stringify(confirmed.json)).toBe(200);
  return made.json.id as number;
}
const checksOf = (picking: number) =>
  find(
    'quality.check',
    'maria',
    { resModel: 'stock.picking', resId: picking },
    'title,state,resName',
  );
const stateOf = async (picking: number) =>
  (await call('GET', `${T}/${picking}?fields=state`, 'wali')).json.state as string;

test('the plan proposes the bridge when Quality and Stockroom come', () => {
  const plan = planApps([base, quality, stock, qualityStock], [], {
    install: ['quality', 'stock'],
  });
  expect(plan.install.find((i) => i.name === 'quality_stock')).toEqual({
    name: 'quality_stock',
    reason: 'bridge',
  });
});

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  erp = await testInstallation({
    modules: [qualityStock],
    users: {
      maria: ['stock.manager', 'product.manager', 'quality.manager'],
      wali: ['stock.user'],
      quin: ['quality_stock.user'],
    },
    company: { name: 'Padma Mills', currency: 'BDT' },
  });
  for (const l of await find('stock.location', 'maria', {}, 'usage,name'))
    if (l.usage === 'internal' && ids['stock'] === undefined) ids['stock'] = l.id;
    else if (l.usage === 'vendor' && ids['vendors'] === undefined) ids['vendors'] = l.id;
  ids['rice'] = (
    await call('POST', '/api/v1/models/product.product', 'maria', { name: 'Rice, 25 kg bag' })
  ).json.id;
  const point = await call('POST', '/api/v1/models/quality.point', 'maria', {
    name: 'Visual inspection',
    kind: 'pass_fail',
    operation: 'receipt',
  });
  expect(point.status, JSON.stringify(point.json)).toBe(201);
}, 300_000);

afterAll(async () => {
  await erp?.close();
});

test('a confirmed receipt has its checks, and is not validated while one is to do', async () => {
  const picking = await receipt();
  // Made by the server at confirmation, though the warehouse has no Quality rights; once.
  const checks = await checksOf(picking);
  expect(checks.map((c) => [c.title, c.state])).toEqual([['Visual inspection', 'todo']]);
  expect(checks[0].resName).toMatch(/\S/);
  expect((await call('GET', C, 'wali')).status).toBe(403);

  const refused = await step('stock.picking', picking, 'validate', 'wali');
  expect(refused.status).toBe(422);
  expect(JSON.stringify(refused.json)).toContain('Quality checks to do');
  // Nothing moved: the transfer is as it was.
  expect(await stateOf(picking)).toBe('confirmed');
  expect(await checksOf(picking)).toHaveLength(1);

  // Passed by Quality: the warehouse validates.
  expect((await step('quality.check', checks[0].id, 'pass', 'quin')).status).toBe(200);
  const done = await step('stock.picking', picking, 'validate', 'wali');
  expect(done.status, JSON.stringify(done.json)).toBe(200);
  expect(await stateOf(picking)).toBe('done');
});

test('a failed check holds the receipt until a Quality manager releases it', async () => {
  const picking = await receipt();
  const [check] = await checksOf(picking);
  expect((await step('quality.check', check.id, 'fail', 'quin')).status).toBe(200);
  const refused = await step('stock.picking', picking, 'validate', 'wali');
  expect(refused.status).toBe(422);
  expect(JSON.stringify(refused.json)).toContain('Quality checks failed');
  expect(await stateOf(picking)).toBe('confirmed');
  // A stock manager is not a Quality manager's stand-in: the release is Quality's.
  expect((await step('quality.check', check.id, 'release', 'quin')).status).toBe(403);
  await call('PATCH', `${C}/${check.id}`, 'maria', { reason: 'Accepted with a discount' });
  expect((await step('quality.check', check.id, 'release', 'maria')).status).toBe(200);
  expect((await step('stock.picking', picking, 'validate', 'wali')).status).toBe(200);
  expect(await stateOf(picking)).toBe('done');
});
