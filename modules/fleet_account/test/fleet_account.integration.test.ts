/**
 * Fleet in the books on real PostgreSQL (RFC 0038 step 2, `fleet_account`): a fill paid from the cash journal is
 * one posted entry on the vehicle's cost centre — made with its plate —; fills on account collect on the station's
 * draft bill; a booked log no longer changes and is not deleted; taking it out reverses the entry — the cost
 * centre is back at zero — or takes the line off the draft bill, and is refused once the bill is posted; who may
 * book.
 */
import { type TestInstallation, testInstallation } from '@kosh/server/testing';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { fleetAccount } from '../src/index.js';

const F = '/api/v1/models/fleet.fuel';
const S = '/api/v1/models/fleet.service';
const D = '/api/v1/models/fleet.document';
let erp: TestInstallation;
const ids: Record<string, number> = {};

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
const step = (url: string, id: number, name: string, as: string) =>
  call('POST', `${url}/${id}/transitions/${name}`, as);
const sql = <T extends Record<string, unknown>>(text: string, params: unknown[] = []) =>
  erp.host.server.driver.query<T>({ text, params });
const log = async (url: string, id: number) => {
  const json = (await call('GET', `${url}/${id}?fields=booking,entry`, 'acc')).json as Json;
  return {
    booking: json.booking as string,
    entry: (json.entry?.id ?? json.entry ?? null) as number,
  };
};
/** The lines of an entry or a bill: account code, cost centre code, debit, credit. */
const linesOf = (move: number) =>
  sql<{ code: string | null; centre: string | null; debit: string; credit: string; name: string }>(
    `SELECT a.code, c.code AS centre, l.debit::text AS debit, l.credit::text AS credit, l.name
       FROM account_move_line l
       LEFT JOIN account_account a ON a.id = l.account_id
       LEFT JOIN account_analytic c ON c.id = l.analytic_id
      WHERE l.move_id = $1 ORDER BY l.id`,
    [move],
  );
/** What posted entries leave on the van's cost centre. */
const onCentre = async () =>
  Number(
    (
      await sql<{ total: string }>(
        `SELECT coalesce(sum(l.debit - l.credit), 0)::text AS total
           FROM account_move_line l
           JOIN account_move m ON m.id = l.move_id
           JOIN account_analytic c ON c.id = l.analytic_id
          WHERE m.state = 'posted' AND c.code = 'DM-MA 51-2040'`,
      )
    )[0]?.total,
  );
const fill = (as: string, date: string, odometer: string, amount: string, more = {}) =>
  make('fleet.fuel', as, {
    vehicle: ids['van'],
    date,
    odometer,
    litres: '40',
    amount,
    ...more,
  });

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  erp = await testInstallation({
    modules: [fleetAccount],
    users: {
      fay: ['fleet.manager'],
      dev: ['fleet.user'],
      acc: ['fleet_account.user', 'fleet.manager', 'account.manager'],
    },
    company: { name: 'Padma Mills', currency: 'BDT' },
  });
  expect(
    (await call('POST', '/api/v1/accounting/charts/install', 'acc', { template: 'generic' }))
      .status,
  ).toBe(200);
  ids['cash'] = Number(
    (await sql<{ id: number }>(`SELECT id FROM account_journal WHERE type = 'cash' LIMIT 1`))[0]
      ?.id,
  );
  ids['van'] = await make('fleet.vehicle', 'fay', {
    name: 'DM-MA 51-2040 Hiace',
    plate: 'DM-MA 51-2040',
    initialOdometer: '41000',
  });
  ids['station'] = await make('res.partner', 'acc', { name: 'Meghna Filling Station' });
  ids['workshop'] = await make('res.partner', 'acc', { name: 'Rahim Motors' });
}, 300_000);

afterAll(async () => {
  await erp?.close();
});

