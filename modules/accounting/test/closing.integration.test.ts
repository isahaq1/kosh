/**
 * Year closing, the settings and the reports on real PostgreSQL through the HTTP API (RFC 0009 step 4): a manager
 * sets the lock dates (an accountant may not); a year with a draft entry does not close; closing posts the result
 * to retained earnings, closes the year and locks the company; reopening needs a reason and reverses the
 * closing entry; the aging report buckets open receivables by days overdue; the report actions and pivots serve.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AppHost,
  applyApps,
  base,
  createAppHost,
  installBase,
  installDefaults,
  prepareApps,
  recordInstalledApps,
} from '@kosh/server';
import { type Driver, orm, pg } from '@kosh/server/orm';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { accounting } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [base, accounting];

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let host: AppHost;
let company: number;
let bdt: number;
let customer: number;
const accounts: Record<string, number> = {};
const journals: Record<string, number> = {};
const tokens = new Map<string, string>();

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function call(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  as: string,
  payload?: unknown,
): Promise<{ status: number; json: Json }> {
  let token = tokens.get(as);
  if (token === undefined) {
    const login = await host.server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { login: as, password: PASSWORD },
    });
    token = (login.json() as { token: string }).token;
    tokens.set(as, token);
  }
  const res = await host.server.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: res.statusCode, json: res.body === '' ? null : res.json() };
}
const expectStatus = (r: { status: number; json: Json }, status: number) =>
  expect(r.status, JSON.stringify(r.json)).toBe(status);
const plusDays = (days: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const today = plusDays(0);

async function entry(
  date: string,
  debitCode: string,
  creditCode: string,
  amount: string,
): Promise<number> {
  const created = await call('POST', '/api/v1/models/account.move', 'rahim', {
    journal: journals['MISC'],
    currency: bdt,
    date,
    partner: customer,
    lines: {
      create: [
        { name: 'd', account: accounts[debitCode], debit: amount, credit: '0' },
        { name: 'c', account: accounts[creditCode], debit: '0', credit: amount },
      ],
    },
  });
  expectStatus(created, 201);
  return created.json.id as number;
}
const post = (id: number) =>
  call('POST', `/api/v1/models/account.move/${id}/transitions/post`, 'rahim');

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-closing-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({ driver, catalogue, change: { install: ['accounting'] }, dir }),
    { driver, dir, actor: 'test' },
  );
  host = await createAppHost({
    databaseUrl: container.getConnectionUri(),
    catalogue,
    migrationsDir: dir,
    logger: false,
    listen: false,
    auth: { secureCookies: false, cacheMs: 0, loginLimit: 0 },
    rateLimit: { max: 0, timeWindow: '1 minute' },
  });
  const auth = host.server.auth;
  if (auth === undefined) throw new Error('base is installed');
  ({ company } = await installBase(host.server.shutro, auth, {
    company: { name: 'Padma Traders', currency: 'BDT' },
    admin: { login: 'admin', name: 'Administrator', password: PASSWORD },
  }));
  await installDefaults(host.server.shutro, host.server.registry.loaded.modules, { company });
  for (const [login, groups] of [
    ['maria', ['account.manager']],
    ['rahim', ['account.user']],
  ] as const)
    await auth.createUser({
      login,
      name: login,
      password: PASSWORD,
      company,
      companies: [company],
      groups: [...groups],
    });
  expectStatus(
    await call('POST', '/api/v1/accounting/charts/install', 'maria', { template: 'generic' }),
    200,
  );
  const ids = await host.server.shutro.bootstrap({ reason: 'test: data', company }, async (env) => {
    type Model = { create(rows: unknown[]): Promise<{ ids: number[] }> };
    const model = (name: string) => env.model(name as never) as unknown as Model;
    const [row] = await env.sql<{ id: number }>`SELECT id FROM res_currency WHERE name = 'BDT'`;
    const p = await model('res.partner').create([
      { name: 'Bengal Steel', isCompany: true, isCustomer: true },
    ]);
    return { bdt: row?.id as number, customer: p.ids[0] as number };
  });
  bdt = ids.bdt;
  customer = ids.customer;
  const accountRows = await call(
    'GET',
    '/api/v1/models/account.account?fields=id,code&limit=200',
    'maria',
  );
  for (const a of accountRows.json.items as { id: number; code: string }[]) accounts[a.code] = a.id;
  const journalRows = await call('GET', '/api/v1/models/account.journal?fields=id,code', 'maria');
  for (const j of journalRows.json.items as { id: number; code: string }[]) journals[j.code] = j.id;
}, 180_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('settings: a manager sets the lock dates, an accountant may not', async () => {
  const before = await call('GET', '/api/v1/accounting/settings', 'rahim');
  expectStatus(before, 200);
  expect(before.json).toMatchObject({
    chartTemplate: 'generic',
    lockDate: null,
    accounts: { receivable: accounts['1100'] },
  });
  expectStatus(
    await call('PUT', '/api/v1/accounting/settings', 'rahim', { taxLockDate: plusDays(-100) }),
    403,
  );
  expect(
    (await call('PUT', '/api/v1/accounting/settings', 'maria', { taxLockDate: 'nope' })).status,
  ).toBe(400);
  const set = await call('PUT', '/api/v1/accounting/settings', 'maria', {
    taxLockDate: plusDays(-100),
  });
  expectStatus(set, 200);
  expect(set.json.taxLockDate).toBe(plusDays(-100));
});

test('closing a year: drafts block it; the result goes to retained earnings; reopening reverses it', async () => {
  // A year that ended 10 days ago, with income 5,000 and expenses 2,000 posted inside it, and a draft.
  const from = plusDays(-375);
  const to = plusDays(-10);
  const fy = await call('POST', '/api/v1/models/account.fiscal.year', 'maria', {
    name: 'FY test',
    dateFrom: from,
    dateTo: to,
  });
  expectStatus(fy, 201);
  expectStatus(await post(await entry(plusDays(-100), '1100', '4000', '5000')), 200);
  expectStatus(await post(await entry(plusDays(-90), '6100', '1010', '2000')), 200);
  const draft = await entry(plusDays(-50), '6200', '1010', '10');
  expectStatus(
    await call('POST', `/api/v1/accounting/fiscal-years/${fy.json.id}/close`, 'rahim'),
    403,
  );
  const blocked = await call(
    'POST',
    `/api/v1/accounting/fiscal-years/${fy.json.id}/close`,
    'maria',
  );
  expect(blocked.status).toBe(409);
  expect(blocked.json.detail).toContain('not posted');
  expectStatus(
    await call('POST', `/api/v1/models/account.move/${draft}/transitions/cancel`, 'rahim'),
    200,
  );

  const closed = await call('POST', `/api/v1/accounting/fiscal-years/${fy.json.id}/close`, 'maria');
  expectStatus(closed, 200);
  expect(closed.json, JSON.stringify(closed.json)).toMatchObject({
    state: 'closed',
    lockDate: to,
    result: '3000',
  }); // profit 3,000
  const closing = await call(
    'GET',
    `/api/v1/models/account.move/${closed.json.closingMove}?fields=state,date,amountDebit`,
    'rahim',
  );
  expect(closing.json).toMatchObject({ state: 'posted', date: to });
  const lines = await call(
    'GET',
    `/api/v1/models/account.move.line?filter=${encodeURIComponent(JSON.stringify({ move: closed.json.closingMove }))}&fields=account,debit,credit`,
    'rahim',
  );
  const byAccount = Object.fromEntries(
    lines.json.items.map((l: Json) => [l.account, [l.debit.amount, l.credit.amount]]),
  );
  expect(byAccount[accounts['4000'] as number]).toEqual(['5000.00', '0.00']); // income closed by a debit
  expect(byAccount[accounts['6100'] as number]).toEqual(['0.00', '2000.00']); // expense closed by a credit
  expect(byAccount[accounts['3100'] as number]).toEqual(['0.00', '3000.00']); // the profit, to retained earnings
  expect((await call('GET', '/api/v1/accounting/settings', 'rahim')).json.lockDate).toBe(to);
  // Nothing posts inside the closed year any more.
  const late = await entry(plusDays(-20), '6100', '1010', '1');
  const refused = await post(late);
  expect(refused.status).toBe(422);
  expect(refused.json.detail).toContain('lock date');

  // Reopen, with a reason: the closing entry is reversed, the lock date steps back before the year.
  expect(
    (await call('POST', `/api/v1/accounting/fiscal-years/${fy.json.id}/reopen`, 'maria', {}))
      .status,
  ).toBe(400);
  const reopened = await call(
    'POST',
    `/api/v1/accounting/fiscal-years/${fy.json.id}/reopen`,
    'maria',
    { reason: 'late supplier bill' },
  );
  expectStatus(reopened, 200);
  expect(reopened.json.state).toBe('open');
  const year = await call(
    'GET',
    `/api/v1/models/account.fiscal.year/${fy.json.id}?fields=state,lockDate,reopenReason`,
    'rahim',
  );
  expect(year.json).toMatchObject({
    state: 'open',
    lockDate: null,
    reopenReason: 'late supplier bill',
  });
  const reversed = await call(
    'GET',
    `/api/v1/models/account.move/${closed.json.closingMove}?fields=reversedBy`,
    'rahim',
  );
  expect(reversed.json.reversedBy).not.toBeNull();
  expectStatus(await post(late), 200);
});

test('aged receivables bucket open items by days overdue; the report actions and pivots serve', async () => {
  // Two open receivable lines: due 40 days ago (1,500) and not yet due (700).
  expectStatus(await post(await entry(plusDays(-45), '1100', '4000', '1500')), 200);
  const soon = await call('POST', '/api/v1/models/account.move', 'rahim', {
    journal: journals['MISC'],
    currency: bdt,
    date: today,
    partner: customer,
    lines: {
      create: [
        {
          name: 'd',
          account: accounts['1100'],
          debit: '700',
          credit: '0',
          dateMaturity: plusDays(20),
        },
        { name: 'c', account: accounts['4000'], debit: '0', credit: '700' },
      ],
    },
  });
  expectStatus(await post(soon.json.id), 200);
  const aging = await call(
    'GET',
    `/api/v1/accounting/reports/aging?type=receivable&date=${today}`,
    'rahim',
  );
  expectStatus(aging, 200);
  const row = aging.json.rows.find((r: Json) => r.partner === customer);
  expect(row).toBeDefined();
  expect(Number(row.notDue)).toBeGreaterThanOrEqual(700);
  expect(Number(row.d60)).toBe(1500); // 45 days overdue (the entry's date is its due date)
  expect(Number(aging.json.total.total)).toBe(Number(row.total));
  expect(
    (await call('GET', '/api/v1/accounting/reports/aging?type=payable', 'rahim')).json.rows,
  ).toEqual([]);

  const action = await call('GET', '/api/v1/actions/accounting.action_trial_balance', 'rahim');
  expectStatus(action, 200);
  expect(action.json.spec.views).toEqual(['pivot', 'list']);
  const pivot = await call('GET', '/api/v1/views/account.move.line.trial_balance', 'rahim');
  expectStatus(pivot, 200);
  expect(pivot.json.view.type).toBe('pivot');
  const balance = await call('POST', '/api/v1/models/account.move.line/aggregate', 'rahim', {
    where: { posted: true },
    groupBy: ['accountType'],
    measures: { balance: { sum: 'balance' } },
  });
  expectStatus(balance, 200);
  // Posted lines always balance: the sum over every type is zero.
  const total = balance.json.rows.reduce(
    (n: number, r: Json) => n + Number(r.balance?.amount ?? r.balance ?? 0),
    0,
  );
  expect(Math.abs(total)).toBeLessThan(0.005);
});
