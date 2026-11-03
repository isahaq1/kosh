/**
 * Payroll in the books on real PostgreSQL (RFC 0024 §2.3, `payroll_account`): the bridge is proposed with both
 * apps; an approved run is one balanced posted entry — the gross to Salaries, a loan instalment to Payroll
 * deductions payable, the net to Salaries payable — paid from the bank journal chosen on the run; a correction books
 * only its difference.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accounting } from '@kosh/accounting';
import { planApps } from '@kosh/modules-sdk';
import { payroll } from '@kosh/payroll';
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
import { payrollAccount } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [base, settings, accounting, payroll, payrollAccount];
const R = '/api/v1/models/payroll.run';

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let host: AppHost;
const employees: Record<string, number> = {};
const tokens = new Map<string, string>();

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function call(method: 'GET' | 'POST' | 'PATCH', url: string, as: string, payload?: unknown) {
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
  return { status: res.statusCode, json: (res.body === '' ? null : res.json()) as Json };
}
const transition = (id: number, name: string) =>
  call('POST', `${R}/${id}/transitions/${name}`, 'pia');
const num = (v: unknown) => Number((v as { amount?: unknown })?.amount ?? v);
const accountId = async (code: string) =>
  (
    await call(
      'GET',
      `/api/v1/models/account.account?filter=${encodeURIComponent(JSON.stringify({ code }))}&fields=code`,
      'pia',
    )
  ).json.items[0].id as number;
const sums = async (move: number) => {
  const out: Record<number, number> = {};
  for (const l of (
    await call(
      'GET',
      `/api/v1/models/account.move.line?filter=${encodeURIComponent(JSON.stringify({ move }))}&fields=account,debit,credit`,
      'pia',
    )
  ).json.items as Json[]) {
    const a = l.account?.id ?? l.account;
    out[a] = (out[a] ?? 0) + num(l.debit) - num(l.credit);
  }
  return out;
};

test('the plan proposes the bridge when Payroll and Accounting come', () => {
  const plan = planApps(catalogue, [], { install: ['payroll', 'accounting'] });
  expect(plan.install.find((i) => i.name === 'payroll_account')).toEqual({
    name: 'payroll_account',
    reason: 'bridge',
  });
});

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-payroll-account-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({
      driver,
      catalogue,
      change: { install: ['settings', 'accounting', 'payroll'] },
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
  await auth.createUser({
    login: 'pia',
    name: 'Pia',
    password: PASSWORD,
    company,
    companies: [company],
    groups: ['payroll.manager', 'hr.manager', 'account.manager'],
  });
  expect(
    (await call('POST', '/api/v1/accounting/charts/install', 'pia', { template: 'generic' }))
      .status,
  ).toBe(200);
  const structure = (
    await call('POST', '/api/v1/models/payroll.structure', 'pia', {
      name: 'Simple',
      rules: {
        create: [
          { sequence: 10, code: 'BASIC', name: 'Basic', category: 'basic', formula: 'WAGE' },
          {
            sequence: 20,
            code: 'BONUS',
            name: 'Bonus',
            category: 'allowance',
            formula: 'INPUT_BONUS',
          },
          { sequence: 30, code: 'LOAN', name: 'Loan', category: 'deduction', formula: 'LOAN' },
        ],
      },
    })
  ).json.id;
  for (const [who, wage] of [
    ['rahim', '45000'],
    ['sumi', '60000'],
  ] as const) {
    employees[who] = (
      await call('POST', '/api/v1/models/hr.employee', 'pia', { name: who })
    ).json.id;
    const c = await call('POST', '/api/v1/models/hr.contract', 'pia', {
      name: who,
      employee: employees[who],
      dateStart: '2026-01-01',
      wage,
      structure,
    });
    await call('POST', `/api/v1/models/hr.contract/${c.json.id}/transitions/start`, 'pia');
  }
  const loan = await call('POST', '/api/v1/models/payroll.loan', 'pia', {
    employee: employees['rahim'],
    amount: '4000',
    installment: '2000',
    dateStart: '2026-10-01',
  });
  await call('POST', `/api/v1/models/payroll.loan/${loan.json.id}/transitions/start`, 'pia');
}, 240_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('a run booked on approval, paid from the bank; a correction books its difference only', async () => {
  const run = (await call('POST', R, 'pia', { dateFrom: '2026-10-01', dateTo: '2026-10-31' })).json
    .id;
  expect((await transition(run, 'compute')).status).toBe(200);
  const approved = await transition(run, 'approve');
  expect(approved.status, JSON.stringify(approved.json)).toBe(200);
  const read = (await call('GET', `${R}/${run}?fields=entry,net`, 'pia')).json;
  const booked = await sums(read.entry?.id ?? read.entry);
  expect(booked[await accountId('6000')]).toBeCloseTo(105000, 2);
  expect(booked[await accountId('2191')]).toBeCloseTo(-2000, 2);
  expect(booked[await accountId('2190')]).toBeCloseTo(-103000, 2);
  expect(Object.values(booked).reduce((s, x) => s + x, 0)).toBeCloseTo(0, 2);

  expect((await transition(run, 'pay')).status).toBe(422); // the bank journal first
  const journals = (await call('GET', '/api/v1/models/account.journal?fields=code', 'pia')).json
    .items as Json[];
  const bank = journals.find((j) => j.code === 'BNK').id;
  expect((await call('PATCH', `${R}/${run}`, 'pia', { paymentJournal: bank })).status).toBe(200);
  const paid = await transition(run, 'pay');
  expect(paid.status, JSON.stringify(paid.json)).toBe(200);
  const payment = (await call('GET', `${R}/${run}?fields=paymentEntry`, 'pia')).json.paymentEntry;
  expect((await sums(payment?.id ?? payment))[await accountId('2190')]).toBeCloseTo(103000, 2);

  // A 3 000 bonus for Rahim afterwards: the correction books 3 000, nothing else.
  await call('POST', '/api/v1/models/payroll.input', 'pia', {
    employee: employees['rahim'],
    date: '2026-10-25',
    code: 'BONUS',
    amount: '3000',
  });
  const correction = (await call('POST', `/api/v1/payroll/runs/${run}/correction`, 'pia')).json.id;
  expect((await transition(correction, 'approve')).status).toBe(200);
  const fixed = (await call('GET', `${R}/${correction}?fields=entry`, 'pia')).json.entry;
  const diff = await sums(fixed?.id ?? fixed);
  expect(diff[await accountId('6000')]).toBeCloseTo(3000, 2);
  expect(diff[await accountId('2190')]).toBeCloseTo(-3000, 2);
  expect(diff[await accountId('2191')] ?? 0).toBeCloseTo(0, 2);
});
