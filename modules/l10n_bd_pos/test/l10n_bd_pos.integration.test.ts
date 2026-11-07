/**
 * Bangladesh at the counter on real PostgreSQL (RFC 0021, Counter step 4): a shop issues Mushak 6.3 receipts by
 * default — the sale's receipt template is the tax invoice, rendered with the seller's BIN, each line's VAT and the
 * amount in words —; switched off, the plain receipt.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accounting } from '@kosh/accounting';
import { contacts } from '@kosh/contacts';
import { l10nBd } from '@kosh/l10n_bd';
import { messaging } from '@kosh/messaging';
import { permissions } from '@kosh/permissions';
import { pos } from '@kosh/pos';
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
import { l10nBdPos } from '../src/index.js';

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
  l10nBd,
  l10nBdPos,
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
  dir = await mkdtemp(join(tmpdir(), 'kosh-l10n-bd-pos-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({ driver, catalogue, change: { install: ['settings', 'l10n_bd_pos'] }, dir }),
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
    ['maria', ['pos.manager', 'product.manager', 'account.manager']],
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
  await driver.query({ text: "UPDATE res_company SET bin = '0001234560101'", params: [] });
}, 240_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('a shop issues Mushak 6.3 receipts by default; switched off, the plain receipt', async () => {
  const opened = await call('rahim', 'POST', '/api/v1/counter/sessions', {
    shop: ids['shop'],
    openingCash: '500',
  });
  expect(opened.status, JSON.stringify(opened.json)).toBe(201);
  const sale = await call('rahim', 'POST', '/api/v1/counter/orders', {
    session: opened.json.session.id,
    lines: [{ product: ids['tea'], quantity: '2' }],
    payments: [{ method: ids['cash'], amount: '500' }],
  });
  expect(sale.status, JSON.stringify(sale.json)).toBe(201);
  const order = sale.json.order.id as number;
  const template = await call('rahim', 'GET', `/api/v1/counter/orders/${order}/receipt-template`);
  expect(template.status, JSON.stringify(template.json)).toBe(200);
  expect(template.json.name).toBe('Tax invoice (Mushak 6.3) — receipt');
  // Rendered: the tax invoice with the seller's BIN.
  const token = tokens.get('rahim') as string;
  const html = await host.server.app.inject({
    method: 'POST',
    url: `/api/v1/models/pos.order/documents/${template.json.id}?format=html`,
    headers: { authorization: `Bearer ${token}` },
    payload: { ids: [order] },
  });
  expect(html.statusCode, html.body.slice(0, 300)).toBe(200);
  expect(html.body).toContain('Mushak 6.3');
  expect(html.body).toContain('0001234560101');
  // Switched off: the Counter's own receipt.
  expect(
    (
      await call('maria', 'PATCH', `/api/v1/models/pos.shop/${ids['shop']}`, {
        mushakReceipt: false,
      })
    ).status,
  ).toBe(200);
  const plain = await call('rahim', 'GET', `/api/v1/counter/orders/${order}/receipt-template`);
  expect(plain.json.name).toBe('Receipt');
});
