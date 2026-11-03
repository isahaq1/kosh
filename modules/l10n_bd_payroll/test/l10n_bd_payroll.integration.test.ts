/**
 * Bangladesh payroll on real PostgreSQL (RFC 0024 §2.3, `l10n_bd_payroll`): proposed with the localization and
 * Payroll; its structures, parameters and tax tables installed once; a standard payslip split into basic, house
 * rent, medical and conveyance with provident fund and income tax at source from the year's projection, exemption,
 * slabs and investment rebate — the next month deducting what is left over the months left; a garments payslip on
 * the minimum wage breakdown with its festival bonus after a year's service, and none before.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accounting } from '@kosh/accounting';
import { l10nBd } from '@kosh/l10n_bd';
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
import { l10nBdPayroll } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [base, settings, accounting, l10nBd, payroll, l10nBdPayroll];
const R = '/api/v1/models/payroll.run';

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let host: AppHost;
const structures: Record<string, number> = {};
const employees: Record<string, number> = {};
const tokens = new Map<string, string>();

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function call(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) {
  let token = tokens.get('pia');
  if (token === undefined) {
    const login = await host.server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { login: 'pia', password: PASSWORD },
    });
    token = (login.json() as { token: string }).token;
    tokens.set('pia', token);
  }
  const res = await host.server.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: res.statusCode, json: (res.body === '' ? null : res.json()) as Json };
}
const q = (filter: Record<string, unknown>) => encodeURIComponent(JSON.stringify(filter));
async function person(
  name: string,
  wage: string,
  structure: string,
  hired: string,
  values: Record<string, string> = {},
) {
  const id = (await call('POST', '/api/v1/models/hr.employee', { name, hireDate: hired })).json
    .id as number;
  const c = await call('POST', '/api/v1/models/hr.contract', {
    name,
    employee: id,
    dateStart: hired,
    wage,
    structure: structures[structure],
  });
  expect(c.status, JSON.stringify(c.json)).toBe(201);
  await call('POST', `/api/v1/models/hr.contract/${c.json.id}/transitions/start`);
  for (const [code, value] of Object.entries(values))
    expect(
      (
        await call('POST', '/api/v1/models/payroll.employee.value', {
          employee: id,
          code,
          value,
          dateFrom: '2026-07-01',
        })
      ).status,
    ).toBe(201);
  employees[name] = id;
}
async function runFor(from: string, to: string, extra: Record<string, unknown> = {}) {
  const run = (await call('POST', R, { dateFrom: from, dateTo: to, ...extra })).json.id as number;
  const computed = await call('POST', `${R}/${run}/transitions/compute`);
  expect(computed.status, JSON.stringify(computed.json)).toBe(200);
  return run;
}
async function linesOf(run: number, who: string) {
  const [slip] = (
    await call(
      'GET',
      `/api/v1/models/payroll.slip?filter=${q({ run, employee: employees[who] })}&fields=gross,deductions,contributions,net`,
    )
  ).json.items as Json[];
  const lines = (
    await call(
      'GET',
      `/api/v1/models/payroll.slip.line?filter=${q({ slip: slip.id })}&fields=code,amount&limit=50`,
    )
  ).json.items as Json[];
  return {
    slip,
    amount: Object.fromEntries(lines.map((l) => [l.code, Number(l.amount)])) as Record<
      string,
      number
    >,
  };
}

test('the plan proposes Bangladesh payroll with the localization and Payroll', () => {
  const plan = planApps(catalogue, [], { install: ['l10n_bd', 'payroll'] });
  expect(plan.install.find((i) => i.name === 'l10n_bd_payroll')).toEqual({
    name: 'l10n_bd_payroll',
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
  dir = await mkdtemp(join(tmpdir(), 'kosh-l10n-bd-payroll-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({
      driver,
      catalogue,
      change: { install: ['settings', 'l10n_bd', 'payroll'] },
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
    groups: ['payroll.manager', 'hr.manager'],
  });
  for (const s of (await call('GET', '/api/v1/models/payroll.structure?fields=name')).json
    .items as Json[])
    structures[s.name] = s.id;
}, 240_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('installed once: two structures, the parameters and the tax tables, each with its source to verify', async () => {
  expect(Object.keys(structures).sort()).toEqual([
    'Bangladesh — garments (RMG)',
    'Bangladesh — standard',
  ]);
  const slabs = (
    await call(
      'GET',
      `/api/v1/models/payroll.slab?filter=${q({ code: 'BD_TAX' })}&fields=dateFrom,note`,
    )
  ).json.items as Json[];
  expect(slabs).toHaveLength(2);
  expect(slabs.every((s) => /Verify/.test(s.note))).toBe(true);
  // A second pass adds nothing and keeps what a manager changed.
  const [cap] = (
    await call(
      'GET',
      `/api/v1/models/payroll.parameter?filter=${q({ code: 'BD_MIN_TAX' })}&fields=value`,
    )
  ).json.items as Json[];
  expect(
    (await call('PATCH', `/api/v1/models/payroll.parameter/${cap.id}`, { value: '4000' })).status,
  ).toBe(200);
  const [row] = await driver.query<{ id: number }>({
    text: 'SELECT id FROM res_company LIMIT 1',
    params: [],
  });
  await installDefaults(host.server.shutro, host.server.registry.loaded.modules, {
    company: row?.id as number,
  });
  const after = (
    await call(
      'GET',
      `/api/v1/models/payroll.parameter?filter=${q({ code: 'BD_MIN_TAX' })}&fields=value`,
    )
  ).json.items as Json[];
  expect(after).toHaveLength(1);
  expect(Number(after[0].value)).toBe(4000);
  await call('PATCH', `/api/v1/models/payroll.parameter/${cap.id}`, { value: '5000' });
});

test('standard: the split, provident fund, and tax at source spread over the year', async () => {
  await person('Farhana', '100000', 'Bangladesh — standard', '2024-01-01', {
    PF_MEMBER: '1',
    INVESTMENT: '200000',
  });
  const july = await runFor('2026-07-01', '2026-07-31');
  const { slip, amount } = await linesOf(july, 'Farhana');
  expect([amount['BASIC'], amount['HOUSE_RENT'], amount['MEDICAL'], amount['CONVEYANCE']]).toEqual([
    60000, 30000, 6000, 4000,
  ]);
  expect(amount['PF_EMPLOYEE']).toBe(6000);
  expect(amount['PF_EMPLOYER']).toBe(6000);
  // 1 200 000 projected; a third exempt (400 000); 800 000 taxable: 0 on 3 75 000, 10% on 3 00 000, 15% on 1 25 000.
  expect(amount['ANNUAL_INCOME']).toBe(1200000);
  expect(amount['TAX_EXEMPT']).toBe(400000);
  expect(amount['TAX_GROSS']).toBe(48750);
  expect(amount['TAX_REBATE']).toBe(24000); // 3% of 800 000, below 15% of the 200 000 invested
  expect(amount['TAX_YEAR']).toBe(24750);
  expect(amount['TDS']).toBeGreaterThanOrEqual(2062);
  expect(amount['TDS']).toBeLessThanOrEqual(2063);
  expect(Number(slip.gross)).toBe(100000);
  expect(Number(slip.net)).toBe(100000 - 6000 - (amount['TDS'] as number));
  expect(Number(slip.contributions)).toBe(6000);

  expect((await call('POST', `${R}/${july}/transitions/approve`)).status).toBe(200);
  const august = await runFor('2026-08-01', '2026-08-31');
  const next = (await linesOf(august, 'Farhana')).amount;
  // What is left of the year's tax over the eleven months left.
  expect(next['TDS']).toBe(Math.round((24750 - (amount['TDS'] as number)) / 11));
});

test('garments: the minimum wage breakdown; the festival bonus after a year, not before; no tax due', async () => {
  await person('Rina', '12500', 'Bangladesh — garments (RMG)', '2024-03-01');
  await person('Nupur', '12500', 'Bangladesh — garments (RMG)', '2026-03-01');
  const eid = await runFor('2026-09-01', '2026-09-30', {
    festival: true,
    title: 'September with the Eid bonus',
  });
  const rina = (await linesOf(eid, 'Rina')).amount;
  expect([
    rina['BASIC'],
    rina['HOUSE_RENT'],
    rina['MEDICAL'],
    rina['CONVEYANCE'],
    rina['FOOD'],
  ]).toEqual([6700, 3350, 750, 450, 1250]);
  expect(rina['FESTIVAL_BONUS']).toBe(6700);
  expect(rina['TDS']).toBeUndefined();
  const nupur = (await linesOf(eid, 'Nupur')).amount;
  expect(nupur['FESTIVAL_BONUS']).toBeUndefined(); // six months' service
});
