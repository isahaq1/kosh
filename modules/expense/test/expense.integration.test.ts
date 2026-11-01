/**
 * Spend on real PostgreSQL through the HTTP API (RFC 0024 §2.1): a report is refused without the receipt its
 * category asks for and without a reason when beyond the policy; once submitted, the approver decides and the
 * policy level brings a Spend manager in — never the person asking; likely duplicates are flagged; a category per
 * kilometre computes its amount; people see their own expenses only; an advance is approved, paid out and settled
 * by a later report; the demo data loads.
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
  installDemo,
  prepareApps,
  recordInstalledApps,
} from '@kosh/server';
import { type Driver, orm, pg } from '@kosh/server/orm';
import { settings } from '@kosh/settings';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { expense } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [base, settings, expense];
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
  files = await mkdtemp(join(tmpdir(), 'kosh-expense-files-'));
  process.env['KOSH_STORAGE_DIR'] = files;
  process.env['KOSH_SCHEDULES'] = 'off';
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-expense-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({ driver, catalogue, change: { install: ['settings', 'expense'] }, dir }),
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
    ['mona', ['expense.manager']],
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

test('the policy at submission: the receipt, then a reason beyond the limit; approvals with the policy level', async () => {
  const meal = await newExpense('rahim', {
    name: 'Dinner with the client',
    date: '2026-10-20',
    category: categories['Meals'],
    amount: '2000',
  });
  const sheet = await newSheet('rahim', [meal]);
  const noReceipt = await run('expense.sheet', sheet, 'submit', 'rahim');
  expect(noReceipt.status).toBe(422);
  expect(JSON.stringify(noReceipt.json)).toContain('attach the receipt');
  await receipt('rahim', meal, 'Dinner receipt 2000');
  const noReason = await run('expense.sheet', sheet, 'submit', 'rahim');
  expect(noReason.status).toBe(422);
  expect(JSON.stringify(noReason.json)).toContain('say why');
  expect(
    (
      await call('PATCH', `${E}/${meal}`, 'rahim', {
        policyReason: 'Client visit, agreed with Mona',
      })
    ).status,
  ).toBe(200);
  const submitted = await run('expense.sheet', sheet, 'submit', 'rahim');
  expect(submitted.status, JSON.stringify(submitted.json)).toBe(200);
  const read = (await call('GET', `${S}/${sheet}?fields=state,overPolicy,total`, 'rahim')).json;
  expect(read).toMatchObject({ state: 'to_approve', overPolicy: true });
  expect(Number(read.total)).toBe(2000);
  // Submitted: no more changes by the employee.
  expect((await call('PATCH', `${E}/${meal}`, 'rahim', { amount: '1000' })).status).toBe(403);

  // Never by the person asking; the approver, then a Spend manager for the policy level.
  const rahimInbox = (await call('GET', '/api/v1/approvals/inbox', 'rahim')).json
    .requests as Json[];
  expect(rahimInbox.filter((r) => r.targetId === sheet)).toEqual([]);
  expect(await decideAll('expense.sheet', sheet, 'anna')).toBe(1);
  expect((await call('GET', `${S}/${sheet}?fields=state`, 'rahim')).json.state).toBe('to_approve');
  expect(await decideAll('expense.sheet', sheet, 'mona')).toBeGreaterThanOrEqual(1);
  expect((await call('GET', `${S}/${sheet}?fields=state`, 'rahim')).json.state).toBe('approved');
  expect((await call('GET', `${E}/${meal}?fields=status`, 'rahim')).json.status).toBe('approved');
});

test('duplicates are flagged, a rate computes the amount, and people see their own only', async () => {
  // Per kilometre: the amount is the rate times the distance (25 a km).
  const wrong = await call('POST', E, 'sumi', {
    employee: employees['sumi'],
    name: 'Drive to the warehouse',
    date: '2026-10-21',
    category: categories['Own vehicle'],
    quantity: '40',
    amount: '900',
  });
  expect(wrong.status).toBe(422);
  const filled = await call('POST', `${E}/onchange`, 'sumi', {
    values: { name: 'Drive', category: categories['Own vehicle'], quantity: '40' },
    changed: ['quantity'],
  });
  expect(filled.status, JSON.stringify(filled.json)).toBe(200);
  expect(Number(filled.json.values.amount)).toBe(1000);
  expect(filled.json.values.employee).toBe(employees['sumi']);
  const drive = await newExpense('sumi', {
    name: 'Drive to the warehouse',
    date: '2026-10-21',
    category: categories['Own vehicle'],
    quantity: '40',
    amount: '1000',
  });
  const again = await newExpense('sumi', {
    name: 'Drive to the warehouse (again)',
    date: '2026-10-21',
    category: categories['Own vehicle'],
    quantity: '40',
    amount: '1000',
  });
  const sheet = await newSheet('sumi', [drive, again]);
  expect((await run('expense.sheet', sheet, 'submit', 'sumi')).status).toBe(200);
  const flags = (
    await call(
      'GET',
      `${E}?filter=${encodeURIComponent(JSON.stringify({ sheet }))}&fields=duplicate`,
      'sumi',
    )
  ).json.items as Json[];
  expect(flags.map((x) => x.duplicate)).toEqual([true, true]);
  // Sumi sees her own expenses, not Rahim's; the approver sees both.
  const sumiSees = (await call('GET', `${E}?fields=employee`, 'sumi')).json.items as Json[];
  expect(sumiSees.every((x) => (x.employee?.id ?? x.employee) === employees['sumi'])).toBe(true);
  const annaSees = (await call('GET', `${E}?fields=employee`, 'anna')).json.items as Json[];
  expect(new Set(annaSees.map((x) => x.employee?.id ?? x.employee)).size).toBe(2);
});

test('a cash advance: approved, paid out by a Spend manager, settled by a later report', async () => {
  const made = await call('POST', A, 'rahim', {
    employee: employees['rahim'],
    purpose: 'Supplier visits',
    date: '2026-10-25',
    amount: '5000',
  });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  const id = made.json.id as number;
  expect((await run('expense.advance', id, 'submit', 'rahim')).status).toBe(200);
  expect(await decideAll('expense.advance', id, 'anna')).toBe(1);
  expect((await call('GET', `${A}/${id}?fields=state`, 'rahim')).json.state).toBe('approved');
  expect((await run('expense.advance', id, 'pay', 'anna')).status).toBe(403);
  expect((await run('expense.advance', id, 'pay', 'mona')).status).toBe(200);

  const days = await newExpense('rahim', {
    name: 'Daily allowance',
    date: '2026-10-26',
    category: categories['Daily allowance'],
    quantity: '3',
    amount: '2400',
  });
  const sheet = await newSheet('rahim', [days], { advance: id });
  expect((await run('expense.sheet', sheet, 'submit', 'rahim')).status).toBe(200);
  const read = (await call('GET', `${S}/${sheet}?fields=advanceUsed,toReimburse`, 'rahim')).json;
  expect(Number(read.advanceUsed)).toBe(2400);
  expect(Number(read.toReimburse)).toBe(0);
  const advance = (await call('GET', `${A}/${id}?fields=settled,balance`, 'rahim')).json;
  expect(Number(advance.settled)).toBe(2400);
  expect(Number(advance.balance)).toBe(2600);
  // Another employee's advance is refused on a report.
  const other = await newExpense('sumi', {
    name: 'Daily allowance',
    date: '2026-10-27',
    category: categories['Daily allowance'],
    quantity: '1',
    amount: '800',
  });
  const wrong = await call('POST', S, 'sumi', { employee: employees['sumi'], advance: id });
  expect([403, 404, 422]).toContain(wrong.status);
  void other;
});

test('the demo data loads', async () => {
  const auth = host.server.auth;
  if (auth === undefined) throw new Error('base is installed');
  const company = (
    await driver.query<{ id: number }>({ text: 'SELECT id FROM res_company LIMIT 1', params: [] })
  )[0]?.id as number;
  const summary = await installDemo({
    shutro: host.server.shutro,
    auth,
    driver,
    modules: host.server.registry.loaded.modules,
    company,
  });
  expect(JSON.stringify(summary)).toContain('Spend');
});
