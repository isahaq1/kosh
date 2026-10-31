/**
 * The Trade Finance ↔ Accounting bridge on real PostgreSQL (RFC 0021, Trade Finance step 2): the two apps propose it;
 * an import LC's margin is posted when it is issued and released when it is settled; a bank charge is expensed; a
 * payment is posted against the vendor's payable (import) or the customer's receivable (export); an LC without its
 * bank journal takes the company's.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accounting } from '@kosh/accounting';
import { contacts } from '@kosh/contacts';
import { messaging } from '@kosh/messaging';
import { planApps } from '@kosh/modules-sdk';
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
import { tradeFinance } from '@kosh/trade_finance';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { tradeFinanceAccount } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [
  base,
  settings,
  contacts,
  messaging,
  accounting,
  tradeFinance,
  tradeFinanceAccount,
];
const L = '/api/v1/models/trade.lc';
const PR = '/api/v1/models/trade.lc.presentation';

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let host: AppHost;
let company: number;
const ids: Record<string, number> = {};
const tokens = new Map<string, string>();

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function call(
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  payload?: unknown,
): Promise<{ status: number; json: Json }> {
  let token = tokens.get('maria');
  if (token === undefined) {
    const login = await host.server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { login: 'maria', password: PASSWORD },
    });
    token = (login.json() as { token: string }).token;
    tokens.set('maria', token);
  }
  const res = await host.server.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: res.statusCode, json: res.body === '' ? null : res.json() };
}
const find = async (model: string, filter: unknown, fields: string) =>
  (
    await call(
      'GET',
      `/api/v1/models/${model}?filter=${encodeURIComponent(JSON.stringify(filter))}&fields=${fields}&order=id+asc&limit=500`,
    )
  ).json.items as Json[];
const ok = async (url: string) => {
  const res = await call('POST', url);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
};
const amount = (v: Json) => orm.toDecimal(String(v?.amount ?? v ?? '0'));
async function balanceOf(account: number): Promise<string> {
  const lines = await find('account.move.line', { account }, 'debit,credit');
  return lines
    .reduce((s, l) => s.plus(amount(l.debit)).minus(amount(l.credit)), orm.toDecimal(0))
    .toFixed(2);
}
const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
async function issued(extra: Record<string, unknown>): Promise<number> {
  const made = await call('POST', L, {
    bank: ids['bank'],
    partner: ids['vendor'],
    currency: ids['bdt'],
    latestShipmentDate: day(20),
    expiryDate: day(35),
    journal: ids['journal'],
    ...extra,
  });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  await ok(`${L}/${made.json.id}/transitions/apply`);
  await ok(`${L}/${made.json.id}/transitions/issue`);
  return made.json.id as number;
}
async function paid(lc: number, drawn: string): Promise<void> {
  const p = await call('POST', PR, { lc, amount: drawn });
  expect(p.status, JSON.stringify(p.json)).toBe(201);
  await ok(`${PR}/${p.json.id}/transitions/accept`);
  await ok(`${PR}/${p.json.id}/transitions/pay`);
}

test('the plan proposes the bridge when Trade Finance and Accounting come', () => {
  const plan = planApps(catalogue, [], { install: ['trade_finance', 'accounting'] });
  expect(plan.install.find((i) => i.name === 'trade_finance_account')).toEqual({
    name: 'trade_finance_account',
    reason: 'bridge',
  });
});

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-trade-account-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({
      driver,
      catalogue,
      change: { install: ['settings', 'accounting', 'trade_finance'] },
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
  await auth.createUser({
    login: 'maria',
    name: 'Maria',
    password: PASSWORD,
    company,
    companies: [company],
    groups: ['account.manager', 'trade_finance.manager', 'contacts.manager'],
  });
  expect(
    (await call('POST', '/api/v1/accounting/charts/install', { template: 'generic' })).status,
  ).toBe(200);
  const [bdt] = await host.server.shutro.bootstrap(
    { reason: 'test', company },
    (env) => env.sql<{ id: number }>`SELECT id FROM res_currency WHERE name = 'BDT'`,
  );
  ids['bdt'] = bdt?.id as number;
  const [journal] = await find('account.journal', { type: 'bank' }, 'defaultAccount');
  ids['journal'] = journal.id;
  ids['bankAccount'] = journal.defaultAccount?.id ?? journal.defaultAccount;
  for (const [key, name] of [
    ['bank', 'Dhaka Commerce Bank'],
    ['vendor', 'Bengal Steel'],
    ['customer', 'Acme Trading'],
  ] as const)
    ids[key] = (
      await call('POST', '/api/v1/models/res.partner', { name, isCompany: true })
    ).json.id;
  for (const code of ['1100', '2000'])
    ids[code] = (await find('account.account', { code }, 'id'))[0].id;
}, 240_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('import: the margin posted and released, a charge expensed, the vendor paid', async () => {
  const lc = await issued({ amount: '100000', marginPercent: '10' });
  const margin = (await find('account.account', { code: '1160' }, 'id'))[0].id;
  expect(await balanceOf(margin)).toBe('10000.00');
  expect(await balanceOf(ids['bankAccount'] as number)).toBe('-10000.00');

  const charge = await call('POST', '/api/v1/models/trade.lc.charge', {
    lc,
    name: 'Opening commission',
    currency: ids['bdt'],
    amount: '1500',
  });
  expect(charge.status, JSON.stringify(charge.json)).toBe(201);
  await ok(`/api/v1/models/trade.lc.charge/${charge.json.id}/transitions/post`);
  const charges = (await find('account.account', { code: '6510' }, 'id'))[0].id;
  expect(await balanceOf(charges)).toBe('1500.00');

  await paid(lc, '100000');
  expect(await balanceOf(ids['2000'] as number)).toBe('100000.00'); // the vendor's payable, debited
  const [line] = await find('account.move.line', { account: ids['2000'] }, 'partner');
  expect(line.partner?.id ?? line.partner).toBe(ids['vendor']);
  const settled = (await call('GET', `${L}/${lc}`)).json;
  expect(settled.state).toBe('settled');
  expect(settled.marginReleaseMove).toBeTruthy();
  expect(await balanceOf(margin)).toBe('0.00');
  expect(await balanceOf(ids['bankAccount'] as number)).toBe('-101500.00');
});

test('export: the customer’s receivable credited by the bank', async () => {
  const before = orm.toDecimal(await balanceOf(ids['bankAccount'] as number));
  const lc = await issued({ direction: 'export', partner: ids['customer'], amount: '50000' });
  await paid(lc, '50000');
  expect(await balanceOf(ids['1100'] as number)).toBe('-50000.00');
  expect(await balanceOf(ids['bankAccount'] as number)).toBe(before.plus(50000).toFixed(2));
});

test('an LC without its bank journal takes the company’s', async () => {
  const made = await call('POST', L, {
    bank: ids['bank'],
    partner: ids['vendor'],
    currency: ids['bdt'],
    amount: '1000',
    marginPercent: '20',
    latestShipmentDate: day(20),
    expiryDate: day(35),
  });
  await ok(`${L}/${made.json.id}/transitions/apply`);
  await ok(`${L}/${made.json.id}/transitions/issue`);
  const lc = (await call('GET', `${L}/${made.json.id}`)).json;
  expect(lc.journal?.id ?? lc.journal).toBe(ids['journal']);
  expect(lc.marginMove).toBeTruthy();
});
