/**
 * Projects' money on real PostgreSQL (RFC 0026 step 4), with Accounting and Purchase: a project's cost centre is made
 * when its figures are first refreshed; a posted bill on it is booked; a confirmed purchase order on it is committed
 * until billed, then booked — never both; at 90 % of the budget the project is at risk; users never see the money.
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
  prepareApps,
  recordInstalledApps,
} from '@kosh/server';
import { type Driver, orm, pg } from '@kosh/server/orm';
import { settings } from '@kosh/settings';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { projectPurchase } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [base, settings, projectPurchase];
const PO = '/api/v1/models/purchase.order';

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let host: AppHost;
let company: number;
const ids: Record<string, number> = {};
const tokens = new Map<string, string>();

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function call(method: 'GET' | 'POST' | 'PATCH', url: string, as: string, payload?: unknown) {
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
  return { status: res.statusCode, json: (res.body === '' ? null : res.json()) as Json };
}
const expectStatus = (r: { status: number; json: Json }, status: number) =>
  expect(r.status, JSON.stringify(r.json)).toBe(status);

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-project-purchase-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({
      driver,
      catalogue,
      change: { install: ['settings', 'project_purchase'] },
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
  ({ company } = await installBase(host.server.shutro, auth, {
    company: { name: 'Padma Traders', currency: 'BDT' },
    admin: { login: 'admin', name: 'Administrator', password: PASSWORD },
  }));
  await installDefaults(host.server.shutro, host.server.registry.loaded.modules, { company });
  for (const [login, groups] of [
    ['pia', ['account.manager', 'purchase.manager', 'project.manager']],
    ['bob', ['purchase.user', 'account.user', 'project.user']],
  ] as const)
    await auth.createUser({
      login,
      name: login,
      password: PASSWORD,
      company,
      companies: [company],
      groups: [...groups],
    });
  expectStatus(
    await call('POST', '/api/v1/accounting/charts/install', 'pia', { template: 'generic' }),
    200,
  );
  for (const a of (await call('GET', '/api/v1/models/account.account?fields=code&limit=200', 'pia'))
    .json.items as Json[])
    ids[`acc${a.code}`] = a.id;
  for (const j of (await call('GET', '/api/v1/models/account.journal?fields=code', 'pia')).json
    .items as Json[])
    ids[`j${j.code}`] = j.id;
  ids['bdt'] = (
    await call('GET', '/api/v1/models/res.currency?fields=name', 'pia')
  ).json.items.find((c: Json) => c.name === 'BDT').id;
  ids['vendor'] = (
    await call('POST', '/api/v1/models/res.partner', 'pia', { name: 'Brick Co', isVendor: true })
  ).json.id;
  ids['bricks'] = (
    await call('POST', '/api/v1/models/product.product', 'pia', {
      name: 'Bricks',
      purchaseOk: true,
      kind: 'goods',
    })
  ).json.id;
}, 240_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('a cost centre made on the first refresh; a bill booked, an order committed until billed, never both; at risk at 90 % of the budget', async () => {
  const p = await call('POST', '/api/v1/models/project.project', 'pia', {
    name: 'Hatchery 3',
    budgetLines: { create: [{ name: 'Building', category: 'materials', planned: '100000' }] },
  });
  expectStatus(p, 201);
  const refresh = async () =>
    expectStatus(
      await call('POST', '/api/v1/projects/refresh', 'pia', { projects: [p.json.id] }),
      200,
    );
  const figures = async () =>
    (
      await call(
        'GET',
        `/api/v1/models/project.project/${p.json.id}?fields=analytic,bookedCost,committedCost,actualCost,variance,health`,
        'pia',
      )
    ).json;
  await refresh();
  const first = await figures();
  expect(first.analytic).toEqual(expect.any(Number));
  const analytic = first.analytic as number;
  const centre = await call(
    'GET',
    `/api/v1/models/account.analytic/${analytic}?fields=code,name`,
    'pia',
  );
  expect(centre.json).toMatchObject({ name: 'Hatchery 3', code: expect.stringMatching(/^PRJ-/) });
  await refresh(); // made once
  expect((await figures()).analytic).toBe(analytic);

  // A bill of 30 000 on the project's cost centre, posted: booked.
  const bill = await call('POST', '/api/v1/models/account.move', 'pia', {
    kind: 'in_invoice',
    journal: ids['jBILL'],
    partner: ids['vendor'],
    currency: ids['bdt'],
    lines: {
      create: [
        {
          lineKind: 'product',
          name: 'Cement',
          quantity: '1',
          priceUnit: '30000.00',
          account: ids['acc6300'],
          analytic,
        },
      ],
    },
  });
  expectStatus(bill, 201);
  for (const t of ['submit', 'post'])
    expectStatus(
      await call('POST', `/api/v1/models/account.move/${bill.json.id}/transitions/${t}`, 'pia'),
      200,
    );
  // An order of 60 000 on it, confirmed: committed.
  const order = await call('POST', PO, 'bob', {
    partner: ids['vendor'],
    currency: ids['bdt'],
    lines: {
      create: [
        { product: ids['bricks'], name: 'Bricks', quantity: '1', priceUnit: '60000.00', analytic },
      ],
    },
  });
  expectStatus(order, 201);
  for (const t of ['submit', 'confirm'])
    expectStatus(await call('POST', `${PO}/${order.json.id}/transitions/${t}`, 'pia'), 200);
  await refresh();
  let now = await figures();
  expect(Number(now.bookedCost)).toBe(30000);
  expect(Number(now.committedCost)).toBe(60000);
  expect(Number(now.actualCost)).toBe(30000);
  expect(Number(now.variance)).toBe(10000);
  expect(now.health).toBe('at_risk'); // 90 % of the budget

  // Billed and posted: no longer committed, booked instead; beyond the budget with another bill: off track.
  expectStatus(await call('POST', `${PO}/${order.json.id}/transitions/bill`, 'pia'), 200);
  const vendorBill = (
    await call(
      'GET',
      `/api/v1/models/account.move?filter=${encodeURIComponent(JSON.stringify({ purchaseOrder: order.json.id }))}&fields=id`,
      'pia',
    )
  ).json.items[0];
  expect(vendorBill).toBeDefined();
  for (const t of ['submit', 'post'])
    expectStatus(
      await call('POST', `/api/v1/models/account.move/${vendorBill.id}/transitions/${t}`, 'pia'),
      200,
    );
  await refresh();
  now = await figures();
  expect(Number(now.committedCost)).toBe(0);
  expect(Number(now.bookedCost)).toBe(90000); // the bill and the order's, billed: never counted twice
  expect(now.health).toBe('at_risk');
  // Users never see the money.
  expectStatus(
    await call('GET', `/api/v1/models/project.project/${p.json.id}?fields=bookedCost`, 'bob'),
    403,
  );
});
