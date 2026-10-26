/**
 * Performance budgets of the business apps (CLAUDE.md, RFC 0008 §5.7) on PostgreSQL 18 in a container, measured
 * as API time through the real server on the demo data plus 10 000 sales orders and 1 000 posted invoices made
 * through the ORM as the demo users. Run with `pnpm bench` (not part of `pnpm test`: seeding takes a while).
 *
 * App manager: plan < 500 ms · install Sales on a fresh database < 5 s · disable or enable an app < 1 s · the
 * other node serves the new set < 1 s after the change.
 * Workloads: an 80-row and a 1 000-row order list page with the count < 300 ms · search and the kanban's
 * aggregate < 300 ms · an order's form with its lines < 150 ms · confirm an order < 300 ms · post an invoice
 * < 300 ms · trial balance and aged balances over 1 000 invoices < 500 ms.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planApps } from '@kosh/modules-sdk';
import {
  type AppHost,
  applyApps,
  createAppHost,
  DEMO_PASSWORD,
  installBase,
  installDefaults,
  installDemo,
  prepareApps,
  readInstalledApps,
  recordInstalledApps,
} from '@kosh/server';
import { type Driver, orm, pg } from '@kosh/server/orm';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { DEMO_APPS, demoCatalogue } from '../src/catalogue.js';

const ORDERS = Number(process.env['KOSH_BENCH_ORDERS'] ?? 10_000);
const INVOICES = Number(process.env['KOSH_BENCH_INVOICES'] ?? 1_000);
const catalogue = demoCatalogue();

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let host: AppHost;
let other: AppHost;
let company: number;
const results: Record<string, number> = {};
const tokens = new Map<string, string>();

const timed = async <T>(name: string, fn: () => Promise<T>): Promise<[T, number]> => {
  const start = performance.now();
  const value = await fn();
  const ms = Math.round(performance.now() - start);
  results[name] = ms;
  return [value, ms];
};
const median = (xs: readonly number[]): number =>
  [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

// biome-ignore lint/suspicious/noExplicitAny: the benchmark reads untyped JSON responses
type Json = any;
async function call(
  method: 'GET' | 'POST',
  url: string,
  as: string,
  payload?: unknown,
): Promise<{ status: number; json: Json; body: string }> {
  let token = tokens.get(as);
  if (token === undefined) {
    const login = await host.server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { login: as, password: DEMO_PASSWORD },
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
  return { status: res.statusCode, json: res.body === '' ? null : res.json(), body: res.body };
}
const ok = (r: { status: number; body: string }) =>
  expect(r.status, r.body.slice(0, 300)).toBe(200);
const filter = (where: unknown) => `filter=${encodeURIComponent(JSON.stringify(where))}`;

type Rows = { readonly ids: readonly number[]; load(spec: unknown): Promise<Rows> } & Record<
  string,
  unknown
>;
type Model = {
  search(q: unknown): Promise<Rows>;
  create(rows: readonly unknown[]): Promise<Rows>;
  browse(ids: readonly number[]): Rows & { post(): Promise<void> };
};
const asUser = <T>(
  user: number,
  groups: readonly string[],
  fn: (model: (name: string) => Model) => Promise<T>,
): Promise<T> =>
  host.server.shutro.run(
    { user, company, companies: [company], groups, reason: 'bench seed' },
    (env) => fn((name) => env.model(name as never) as unknown as Model),
  );

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
  dir = mkdtempSync(join(tmpdir(), 'kosh-bench-apps-'));
  await recordInstalledApps(driver, [], [], 'bench');
  // RFC 0008 §5.7: install Sales on a fresh database (its dependencies come along) < 5 s.
  await timed('install-sales', async () =>
    applyApps(await prepareApps({ driver, catalogue, change: { install: ['sales'] }, dir }), {
      driver,
      dir,
      actor: 'bench',
    }),
  );
  await applyApps(
    await prepareApps({
      driver,
      catalogue,
      change: { install: DEMO_APPS.filter((a) => a !== 'sales') },
      dir,
    }),
    { driver, dir, actor: 'bench' },
  );
  const hostOptions = {
    databaseUrl: container.getConnectionUri(),
    catalogue,
    migrationsDir: dir,
    logger: false as const,
    auth: { secureCookies: false, cacheMs: 0, loginLimit: 0 },
    rateLimit: { max: 0, timeWindow: '1 minute' },
    poolSize: 8,
  };
  host = await createAppHost(hostOptions);
  other = await createAppHost(hostOptions); // the second node: rebuilds on NOTIFY
  const auth = host.server.auth;
  if (auth === undefined) throw new Error('base is installed');
  ({ company } = await installBase(host.server.shutro, auth, {
    company: { name: 'Padma Traders', currency: 'BDT' },
    admin: { login: 'admin', name: 'Administrator', password: DEMO_PASSWORD },
  }));
  await installDefaults(host.server.shutro, host.server.registry.loaded.modules, { company });
  await installDemo({
    shutro: host.server.shutro,
    auth,
    driver: host.server.driver,
    modules: host.server.registry.loaded.modules,
    company,
  });
  // Volume, as the demo users through the ORM: orders with a line each, invoices posted.
  const [rahim] = await driver.query<{ id: number }>({
    text: "SELECT id FROM res_users WHERE login = 'rahim'",
    params: [],
  });
  const uid = rahim?.id as number;
  const ids = await asUser(uid, ['sales.user', 'account.user'], async (model) => {
    const partners = (await model('res.partner').search({ where: { isCustomer: true } })).ids;
    const product = (
      await model('product.product').search({ where: { name: 'Steel beam IPE 200' }, limit: 1 })
    ).ids[0] as number;
    const vat = (await model('account.tax').search({ where: { name: 'VAT 15%' }, limit: 1 }))
      .ids[0] as number;
    const [currency] = await driver.query<{ id: number }>({
      text: "SELECT id FROM res_currency WHERE name = 'BDT'",
      params: [],
    });
    const journal = (await model('account.journal').search({ where: { code: 'INV' }, limit: 1 }))
      .ids[0] as number;
    return { partners, product, vat, currency: currency?.id as number, journal };
  });
  const [, orderMs] = await timed('seed-orders', async () => {
    for (let at = 0; at < ORDERS; at += 500) {
      const n = Math.min(500, ORDERS - at);
      await asUser(uid, ['sales.user'], async (model) => {
        await model('sale.order').create(
          Array.from({ length: n }, (_, i) => {
            const g = at + i;
            return {
              partner: orm.asId(ids.partners[g % ids.partners.length] as number, 'res.partner'),
              currency: orm.asId(ids.currency, 'res.currency'),
              dateOrder: new Date(Date.UTC(2026, 0, 1 + (g % 300))).toISOString().slice(0, 10),
              clientReference: `REF-${g}`,
              lines: {
                create: [
                  {
                    product: orm.asId(ids.product, 'product.product'),
                    name: 'Steel beam IPE 200',
                    quantity: String(1 + (g % 9)),
                    priceUnit: '85000',
                    tax: orm.asId(ids.vat, 'account.tax'),
                  },
                ],
              },
            };
          }),
        );
      });
    }
  });
  const [, invoiceMs] = await timed('seed-invoices', async () => {
    for (let at = 0; at < INVOICES; at += 50) {
      const n = Math.min(50, INVOICES - at);
      await asUser(uid, ['account.user'], async (model) => {
        for (let i = 0; i < n; i++) {
          const g = at + i;
          const created = await model('account.move').create([
            {
              kind: 'out_invoice',
              journal: orm.asId(ids.journal, 'account.journal'),
              partner: orm.asId(ids.partners[g % ids.partners.length] as number, 'res.partner'),
              currency: orm.asId(ids.currency, 'res.currency'),
              date: new Date(Date.UTC(2026, 0, 1 + (g % 290))).toISOString().slice(0, 10),
              ref: `INV-REF-${g}`,
              lines: {
                create: [
                  {
                    lineKind: 'product',
                    product: orm.asId(ids.product, 'product.product'),
                    name: 'Steel beam IPE 200',
                    quantity: String(1 + (g % 5)),
                    priceUnit: '85000',
                    tax: orm.asId(ids.vat, 'account.tax'),
                  },
                ],
              },
            },
          ]);
          await model('account.move').browse(created.ids).post();
        }
      });
    }
  });
  await driver.query({ text: 'ANALYZE', params: [] });
  process.stdout.write(
    `seeded ${ORDERS} orders in ${orderMs} ms and ${INVOICES} posted invoices in ${invoiceMs} ms\n`,
  );
}, 1_800_000);

afterAll(async () => {
  process.stdout.write(`\nBenchmark results (ms): ${JSON.stringify(results)}\n`);
  await other?.close();
  await host?.close();
  await driver?.end();
  await container?.stop();
});

/** Waits until `node` rebuilt (its generation moved past `from`); the time it took, or -1 after `limitMs`. */
async function rebuilt(node: AppHost, from: number, limitMs: number): Promise<number> {
  const start = performance.now();
  while (performance.now() - start < limitMs) {
    if (node.generation > from) return Math.round(performance.now() - start);
    await new Promise((r) => setTimeout(r, 5));
  }
  return -1;
}

