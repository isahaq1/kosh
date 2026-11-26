/**
 * How Attendance's days scale (RFC 0039 §5b): every person's day is computed — from their punches, shift,
 * calendar, leave, tours and home office —, for one day and for a week, through the API as an Attendance manager
 * does it. People have a shift; half of them punched in and out on the first day, the others are absent.
 *
 * `KOSH_BENCH_EMPLOYEES` (default 2 000). Run with `pnpm bench attendance` (not part of `pnpm test`).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attendance, attendanceWorker } from '@kosh/attendance';
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
const PASSWORD = 'correct horse battery';
const catalogue = [base, settings, attendance];
// A Sunday to the next Saturday: five working days and the weekend of the standard week.
const FIRST = '2026-11-01';
const LAST = '2026-11-07';

let container: StartedPostgreSqlContainer;
let driver: Driver;
let host: AppHost;
let company: number;
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
  search(q: unknown): Promise<{ ids: number[] }>;
};
/** Seeding as the system, without the activity log: what is measured is the computation, not the seed. */
const seed = <T>(fn: (model: (name: string) => Model) => Promise<T>): Promise<T> =>
  host.server.shutro.bootstrap({ reason: 'bench seed', company }, (env) => {
    const quiet = (
      env as unknown as { withFlags(flags: unknown): { model(name: string): unknown } }
    ).withFlags({ tracking: false });
    return fn((name) => quiet.model(name) as Model);
  });

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
  const dir = mkdtempSync(join(tmpdir(), 'kosh-bench-attendance-'));
  await recordInstalledApps(driver, [], [], 'bench');
  await applyApps(
    await prepareApps({ driver, catalogue, change: { install: ['settings', 'attendance'] }, dir }),
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
    login: 'hana',
    name: 'Hana',
    password: PASSWORD,
    company,
    companies: [company],
    groups: ['attendance.manager', 'hr.manager'],
  });
  const login = await host.server.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { login: 'hana', password: PASSWORD },
  });
  token = (login.json() as { token: string }).token;

  const seeded = performance.now();
  for (let start = 0; start < EMPLOYEES; start += 500) {
    const n = Math.min(500, EMPLOYEES - start);
    await seed(async (model) => {
      const [shift] = (await model('attendance.shift').search({ where: { name: 'General' } })).ids;
      const employees = (
        await model('hr.employee').create(
          Array.from({ length: n }, (_, i) => ({
            name: `Employee ${start + i + 1}`,
            attendanceShift: shift,
          })),
        )
      ).ids;
      // Every other person came on the first day, nine to six (Dhaka: UTC+6).
      await model('attendance.record').create(
        employees
          .filter((_, i) => i % 2 === 0)
          .map((employee) => ({
            employee,
            checkIn: new Date(`${FIRST}T03:00:00Z`),
            checkOut: new Date(`${FIRST}T12:00:00Z`),
            source: 'manual',
          })),
      );
    });
  }
  results['seeding: seconds'] = Math.round((performance.now() - seeded) / 1000);
});

afterAll(async () => {
  process.stdout.write(`\nattendance bench\n${JSON.stringify(results, null, 2)}\n`);
  await host?.close();
  await driver?.end();
  await container?.stop();
});

test(`the days of ${EMPLOYEES} people: one day, then a week`, async () => {
  const timed = async (title: string, from: string, to: string) => {
    const start = performance.now();
    const computed = await call('POST', '/api/v1/attendance/days/compute', { from, to });
    expect(computed.status, JSON.stringify(computed.json).slice(0, 400)).toBe(200);
    results[`${title}: the request answered in ms`] = Math.round(performance.now() - start);
    // More than a request computes at once goes to the jobs, a job per 500 people: the worker is driven here.
    results[`${title}: jobs`] = computed.json.queued;
    if (computed.json.queued > 0) {
      const worker = attendanceWorker({ shutro: host.server.shutro });
      while ((await worker.drain()) > 0);
    }
    const ms = Math.round(performance.now() - start);
    const [counted] = await driver.query<{ n: string }>({
      text: 'SELECT count(*)::text AS n FROM attendance_day WHERE date BETWEEN $1 AND $2',
      params: [from, to],
    });
    const written = Number(counted?.n);
    results[`${title}: days`] = written;
    results[`${title}: seconds`] = Math.round(ms / 100) / 10;
    results[`${title}: ms per person`] = Math.round((ms / EMPLOYEES) * 100) / 100;
    return { ms, written };
  };
  const one = await timed('one day', FIRST, FIRST);
  // Everybody has a day: present for those who punched, absent for the others.
  expect(one.written).toBe(EMPLOYEES);
  const [counts] = await driver.query<{ present: string; absent: string }>({
    text: `SELECT count(*) FILTER (WHERE status = 'present')::text AS present,
                  count(*) FILTER (WHERE status = 'absent')::text AS absent
             FROM attendance_day WHERE date = $1`,
    params: [FIRST],
  });
  expect(Number(counts?.present)).toBe(Math.ceil(EMPLOYEES / 2));
  expect(Number(counts?.absent)).toBe(Math.floor(EMPLOYEES / 2));
  const week = await timed('a week', FIRST, LAST);
  // Five working days a person; the weekend has nothing to say.
  expect(week.written).toBe(EMPLOYEES * 5);
  // RFC 0039 §5b: a day for everybody in under a minute at the size asked for, in proportion.
  expect(one.ms).toBeLessThan((60_000 * EMPLOYEES) / 30_000 + 5_000);
});
