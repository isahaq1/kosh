/**
 * Counter on real PostgreSQL (RFC 0021): a cashier's session opened with its cash; a sale posted whole with two
 * payments, paid at once, the change given; the same sale from the device accepted once; a sale not covered by
 * its payments refused; a cashier sees only their own sessions; closing needs the count and a reason for a
 * difference; one open session per cashier.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accounting } from '@kosh/accounting';
import { contacts } from '@kosh/contacts';
import { messaging } from '@kosh/messaging';
import { permissions } from '@kosh/permissions';
import { product } from '@kosh/product';
import { reporting } from '@kosh/reporting';
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
import { pos } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [
  base,
  settings,
  contacts,
  product,
  accounting,
  messaging,
  permissions,
  reporting,
  pos,
];

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let host: AppHost;
const tokens = new Map<string, string>();
const ids: Record<string, number> = {};

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function call(
  login: string,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  payload?: unknown,
): Promise<{ status: number; json: Json }> {
  let token = tokens.get(login);
  if (token === undefined) {
    const res = await host.server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { login, password: PASSWORD },
    });
    token = (res.json() as { token: string }).token;
    tokens.set(login, token);
  }
  const res = await host.server.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: res.statusCode, json: res.body === '' ? null : res.json() };
}

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-pos-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({ driver, catalogue, change: { install: ['settings', 'pos'] }, dir }),
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
  const { company } = await installBase(host.server.shutro, auth, {
    company: { name: 'Padma Traders', currency: 'BDT' },
    admin: { login: 'admin', name: 'Administrator', password: PASSWORD },
  });
  await installDefaults(host.server.shutro, host.server.registry.loaded.modules, { company });
  for (const [login, groups] of [
    ['maria', ['pos.manager', 'product.manager']],
    ['rahim', ['pos.cashier']],
    ['sam', ['pos.cashier']],
  ] as const)
    await auth.createUser({
      login,
      name: login,
      password: PASSWORD,
      company,
      companies: [company],
      groups: [...groups],
    });
  const tea = await call('maria', 'POST', '/api/v1/models/product.product', {
    name: 'Tea 500 g',
    listPrice: '250',
    standardPrice: '180',
  });
  expect(tea.status, JSON.stringify(tea.json)).toBe(201);
  ids['tea'] = tea.json.id;
  const shop = await call('maria', 'POST', '/api/v1/models/pos.shop', {
    name: 'Padma Shop',
    pricesIncludeTax: true,
    methods: {
      create: [
        { name: 'Cash', kind: 'cash', sequence: 1 },
        { name: 'Card', kind: 'card', sequence: 2 },
      ],
    },
  });
  expect(shop.status, JSON.stringify(shop.json)).toBe(201);
  ids['shop'] = shop.json.id;
  const shops = await call('rahim', 'GET', '/api/v1/counter/shops');
  expect(shops.status, JSON.stringify(shops.json)).toBe(200);
  for (const m of shops.json.shops[0].methods as { id: number; kind: string }[]) ids[m.kind] = m.id;
}, 240_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('a session opened with its cash; the catalogue for the register; one open session per cashier', async () => {
  expect(
    (await call('rahim', 'GET', `/api/v1/counter/session?shop=${ids['shop']}`)).json.session,
  ).toBeNull();
  const opened = await call('rahim', 'POST', '/api/v1/counter/sessions', {
    shop: ids['shop'],
    openingCash: '1000',
  });
  expect(opened.status, JSON.stringify(opened.json)).toBe(201);
  expect(opened.json.session.state).toBe('open');
  expect(Number(opened.json.session.openingCash)).toBe(1000);
  expect(Number(opened.json.session.expectedCash)).toBe(1000);
  ids['session'] = opened.json.session.id;
  const again = await call('rahim', 'POST', '/api/v1/counter/sessions', {
    shop: ids['shop'],
    openingCash: '5',
  });
  expect(again.status).toBe(422);
  const catalogue = await call('rahim', 'GET', `/api/v1/counter/catalogue?shop=${ids['shop']}`);
  expect(catalogue.json.products.map((p: { name: string }) => p.name)).toContain('Tea 500 g');
});

test('a sale with two payments, paid at once, the change given; the device sends it twice, accepted once', async () => {
  const sale = {
    session: ids['session'],
    clientId: 'device-1-0001',
    lines: [{ product: ids['tea'], quantity: '2' }],
    payments: [
      { method: ids['card'], amount: '300' },
      { method: ids['cash'], amount: '250' },
    ],
  };
  const first = await call('rahim', 'POST', '/api/v1/counter/orders', sale);
  expect(first.status, JSON.stringify(first.json)).toBe(201);
  expect(first.json.order.state).toBe('paid');
  expect(Number(first.json.order.total)).toBe(500);
  expect(Number(first.json.order.amountPaid)).toBe(550);
  expect(Number(first.json.order.change)).toBe(50);
  const second = await call('rahim', 'POST', '/api/v1/counter/orders', sale);
  expect(second.status).toBe(200);
  expect(second.json).toMatchObject({ repeated: true, order: { id: first.json.order.id } });
  // The drawer: 1,000 + 250 in cash − 50 change.
  const session = await call('rahim', 'GET', `/api/v1/counter/session?shop=${ids['shop']}`);
  expect(Number(session.json.session.expectedCash)).toBe(1200);
  expect(session.json.session.orderCount).toBe(1);
  expect(Number(session.json.session.total)).toBe(500);
});

test('a sale not covered by its payments is refused; a cashier sees only their own sessions', async () => {
  const short = await call('rahim', 'POST', '/api/v1/counter/orders', {
    session: ids['session'],
    lines: [{ product: ids['tea'], quantity: '1' }],
    payments: [{ method: ids['cash'], amount: '100' }],
  });
  expect(short.status).toBe(409);
  expect(short.json.detail).toContain('cover the total');
  const mine = await call('sam', 'GET', '/api/v1/models/pos.session?fields=name');
  expect(mine.json.items).toEqual([]);
  expect(
    (await call('sam', 'GET', `/api/v1/counter/session?shop=${ids['shop']}`)).json.session,
  ).toBeNull();
  expect(
    (await call('maria', 'GET', '/api/v1/models/pos.session?fields=name')).json.items,
  ).toHaveLength(1);
});

test('closing: the count is needed, a difference needs a reason; closed with the difference kept', async () => {
  const noCount = await call(
    'rahim',
    'POST',
    `/api/v1/counter/sessions/${ids['session']}/close`,
    {},
  );
  expect(noCount.status).toBe(422);
  const unexplained = await call(
    'rahim',
    'POST',
    `/api/v1/counter/sessions/${ids['session']}/close`,
    {
      closingCash: '1150',
    },
  );
  expect(unexplained.status).toBe(422);
  expect(unexplained.json.detail).toContain('why');
  const closed = await call('rahim', 'POST', `/api/v1/counter/sessions/${ids['session']}/close`, {
    closingCash: '1150',
    differenceReason: 'A 50 note given as change by mistake',
  });
  expect(closed.status, JSON.stringify(closed.json)).toBe(200);
  expect(closed.json.session.state).toBe('closed');
  expect(Number(closed.json.session.closingDifference)).toBe(-50);
  expect(
    (await call('rahim', 'GET', `/api/v1/counter/session?shop=${ids['shop']}`)).json.session,
  ).toBeNull();
  // A receipt for the sale, through the record's templates.
  const templates = await call('rahim', 'GET', '/api/v1/models/pos.order/documents');
  expect(templates.status, JSON.stringify(templates.json)).toBe(200);
  const receiptTemplate = (templates.json.templates as { id: number; name: string }[]).find(
    (tpl) => tpl.name === 'Receipt',
  );
  expect(receiptTemplate).toBeDefined();
  const order = (await call('rahim', 'GET', '/api/v1/models/pos.order?fields=name')).json.items[0];
  const receipt = await host.server.app.inject({
    method: 'POST',
    url: `/api/v1/models/pos.order/documents/${receiptTemplate?.id}?format=html`,
    headers: { authorization: `Bearer ${tokens.get('rahim')}` },
    payload: { ids: [order.id] },
  });
  expect(receipt.statusCode, receipt.body.slice(0, 200)).toBe(200);
  expect(receipt.body).toContain('Tea 500 g');
});