describe('app manager (RFC 0008 §5.7)', () => {
  test('install Sales on a fresh database < 5 s (measured during set-up)', () => {
    expect(results['install-sales']).toBeLessThan(5_000);
  });

  test('plan an app change against the live database < 500 ms', async () => {
    const installed = (await readInstalledApps(driver)) ?? [];
    const [, pure] = await timed('plan-pure', async () =>
      planApps(catalogue, installed, { disable: ['project'] }),
    );
    const [, live] = await timed('plan-live', () =>
      prepareApps({ driver, catalogue, change: { disable: ['project'] }, dir }),
    );
    expect(pure).toBeLessThan(50);
    expect(live).toBeLessThan(500);
  });

  test('disable and enable an app < 1 s each; the other node serves the new set < 1 s after', async () => {
    for (const change of [{ disable: ['project'] }, { enable: ['project'] }] as const) {
      const name = 'disable' in change ? 'disable' : 'enable';
      const before = other.generation;
      const [, ms] = await timed(`${name}-project`, async () =>
        applyApps(await prepareApps({ driver, catalogue, change, dir }), {
          driver,
          dir,
          actor: 'bench',
        }),
      );
      expect(ms).toBeLessThan(1_000);
      const rebuild = await rebuilt(other, before, 5_000);
      results[`${name}-rebuild-other-node`] = rebuild;
      expect(rebuild).toBeGreaterThanOrEqual(0);
      expect(rebuild).toBeLessThan(1_000);
      await rebuilt(host, before, 5_000); // this node too, before the next step uses it
    }
    const projects = await call('GET', '/api/v1/models/project.project?limit=1', 'dina');
    ok(projects); // served again
  }, 60_000);
});

