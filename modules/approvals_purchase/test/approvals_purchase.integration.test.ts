/**
 * Purchase requests on real PostgreSQL (RFC 0025 step 4): the shipped *Purchase request* category leads to a request
 * for quotation; request lines name products; approved by an Approvals manager (the requester has no manager), the
 * request makes a request for quotation to its contact from its lines, once, and shows it.
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
import { approvalsPurchase } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [base, settings, approvalsPurchase];
const PO = '/api/v1/models/purchase.order';
const ASK = '/api/v1/models/approval.ask';

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
  dir = await mkdtemp(join(tmpdir(), 'kosh-approvals-purchase-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({
      driver,
      catalogue,
      change: { install: ['settings', 'approvals_purchase'] },
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
    ['pia', ['approvals.manager', 'purchase.manager', 'product.manager']],
    ['bob', ['purchase.user']],
  ] as const)
    await auth.createUser({
      login,
      name: login,
      password: PASSWORD,
      company,
      companies: [company],
      groups: [...groups],
    });
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

test('an approved purchase request becomes a request for quotation from its lines, once', async () => {
  const cats = (await call('GET', '/api/v1/models/approval.category?fields=code,outcome', 'bob'))
    .json.items as Json[];
  const pr = cats.find((c) => c.code === 'PR');
  expect(pr.outcome).toBe('purchase');
  const ask = await call('POST', ASK, 'bob', {
    category: pr.id,
    title: 'Bricks for the new shed',
    partner: ids['vendor'],
    lines: {
      create: [
        { product: ids['bricks'], name: 'Bricks', quantity: '2000', priceUnit: '12' },
        { name: 'Delivery by the vendor', quantity: '1', priceUnit: '0' },
      ],
    },
  });
  expectStatus(ask, 201);
  const id = ask.json.id as number;
  expectStatus(await call('POST', `${ASK}/${id}/transitions/submit`, 'bob'), 200);
  const inbox = (await call('GET', '/api/v1/approvals/inbox', 'pia')).json.requests as Json[];
  const request = inbox.find((r) => r.targetModel === 'approval.ask' && r.targetId === id);
  expect(request).toBeDefined();
  expectStatus(await call('POST', `/api/v1/approvals/requests/${request.id}/approve`, 'pia'), 200);
  const done = (
    await call('GET', `${ASK}/${id}?fields=state,resultModel,resultId,resultName`, 'bob')
  ).json;
  expect(done).toMatchObject({ state: 'approved', resultModel: 'purchase.order' });
  const order = (
    await call('GET', `${PO}/${done.resultId}?fields=partner,state,amountUntaxed,name,lines`, 'pia')
  ).json;
  expect(order.partner).toBe(ids['vendor']);
  expect(order.state).toBe('draft');
  expect(order.lines).toHaveLength(1); // the line with a product
  expect(done.resultName).toBe(order.name);
});
