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
import { type TestDatabase, testDatabase } from '@kosh/server/testing';
import { settings } from '@kosh/settings';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { STANDARD_RULES } from '../src/demo.js';
import { payroll, payrollWorker } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [base, settings, payroll];
const R = '/api/v1/models/payroll.run';
const SLIPS = '/api/v1/models/payroll.slip';
const RUNS = '/api/v1/payroll/runs';

let container: TestDatabase;
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
  container = await testDatabase();
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
        {
          sequence: 91,
          code: 'HOME_SEEN',
          name: 'Days of home office',
          category: 'info',
          formula: 'REMOTE_DAYS + PRESENT_DAYS / 100',
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
  // An approved day of home office (RFC 0039 §3): present, and counted on its own.
  await day('2026-10-08', { status: 'remote' }, true);
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
  // One day of home office, and two days present with it (the approved day at work, and the one at home).
  expect(Number(lines['HOME_SEEN'].amount)).toBe(1.02);
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

test('a large run is computed by the job, a batch at a time: it shows how far it is, waits to be approved, and a failing formula stops it by name', async () => {
  process.env['KOSH_PAYROLL_BATCH'] = '100';
  // 230 more people on the structure: more than a request computes at once.
  type Model = {
    create(rows: readonly unknown[]): Promise<{ ids: number[] }>;
    browse(ids: readonly number[]): { start(): Promise<void> };
  };
  await host.server.shutro.bootstrap({ reason: 'test: people', company }, async (env) => {
    const model = (name: string) => env.model(name as never) as unknown as Model;
    const made = (
      await model('hr.employee').create(
        Array.from({ length: 230 }, (_, i) => ({
          name: `Person ${i + 1}`,
          hireDate: '2025-01-01',
        })),
      )
    ).ids;
    const contracts = (
      await model('hr.contract').create(
        made.map((employee, i) => ({
          name: `Employment ${i + 1}`,
          employee,
          dateStart: '2025-01-01',
          wage: String(20_000 + i * 100),
          structure,
        })),
      )
    ).ids;
    await model('hr.contract').browse(contracts).start();
  });
  const figures = async (id: number) =>
    (
      await call(
        'GET',
        `${R}/${id}?fields=state,toCompute,computedCount,slipCount,gross,net,computeError`,
        'otto',
      )
    ).json;
  const january = await call('POST', R, 'otto', { dateFrom: '2027-01-01', dateTo: '2027-01-31' });
  const id = january.json.id as number;
  // Pressed: answered at once, nothing computed yet.
  expect((await run(id, 'compute', 'otto')).status).toBe(200);
  const started = await figures(id);
  expect(started.toCompute).toBeGreaterThanOrEqual(230);
  expect(started).toMatchObject({ state: 'computed', computedCount: 0, slipCount: 0 });
  // Not approved, and not computed a second time, while the job is at it.
  const early = await run(id, 'approve', 'pia');
  expect(early.status).toBe(409);
  expect(JSON.stringify(early.json)).toContain('wait until everybody is computed');
  expect(JSON.stringify((await run(id, 'compute', 'otto')).json)).toContain('being computed');

  const worker = payrollWorker({ shutro: host.server.shutro });
  // One batch, committed: the run says how far it is.
  expect(await worker.drain()).toBe(Math.ceil(started.toCompute / 100));
  const done = await figures(id);
  expect(done).toMatchObject({
    computedCount: started.toCompute,
    slipCount: started.toCompute,
    computeError: null,
  });
  // One payslip a person, and the run's figures are the payslips' sums.
  const [sums] = await driver.query<{ n: string; people: string; gross: string; net: string }>({
    text: `SELECT count(*)::text AS n, count(DISTINCT employee_id)::text AS people,
                  sum(gross)::text AS gross, sum(net)::text AS net FROM payroll_slip WHERE run_id = $1`,
    params: [id],
  });
  expect(Number(sums?.n)).toBe(started.toCompute);
  expect(Number(sums?.people)).toBe(started.toCompute);
  expect(Number(done.gross)).toBe(Number(sums?.gross));
  expect(Number(done.net)).toBe(Number(sums?.net));
  // Person 1 is paid like anybody: 20 000 a month on the standard structure.
  const [first] = (
    await call(
      'GET',
      `${SLIPS}?filter=${encodeURIComponent(JSON.stringify({ run: id, 'employee.name': 'Person 1' }))}&fields=gross`,
      'pia',
    )
  ).json.items as Json[];
  expect(Number(first.gross)).toBe(20000);
  expect((await run(id, 'approve', 'pia')).status).toBe(200);

  // A formula that fails on somebody: the batches before stay, the run names the person and the rule, and is
  // not approved; fixed, it is computed again from the start.
  const broken = await call('POST', '/api/v1/models/payroll.rule', 'pia', {
    structure,
    sequence: 95,
    code: 'SHARE',
    name: 'A share of nothing',
    category: 'info',
    formula: 'WAGE / (MONTH - MONTH)',
  });
  expect(broken.status, JSON.stringify(broken.json)).toBe(201);
  const february = await call('POST', R, 'otto', { dateFrom: '2027-02-01', dateTo: '2027-02-28' });
  expect((await run(february.json.id, 'compute', 'otto')).status).toBe(200);
  await worker.drain();
  const stopped = await figures(february.json.id);
  expect(String(stopped.computeError), JSON.stringify(stopped)).toMatch(/rule SHARE/);
  expect(stopped.computedCount).toBe(0);
  expect((await run(february.json.id, 'approve', 'pia')).status).toBe(409);
  expect(
    (
      await call('PATCH', `/api/v1/models/payroll.rule/${broken.json.id}`, 'pia', {
        formula: 'WAGE / 2',
      })
    ).status,
  ).toBe(200);
  expect((await run(february.json.id, 'compute', 'otto')).status).toBe(200);
  await worker.drain();
  const fixed = await figures(february.json.id);
  expect(fixed).toMatchObject({ computeError: null, computedCount: fixed.toCompute });
  // What the server keeps is not typed in.
  expect(
    (await call('PATCH', `${R}/${february.json.id}`, 'pia', { computedCount: 0, gross: '1' }))
      .status,
  ).toBeGreaterThanOrEqual(400);
  delete process.env['KOSH_PAYROLL_BATCH'];
});

test('a temporary person paid by the day: the pay basis, the employment type and the shifts in the rules', async () => {
  const first = async (model: string, where: unknown) =>
    (
      await call(
        'GET',
        `/api/v1/models/${model}?filter=${encodeURIComponent(JSON.stringify(where))}&limit=1`,
        'pia',
      )
    ).json.items[0] as Json;
  // Shipped employment types: temporary people among them.
  const temporary = await first('hr.contract.type', { code: 'TEMP' });
  expect(temporary?.name).toBe('Temporary');
  const night = await first('attendance.shift', { name: 'Night' });
  const daily = await call('POST', '/api/v1/models/payroll.structure', 'pia', {
    name: 'Daily wage',
    rules: {
      create: [
        // By the day: the wage for each day worked; a monthly person on this structure would get nothing here.
        {
          sequence: 1,
          code: 'BASIC',
          name: 'Days worked',
          category: 'basic',
          formula: 'WAGE * PRESENT_DAYS',
          condition: 'PAID_BY_DAY',
        },
        {
          sequence: 2,
          code: 'NIGHT',
          name: 'Night allowance',
          category: 'allowance',
          formula: 'NIGHT_SHIFTS * 100',
        },
        { sequence: 3, code: 'T_TEMP', name: 'Temporary', category: 'info', formula: 'TYPE_TEMP' },
        { sequence: 4, code: 'T_PERM', name: 'Permanent', category: 'info', formula: 'TYPE_PERM' },
        { sequence: 5, code: 'HOURS', name: 'Hours', category: 'info', formula: 'WORKED_HOURS' },
        { sequence: 6, code: 'LATE', name: 'Late', category: 'info', formula: 'LATE_MINUTES' },
        {
          sequence: 7,
          code: 'OFF',
          name: 'Off days',
          category: 'info',
          formula: 'OFF_DAYS_WORKED',
        },
        {
          sequence: 8,
          code: 'BY_HOUR',
          name: 'By hour',
          category: 'info',
          formula: 'PAID_BY_HOUR',
        },
        // Leave told apart: unpaid days, paid days, and each type by its code (a type not taken is 0).
        {
          sequence: 9,
          code: 'LEAVES',
          name: 'Leave',
          category: 'info',
          formula:
            'UNPAID_LEAVE_DAYS * 1000 + PAID_LEAVE_DAYS * 100 + LEAVE_LWP * 10 + LEAVE_CL + LEAVE_SL * 5',
        },
      ],
    },
  });
  expect(daily.status, JSON.stringify(daily.json)).toBe(201);
  const karim = (
    await call('POST', '/api/v1/models/hr.employee', 'pia', {
      name: 'Karim',
      hireDate: '2027-03-01',
    })
  ).json.id as number;
  employees['karim'] = karim;
  const contract = await call('POST', '/api/v1/models/hr.contract', 'pia', {
    name: 'Karim, three months',
    employee: karim,
    employmentType: temporary.id,
    kind: 'fixed',
    payBasis: 'day',
    dateStart: '2027-03-01',
    dateEnd: '2027-05-31',
    wage: '800',
    structure: daily.json.id,
  });
  expect(contract.status, JSON.stringify(contract.json)).toBe(201);
  expect(
    (await call('POST', `/api/v1/models/hr.contract/${contract.json.id}/transitions/start`, 'pia'))
      .status,
  ).toBe(200);
  // Three approved days: one late by a quarter of an hour, one on the night shift, one on a Friday (a day off).
  const D = '/api/v1/models/attendance.day';
  for (const values of [
    { date: '2027-03-01', workedHours: '8', expectedHours: '8', lateMinutes: 15 },
    { date: '2027-03-02', workedHours: '7.5', expectedHours: '7.5', shift: night.id },
    { date: '2027-03-05', workedHours: '5', expectedHours: '0' },
  ]) {
    const made = await call('POST', D, 'pia', { employee: karim, status: 'present', ...values });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    expect((await call('POST', `${D}/${made.json.id}/transitions/approve`, 'pia')).status).toBe(
      200,
    );
  }
  // A day of unpaid leave and a day of casual leave, approved by HR, and their days in Attendance.
  for (const [code, date] of [
    ['LWP', '2027-03-08'],
    ['CL', '2027-03-09'],
  ] as const) {
    const type = await first('hr.leave.type', { code });
    expect(type?.paid).toBe(code !== 'LWP');
    const leave = await call('POST', '/api/v1/models/hr.leave', 'pia', {
      employee: karim,
      type: type.id,
      dateFrom: date,
      dateTo: date,
      days: 1,
    });
    expect(leave.status, JSON.stringify(leave.json)).toBe(201);
    for (const step of ['submit', 'approve'])
      expect(
        (await call('POST', `/api/v1/models/hr.leave/${leave.json.id}/transitions/${step}`, 'pia'))
          .status,
        `${code} ${step}`,
      ).toBe(200);
    const made = await call('POST', D, 'pia', { employee: karim, status: 'leave', date });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    expect((await call('POST', `${D}/${made.json.id}/transitions/approve`, 'pia')).status).toBe(
      200,
    );
  }
  const march = await call('POST', R, 'otto', { dateFrom: '2027-03-01', dateTo: '2027-03-31' });
  expect((await run(march.json.id, 'compute', 'otto')).status).toBe(200);
  await payrollWorker({ shutro: host.server.shutro }).drain();
  const slip = await slipOf(march.json.id, 'karim');
  const lines = await linesOf(slip.id);
  expect(Number(lines['BASIC'].amount)).toBe(2400); // 800 a day, three days
  expect(Number(lines['NIGHT'].amount)).toBe(100);
  expect(Number(lines['T_TEMP'].amount)).toBe(1);
  expect(Number(lines['T_PERM'].amount)).toBe(0);
  expect(Number(lines['HOURS'].amount)).toBe(20.5);
  expect(Number(lines['LATE'].amount)).toBe(15);
  expect(Number(lines['OFF'].amount)).toBe(1);
  expect(Number(lines['BY_HOUR'].amount)).toBe(0);
  expect(Number(slip.gross)).toBe(2500);
  // One unpaid day (1000), one paid day (100), one of the LWP type (10), one casual (1), no sick leave.
  expect(Number(lines['LEAVES'].amount)).toBe(1111);
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
