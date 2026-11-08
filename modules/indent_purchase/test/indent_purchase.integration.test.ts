/**
 * The Requests ↔ Purchase bridge on real PostgreSQL through the HTTP API (RFC 0032 §3.4): an approved indent asking
 * for more than the store holds gets a purchase request for the shortfall — once, by a store keeper, its lines
 * linked —, drafted for the requester; an indent the store can serve gets none.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { indent } from '@kosh/indent';
import { installApprovalPolicies } from '@kosh/permissions';
import { purchase } from '@kosh/purchase';
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
import { indentPurchase } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [base, settings, indent, purchase, indentPurchase];
const R = '/api/v1/models/indent.request';

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let host: AppHost;
let company: number;
const users: Record<string, number> = {};
const tokens = new Map<string, string>();
let warehouse: number;
let internalUse: number;
let bolt: number;

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function token(as: string): Promise<string> {
  let t = tokens.get(as);
  if (t === undefined) {
    const login = await host.server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { login: as, password: PASSWORD },
    });
    t = (login.json() as { token: string }).token;
    tokens.set(as, t);
  }
  return t;
}
async function call(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  as: string,
  payload?: unknown,
): Promise<{ status: number; json: Json }> {
  const res = await host.server.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${await token(as)}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: res.statusCode, json: res.body === '' ? null : res.json() };
}
const run = (model: string, id: number, transition: string, as: string) =>
  call('POST', `/api/v1/models/${model}/${id}/transitions/${transition}`, as);
const decide = async (id: number, who: string) => {
  const inbox = (await call('GET', '/api/v1/approvals/inbox', who)).json.requests as Json[];
  const mine = inbox.filter((r) => r.targetModel === 'indent.request' && r.targetId === id);
  for (const r of mine)
    expect((await call('POST', `/api/v1/approvals/requests/${r.id}/approve`, who)).status).toBe(
      200,
    );
  return mine.length;
};
const approvedIndent = async (quantity: string) => {
  const made = await call('POST', R, 'rahim', {
    warehouse,
    destination: internalUse,
    dateRequired: '2026-11-20',
    purpose: 'Belts',
    lines: { create: [{ product: bolt, quantity }] },
  });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  const id = made.json.id as number;
  expect((await run('indent.request', id, 'submit', 'rahim')).status).toBe(200);
  expect(await decide(id, 'head')).toBe(1);
  // No product group names approvers here: the level's role, a Requests manager, decides instead.
  expect(await decide(id, 'hana')).toBe(1);
  expect((await call('GET', `${R}/${id}?fields=state`, 'rahim')).json.state).toBe('approved');
  return id;
};

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-indent-purchase-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({
      driver,
      catalogue,
      change: { install: ['settings', 'indent', 'purchase', 'indent_purchase'] },
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
    company: { name: 'Padma Feeds', currency: 'BDT' },
    admin: { login: 'admin', name: 'Administrator', password: PASSWORD },
  }));
  await installDefaults(host.server.shutro, host.server.registry.loaded.modules, { company });
  await host.server.shutro.bootstrap({ reason: 'test policies', company }, (env) =>
    installApprovalPolicies(env, host.server.registry.loaded.modules),
  );
  for (const [login, groups] of [
    ['hana', ['hr.manager', 'stock.manager', 'product.manager', 'indent.manager']],
    ['head', ['indent.user']],
    ['stan', ['indent.store']],
    ['rahim', ['indent.user', 'purchase.requester']],
    ['farid', ['purchase.user']],
  ] as const)
    users[login] = await auth.createUser({
      login,
      name: login,
      password: PASSWORD,
      company,
      companies: [company],
      groups: [...groups],
    });
  const headEmployee = (
    await call('POST', '/api/v1/models/hr.employee', 'hana', { name: 'Head', user: users['head'] })
  ).json.id;
  const department = (
    await call('POST', '/api/v1/models/hr.department', 'hana', {
      name: 'Maintenance',
      head: headEmployee,
    })
  ).json.id;
  expect(
    (
      await call('POST', '/api/v1/models/hr.employee', 'hana', {
        name: 'rahim',
        user: users['rahim'],
        department,
      })
    ).status,
  ).toBe(201);
  bolt = (
    await call('POST', '/api/v1/models/product.product', 'hana', {
      name: 'Bolt M12',
      kind: 'goods',
    })
  ).json.id;
  warehouse = (await call('GET', '/api/v1/models/stock.warehouse?fields=name', 'hana')).json
    .items[0].id;
  const locations = (
    await call(
      'GET',
      `/api/v1/models/stock.location?filter=${encodeURIComponent(JSON.stringify({ usage: { in: ['internal', 'consumption', 'adjustment'] } }))}&fields=usage,warehouse`,
      'hana',
    )
  ).json.items as Json[];
  const stockLocation = locations.find((l) => l.usage === 'internal' && l.warehouse !== null).id;
  internalUse = locations.find((l) => l.usage === 'consumption').id;
  const adjustment = locations.find((l) => l.usage === 'adjustment').id;
  // The store holds 20 bolts.
  const receipt = await call('POST', '/api/v1/models/stock.picking', 'hana', {
    kind: 'adjustment',
    source: adjustment,
    destination: stockLocation,
    moves: { create: [{ product: bolt, quantity: '20' }] },
  });
  expect(receipt.status, JSON.stringify(receipt.json)).toBe(201);
  expect((await run('stock.picking', receipt.json.id, 'confirm', 'hana')).status).toBe(200);
  expect((await run('stock.picking', receipt.json.id, 'validate', 'hana')).status).toBe(200);
}, 240_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('the shortfall of an approved indent becomes one purchase request, by a store keeper, once', async () => {
  const id = await approvedIndent('50');
  // Not the requester; the store keeper.
  expect((await run('indent.request', id, 'buy', 'rahim')).status).toBe(403);
  const asked = await run('indent.request', id, 'buy', 'stan');
  expect(asked.status, JSON.stringify(asked.json)).toBe(200);
  const requests = (
    await call(
      'GET',
      `/api/v1/models/purchase.request?filter=${encodeURIComponent(JSON.stringify({ indent: id }))}&fields=requester,state,purpose`,
      'rahim',
    )
  ).json.items as Json[];
  expect(requests.length).toBe(1);
  expect(requests[0].state).toBe('draft');
  expect(requests[0].requester?.id ?? requests[0].requester).toBe(users['rahim']);
  const lines = (
    await call(
      'GET',
      `/api/v1/models/purchase.request.line?filter=${encodeURIComponent(JSON.stringify({ request: requests[0].id }))}&fields=product,quantity,indentLine`,
      'rahim',
    )
  ).json.items as Json[];
  expect(lines.length).toBe(1);
  expect(Number(lines[0].quantity)).toBe(30); // 50 asked, 20 in the store
  expect(lines[0].indentLine).not.toBeNull();
  // The indent shows what is being bought; asking again finds nothing to ask for.
  const [line] = (
    await call(
      'GET',
      `/api/v1/models/indent.request.line?filter=${encodeURIComponent(JSON.stringify({ request: id }))}&fields=qtyBuying`,
      'rahim',
    )
  ).json.items as Json[];
  expect(Number(line.qtyBuying)).toBe(30);
  expect((await run('indent.request', id, 'buy', 'stan')).status).toBe(409);
  // The requester sees the drafted purchase request as their own.
  expect(
    (await call('GET', `/api/v1/models/purchase.request/${requests[0].id}`, 'rahim')).status,
  ).toBe(200);
});

test('an indent the store can serve has nothing to buy', async () => {
  const id = await approvedIndent('5');
  expect((await run('indent.request', id, 'buy', 'stan')).status).toBe(409);
});