test('a fill paid from cash is a posted entry on the vehicle’s cost centre', async () => {
  ids['paid'] = await fill('dev', '2026-10-01', '41200', '5184', { paymentJournal: ids['cash'] });
  // Logging is not booking: it takes the permission.
  expect((await step(F, ids['paid'] as number, 'book', 'dev')).status).toBe(403);
  expect((await step(F, ids['paid'] as number, 'book', 'fay')).status).toBe(403);
  const done = await step(F, ids['paid'] as number, 'book', 'acc');
  expect(done.status, JSON.stringify(done.json)).toBe(200);
  const seen = await log(F, ids['paid'] as number);
  expect(seen.booking).toBe('booked');
  const [move] = await sql<{ state: string; kind: string; date: string }>(
    `SELECT state, kind, date::text AS date FROM account_move WHERE id = $1`,
    [seen.entry],
  );
  expect(move).toMatchObject({ state: 'posted', kind: 'entry', date: '2026-10-01' });
  const lines = await linesOf(seen.entry);
  expect(lines.map((l) => [l.code, l.centre, Number(l.debit), Number(l.credit)])).toEqual([
    ['6410', 'DM-MA 51-2040', 5184, 0],
    ['1000', null, 0, 5184],
  ]);
  expect(await onCentre()).toBe(5184);
  // The cost centre is the vehicle's from now on.
  const van = (
    await call('GET', `/api/v1/models/fleet.vehicle/${ids['van']}?fields=analytic`, 'acc')
  ).json;
  expect(van.analytic).not.toBeNull();
});

test('a booked log no longer changes, and is not deleted', async () => {
  const id = ids['paid'] as number;
  expect((await call('PATCH', `${F}/${id}`, 'fay', { amount: '6000' })).status).toBe(422);
  expect((await call('PATCH', `${F}/${id}`, 'fay', { note: 'Receipt 4411' })).status).toBe(200);
  expect((await call('DELETE', `${F}/${id}`, 'fay')).status).toBeGreaterThanOrEqual(400);
});

test('nothing to book without an amount, or without knowing who was or will be paid', async () => {
  const nobody = await fill('dev', '2026-10-03', '41300', '900');
  expect((await step(F, nobody, 'book', 'acc')).status).toBe(409);
  const free = await make('fleet.service', 'dev', {
    vehicle: ids['van'],
    date: '2026-10-04',
    description: 'Warranty check',
    vendor: ids['workshop'],
    amount: '0',
  });
  expect((await step(S, free, 'book', 'acc')).status).toBe(409);
  // A journal that holds no money is refused, and nothing is booked.
  const sales = Number(
    (await sql<{ id: number }>(`SELECT id FROM account_journal WHERE type = 'sale' LIMIT 1`))[0]
      ?.id,
  );
  const wrong = await fill('dev', '2026-10-05', '41350', '700', { paymentJournal: sales });
  expect((await step(F, wrong, 'book', 'acc')).status).toBe(422);
  expect((await log(F, wrong)).booking).toBe('open');
});

test('fills on account collect on the station’s draft bill; a workshop has its own', async () => {
  ids['a'] = await fill('dev', '2026-10-09', '41680', '4860', { station: ids['station'] });
  ids['b'] = await fill('dev', '2026-10-17', '42150', '4752', { station: ids['station'] });
  for (const id of [ids['a'], ids['b']])
    expect((await step(F, id as number, 'book', 'acc')).status).toBe(200);
  const a = await log(F, ids['a'] as number);
  const b = await log(F, ids['b'] as number);
  expect(b.entry).toBe(a.entry);
  ids['bill'] = a.entry;
  const [bill] = await sql<{ state: string; kind: string; partner: number; origin: string }>(
    `SELECT state, kind, partner_id AS partner, invoice_origin AS origin FROM account_move WHERE id = $1`,
    [a.entry],
  );
  expect(bill).toMatchObject({ state: 'draft', kind: 'in_invoice', origin: 'Fleet' });
  expect(Number(bill?.partner)).toBe(ids['station']);
  const lines = (await linesOf(a.entry)).filter((l) => l.code === '6410');
  expect(lines.map((l) => l.centre)).toEqual(['DM-MA 51-2040', 'DM-MA 51-2040']);
  // Nothing of a draft is on the cost centre yet.
  expect(await onCentre()).toBe(5184);

  ids['service'] = await make('fleet.service', 'dev', {
    vehicle: ids['van'],
    date: '2026-10-20',
    odometer: '42300',
    description: 'Oil and filters',
    vendor: ids['workshop'],
    amount: '6500',
  });
  expect((await step(S, ids['service'] as number, 'book', 'acc')).status).toBe(200);
  const service = await log(S, ids['service'] as number);
  expect(service.entry).not.toBe(a.entry);
  expect((await linesOf(service.entry)).map((l) => l.code)).toContain('6420');
});

