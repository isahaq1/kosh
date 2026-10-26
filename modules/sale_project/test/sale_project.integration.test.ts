/**
 * The Sales ↔ Projects bridge on real PostgreSQL (RFC 0008 §5.1): installing Sales and Projects proposes the
 * bridge; confirming an order whose service products ask for tasks creates them through the outbox, once (a line
 * served is not served twice), in the product's project or in a project made for the order; goods lines create
 * nothing.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planApps } from '@kosh/modules-sdk';
import { project } from '@kosh/project';
import { sales } from '@kosh/sales';
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
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { saleProject, saleProjectWorker } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [base, sales, project, saleProject];

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let host: AppHost;
let company: number;
let bdt: number;
let customer: number;
let goods: number;
let hours: number;
let audit: number;
let supportProject: number;
const tokens = new Map<string, string>();

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function call(
  method: 'GET' | 'POST',
  url: string,
  as: string,
  payload?: unknown,
): Promise<{ status: number; json: Json }> {
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
  return { status: res.statusCode, json: res.body === '' ? null : res.json() };
}
const expectStatus = (r: { status: number; json: Json }, status: number) =>
  expect(r.status, JSON.stringify(r.json)).toBe(status);

test('the plan proposes the bridge when Sales and Projects come', () => {
  const plan = planApps(catalogue, [], { install: ['sales', 'project'] });
  expect(plan.install.find((i) => i.name === 'sale_project')).toEqual({
    name: 'sale_project',
    reason: 'bridge',
  });
});

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off'; // the test drains the subscriber itself
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-sale-project-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({ driver, catalogue, change: { install: ['sales', 'project'] }, dir }),
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
  await auth.createUser({
    login: 'sumi',
    name: 'Sumi',
    password: PASSWORD,
    company,
    companies: [company],
    groups: ['sale_project.user'],
  });
  const ids = await host.server.shutro.bootstrap({ reason: 'test: data', company }, async (env) => {
    type Model = { create(rows: unknown[]): Promise<{ ids: number[] }> };
    const model = (name: string) => env.model(name as never) as unknown as Model;
    const [row] = await env.sql<{ id: number }>`SELECT id FROM res_currency WHERE name = 'BDT'`;
    const c = await model('res.partner').create([
      { name: 'Bengal Steel', isCompany: true, isCustomer: true },
    ]);
    const products = await model('product.product').create([
      { name: 'Steel beam', listPrice: '1000' },
      { name: 'Installation hours', kind: 'service', listPrice: '50', serviceTracking: 'task' },
      { name: 'Site audit', kind: 'service', listPrice: '5000', serviceTracking: 'project' },
    ]);
    return { bdt: row?.id as number, customer: c.ids[0] as number, products: products.ids };
  });
  bdt = ids.bdt;
  customer = ids.customer;
  [goods, hours, audit] = ids.products as [number, number, number];
  // The support project and the product's link to it, as a user would make them.
  const sp = await call('POST', '/api/v1/models/project.project', 'sumi', { name: 'Support desk' });
  expectStatus(sp, 201);
  supportProject = sp.json.id as number;
  await host.server.shutro.bootstrap({ reason: 'test: product project', company }, async (env) => {
    await env.sql`UPDATE product_product SET project_id = ${supportProject} WHERE id = ${hours}`;
  });
}, 180_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('confirming an order creates the tasks its service lines ask for, once', async () => {
  const worker = saleProjectWorker({ shutro: host.server.shutro });
  const order = await call('POST', '/api/v1/models/sale.order', 'sumi', {
    partner: customer,
    currency: bdt,
    lines: {
      create: [
        { product: goods, name: 'Steel beam', quantity: '2', priceUnit: '1000' },
        { product: hours, name: 'Installation', quantity: '16', priceUnit: '50' },
        { product: audit, name: 'Site audit', quantity: '1', priceUnit: '5000' },
      ],
    },
  });
  expectStatus(order, 201);
  expectStatus(
    await call('POST', `/api/v1/models/sale.order/${order.json.id}/transitions/confirm`, 'sumi'),
    200,
  );
  expect(
    (await call('GET', `/api/v1/models/sale.order/${order.json.id}?fields=taskCount`, 'sumi')).json
      .taskCount,
  ).toBe(0); // not yet: the outbox
  expect(await worker.drain()).toBe(1);
  const tasks = await call(
    'GET',
    `/api/v1/models/project.task?filter=${encodeURIComponent(JSON.stringify({ saleOrder: order.json.id }))}&fields=name,project,plannedHours,partner,saleLine&order=id+asc`,
    'sumi',
  );
  expect(tasks.json.items).toHaveLength(2); // goods create nothing
  const [installation, siteAudit] = tasks.json.items as Json[];
  expect(installation).toMatchObject({
    project: supportProject,
    plannedHours: '16',
    partner: customer,
  });
  expect(installation.name).toMatch(/^SO\/.*: Installation$/);
  expect(siteAudit.project).not.toBe(supportProject); // a project of its own, named after the order
  const own = await call(
    'GET',
    `/api/v1/models/project.project/${siteAudit.project}?fields=name,saleOrder,partner`,
    'sumi',
  );
  expect(own.json).toMatchObject({ saleOrder: order.json.id, partner: customer });
  expect(own.json.name).toMatch(/^SO\/.* Bengal Steel$/);
  expect(
    (await call('GET', `/api/v1/models/sale.order/${order.json.id}?fields=taskCount`, 'sumi')).json
      .taskCount,
  ).toBe(2);
  // Served once: another delivery of the event (or a drain) adds nothing.
  await host.server.shutro.bootstrap({ reason: 'test: replay', company }, (env) =>
    env.emit('sale.order.confirmed', { id: order.json.id }),
  );
  expect(await worker.drain()).toBe(1);
  expect(
    (await call('GET', `/api/v1/models/sale.order/${order.json.id}?fields=taskCount`, 'sumi')).json
      .taskCount,
  ).toBe(2);
});
