/**
 * Field service ↔ Accounting on real PostgreSQL (RFC 0038 step 8): a charged visit done by a technician who has no
 * role in Accounting gets one draft invoice with its parts and labour; a visit not charged gets none.
 */
import { type TestInstallation, testInstallation } from '@kosh/server/testing';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { fieldServiceAccount } from '../src/index.js';

const V = '/api/v1/models/field.visit';
let erp: TestInstallation;
const ids: Record<string, number> = {};
const users: Record<string, number> = {};

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
/** A visit planned by the dispatcher, worked and finished by the technician. */
const worked = async (billable: boolean) => {
  const id = await make('field.visit', 'dia', {
    partner: ids['clinic'],
    technician: users['tom'],
    plannedStart: new Date().toISOString(),
    problem: 'The generator does not start.',
    billable,
    signatureRequired: false,
  });
  expect((await call('POST', `${V}/${id}/transitions/begin`, 'tom')).status).toBe(200);
  const done = await call('PATCH', `${V}/${id}`, 'tom', {
    report: 'Battery replaced.',
    lines: {
      create: [
        {
          kind: 'part',
          product: ids['battery'],
          name: 'Battery',
          quantity: '1',
          priceUnit: '6500',
        },
        { kind: 'labour', name: 'Labour', quantity: '2', priceUnit: '700' },
      ],
    },
  });
  expect(done.status, JSON.stringify(done.json)).toBe(200);
  const finished = await call('POST', `${V}/${id}/transitions/finish`, 'tom');
  expect(finished.status, JSON.stringify(finished.json)).toBe(200);
  const seen = (await call('GET', `${V}/${id}?fields=invoice`, 'dia')).json as Json;
  return (seen.invoice?.id ?? seen.invoice ?? null) as number | null;
};

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  erp = await testInstallation({
    modules: [fieldServiceAccount],
    users: {
      dia: ['field_service.manager', 'product.manager', 'account.manager'],
      // A technician: Field service only.
      tom: ['field_service.user'],
    },
    company: { name: 'Padma Service', currency: 'BDT' },
  });
  expect(
    (await call('POST', '/api/v1/accounting/charts/install', 'dia', { template: 'generic' }))
      .status,
  ).toBe(200);
  for (const u of await sql<{ id: number; login: string }>('SELECT id, login FROM res_users'))
    users[u.login] = Number(u.id);
  ids['clinic'] = await make('res.partner', 'dia', { name: 'Gulshan Clinic' });
  ids['battery'] = await make('product.product', 'dia', { name: 'Battery', listPrice: '6500' });
}, 300_000);

afterAll(async () => {
  await erp?.close();
});

test('a charged visit done: one draft invoice with its parts and labour', async () => {
  const invoice = await worked(true);
  expect(invoice).not.toBeNull();
  const [move] = await sql<{ kind: string; state: string; untaxed: string; partner: number }>(
    `SELECT kind, state, amount_untaxed::text AS untaxed, partner_id AS partner FROM account_move WHERE id = $1`,
    [invoice],
  );
  expect(move).toMatchObject({ kind: 'out_invoice', state: 'draft' });
  expect(Number(move?.untaxed)).toBe(7900);
  expect(Number(move?.partner)).toBe(ids['clinic']);
  const lines = await sql<{ product: number | null }>(
    `SELECT product_id AS product FROM account_move_line WHERE move_id = $1 AND line_kind = 'product' ORDER BY id`,
    [invoice],
  );
  expect(lines.map((l) => (l.product === null ? null : Number(l.product)))).toEqual([
    ids['battery'],
    null,
  ]);
});

test('a visit not charged: no invoice', async () => {
  expect(await worked(false)).toBeNull();
  const [n] = await sql<{ n: string }>(`SELECT count(*)::text AS n FROM account_move`);
  expect(Number(n?.n)).toBe(1);
});