test('a paper’s cost is booked like a log', async () => {
  const paper = await make('fleet.document', 'fay', {
    vehicle: ids['van'],
    kind: 'insurance',
    name: 'INS-2026-771',
    issuedOn: '2026-10-02',
    expiresOn: '2027-10-01',
    cost: '18500',
    paymentJournal: ids['cash'],
  });
  const done = await step(D, paper, 'book', 'acc');
  expect(done.status, JSON.stringify(done.json)).toBe(200);
  const lines = await linesOf((await log(D, paper)).entry);
  expect(lines.map((l) => [l.code, l.centre, Number(l.debit)])).toContainEqual([
    '6430',
    'DM-MA 51-2040',
    18500,
  ]);
  expect(await onCentre()).toBe(5184 + 18500);
});

test('out of the books: the entry is reversed and the cost centre gives the cost back', async () => {
  const id = ids['paid'] as number;
  expect((await step(F, id, 'unbook', 'dev')).status).toBe(403);
  const before = (await log(F, id)).entry;
  const out = await step(F, id, 'unbook', 'acc');
  expect(out.status, JSON.stringify(out.json)).toBe(200);
  expect(await log(F, id)).toEqual({ booking: 'open', entry: null });
  const [reversed] = await sql<{ by: number | null }>(
    `SELECT reversed_by_id AS by FROM account_move WHERE id = $1`,
    [before],
  );
  expect(reversed?.by).not.toBeNull();
  expect(await onCentre()).toBe(18500);
  // It changes again, and is booked again at what it now says.
  expect((await call('PATCH', `${F}/${id}`, 'fay', { amount: '5200' })).status).toBe(200);
  expect((await step(F, id, 'book', 'acc')).status).toBe(200);
  expect(await onCentre()).toBe(18500 + 5200);
});

test('out of the books: the line leaves the draft bill, and the last one cancels it', async () => {
  const bill = ids['bill'] as number;
  expect((await step(F, ids['a'] as number, 'unbook', 'acc')).status).toBe(200);
  expect((await linesOf(bill)).filter((l) => l.code === '6410')).toHaveLength(1);
  expect((await step(F, ids['b'] as number, 'unbook', 'acc')).status).toBe(200);
  const [state] = await sql<{ state: string }>(`SELECT state FROM account_move WHERE id = $1`, [
    bill,
  ]);
  expect(state?.state).toBe('cancel');
  // Booked again, it starts a new bill.
  expect((await step(F, ids['a'] as number, 'book', 'acc')).status).toBe(200);
  expect((await log(F, ids['a'] as number)).entry).not.toBe(bill);
});

test('a posted bill is credited in Accounting first', async () => {
  const service = await log(S, ids['service'] as number);
  const posted = await call(
    'POST',
    `/api/v1/models/account.move/${service.entry}/transitions/post`,
    'acc',
  );
  expect(posted.status, JSON.stringify(posted.json)).toBe(200);
  expect(await onCentre()).toBe(18500 + 5200 + 6500);
  const out = await step(S, ids['service'] as number, 'unbook', 'acc');
  expect(out.status).toBe(422);
  expect(JSON.stringify(out.json)).toContain('no longer a draft');
  expect((await log(S, ids['service'] as number)).booking).toBe('booked');
});
