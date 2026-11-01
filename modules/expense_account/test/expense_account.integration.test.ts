/**
 * Spend in the books on real PostgreSQL (RFC 0024 §2.1, `expense_account`): the bridge is proposed with both apps;
 * an approved report is booked as one balanced posted entry (the category's account against what to reimburse and
 * the company card), reimbursed from the cash journal chosen on it; an advance is paid out, partly settled by a
 * report and the rest returned, leaving Employee advances at zero.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accounting } from '@kosh/accounting';
import { expense } from '@kosh/expense';
import { planApps } from '@kosh/modules-sdk';
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
import { settings } from '@kosh/settings';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { expenseAccount } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [base, settings, accounting, expense, expenseAccount];
const E = '/api/v1/models/expense.expense';
const S = '/api/v1/models/expense.sheet';
const A = '/api/v1/models/expense.advance';

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let files: string;
let host: AppHost;
const employees: Record<string, number> = {};
const categories: Record<string, number> = {};
const tokens = new Map<string, string>();

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function token(as: string): Promise<string> {
  let t = tokens.get(as);
  if (t === undefined) {
    const login = await host.server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { login: as, password: PASSWORD },
    });
    t = (login.json() as { token: string }).token;
    tokens.set(as, t);
  }
  return t;
}
async function call(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  as: string,
  payload?: unknown,
): Promise<{ status: number; json: Json }> {
  const res = await host.server.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${await token(as)}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: res.statusCode, json: res.body === '' ? null : res.json() };
}
async function receipt(as: string, id: number, content: string): Promise<void> {
  const res = await host.server.app.inject({
    method: 'POST',
    url: `/api/v1/attachments/expense.expense/${id}`,
    headers: {
      authorization: `Bearer ${await token(as)}`,
      'content-type': 'text/plain',
      'x-filename': 'receipt.txt',
    },
    payload: content,
  });
  expect(res.statusCode, res.body).toBe(201);
}
const run = (model: string, id: number, transition: string, as: string) =>
  call('POST', `/api/v1/models/${model}/${id}/transitions/${transition}`, as);
const newExpense = async (as: string, values: Record<string, unknown>) => {
  const res = await call('POST', E, as, { employee: employees[as], ...values });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return res.json.id as number;
};
const newSheet = async (as: string, expenses: number[], extra: Record<string, unknown> = {}) => {
  const res = await call('POST', S, as, { employee: employees[as], title: 'Trip', ...extra });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  for (const id of expenses)
    expect((await call('PATCH', `${E}/${id}`, as, { sheet: res.json.id })).status).toBe(200);
  return res.json.id as number;
};
const decideAll = async (sheetModel: string, id: number, who: string) => {
  const inbox = (await call('GET', '/api/v1/approvals/inbox', who)).json.requests as Json[];
  const mine = inbox.filter((r) => r.targetModel === sheetModel && r.targetId === id);
  for (const r of mine) {
    const res = await call('POST', `/api/v1/approvals/requests/${r.id}/approve`, who);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
  }
  return mine.length;
};

beforeAll(async () => {
  files = await mkdtemp(join(tmpdir(), 'kosh-expense-account-files-'));
  process.env['KOSH_STORAGE_DIR'] = files;
  process.env['KOSH_SCHEDULES'] = 'off';
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-expense-account-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({
      driver,
      catalogue,
      change: { install: ['settings', 'accounting', 'expense'] },
      dir,
    }),
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
  const { company } = await installBase(host.server.shutro, auth, {
    company: { name: 'Padma Traders', currency: 'BDT' },
    admin: { login: 'admin', name: 'Administrator', password: PASSWORD },
  });
  await installDefaults(host.server.shutro, host.server.registry.loaded.modules, { company });
  const users: Record<string, number> = {};
  for (const [login, groups] of [
    ['hana', ['hr.manager']],
    ['mona', ['expense.manager', 'account.manager']],
    ['anna', ['expense.approver']],
    ['rahim', ['expense.user']],
    ['sumi', ['expense.user']],
  ] as const)
    users[login] = await auth.createUser({
      login,
      name: login,
      password: PASSWORD,
      company,
      companies: [company],
      groups: [...groups],
    });
  for (const who of ['mona', 'anna', 'rahim', 'sumi'])
    employees[who] = (
      await call('POST', '/api/v1/models/hr.employee', 'hana', { name: who, user: users[who] })
    ).json.id;
  for (const c of (await call('GET', '/api/v1/models/expense.category?fields=name', 'rahim')).json
    .items as Json[])
    categories[c.name] = c.id;
}, 240_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
  await rm(files, { recursive: true, force: true });
});

test('the plan proposes the bridge when Spend and Accounting come', () => {
  const plan = planApps(catalogue, [], { install: ['expense', 'accounting'] });
  expect(plan.install.find((i) => i.name === 'expense_account')).toEqual({
    name: 'expense_account',
    reason: 'bridge',
  });
});

const journals: Record<string, number> = {};
const accountId: Record<string, number> = {};
const linesOf = async (move: number) =>
  (
    await call(
      'GET',
      `/api/v1/models/account.move.line?filter=${encodeURIComponent(JSON.stringify({ move }))}&fields=account,debit,credit`,
      'mona',
    )
  ).json.items as Json[];
const num = (v: unknown) => Number((v as { amount?: unknown })?.amount ?? v);
const byAccount = (lines: Json[]) => {
  const out: Record<number, number> = {};
  for (const l of lines) {
    const a = l.account?.id ?? l.account;
    out[a] = (out[a] ?? 0) + num(l.debit) - num(l.credit);
  }
  return out;
};
const accountByCode = async (code: string) =>
  (
    await call(
      'GET',
      `/api/v1/models/account.account?filter=${encodeURIComponent(JSON.stringify({ code }))}&fields=code`,
      'mona',
    )
  ).json.items[0].id as number;

test('the chart, then a report booked and reimbursed from the cash journal', async () => {
  expect(
    (await call('POST', '/api/v1/accounting/charts/install', 'mona', { template: 'generic' }))
      .status,
  ).toBe(200);
  for (const j of (await call('GET', '/api/v1/models/account.journal?fields=code', 'mona')).json
    .items as Json[])
    journals[j.code] = j.id;
  for (const a of (
    await call('GET', '/api/v1/models/account.account?fields=code&limit=200', 'mona')
  ).json.items as Json[])
    accountId[a.code] = a.id;
  expect(
    (
      await call('PATCH', `/api/v1/models/expense.category/${categories['Travel']}`, 'mona', {
        account: accountId['6400'],
      })
    ).status,
  ).toBe(200);

  const taxi = await newExpense('rahim', {
    name: 'Taxi to the airport',
    date: '2026-10-28',
    category: categories['Travel'],
    amount: '1150',
  });
  await receipt('rahim', taxi, 'taxi 1150');
  const hotel = await newExpense('rahim', {
    name: 'Hotel (company card)',
    date: '2026-10-28',
    category: categories['Travel'],
    amount: '400',
    paidBy: 'company',
  });
  const sheet = await newSheet('rahim', [taxi, hotel]);
  expect((await run('expense.sheet', sheet, 'submit', 'rahim')).status).toBe(200);
  expect(await decideAll('expense.sheet', sheet, 'anna')).toBe(1);
  expect((await run('expense.sheet', sheet, 'post', 'rahim')).status).toBe(403);
  const booked = await run('expense.sheet', sheet, 'post', 'mona');
  expect(booked.status, JSON.stringify(booked.json)).toBe(200);
  const read = (await call('GET', `${S}/${sheet}?fields=state,entry,toReimburse`, 'mona')).json;
  expect(read.state).toBe('posted');
  const sums = byAccount(await linesOf(read.entry?.id ?? read.entry));
  const payable = await accountByCode('2170');
  const card = await accountByCode('2180');
  expect(sums[accountId['6400'] as number]).toBeCloseTo(1550, 2);
  expect(sums[payable]).toBeCloseTo(-1150, 2);
  expect(sums[card]).toBeCloseTo(-400, 2);

  // Reimbursed: the cash journal chosen first.
  expect((await run('expense.sheet', sheet, 'reimburse', 'mona')).status).toBe(422);
  expect(
    (await call('PATCH', `${S}/${sheet}`, 'mona', { paymentJournal: journals['CSH'] })).status,
  ).toBe(200);
  const paid = await run('expense.sheet', sheet, 'reimburse', 'mona');
  expect(paid.status, JSON.stringify(paid.json)).toBe(200);
  const after = (await call('GET', `${S}/${sheet}?fields=state,paymentEntry`, 'mona')).json;
  expect(after.state).toBe('paid');
  const pay = byAccount(await linesOf(after.paymentEntry?.id ?? after.paymentEntry));
  expect(pay[payable]).toBeCloseTo(1150, 2);
  expect((await call('GET', `${E}/${taxi}?fields=status`, 'rahim')).json.status).toBe('paid');
});

test('an advance paid out, settled in part by a report, the rest returned: Employee advances at zero', async () => {
  const made = await call('POST', A, 'rahim', {
    employee: employees['rahim'],
    purpose: 'Trade fair',
    date: '2026-10-29',
    amount: '3000',
    paymentJournal: journals['CSH'],
  });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  const id = made.json.id as number;
  expect((await run('expense.advance', id, 'submit', 'rahim')).status).toBe(200);
  expect(await decideAll('expense.advance', id, 'anna')).toBe(1);
  const out = await run('expense.advance', id, 'pay', 'mona');
  expect(out.status, JSON.stringify(out.json)).toBe(200);

  const days = await newExpense('rahim', {
    name: 'Daily allowance at the fair',
    date: '2026-10-30',
    category: categories['Daily allowance'],
    quantity: '1',
    amount: '800',
  });
  const sheet = await newSheet('rahim', [days], { advance: id });
  expect((await run('expense.sheet', sheet, 'submit', 'rahim')).status).toBe(200);
  expect(await decideAll('expense.sheet', sheet, 'anna')).toBe(1);
  expect((await run('expense.sheet', sheet, 'post', 'mona')).status).toBe(200);
  const settled = await run('expense.advance', id, 'settle', 'mona');
  expect(settled.status, JSON.stringify(settled.json)).toBe(200);
  const advances = await accountByCode('1170');
  const all = (
    await call(
      'GET',
      `/api/v1/models/account.move.line?filter=${encodeURIComponent(JSON.stringify({ account: advances }))}&fields=debit,credit&limit=100`,
      'mona',
    )
  ).json.items as Json[];
  expect(all.length).toBe(3);
  expect(all.reduce((s, l) => s + num(l.debit) - num(l.credit), 0)).toBeCloseTo(0, 2);
});