describe('Odoo-like workloads', () => {
  const LIST = '/api/v1/models/sale.order?fields=name,partner,dateOrder,state,amountTotal';

  test(`order list pages with the count over ${ORDERS} orders < 300 ms`, async () => {
    const page = (limit: number, offset: number) =>
      call(
        'GET',
        `${LIST}&limit=${limit}&offset=${offset}&count=true&order=dateOrder desc`,
        'rahim',
      );
    ok(await page(80, 0)); // warm
    const [first, ms80] = await timed('list-80', () => page(80, 0));
    ok(first);
    expect(first.json.count).toBeGreaterThanOrEqual(ORDERS);
    expect(ms80).toBeLessThan(300);
    const [, ms1000] = await timed('list-1000', () => page(1000, 2000));
    expect(ms1000).toBeLessThan(300);
  }, 60_000);

  test('search by partner and state, and the kanban aggregate < 300 ms', async () => {
    const where = { 'partner.name': { ilike: '%Steel%' }, state: 'draft' };
    const search = () =>
      call('GET', `${LIST}&${filter(where)}&limit=80&count=true&order=dateOrder desc`, 'rahim');
    ok(await search());
    const [res, ms] = await timed('search', search);
    ok(res);
    expect(res.json.count).toBeGreaterThan(0);
    expect(ms).toBeLessThan(300);
    const aggregate = () =>
      call('POST', '/api/v1/models/sale.order/aggregate', 'rahim', {
        groupBy: ['state'],
        measures: { n: 'count', total: { sum: 'amountTotal' } },
      });
    ok(await aggregate());
    const [agg, aggMs] = await timed('kanban-aggregate', aggregate);
    ok(agg);
    expect(agg.json.rows.length).toBeGreaterThan(0);
    expect(aggMs).toBeLessThan(300);
  }, 60_000);

  test("an order's form with its lines < 150 ms; confirming an order < 300 ms", async () => {
    const drafts = await call(
      'GET',
      `/api/v1/models/sale.order?fields=id&${filter({ state: 'draft' })}&limit=11&order=id desc`,
      'rahim',
    );
    ok(drafts);
    const ids = (drafts.json.items as { id: number }[]).map((o) => o.id);
    const form = (id: number) =>
      Promise.all([
        call('GET', `/api/v1/models/sale.order/${id}`, 'rahim'),
        call(
          'GET',
          `/api/v1/models/sale.order.line?${filter({ order: id })}&fields=product,name,quantity,priceUnit,tax,subtotal&order=id asc`,
          'rahim',
        ),
      ]);
    await form(ids[0] as number);
    const [[record, lines], formMs] = await timed('form', () => form(ids[0] as number));
    ok(record);
    ok(lines);
    expect(lines.json.items).toHaveLength(1);
    expect(formMs).toBeLessThan(150);
    const times: number[] = [];
    for (const id of ids.slice(1)) {
      const start = performance.now();
      ok(await call('POST', `/api/v1/models/sale.order/${id}/transitions/confirm`, 'rahim'));
      times.push(performance.now() - start);
    }
    results['confirm-median'] = Math.round(median(times));
    expect(median(times)).toBeLessThan(300);
  }, 60_000);

  test(`post an invoice < 300 ms; trial balance and aged balances over ${INVOICES} invoices < 500 ms`, async () => {
    const drafts = await call(
      'GET',
      `/api/v1/models/account.move?fields=id&${filter({ kind: 'out_invoice', state: 'draft' })}&limit=10`,
      'rahim',
    );
    ok(drafts);
    const times: number[] = [];
    for (const { id } of drafts.json.items as { id: number }[]) {
      const start = performance.now();
      ok(await call('POST', `/api/v1/models/account.move/${id}/transitions/post`, 'rahim'));
      times.push(performance.now() - start);
    }
    expect(times.length).toBeGreaterThan(0); // the demo's draft invoices from the orders
    results['post-median'] = Math.round(median(times));
    expect(median(times)).toBeLessThan(300);

    const trialBalance = () =>
      call('POST', '/api/v1/models/account.move.line/report', 'dina', {
        rows: ['account'],
        measures: {
          debit: { sum: 'debit' },
          credit: { sum: 'credit' },
          balance: { sum: 'balance' },
        },
        where: { posted: true },
      });
    ok(await trialBalance());
    const [tb, tbMs] = await timed('trial-balance', trialBalance);
    ok(tb);
    expect(tb.json.rows.children.length).toBeGreaterThan(3);
    expect(tbMs).toBeLessThan(500);
    const aging = () => call('GET', '/api/v1/accounting/reports/aging?type=receivable', 'dina');
    ok(await aging());
    const [ag, agMs] = await timed('aging', aging);
    ok(ag);
    expect(ag.json.rows.length).toBeGreaterThan(0);
    expect(agMs).toBeLessThan(500);
  }, 120_000);
});
