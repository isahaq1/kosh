/**
 * Trade Finance on real PostgreSQL through the HTTP API (RFC 0021): an LC's dates and usance are checked; issuing
 * stays within the bank's limit and is for managers; an amendment changes the LC only once accepted; a discrepant
 * presentation is accepted only once waived, its maturity follows the usance; drawings never pass the amount plus
 * the tolerance; paid in full, the LC is settled; alerts within the window; access; the demo.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contacts } from '@kosh/contacts';
import { messaging } from '@kosh/messaging';
import {
  type AppHost,
  applyApps,
  base,
  createAppHost,
  installBase,
  installDemo,
  prepareApps,
  recordInstalledApps,
} from '@kosh/server';
import { type Driver, orm, pg } from '@kosh/server/orm';
import { settings } from '@kosh/settings';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { tradeFinance } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [base, settings, contacts, messaging, tradeFinance];
const L = '/api/v1/models/trade.lc';
const PR = '/api/v1/models/trade.lc.presentation';
const AM = '/api/v1/models/trade.lc.amendment';

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
const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const lc = (amount: string, extra: Record<string, unknown> = {}) =>
  call('POST', L, 'rahim', {
    bank: ids['bank'],
    partner: ids['vendor'],
    currency: ids['usd'],
    amount,
    latestShipmentDate: day(20),
    expiryDate: day(35),
    ...extra,
  });
const go = (url: string, as = 'maria') => call('POST', url, as);
const money = (v: Json) => String(Number(v?.amount ?? v));

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-trade-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({
      driver,
      catalogue,
      change: { install: ['settings', 'trade_finance'] },
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
  for (const [login, groups] of [
    ['maria', ['trade_finance.manager', 'contacts.manager']],
    ['rahim', ['trade_finance.user']],
    ['bob', ['base.user']],
  ] as const)
    await auth.createUser({
      login,
      name: login,
      password: PASSWORD,
      company,
      companies: [company],
      groups: [...groups],
    });
  // A fresh database has the company's currency only.
  ids['usd'] = await host.server.shutro.bootstrap({ reason: 'test: USD', company }, async (env) => {
    const made = await (
      env.model('res.currency' as never) as unknown as {
        create(rows: unknown[]): Promise<{ ids: number[] }>;
      }
    ).create([{ name: 'USD' }]);
    return made.ids[0] as number;
  });
  for (const [key, name] of [
    ['bank', 'Dhaka Commerce Bank'],
    ['vendor', 'Bengal Steel'],
  ] as const)
    ids[key] = (
      await call('POST', '/api/v1/models/res.partner', 'maria', { name, isCompany: true })
    ).json.id;
  const limit = await call('POST', '/api/v1/models/trade.lc.limit', 'maria', {
    bank: ids['bank'],
    currency: ids['usd'],
    amount: '100000',
  });
  expect(limit.status, JSON.stringify(limit.json)).toBe(201);
}, 240_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('the dates and the usance are checked', async () => {
  expect((await lc('1000', { latestShipmentDate: day(40) })).status).toBe(422);
  expect((await lc('1000', { payment: 'usance' })).status).toBe(422);
  expect((await lc('0')).status).toBe(422);
});

test('issued within the bank’s limit, by managers', async () => {
  const a = (await lc('80000', { payment: 'usance', usanceDays: 90, tolerance: '5' })).json.id;
  const b = (await lc('30000')).json.id;
  ids['a'] = a;
  for (const id of [a, b])
    expect((await go(`${L}/${id}/transitions/apply`, 'rahim')).status).toBe(200);
  expect((await go(`${L}/${a}/transitions/issue`, 'rahim')).status).toBe(403);
  expect((await go(`${L}/${a}/transitions/issue`)).status).toBe(200);
  const over = await go(`${L}/${b}/transitions/issue`);
  expect(over.status).toBe(409);
  expect(JSON.stringify(over.json)).toContain('limit');
  const issued = (await call('GET', `${L}/${a}`, 'rahim')).json;
  expect(issued).toMatchObject({ state: 'issued', issueDate: day(0) });
  expect(issued.outstanding).toBe('80000');
});

test('an amendment changes the LC only once accepted', async () => {
  const made = await call('POST', AM, 'rahim', { lc: ids['a'], newAmount: '90000' });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  expect(money((await call('GET', `${L}/${ids['a']}`, 'rahim')).json.amount)).toBe('80000');
  expect((await go(`${AM}/${made.json.id}/transitions/accept`)).status).toBe(200);
  const after = (await call('GET', `${L}/${ids['a']}`, 'rahim')).json;
  expect(money(after.amount)).toBe('90000');
  expect(after.maxDrawable).toBe('94500'); // 90,000 + 5 %
  const refused = await call('POST', AM, 'rahim', { lc: ids['a'], newAmount: '10' });
  await go(`${AM}/${refused.json.id}/transitions/refuse`);
  expect(money((await call('GET', `${L}/${ids['a']}`, 'rahim')).json.amount)).toBe('90000');
});

test('presentations: discrepancies waived before acceptance, maturity, the tolerance, settled when paid', async () => {
  const first = await call('POST', PR, 'rahim', {
    lc: ids['a'],
    amount: '50000',
    documents: 'Invoice, B/L',
    discrepancies: 'Late shipment by two days',
  });
  expect(first.status, JSON.stringify(first.json)).toBe(201);
  const early = await go(`${PR}/${first.json.id}/transitions/accept`, 'rahim');
  expect(early.status).toBe(409);
  expect(JSON.stringify(early.json)).toContain('discrepant');
  await call('PATCH', `${PR}/${first.json.id}`, 'rahim', { waived: true });
  expect((await go(`${PR}/${first.json.id}/transitions/accept`, 'rahim')).status).toBe(200);
  expect((await call('GET', `${PR}/${first.json.id}`, 'rahim')).json.maturityDate).toBe(day(90));

  expect((await call('POST', PR, 'rahim', { lc: ids['a'], amount: '50000' })).status).toBe(422); // 100,000 > 94,500
  const second = await call('POST', PR, 'rahim', { lc: ids['a'], amount: '44500' });
  expect(second.status).toBe(201);
  await go(`${PR}/${second.json.id}/transitions/accept`, 'rahim');
  await go(`${PR}/${first.json.id}/transitions/pay`, 'rahim');
  expect((await call('GET', `${L}/${ids['a']}`, 'rahim')).json.state).toBe('issued'); // 50,000 of 90,000
  await go(`${PR}/${second.json.id}/transitions/pay`, 'rahim');
  const settled = (await call('GET', `${L}/${ids['a']}`, 'rahim')).json;
  expect(settled).toMatchObject({ state: 'settled', paid: '94500', outstanding: '0' });
});

test('shipments: before the latest shipment date, within the LC, once unless partial shipments are allowed', async () => {
  const S = '/api/v1/models/trade.lc.shipment';
  const once = (await lc('20000')).json.id;
  await go(`${L}/${once}/transitions/apply`, 'rahim');
  await go(`${L}/${once}/transitions/issue`);
  const ship = (id: number, value: string, date = day(10)) =>
    call('POST', S, 'rahim', { lc: id, value, date, blNumber: `BL-${value}`, vessel: 'MV Padma' });
  expect((await ship(once, '20000', day(25))).status).toBe(422); // after the latest shipment date
  expect((await ship(once, '15000')).status).toBe(201);
  expect((await ship(once, '5000')).status).toBe(422); // a second shipment: partial shipments not allowed
  expect((await call('GET', `${L}/${once}`, 'rahim')).json.shipped).toBe('15000');

  const partial = (await lc('10000', { partialShipment: true })).json.id;
  await go(`${L}/${partial}/transitions/apply`, 'rahim');
  await go(`${L}/${partial}/transitions/issue`);
  expect((await ship(partial, '6000')).status).toBe(201);
  expect((await ship(partial, '4000')).status).toBe(201);
  expect((await ship(partial, '1')).status).toBe(422); // beyond the amount (no tolerance)
});

test('alerts within the window (the setting); access', async () => {
  const c = (await lc('5000', { latestShipmentDate: day(5), expiryDate: day(10) })).json.id;
  await go(`${L}/${c}/transitions/apply`, 'rahim');
  await go(`${L}/${c}/transitions/issue`);
  const alerts = await call('GET', '/api/v1/trade/alerts', 'rahim');
  expect(alerts.status, JSON.stringify(alerts.json)).toBe(200);
  expect(
    (alerts.json.alerts as Json[]).filter((a) => a.lc === c).map((a) => [a.what, a.daysLeft]),
  ).toEqual([
    ['shipment', 5],
    ['expiry', 10],
  ]);
  await call('PATCH', '/api/v1/settings/app-settings/trade_finance/alerts', 'maria', {
    values: { alertDays: 3 },
  });
  expect(
    ((await call('GET', '/api/v1/trade/alerts', 'rahim')).json.alerts as Json[]).filter(
      (a) => a.lc === c,
    ),
  ).toEqual([]);
  expect((await call('GET', L, 'bob')).status).toBe(403);
  expect((await call('POST', '/api/v1/models/trade.lc.limit', 'rahim', {})).status).toBe(403);
});

test('the demo data loads', async () => {
  const auth = host.server.auth;
  if (auth === undefined) throw new Error('base is installed');
  const summary = await installDemo({
    shutro: host.server.shutro,
    auth,
    driver,
    modules: host.server.registry.loaded.modules,
    company,
  });
  expect(JSON.stringify(summary)).toContain('Trade Finance');
});

test('the overview of the app (RFC 0022 step 2) is served to a user', async () => {
  const overview = await call('GET', '/api/v1/reports/overview?app=tradefinance', 'rahim');
  expect(overview.status, JSON.stringify(overview.json)).toBe(200);
  expect(overview.json.cards.map((c: { id: string }) => c.id)).toContain('issued');
});
