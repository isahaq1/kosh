/**
 * How a payroll run scales (asked 2026-11-25: "more than 30 000 employees?"). On PostgreSQL 18 in a container,
 * through the real server: employees with a running contract on the standard structure and a month of attendance
 * days, then the run computed by the API as a payroll officer does — once with a first group of people, once
 * with all of them, so the time per person at two sizes says whether it grows with the size.
 *
 * `KOSH_BENCH_EMPLOYEES` (default 2 000; the first run takes a quarter of them) · `KOSH_BENCH_DAYS` (default 26).
 * Run with `pnpm bench payroll` (not part of `pnpm test`).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { payroll, payrollWorker, STANDARD_RULES } from '@kosh/payroll';
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

const EMPLOYEES = Number(process.env['KOSH_BENCH_EMPLOYEES'] ?? 2_000);
const DAYS = Number(process.env['KOSH_BENCH_DAYS'] ?? 26);
const FIRST = Math.max(1, Math.floor(EMPLOYEES / 4));
const PASSWORD = 'correct horse battery';
const catalogue = [base, settings, payroll];

let container: StartedPostgreSqlContainer;
let driver: Driver;
let host: AppHost;
let company: number;
let structure: number;
let token = '';
const results: Record<string, number | string> = {};

// biome-ignore lint/suspicious/noExplicitAny: the benchmark reads untyped JSON responses
type Json = any;
async function call(method: 'GET' | 'POST', url: string, payload?: unknown) {
  const res = await host.server.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: res.statusCode, json: (res.body === '' ? null : res.json()) as Json };
}
type Model = {
  create(rows: readonly unknown[]): Promise<{ ids: number[] }>;
  browse(ids: readonly number[]): { start(): Promise<void> };
};
/** Seeding as the system, without the activity log: what is measured is the run, not the seed. */
const seed = <T>(fn: (model: (name: string) => Model) => Promise<T>): Promise<T> =>
  host.server.shutro.bootstrap({ reason: 'bench seed', company }, (env) => {
    const quiet = (
      env as unknown as { withFlags(flags: unknown): { model(name: string): unknown } }
    ).withFlags({ tracking: false });
    return fn((name) => quiet.model(name) as Model);
  });

/** Employees `from`…`to` (exclusive) with a running contract and their attendance days of two months. */
async function people(from: number, to: number): Promise<void> {
  for (let start = from; start < to; start += 250) {
    const n = Math.min(250, to - start);
    await seed(async (model) => {
      const employees = (
        await model('hr.employee').create(
          Array.from({ length: n }, (_, i) => ({
            name: `Employee ${start + i + 1}`,
            hireDate: '2024-01-01',
            payMethod: 'bank',
            bankName: 'Sonali Bank',
            bankAccount: String(1_000_000 + start + i),
          })),
        )
      ).ids;
      const contracts = (
        await model('hr.contract').create(
          employees.map((employee, i) => ({
            name: `Employment ${start + i + 1}`,
            employee,
            dateStart: '2024-01-01',
            wage: String(20_000 + ((start + i) % 40) * 1_000),
            structure,
          })),
        )
      ).ids;
      await model('hr.contract').browse(contracts).start();
      for (const month of ['10', '11'])
        await model('attendance.day').create(
          employees.flatMap((employee) =>
            Array.from({ length: DAYS }, (_, d) => ({
              employee,
              date: `2026-${month}-${String(d + 1).padStart(2, '0')}`,
              status: 'present',
            })),
          ),
        );
    });
  }
}

async function computeRun(title: string, from: string, to: string): Promise<number> {
  const created = await call('POST', '/api/v1/models/payroll.run', {
    title,
    dateFrom: from,
    dateTo: to,
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const start = performance.now();
  const computed = await call(
    'POST',
    `/api/v1/models/payroll.run/${created.json.id}/transitions/compute`,
  );
  expect(computed.status, JSON.stringify(computed.json).slice(0, 400)).toBe(200);
  results[`${title}: the request answered in ms`] = Math.round(performance.now() - start);
  // A large run is computed by the job, a batch per job (RFC 0039 §2): the worker is driven here.
  const worker = payrollWorker({ shutro: host.server.shutro });
  let batches = 0;
  for (;;) {
    const did = await worker.drain();
    if (did === 0) break;
    batches += did;
  }
  const ms = Math.round(performance.now() - start);
  results[`${title}: batches`] = batches;
  const run = await call(
    'GET',
    `/api/v1/models/payroll.run/${created.json.id}?fields=slipCount,toCompute,computedCount,computeError`,
  );
  expect(run.json.computeError).toBeNull();
  expect(run.json.computedCount).toBe(run.json.toCompute);
  results[`${title}: payslips`] = run.json.slipCount;
  results[`${title}: seconds`] = Math.round(ms / 100) / 10;
  results[`${title}: ms per person`] = Math.round((ms / run.json.slipCount) * 10) / 10;
  return ms / run.json.slipCount;
}

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  container = await new PostgreSqlContainer('postgres:18')
    .withCommand(['postgres', '-c', 'shared_buffers=512MB', '-c', 'work_mem=64MB'])
    .start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  const dir = mkdtempSync(join(tmpdir(), 'kosh-bench-payroll-'));
  await recordInstalledApps(driver, [], [], 'bench');
  await applyApps(
    await prepareApps({ driver, catalogue, change: { install: ['settings', 'payroll'] }, dir }),
    { driver, dir, actor: 'bench' },
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
  await auth.createUser({
    login: 'pia',
    name: 'Pia',
    password: PASSWORD,
    company,
    companies: [company],
    groups: ['payroll.manager', 'hr.manager', 'attendance.manager'],
  });
  const login = await host.server.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { login: 'pia', password: PASSWORD },
  });
  token = (login.json() as { token: string }).token;
  const made = await call('POST', '/api/v1/models/payroll.structure', {
    name: 'Standard',
    rules: { create: STANDARD_RULES.map((r) => ({ ...r })) },
  });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  structure = made.json.id;
});

afterAll(async () => {
  process.stdout.write(`\npayroll bench\n${JSON.stringify(results, null, 2)}\n`);
  await host?.close();
  await driver?.end();
  await container?.stop();
});

test(`a payroll run of ${FIRST} people, then of ${EMPLOYEES}: the time, and whether it grows with the size`, async () => {
  const seeded = performance.now();
  await people(0, FIRST);
  const small = await computeRun('October', '2026-10-01', '2026-10-31');
  await people(FIRST, EMPLOYEES);
  results['seeding: seconds'] = Math.round((performance.now() - seeded) / 1000);
  const large = await computeRun('November', '2026-11-01', '2026-11-30');
  results['per person, large against small'] = `${Math.round((large / small) * 100)} %`;
  // RFC 0039 §2: the time per person does not grow with the size of the run, and 30 000 people take under ten
  // minutes (the budget is checked at the size asked for).
  expect(large / small).toBeLessThan(2);
  expect(large * EMPLOYEES).toBeLessThan((600_000 * EMPLOYEES) / 30_000);
});
