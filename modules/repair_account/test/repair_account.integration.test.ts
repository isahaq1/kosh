/**
 * Repairs ↔ Accounting on real PostgreSQL (RFC 0038 step 4): an item handed back repaired gets one draft customer
 * invoice with its parts — as their products — and its labour; nothing under warranty, nothing for a repair the
 * customer declined; and the link is the server's.
 */
import { type TestInstallation, testInstallation } from '@kosh/server/testing';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { repairAccount } from '../src/index.js';

const O = '/api/v1/models/repair.order';
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
const sql = <T extends Record<string, unknown>>(text: string, params: unknown[] = []) =>
  erp.host.server.driver.query<T>({ text, params });
const run = async (id: number, steps: string[]) => {
  for (const name of steps) {
    const done = await call('POST', `${O}/${id}/transitions/${name}`, 'ron');
    expect(done.status, `${name}: ${JSON.stringify(done.json)}`).toBe(200);
  }
};
const invoiceOf = async (id: number) => {
  const seen = (await call('GET', `${O}/${id}?fields=invoice`, 'mona')).json as Json;
  return (seen.invoice?.id ?? seen.invoice ?? null) as number | null;
};
const LINES = [
  { kind: 'part', name: 'Pickup roller', quantity: '2', priceUnit: '350' },
  { kind: 'labour', name: 'Rollers fitted', quantity: '1', priceUnit: '800' },
];
const takeIn = (values: Record<string, unknown> = {}) =>
  make('repair.order', 'ron', {
    partner: ids['customer'],
    itemName: 'HP LaserJet 1020',
    problem: 'Does not pick paper.',
    diagnosis: 'Both pickup rollers are worn.',
    lines: { create: LINES.map((l) => (l.kind === 'part' ? { ...l, product: ids['roller'] } : l)) },
    ...values,
  });

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  erp = await testInstallation({
    modules: [repairAccount],
    users: {
      mona: ['repair.manager', 'product.manager', 'account.manager'],
      ron: ['repair_account.user'],
    },
    company: { name: 'Padma Service', currency: 'BDT' },
  });
  expect(
    (await call('POST', '/api/v1/accounting/charts/install', 'mona', { template: 'generic' }))
      .status,
  ).toBe(200);
  ids['customer'] = await make('res.partner', 'mona', { name: 'Shapla Printers Ltd' });
  ids['roller'] = await make('product.product', 'mona', {
    name: 'Pickup roller',
    listPrice: '350',
  });
}, 300_000);

afterAll(async () => {
  await erp?.close();
});

test('handed back repaired: one draft invoice with the parts and the labour', async () => {
  const id = await takeIn();
  await run(id, ['diagnose', 'quote', 'approve', 'begin', 'finish']);
  // Not before it is handed back.
  expect(await invoiceOf(id)).toBeNull();
  await run(id, ['deliver']);
  const invoice = await invoiceOf(id);
  expect(invoice).not.toBeNull();
  const [move] = await sql<{ kind: string; state: string; partner: number; untaxed: string }>(
    `SELECT kind, state, partner_id AS partner, amount_untaxed::text AS untaxed
       FROM account_move WHERE id = $1`,
    [invoice],
  );
  expect(move).toMatchObject({ kind: 'out_invoice', state: 'draft' });
  expect(Number(move?.partner)).toBe(ids['customer']);
  expect(Number(move?.untaxed)).toBe(1500);
  const lines = await sql<{ name: string; product: number | null; quantity: string }>(
    `SELECT name, product_id AS product, quantity::text AS quantity FROM account_move_line
      WHERE move_id = $1 AND line_kind = 'product' ORDER BY id`,
    [invoice],
  );
  expect(
    lines.map((l) => [l.name, l.product === null ? null : Number(l.product), Number(l.quantity)]),
  ).toEqual([
    ['Pickup roller', ids['roller'], 2],
    ['Rollers fitted', null, 1],
  ]);
  // The link is the server's.
  expect(
    (await call('PATCH', `${O}/${id}`, 'mona', { invoice: null })).status,
  ).toBeGreaterThanOrEqual(400);
});

test('under warranty nothing is invoiced', async () => {
  const id = await takeIn({ warranty: true });
  await run(id, ['diagnose', 'begin', 'finish', 'deliver']);
  expect(await invoiceOf(id)).toBeNull();
});

test('a repair the customer declined is handed back without an invoice', async () => {
  const id = await takeIn({ declineReason: 'Too expensive' });
  await run(id, ['diagnose', 'quote', 'decline', 'deliver']);
  expect(await invoiceOf(id)).toBeNull();
  const [n] = await sql<{ n: string }>(`SELECT count(*)::text AS n FROM account_move`);
  expect(Number(n?.n)).toBe(1);
});
