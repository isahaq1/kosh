/**
 * Performance budgets (CLAUDE.md, RFC 0005 §5) on 1 000 000 orders, PostgreSQL 18 in a container, measured as API
 * time through the real server. Run with `pnpm bench` (not part of `pnpm test`: seeding takes a while).
 *
 * - pivot: 3 row levels × 12 month columns, count and sum, in < 1 000 ms
 * - CSV export of 1M rows: first bytes in < 500 ms
 * - list page of 1 000 rows with the total count in < 300 ms (10 000 rows: 10 pages, each < 300 ms)
 */
import { defineModule as defineKoshModule } from '@isahaq/kosh-modules-sdk';
import {
  type Authenticator,
  base,
  baseShutro,
  createServer,
  type KoshServer,
} from '@isahaq/kosh-server';
import { orm } from '@isahaq/kosh-server/orm';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { reporting, reportingShutro } from '../src/index.js';

const ROWS = Number(process.env['KOSH_BENCH_ROWS'] ?? 1_000_000);
const { defineGroup, defineModel, defineModule, f } = orm;

const Partner = defineModel('bench.partner', {
  access: { 'base.user': ['read'] },
  fields: { name: f.char({ required: true }) },
});
const Order = defineModel('bench.order', {
  access: { 'base.user': ['read', 'export'] },
  indexes: [{ fields: ['dateOrder'] }, { fields: ['partner', 'state'] }],
  fields: {
    name: f.char({ required: true }),
    partner: f.many2one('bench.partner', { required: true }),
    user: f.many2one('res.users', { required: true }),
    state: f.selection({ draft: 'Draft', sale: 'Confirmed', done: 'Done' }, { required: true }),
    dateOrder: f.date({ required: true }),
    amount: f.decimal({ scale: 2, required: true }),
    qty: f.integer({ required: true }),
  },
});
const benchShutro = defineModule({
  name: 'bench',
  version: '0.1.0',
  depends: [baseShutro, reportingShutro],
  groups: [defineGroup({ code: 'bench.user', label: 'Bench', implies: ['base.user'] })],
  models: [Partner, Order],
});
const bench = defineKoshModule({
  shutro: benchShutro,
  kosh: '^0.1.0',
  depends: [base, reporting],
  accessLevels: { user: { label: 'Bench', groups: ['bench.user'] } },
});

const authenticate: Authenticator = async () => ({
  user: 1,
  company: 1,
  companies: [1],
  groups: ['bench.user', 'reporting.user'],
});
let pg: StartedPostgreSqlContainer;
let server: KoshServer;
let baseUrl: string;
const results: Record<string, number> = {};

const timed = async <T>(name: string, fn: () => Promise<T>): Promise<[T, number]> => {
  const start = performance.now();
  const value = await fn();
  const ms = Math.round(performance.now() - start);
  results[name] = ms;
  return [value, ms];
};

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  pg = await new PostgreSqlContainer('postgres:18')
    .withCommand([
      'postgres',
      '-c',
      'shared_buffers=512MB',
      '-c',
      'work_mem=64MB',
      '-c',
      'max_parallel_workers_per_gather=4',
    ])
    .start();
  server = await createServer({
    databaseUrl: pg.getConnectionUri(),
    modules: [bench],
    authenticate,
    logger: false,
    rateLimit: { max: 0, timeWindow: '1 minute' },
    poolSize: 8,
  });
  for (const statement of orm.createTableStatements(server.registry.registry))
    await server.driver.query(statement);
  const q = (text: string) => server.driver.query({ text, params: [] });
  await q(
    "INSERT INTO res_users (login, name) SELECT 'u' || g, 'User ' || g FROM generate_series(1, 20) g",
  );
  await q("INSERT INTO res_currency (name) VALUES ('BDT')");
  await q("INSERT INTO res_company (name, currency_id) VALUES ('Bench Ltd', 1)");
  await q(
    "INSERT INTO bench_partner (name, created_at, updated_at) SELECT 'Partner ' || g, now(), now() FROM generate_series(1, 50) g",
  );
  const [, seedMs] = await timed('seed', () =>
    q(`INSERT INTO bench_order (name, partner_id, user_id, state, date_order, amount, qty, created_at, updated_at)
       SELECT 'SO-' || g, 1 + (g % 50), 1 + (g % 20), (ARRAY['draft','sale','done'])[1 + (g % 3)],
              DATE '2026-01-01' + ((g::bigint * 7919) % 365)::int, ((g::bigint * 37) % 100000) / 100.0, 1 + (g % 9), now(), now()
       FROM generate_series(1, ${ROWS}) g`),
  );
  await q('ANALYZE bench_order');
  process.stdout.write(`seeded ${ROWS} rows in ${seedMs} ms\n`);
  baseUrl = await server.app.listen({ port: 0, host: '127.0.0.1' });
}, 1_800_000);

afterAll(async () => {
  process.stdout.write(`\nBenchmark results (ms): ${JSON.stringify(results)}\n`);
  await server?.close();
  await pg?.stop();
});

