/**
 * Payroll on real PostgreSQL through the HTTP API (RFC 0024 §2.3): a structure's rules with their formulas (a broken
 * one refused), contracts on it, approved attendance (overtime, an absence) and a day not approved (a warning), a
 * loan and a bonus; the run computed with each line explained; officers compute, managers approve — the loan's
 * instalment recorded; people read their own payslips once approved; payment files per method; a correction pays
 * the difference; the next month reads the year so far; the demo data loads.
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
import { STANDARD_RULES } from '../src/demo.js';
import { payroll } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [base, settings, payroll];
const R = '/api/v1/models/payroll.run';
const SLIPS = '/api/v1/models/payroll.slip';
const RUNS = '/api/v1/payroll/runs';

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let host: AppHost;
let company: number;
let structure: number;
let october: number;
const employees: Record<string, number> = {};
const tokens = new Map<string, string>();

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function call(
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  as: string,
  payload?: unknown,
): Promise<{ status: number; json: Json; body: string }> {
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
  const json =
    res.headers['content-type']?.toString().includes('json') && res.body !== '' ? res.json() : null;
  return { status: res.statusCode, json, body: res.body };
}
const run = (id: number, transition: string, as: string) =>
  call('POST', `${R}/${id}/transitions/${transition}`, as);
const slipOf = async (runId: number, who: string, as = 'pia') =>
  (
    await call(
      'GET',
      `${SLIPS}?filter=${encodeURIComponent(JSON.stringify({ run: runId, employee: employees[who] }))}&fields=gross,deductions,net,difference,warnings,previousNet`,
      as,
    )
  ).json.items[0];
const linesOf = async (slip: number) =>
  Object.fromEntries(
    (
      (
        await call(
          'GET',
          `/api/v1/models/payroll.slip.line?filter=${encodeURIComponent(JSON.stringify({ slip }))}&fields=code,amount,explanation&limit=50`,
          'pia',
        )
      ).json.items as Json[]
    ).map((l) => [l.code, l]),
  );

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-payroll-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({ driver, catalogue, change: { install: ['settings', 'payroll'] }, dir }),
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
  const users: Record<string, number> = {};
  for (const [login, groups] of [
    ['pia', ['payroll.manager', 'hr.manager', 'attendance.manager']],
    ['otto', ['payroll.officer']],
    ['rahim', ['payroll.user']],
    ['sumi', ['payroll.user']],
  ] as const)
    users[login] = await auth.createUser({
      login,
      name: login,
      password: PASSWORD,
      company,
      companies: [company],
      groups: [...groups],
    });
  const made = await call('POST', '/api/v1/models/payroll.structure', 'pia', {
    name: 'Standard',
    rules: {
      create: [
        ...STANDARD_RULES.map((r) => ({ ...r })),
        {
          sequence: 90,
          code: 'YTD_BASIC_SEEN',
          name: 'Basic this year so far',
          category: 'info',
          formula: 'YTD_BASIC',
        },
      ],
    },
  });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  structure = made.json.id;
  for (const [who, wage, method] of [
    ['rahim', '45000', { payMethod: 'bank', bankName: 'Sonali Bank', bankAccount: '0001234567' }],
    [
      'sumi',
      '60000',
      { payMethod: 'wallet', walletProvider: 'bkash', walletNumber: '01700000000' },
    ],
  ] as const) {
    employees[who] = (
      await call('POST', '/api/v1/models/hr.employee', 'pia', {
        name: who,
        user: users[who],
        hireDate: '2025-01-01',
        ...method,
      })
    ).json.id;
    const contract = await call('POST', '/api/v1/models/hr.contract', 'pia', {
      name: `${who} employment`,
      employee: employees[who],
      dateStart: '2025-01-01',
      wage,
      structure,
    });
    expect(contract.status, JSON.stringify(contract.json)).toBe(201);
    expect(
      (
        await call(
          'POST',
          `/api/v1/models/hr.contract/${contract.json.id}/transitions/start`,
          'pia',
        )
      ).status,
    ).toBe(200);
  }
}, 240_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('a broken formula is refused; the formula check names the variables', async () => {
  const bad = await call('POST', '/api/v1/models/payroll.rule', 'pia', {
    structure,
    code: 'BROKEN',
    name: 'Broken',
    formula: 'WAGE *',
  });
  expect(bad.status).toBe(422);
  const checked = await call('POST', '/api/v1/payroll/formula', 'otto', {
    formula: 'max(0, WAGE - BASIC)',
  });
  expect(checked.json).toEqual({ ok: true, variables: ['BASIC', 'WAGE'] });
  expect((await call('POST', '/api/v1/payroll/formula', 'otto', { formula: 'x' })).json.ok).toBe(
    false,
  );
});

test('October: attendance, a loan and a bonus into explained payslips; approved by a manager only', async () => {
  // Rahim: one approved absence, one approved day with two hours' overtime, one day not yet approved.
  const D = '/api/v1/models/attendance.day';
  const day = async (date: string, values: Record<string, unknown>, approve: boolean) => {
    const res = await call('POST', D, 'pia', { employee: employees['rahim'], date, ...values });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    if (approve)
      expect((await call('POST', `${D}/${res.json.id}/transitions/approve`, 'pia')).status).toBe(
        200,
      );
  };
  await day('2026-10-05', { status: 'absent' }, true);
  await day('2026-10-06', { status: 'present', overtimeHours: '2', overtimeApproved: '2' }, true);
  await day('2026-10-07', { status: 'present' }, false);
  const loan = await call('POST', '/api/v1/models/payroll.loan', 'otto', {
    employee: employees['rahim'],
    amount: '6000',
    installment: '2000',
    dateStart: '2026-10-01',
  });
  expect(loan.status, JSON.stringify(loan.json)).toBe(201);
  expect(
    (await call('POST', `/api/v1/models/payroll.loan/${loan.json.id}/transitions/start`, 'otto'))
      .status,
  ).toBe(403);
  expect(
    (await call('POST', `/api/v1/models/payroll.loan/${loan.json.id}/transitions/start`, 'pia'))
      .status,
  ).toBe(200);
  expect(
    (
      await call('POST', '/api/v1/models/payroll.input', 'otto', {
        employee: employees['sumi'],
        date: '2026-10-15',
        code: 'BONUS',
        amount: '5000',
      })
    ).status,
  ).toBe(201);

  const created = await call('POST', R, 'otto', {
    title: 'October 2026',
    dateFrom: '2026-10-01',
    dateTo: '2026-10-31',
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  october = created.json.id;
  const computed = await run(october, 'compute', 'otto');
  expect(computed.status, JSON.stringify(computed.json)).toBe(200);

  const rahim = await slipOf(october, 'rahim');
  const lines = await linesOf(rahim.id);
  expect(Number(lines['BASIC'].amount)).toBe(27000);
  expect(lines['BASIC'].explanation).toBe('45000 × 0.6 × 31 ÷ 31 = 27000');
  expect(Number(lines['HOUSE_RENT'].amount)).toBe(10800);
  expect(Number(lines['OTHER'].amount)).toBe(7200);
  expect(Number(lines['OVERTIME'].amount)).toBe(519.23); // 27000 / 208 × 2 × 2
  expect(Number(lines['ABSENCE'].amount)).toBe(900);
  expect(Number(lines['LOAN'].amount)).toBe(2000);
  expect(lines['BONUS']).toBeUndefined(); // its condition is not met
  expect(Number(rahim.gross)).toBe(45519.23);
  expect(Number(rahim.deductions)).toBe(2900);
  expect(Number(rahim.net)).toBe(42619.23);
  expect(rahim.warnings).toMatch(/1 attendance day/);
  const sumi = await slipOf(october, 'sumi');
  expect(Number(sumi.gross)).toBe(65000);

  // Not visible to the people before approval; approved by a manager only; the loan instalment recorded.
  expect((await call('GET', `${SLIPS}?fields=net`, 'rahim')).json.items).toEqual([]);
  expect((await run(october, 'approve', 'otto')).status).toBe(403);
  const approved = await run(october, 'approve', 'pia');
  expect(approved.status, JSON.stringify(approved.json)).toBe(200);
  const read = (
    await call('GET', `/api/v1/models/payroll.loan/${loan.json.id}?fields=repaid,remaining`, 'pia')
  ).json;
  expect(Number(read.repaid)).toBe(2000);
  expect(Number(read.remaining)).toBe(4000);
  // Locked: the run is not computed again.
  expect((await run(october, 'compute', 'pia')).status).toBe(409);
  // People read their own payslips, now.
  const mine = (await call('GET', `${SLIPS}?fields=employee,net`, 'rahim')).json.items as Json[];
  expect(mine).toHaveLength(1);
  expect(Number(mine[0].net)).toBe(42619.23);
});

test('payment files per method; a correction pays the difference; November reads the year so far', async () => {
  const bank = await call('GET', `${RUNS}/${october}/payment-file?format=bank`, 'otto');
  expect(bank.status, bank.body).toBe(200);
  expect(bank.body).toContain('Sonali Bank,,0001234567,,42619.23');
  expect(bank.body).not.toContain('01700000000');
  const bkash = await call('GET', `${RUNS}/${october}/payment-file?format=bkash`, 'otto');
  expect(bkash.body.split('\r\n')[1]).toMatch(/^01700000000,65000\.00,PAY\//);
  expect((await call('GET', `${RUNS}/${october}/payment-file?format=bank`, 'rahim')).status).toBe(
    403,
  );

  // A late bonus for Rahim in October: a correction run pays only the difference.
  await call('POST', '/api/v1/models/payroll.input', 'otto', {
    employee: employees['rahim'],
    date: '2026-10-20',
    code: 'BONUS',
    amount: '3000',
  });
  expect((await call('POST', `/api/v1/payroll/runs/${october}/correction`, 'otto')).status).toBe(
    403,
  );
  const correction = await call('POST', `/api/v1/payroll/runs/${october}/correction`, 'pia');
  expect(correction.status, JSON.stringify(correction.json)).toBe(201);
  const fixed = await slipOf(correction.json.id, 'rahim');
  expect(Number(fixed.previousNet)).toBe(42619.23);
  expect(Number(fixed.difference)).toBe(3000);
  expect(Number((await slipOf(correction.json.id, 'sumi')).difference)).toBe(0);
  expect((await run(correction.json.id, 'approve', 'pia')).status).toBe(200);
  const paid = await call('GET', `${RUNS}/${correction.json.id}/payment-file?format=bank`, 'otto');
  expect(paid.body).toContain(',3000.00,');
  expect(paid.body).not.toContain('42619.23');

  // November: the year so far reads October's (corrected) payslip.
  const november = await call('POST', R, 'otto', { dateFrom: '2026-11-01', dateTo: '2026-11-30' });
  expect((await run(november.json.id, 'compute', 'otto')).status).toBe(200);
  const lines = await linesOf((await slipOf(november.json.id, 'rahim')).id);
  expect(Number(lines['YTD_BASIC_SEEN'].amount)).toBe(27000);
});

test('the demo data loads', async () => {
  const auth = host.server.auth;
  if (auth === undefined) throw new Error('base is installed');
  const summary = await installDemo({
    write: (line: string) => process.stderr.write(`DEMO ${line}\n`),
    shutro: host.server.shutro,
    auth,
    driver,
    modules: host.server.registry.loaded.modules,
    company,
  });
  expect(JSON.stringify(summary)).toContain('Payroll');
});
