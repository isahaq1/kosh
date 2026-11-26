/**
 * How the leave accrual scales (RFC 0039 §6): every person of a company earns their months by the plan and has
 * their balance brought up to date — the run a server makes every six hours. Measured for the first run (ten
 * months to write for everybody), a run that has nothing to write, and the run after a month has ended.
 *
 * `KOSH_BENCH_EMPLOYEES` (default 2 000). Run with `pnpm bench accrual` (not part of `pnpm test`).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accrueLeave, hrAccrual } from '@kosh/hr_accrual';
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
const catalogue = [base, settings, hrAccrual];

let container: StartedPostgreSqlContainer;
let driver: Driver;
let host: AppHost;
let company: number;
const results: Record<string, number | string> = {};

type Model = {
  create(rows: readonly unknown[]): Promise<{ ids: number[] }>;
};
/** Seeding as the system, without the activity log: what is measured is the run, not the seed. */
const seed = <T>(fn: (model: (name: string) => Model) => Promise<T>): Promise<T> =>
  host.server.shutro.bootstrap({ reason: 'bench seed', company }, (env) => {
    const quiet = (
      env as unknown as { withFlags(flags: unknown): { model(name: string): unknown } }
    ).withFlags({ tracking: false });
    return fn((name) => quiet.model(name) as Model);
  });
const runOn = (today: string): Promise<number> =>
  host.server.shutro.bootstrap({ reason: 'bench', company }, (env) =>
    accrueLeave(env as never, today),
  );
const count = async (text: string): Promise<number> =>
  Number((await driver.query<{ n: string }>({ text, params: [] }))[0]?.n);

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
  const dir = mkdtempSync(join(tmpdir(), 'kosh-bench-accrual-'));
  await recordInstalledApps(driver, [], [], 'bench');
  await applyApps(
    await prepareApps({ driver, catalogue, change: { install: ['settings', 'hr_accrual'] }, dir }),
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

  const seeded = performance.now();
  await seed(async (model) => {
    const [type] = (await model('hr.leave.type').create([{ name: 'Earned leave (bench)' }])).ids;
    await model('hr.accrual.plan').create([
      { name: 'A day and a half a month', type, dateStart: '2026-01-01', formula: '1.5', company },
    ]);
  });
  for (let start = 0; start < EMPLOYEES; start += 500) {
    const n = Math.min(500, EMPLOYEES - start);
    await seed((model) =>
      model('hr.employee').create(
        Array.from({ length: n }, (_, i) => ({
          name: `Employee ${start + i + 1}`,
          hireDate: '2026-01-01',
        })),
      ),
    );
  }
  results['seeding: seconds'] = Math.round((performance.now() - seeded) / 1000);
});

afterAll(async () => {
  process.stdout.write(`\naccrual bench\n${JSON.stringify(results, null, 2)}\n`);
  await host?.close();
  await driver?.end();
  await container?.stop();
});

test(`the leave of ${EMPLOYEES} people: ten months at once, nothing to do, a month more`, async () => {
  const timed = async (title: string, today: string) => {
    const start = performance.now();
    const lines = await runOn(today);
    const ms = Math.round(performance.now() - start);
    results[`${title}: ledger lines`] = lines;
    results[`${title}: seconds`] = Math.round(ms / 100) / 10;
    results[`${title}: ms per person`] = Math.round((ms / EMPLOYEES) * 100) / 100;
    return { ms, lines };
  };
  // January to October are over on 26 November: ten lines a person.
  const first = await timed('ten months', '2026-11-26');
  expect(first.lines).toBe(EMPLOYEES * 10);
  expect(await count('SELECT count(*)::text AS n FROM hr_accrual_balance')).toBe(EMPLOYEES);
  // Fifteen days each, to the hundredth.
  expect(
    await count(`SELECT count(*)::text AS n FROM hr_accrual_balance WHERE balance <> 15`),
  ).toBe(0);
  // The same day again: nothing to write.
  const again = await timed('nothing to do', '2026-11-26');
  expect(again.lines).toBe(0);
  // December: November is over.
  const next = await timed('a month more', '2026-12-03');
  expect(next.lines).toBe(EMPLOYEES);
  expect(
    await count(`SELECT count(*)::text AS n FROM hr_accrual_balance WHERE balance <> 16.5`),
  ).toBe(0);
  // RFC 0039 §6: the run every six hours ends within ten minutes at the size asked for, in proportion.
  expect(again.ms).toBeLessThan((600_000 * EMPLOYEES) / 30_000 + 10_000);
  expect(next.ms).toBeLessThan((600_000 * EMPLOYEES) / 30_000 + 10_000);
});