describe('budgets', () => {
  test('pivot: 3 row levels × 12 month columns over 1M rows < 1 000 ms', async () => {
    const run = () =>
      server.app.inject({
        method: 'POST',
        url: '/api/v1/models/bench.order/report',
        payload: {
          rows: ['partner', 'state', 'user'],
          cols: ['dateOrder:month'],
          measures: { n: 'count', total: { sum: 'amount' } },
          where: { dateOrder: { gte: '2026-01-01', lt: '2027-01-01' } },
        },
      });
    await run(); // warm the planner and caches once
    // For the record: the same pivot as GROUPING SETS through the ORM, and as raw SQL (text and date buckets).
    await timed('groupingsets-orm', () =>
      server.shutro.run({ user: 1, company: 1, groups: ['bench.user'] }, (env) =>
        (
          env.model('bench.order' as never) as unknown as {
            aggregate(q: unknown): Promise<unknown[]>;
          }
        ).aggregate({
          where: { dateOrder: { gte: '2026-01-01', lt: '2027-01-01' } },
          groupBy: ['partner', 'state', 'user', 'dateOrder:month'],
          groupingSets: [
            ['partner', 'state', 'user', 'dateOrder:month'],
            ['partner', 'state', 'user'],
            ['partner', 'state', 'dateOrder:month'],
            ['partner', 'state'],
            ['partner', 'dateOrder:month'],
            ['partner'],
            ['dateOrder:month'],
            [],
          ],
          measures: { n: 'count', total: { sum: 'amount' } },
        }),
      ),
    );
    await timed('groupingsets-sql-text', () =>
      server.driver.query({
        text: `SELECT g0, g1, g2, g3, count(*) AS n, coalesce(sum(v), 0) AS total, GROUPING(g0, g1, g2, g3) AS gl FROM (SELECT partner_id AS g0, state AS g1, user_id AS g2, to_char(date_trunc('month', date_order), 'YYYY-MM-DD') AS g3, amount AS v FROM bench_order WHERE date_order >= '2026-01-01' AND date_order < '2027-01-01') t GROUP BY GROUPING SETS ((g0,g1,g2,g3),(g0,g1,g2),(g0,g1,g3),(g0,g1),(g0,g3),(g0),(g3),()) ORDER BY gl, g0, g1, g2, g3`,
        params: [],
      }),
    );
    await timed('groupingsets-sql-date', () =>
      server.driver.query({
        text: `SELECT g0, g1, g2, g3, count(*) AS n, coalesce(sum(v), 0) AS total, GROUPING(g0, g1, g2, g3) AS gl FROM (SELECT partner_id AS g0, state AS g1, user_id AS g2, date_trunc('month', date_order)::date AS g3, amount AS v FROM bench_order WHERE date_order >= '2026-01-01' AND date_order < '2027-01-01') t GROUP BY GROUPING SETS ((g0,g1,g2,g3),(g0,g1,g2),(g0,g1,g3),(g0,g1),(g0,g3),(g0),(g3),()) ORDER BY gl, g0, g1, g2, g3`,
        params: [],
      }),
    );
    const [res, ms] = await timed('pivot', run);
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200);
    const report = res.json() as {
      cols: { children: unknown[] };
      rows: { children: unknown[] };
      statements: number;
    };
    expect(report.cols.children).toHaveLength(12);
    expect(report.rows.children).toHaveLength(50);
    expect(report.statements).toBe(1);
    expect(ms).toBeLessThan(1_000);
  }, 120_000);

  test('CSV export of 1M rows: first bytes < 500 ms (and the whole file streams)', async () => {
    const start = performance.now();
    const response = await fetch(`${baseUrl}/api/v1/models/bench.order/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fields: ['name', 'state', 'amount'] }),
    });
    expect(response.status).toBe(200);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    const firstMs = Math.round(performance.now() - start);
    results['csv-first-bytes'] = firstMs;
    expect(new TextDecoder().decode(first.value).startsWith('id,name,state,amount')).toBe(true);
    expect(firstMs).toBeLessThan(500);
    let bytes = first.value?.length ?? 0;
    let lines = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      for (const b of value) if (b === 10) lines++;
    }
    results['csv-total'] = Math.round(performance.now() - start);
    results['csv-bytes'] = bytes;
    expect(lines).toBeGreaterThanOrEqual(ROWS);
  }, 600_000);

  test('list page of 1 000 rows with the count over 1M < 300 ms; 10 000 rows in 10 pages', async () => {
    const page = (offset: number) =>
      server.app.inject({
        url: `/api/v1/models/bench.order?fields=name,partner,state,dateOrder,amount&limit=1000&offset=${offset}&count=true&order=id asc`,
      });
    await page(0);
    const [res, ms] = await timed('list-1000', () => page(0));
    expect(res.statusCode).toBe(200);
    expect(res.json().count).toBe(ROWS);
    expect(ms).toBeLessThan(300);
    let worst = 0;
    const start = performance.now();
    for (let i = 1; i < 10; i++) {
      const t = performance.now();
      expect((await page(i * 1000)).statusCode).toBe(200);
      worst = Math.max(worst, performance.now() - t);
    }
    results['list-10k-total'] = Math.round(performance.now() - start);
    results['list-page-worst'] = Math.round(worst);
    expect(worst).toBeLessThan(300);
  }, 120_000);
});
