/**
 * The Quality ↔ Production bridge on real PostgreSQL (RFC 0038 §4.3), with Stockroom's bridge installed beside it:
 * a confirmed order has the checks of the product it makes; producing it is refused while one is to do or failed —
 * nothing is consumed, nothing enters stock — and goes through once the check passed or a manager released it.
 * The order's own transfers are not checked: an order with a control point on Production can be produced.
 */
import { planApps } from '@kosh/modules-sdk';
import { production } from '@kosh/production';
import { quality } from '@kosh/quality';
import { qualityStock } from '@kosh/quality_stock';
import { base } from '@kosh/server';
import { type TestInstallation, testInstallation } from '@kosh/server/testing';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { qualityProduction } from '../src/index.js';

const O = '/api/v1/models/production.order';
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
const find = async (model: string, filter: unknown, fields: string) =>
  (
    await call(
      'GET',
      `/api/v1/models/${model}?filter=${encodeURIComponent(JSON.stringify(filter))}&fields=${fields}&order=id+asc&limit=50`,
      'maria',
    )
  ).json.items as Json[];
const step = (model: string, id: number, name: string, as: string) =>
  call('POST', `/api/v1/models/${model}/${id}/transitions/${name}`, as);
const onHand = async (name: string) =>
  Number(
    (await call('GET', `/api/v1/models/product.product/${ids[name]}`, 'maria')).json.qtyOnHand,
  );
/** An order for two fixtures, confirmed by somebody of the shop floor. */
async function order(): Promise<number> {
  const made = await call('POST', O, 'rahim', {
    product: ids['Fixture'],
    quantity: '2',
    bom: ids['bom'],
  });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  const confirmed = await step('production.order', made.json.id, 'confirm', 'rahim');
  expect(confirmed.status, JSON.stringify(confirmed.json)).toBe(200);
  return made.json.id as number;
}
const checksOf = (id: number) =>
  find('quality.check', { resModel: 'production.order', resId: id }, 'title,state,product,resName');

test('the plan proposes the bridge when Quality and Production come', () => {
  const plan = planApps([base, quality, production, qualityProduction], [], {
    install: ['quality', 'production'],
  });
  expect(plan.install.find((i) => i.name === 'quality_production')).toEqual({
    name: 'quality_production',
    reason: 'bridge',
  });
});

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  erp = await testInstallation({
    modules: [qualityProduction, qualityStock],
    users: {
      maria: ['production.manager', 'stock.manager', 'product.manager', 'quality.manager'],
      rahim: ['production.user'],
      quin: ['quality_production.user'],
    },
    company: { name: 'Padma Mills', currency: 'BDT' },
  });
  for (const l of await find('stock.location', {}, 'usage'))
    if (l.usage === 'internal' && ids['stock'] === undefined) ids['stock'] = l.id;
    else if (l.usage === 'vendor' && ids['vendors'] === undefined) ids['vendors'] = l.id;
  for (const name of ['Fixture', 'Panel'])
    ids[name] = (
      await call('POST', '/api/v1/models/product.product', 'maria', { name, standardPrice: '100' })
    ).json.id;
  const bom = await call('POST', '/api/v1/models/production.bom', 'maria', {
    product: ids['Fixture'],
    lines: { create: [{ product: ids['Panel'], quantity: '1' }] },
  });
  expect(bom.status, JSON.stringify(bom.json)).toBe(201);
  ids['bom'] = bom.json.id;
  // Panels for two orders, received before any control point exists.
  const receipt = await call('POST', T, 'maria', {
    kind: 'receipt',
    source: ids['vendors'],
    destination: ids['stock'],
    moves: { create: [{ product: ids['Panel'], quantity: '4' }] },
  });
  expect(receipt.status, JSON.stringify(receipt.json)).toBe(201);
  await step('stock.picking', receipt.json.id, 'confirm', 'maria');
  expect((await step('stock.picking', receipt.json.id, 'validate', 'maria')).status).toBe(200);
  const point = await call('POST', '/api/v1/models/quality.point', 'maria', {
    name: 'Final inspection',
    kind: 'pass_fail',
    operation: 'production',
    product: ids['Fixture'],
  });
  expect(point.status, JSON.stringify(point.json)).toBe(201);
}, 300_000);

afterAll(async () => {
  await erp?.close();
});

test('a confirmed order has its check; it is not produced while the check is to do', async () => {
  const id = await order();
  const checks = await checksOf(id);
  expect(checks.map((c) => [c.title, c.state])).toEqual([['Final inspection', 'todo']]);
  // The order's transfer of components is not checked: the check is the order's.
  expect(await find('quality.check', { resModel: 'stock.picking' }, 'title')).toEqual([]);

  const refused = await step('production.order', id, 'produce', 'rahim');
  expect(refused.status).toBe(422);
  expect(JSON.stringify(refused.json)).toContain('Quality checks to do');
  // Nothing consumed, nothing made.
  expect(await onHand('Fixture')).toBe(0);
  expect(await onHand('Panel')).toBe(4);
  expect((await call('GET', `${O}/${id}?fields=state`, 'rahim')).json.state).toBe('confirmed');

  expect((await step('quality.check', checks[0].id, 'pass', 'quin')).status).toBe(200);
  const produced = await step('production.order', id, 'produce', 'rahim');
  expect(produced.status, JSON.stringify(produced.json)).toBe(200);
  expect(await onHand('Fixture')).toBe(2);
  expect(await onHand('Panel')).toBe(2);
  // Its output transfer went through with Stockroom's bridge installed, and has no check of its own.
  expect(await find('quality.check', { resModel: 'stock.picking' }, 'title')).toEqual([]);
});

test('a failed check holds the order until a Quality manager releases it', async () => {
  const id = await order();
  const [check] = await checksOf(id);
  expect((await step('quality.check', check.id, 'fail', 'quin')).status).toBe(200);
  const refused = await step('production.order', id, 'produce', 'rahim');
  expect(refused.status).toBe(422);
  expect(JSON.stringify(refused.json)).toContain('Quality checks failed');
  expect(await onHand('Fixture')).toBe(2);
  await call('PATCH', `${C}/${check.id}`, 'maria', { reason: 'Reworked on the line' });
  expect((await step('quality.check', check.id, 'release', 'maria')).status).toBe(200);
  expect((await step('production.order', id, 'produce', 'rahim')).status).toBe(200);
  expect(await onHand('Fixture')).toBe(4);
});
