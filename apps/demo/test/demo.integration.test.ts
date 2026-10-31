/**
 * The demo data (RFC 0008 §5.8) on real PostgreSQL: every app installed with its bridges, the demo loaded once
 * (a second run adds nothing), made by the demo users so that the API shows it to them: orders at every stage,
 * approvals waiting, posted and paid invoices, draft invoices from the orders, projects with timesheets.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AppHost,
  applyApps,
  createAppHost,
  DEMO_PASSWORD,
  installBase,
  installDefaults,
  installDemo,
  prepareApps,
  recordInstalledApps,
} from '@kosh/server';
import { type Driver, orm, pg } from '@kosh/server/orm';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { DEMO_APPS, demoCatalogue } from '../src/catalogue.js';

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let host: AppHost;
let company: number;
let loaded: { module: string; summary: string }[];
const tokens = new Map<string, string>();

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function get(url: string, as: string): Promise<Json> {
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
    method: 'GET',
    url,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}
const filter = (where: unknown) => `filter=${encodeURIComponent(JSON.stringify(where))}`;

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-demo-'));
  const catalogue = demoCatalogue();
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({ driver, catalogue, change: { install: [...DEMO_APPS] }, dir }),
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
    admin: { login: 'admin', name: 'Administrator', password: DEMO_PASSWORD },
  }));
  await installDefaults(host.server.shutro, host.server.registry.loaded.modules, { company });
  loaded = await installDemo({
    shutro: host.server.shutro,
    auth,
    driver: host.server.driver,
    modules: host.server.registry.loaded.modules,
    company,
  });
}, 300_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('every app with demo data loaded it, once', async () => {
  // In dependency order (the registry's): an app after the apps it reads from, a bridge after both of its apps.
  const order = loaded.map((l) => l.module);
  expect([...order].sort()).toEqual([
    'accounting',
    'calendar',
    'contacts',
    'crm',
    'event',
    'hr',
    'maintenance',
    'mrp',
    'product',
    'project',
    'purchase',
    'purchase_account',
    'purchase_stock',
    'recruitment',
    'sale_account',
    'sale_project',
    'sale_stock',
    'sales',
    'stock',
    'todo',
    'trade_finance',
  ]);
  for (const [app, bridge] of [
    ['sales', 'sale_account'],
    ['purchase', 'purchase_account'],
    ['project', 'sale_project'],
    ['stock', 'sale_stock'],
    ['stock', 'mrp'],
    ['purchase', 'purchase_stock'],
    ['contacts', 'sales'],
  ])
    expect(order.indexOf(app as string)).toBeLessThan(order.indexOf(bridge as string));
  const auth = host.server.auth;
  if (auth === undefined) throw new Error('base is installed');
  const again = await installDemo({
    shutro: host.server.shutro,
    auth,
    driver: host.server.driver,
    modules: host.server.registry.loaded.modules,
    company,
  });
  expect(again).toEqual([]);
  const marks = await driver.query<{ n: string }>({
    text: 'SELECT count(*)::text AS n FROM kosh_module WHERE demo_at IS NOT NULL',
    params: [],
  });
  expect(Number(marks[0]?.n)).toBe(21);
});

test('the salesperson sees the orders and the invoices made from them; the buyer the approvals', async () => {
  const orders = await get('/api/v1/models/sale.order?fields=state&order=id+asc', 'rahim');
  expect(orders.items.map((o: Json) => o.state)).toEqual(['sale', 'sale', 'sale', 'sent', 'draft']);
  const invoices = await get(
    `/api/v1/models/account.move?fields=state,paymentState&${filter({ kind: 'out_invoice' })}&order=id+asc`,
    'rahim',
  );
  // Three posted by the accounting demo (one paid, one in part), three drafts from the confirmed orders, and three
  // for the paid places at Event Hub's supplier day.
  expect(invoices.items.map((i: Json) => i.state)).toEqual([
    'posted',
    'posted',
    'posted',
    'draft',
    'draft',
    'draft',
    'draft',
    'draft',
    'draft',
  ]);
  expect(invoices.items.map((i: Json) => i.paymentState).slice(0, 3)).toEqual([
    'partial',
    'paid',
    'not_paid',
  ]);
  const purchases = await get('/api/v1/models/purchase.order?fields=state&order=id+asc', 'karim');
  expect(purchases.items.map((o: Json) => o.state)).toEqual([
    'purchase',
    'purchase',
    'purchase',
    'to_approve',
    'draft',
  ]);
  const bills = await get(
    `/api/v1/models/account.move?fields=state&${filter({ kind: 'in_invoice' })}`,
    'dina',
  );
  expect(bills.items).toHaveLength(2 + 3); // two posted bills, three drafts from the confirmed orders
  const inbox = await get('/api/v1/approvals/inbox', 'dina');
  expect(inbox.requests).toHaveLength(1); // the generator waits for the purchase manager
});

test('projects, tasks and the timesheets of their authors; the service products create tasks', async () => {
  const projects = await get('/api/v1/models/project.project?fields=name,taskCount,hours', 'sumi');
  expect(projects.items.map((p: Json) => [p.name, p.taskCount])).toEqual([
    ['Bengal Steel plant extension', 3],
    ['Customer support', 2],
  ]);
  const mine = await get('/api/v1/models/project.timesheet?fields=hours', 'sumi');
  expect(mine.items).toHaveLength(3);
  const all = await get('/api/v1/models/project.timesheet?fields=hours', 'dina');
  expect(all.items).toHaveLength(5);
  const products = await get(
    `/api/v1/models/product.product?fields=name,serviceTracking&${filter({ kind: 'service' })}&order=name+asc`,
    'dina',
  );
  expect(products.items.map((p: Json) => [p.name, p.serviceTracking])).toEqual([
    ['Consulting day', 'none'],
    ['Installation hours', 'task'],
    ['Site audit', 'project'],
  ]);
});
