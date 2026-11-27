/**
 * Rental ↔ Accounting on real PostgreSQL (RFC 0038 step 6): a rental whose products are back gets one draft
 * customer invoice — the rent per product, and the late fee on a line of its own —, made by a clerk who has no
 * role in Accounting; the deposit is not invoiced; the link is the server's.
 */
import { type TestInstallation, testInstallation } from '@kosh/server/testing';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { rentalAccount } from '../src/index.js';

const O = '/api/v1/models/rental.order';
const H = 3_600_000;
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
const ago = (hours: number): string => new Date(Date.now() - hours * H).toISOString();
/** An order of the projector, reserved, picked up and returned by the clerk. */
const rented = async (start: string, stop: string, quantity: string) => {
  const id = await make('rental.order', 'rita', {
    partner: ids['customer'],
    start,
    stop,
    lines: { create: [{ product: ids['projector'], quantity }] },
  });
  for (const name of ['confirm', 'pickup', 'receive']) {
    const done = await call('POST', `${O}/${id}/transitions/${name}`, 'rita');
    expect(done.status, `${name}: ${JSON.stringify(done.json)}`).toBe(200);
  }
  const seen = (await call('GET', `${O}/${id}?fields=invoice,lateFee,rentTotal`, 'mona'))
    .json as Json;
  return { id, invoice: (seen.invoice?.id ?? seen.invoice ?? null) as number | null, seen };
};
const linesOf = (invoice: number | null) =>
  sql<{ name: string; product: number | null; quantity: string; price: string }>(
    `SELECT name, product_id AS product, quantity::text AS quantity, price_unit::text AS price
       FROM account_move_line WHERE move_id = $1 AND line_kind = 'product' ORDER BY id`,
    [invoice],
  );

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  erp = await testInstallation({
    modules: [rentalAccount],
    users: {
      mona: ['rental.manager', 'product.manager', 'account.manager'],
      // A clerk at the counter: Rental only.
      rita: ['rental.user'],
    },
    company: { name: 'Padma Rentals', currency: 'BDT' },
  });
  expect(
    (await call('POST', '/api/v1/accounting/charts/install', 'mona', { template: 'generic' }))
      .status,
  ).toBe(200);
  ids['customer'] = await make('res.partner', 'mona', { name: 'Sonali Events' });
  ids['projector'] = await make('product.product', 'mona', {
    name: 'Projector',
    rentable: true,
    rentUnit: 'hour',
    rentPrice: '300',
    rentDeposit: '5000',
    rentLateFee: '400',
    rentQuantity: '4',
  });
}, 300_000);

afterAll(async () => {
  await erp?.close();
});

test('returned on time: one draft invoice with the rent, made by a clerk without Accounting', async () => {
  // From three hours ago until two hours from now: five hours, two projectors.
  const { invoice, seen } = await rented(ago(3), ago(-2), '2');
  expect(Number(seen.lateFee)).toBe(0);
  expect(invoice).not.toBeNull();
  const [move] = await sql<{ kind: string; state: string; untaxed: string }>(
    `SELECT kind, state, amount_untaxed::text AS untaxed FROM account_move WHERE id = $1`,
    [invoice],
  );
  expect(move).toMatchObject({ kind: 'out_invoice', state: 'draft' });
  // 2 × 5 hours × 300; the 10 000 deposit is held, not invoiced.
  expect(Number(move?.untaxed)).toBe(3000);
  const lines = await linesOf(invoice);
  expect(lines.map((l) => [Number(l.product), Number(l.quantity), Number(l.price)])).toEqual([
    [ids['projector'], 10, 300],
  ]);
});

test('returned late: the fee is a line of its own', async () => {
  // Due an hour and a half ago: two hours begun late.
  const { id, invoice, seen } = await rented(ago(5), ago(1.5), '1');
  expect(Number(seen.lateFee)).toBe(800);
  const lines = await linesOf(invoice);
  expect(
    lines.map((l) => [l.product === null ? null : Number(l.product), Number(l.price)]),
  ).toEqual([
    [ids['projector'], 300],
    [null, 800],
  ]);
  expect(lines[1]?.name).toContain('Late return');
  // The link is the server's.
  expect(
    (await call('PATCH', `${O}/${id}`, 'mona', { invoice: null })).status,
  ).toBeGreaterThanOrEqual(400);
  const [n] = await sql<{ n: string }>(`SELECT count(*)::text AS n FROM account_move`);
  expect(Number(n?.n)).toBe(2);
});
