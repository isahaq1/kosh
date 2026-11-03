/**
 * Fixed assets on real PostgreSQL (RFC 0024 §2.5): a 120 000 asset over a year — three months posted once each with
 * its cost centre, an impairment to 60 000 replanning the rest, then a sale for 50 000 with its 5 000 gain in one
 * balanced entry; the tax book beside it; a posted bill's line on the asset account becoming a draft asset, once;
 * only managers post; the demo data loads.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accounting } from '@kosh/accounting';
import {
  type AppHost,
  applyApps,
  base,
  createAppHost,
  installBase,
  installDefaults,
  installDemo,
  prepareApps,
  recordInstalledApps,
} from '@kosh/server';
import { type Driver, orm, pg } from '@kosh/server/orm';
import { settings } from '@kosh/settings';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { accountAsset, assetWorker } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [base, settings, accounting, accountAsset];
const A = '/api/v1/models/account.asset';

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let host: AppHost;
let company: number;
let category: number;
let asset: number;
let analytic: number;
const accounts: Record<string, number> = {};
const journals: Record<string, number> = {};
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
const num = (v: unknown) => Number((v as { amount?: unknown })?.amount ?? v);
const q = (f: Record<string, unknown>) => encodeURIComponent(JSON.stringify(f));
async function sums(move: number) {
  const out: Record<number, number> = {};
  for (const l of (
    await call(
      'GET',
      `/api/v1/models/account.move.line?filter=${q({ move })}&fields=account,debit,credit,analytic`,
      'pia',
    )
  ).json.items as Json[]) {
    const a = l.account?.id ?? l.account;
    out[a] = (out[a] ?? 0) + num(l.debit) - num(l.credit);
  }
  return out;
}

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-account-asset-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({
      driver,
      catalogue,
      change: { install: ['settings', 'accounting', 'account_asset'] },
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
    ['pia', ['account.manager']],
    ['otto', ['account.user']],
  ] as const)
    await auth.createUser({
      login,
      name: login,
      password: PASSWORD,
      company,
      companies: [company],
      groups: [...groups],
    });
  expect(
    (await call('POST', '/api/v1/accounting/charts/install', 'pia', { template: 'generic' }))
      .status,
  ).toBe(200);
  for (const a of (await call('GET', '/api/v1/models/account.account?fields=code&limit=200', 'pia'))
    .json.items as Json[])
    accounts[a.code] = a.id;
  for (const j of (await call('GET', '/api/v1/models/account.journal?fields=code', 'pia')).json
    .items as Json[])
    journals[j.code] = j.id;
  analytic = (
    await call('POST', '/api/v1/models/account.analytic', 'pia', {
      code: 'SALES',
      name: 'Sales team',
    })
  ).json.id;
  category = (
    await call('POST', '/api/v1/models/account.asset.category', 'pia', {
      name: 'Computers',
      assetAccount: accounts['1500'],
      accumulatedAccount: accounts['1590'],
      expenseAccount: accounts['6600'],
      journal: journals['MISC'],
      method: 'linear',
      lifeMonths: 12,
      prorata: false,
      taxRate: '20',
    })
  ).json.id;
}, 240_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('confirmed: twelve months planned; three posted once each, with the cost centre', async () => {
  const made = await call('POST', A, 'pia', {
    name: 'Servers',
    category,
    value: '120000',
    dateAcquired: '2026-01-01',
    dateInUse: '2026-01-01',
    method: 'linear',
    lifeMonths: 12,
    prorata: false,
    analytic,
  });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  asset = made.json.id;
  expect((await call('POST', `${A}/${asset}/transitions/confirm`, 'pia')).status).toBe(200);
  const lines = (
    await call(
      'GET',
      `/api/v1/models/account.asset.line?filter=${q({ asset })}&fields=date,amount`,
      'pia',
    )
  ).json.items as Json[];
  expect(lines).toHaveLength(12);
  expect(lines.every((l) => num(l.amount) === 10000)).toBe(true);

  expect(
    (await call('POST', '/api/v1/assets/post-due', 'otto', { date: '2026-03-31' })).status,
  ).toBe(403);
  expect(
    (await call('POST', '/api/v1/assets/post-due', 'pia', { date: '2026-03-31' })).json.posted,
  ).toBe(3);
  expect(
    (await call('POST', '/api/v1/assets/post-due', 'pia', { date: '2026-03-31' })).json.posted,
  ).toBe(0);
  const read = (await call('GET', `${A}/${asset}?fields=depreciated,bookValue`, 'pia')).json;
  expect([num(read.depreciated), num(read.bookValue)]).toEqual([30000, 90000]);
  const [first] = (
    await call(
      'GET',
      `/api/v1/models/account.asset.line?filter=${q({ asset, posted: true })}&fields=move&limit=1`,
      'pia',
    )
  ).json.items as Json[];
  const expense = (
    await call(
      'GET',
      `/api/v1/models/account.move.line?filter=${q({ move: first.move?.id ?? first.move, account: accounts['6600'] })}&fields=analytic,debit`,
      'pia',
    )
  ).json.items[0];
  expect(expense.analytic?.id ?? expense.analytic).toBe(analytic);
  expect(num(expense.debit)).toBe(10000);
});

test('an impairment replans the rest; a sale books the gain in one balanced entry', async () => {
  // April posted (book 80 000), then impaired to 60 000: the eight months left at 7 500.
  const impaired = await call('POST', `/api/v1/assets/${asset}/revalue`, 'pia', {
    date: '2026-04-30',
    value: '60000',
  });
  expect(impaired.status, JSON.stringify(impaired.json)).toBe(200);
  const loss = await sums(impaired.json.move);
  expect(loss[accounts['6600'] as number]).toBeCloseTo(20000, 2);
  const planned = (
    await call(
      'GET',
      `/api/v1/models/account.asset.line?filter=${q({ asset, posted: false })}&fields=amount`,
      'pia',
    )
  ).json.items as Json[];
  expect(planned).toHaveLength(8);
  expect(planned.every((l) => num(l.amount) === 7500)).toBe(true);

  // Sold at the end of June for 50 000: May and June posted (book 45 000), a 5 000 gain.
  const sold = await call('POST', `/api/v1/assets/${asset}/dispose`, 'pia', {
    date: '2026-06-30',
    proceeds: '50000',
    account: accounts['1010'],
  });
  expect(sold.status, JSON.stringify(sold.json)).toBe(200);
  const entry = await sums(sold.json.move);
  expect(entry[accounts['1590'] as number]).toBeCloseTo(75000, 2);
  expect(entry[accounts['1500'] as number]).toBeCloseTo(-120000, 2);
  expect(entry[accounts['1010'] as number]).toBeCloseTo(50000, 2);
  expect(entry[accounts['4900'] as number]).toBeCloseTo(-5000, 2);
  expect(Object.values(entry).reduce((s, x) => s + x, 0)).toBeCloseTo(0, 2);
  const after = (await call('GET', `${A}/${asset}?fields=state,disposedOn`, 'pia')).json;
  expect(after.state).toBe('disposed');
  expect(
    (
      await call(
        'GET',
        `/api/v1/models/account.asset.line?filter=${q({ asset, posted: false })}&fields=id`,
        'pia',
      )
    ).json.items,
  ).toEqual([]);
});

test('the tax book of the year beside the accounting book', async () => {
  const book = await call('GET', '/api/v1/assets/tax-book?year=2026', 'otto');
  expect(book.status).toBe(200);
  const row = (book.json.rows as Json[]).find((r) => r.asset === asset);
  // Reducing balance at 20%: 24 000 on 120 000; the books depreciated 55 000 (40 000 and 15 000) and impaired 20 000.
  expect(row).toMatchObject({
    opening: '120000.00',
    taxDepreciation: '24000.00',
    closing: '96000.00',
    bookDepreciation: '55000.00',
  });
});

test('a posted bill’s line on the asset account becomes a draft asset, once', async () => {
  const vendor = (
    await call('POST', '/api/v1/models/res.partner', 'pia', {
      name: 'Star Computers',
      isVendor: true,
    })
  ).json.id;
  const bdt = (await call('GET', '/api/v1/models/res.currency?fields=name', 'pia')).json.items.find(
    (c: Json) => c.name === 'BDT',
  ).id;
  // Entered and submitted by an accountant; above 100 000, approved (and so posted) by a manager.
  const bill = await call('POST', '/api/v1/models/account.move', 'otto', {
    kind: 'in_invoice',
    journal: journals['BILL'],
    partner: vendor,
    currency: bdt,
    date: '2026-07-10',
    lines: {
      create: [
        {
          lineKind: 'product',
          name: 'Laptop',
          quantity: '2',
          priceUnit: '90000.00',
          account: accounts['1500'],
          analytic,
        },
        {
          lineKind: 'product',
          name: 'Carry cases',
          quantity: '2',
          priceUnit: '2500.00',
          account: accounts['6300'],
        },
      ],
    },
  });
  expect(bill.status, JSON.stringify(bill.json)).toBe(201);
  expect(
    (await call('POST', `/api/v1/models/account.move/${bill.json.id}/transitions/submit`, 'otto'))
      .status,
  ).toBe(200);
  const inbox = (await call('GET', '/api/v1/approvals/inbox', 'pia')).json.requests as Json[];
  const request = inbox.find(
    (r) => r.targetModel === 'account.move' && r.targetId === bill.json.id,
  );
  expect(
    (await call('POST', `/api/v1/approvals/requests/${request.id}/approve`, 'pia')).status,
  ).toBe(200);
  expect(
    (await call('GET', `/api/v1/models/account.move/${bill.json.id}?fields=state`, 'pia')).json
      .state,
  ).toBe('posted');
  const worker = assetWorker({ shutro: host.server.shutro });
  expect(await worker.drain()).toBeGreaterThanOrEqual(1);
  const drafts = (
    await call(
      'GET',
      `${A}?filter=${q({ bill: bill.json.id })}&fields=name,value,state,partner,analytic`,
      'pia',
    )
  ).json.items as Json[];
  expect(drafts).toHaveLength(1);
  expect(drafts[0]).toMatchObject({ name: 'Laptop', state: 'draft' });
  expect(num(drafts[0].value)).toBe(180000);
  expect(await worker.drain()).toBe(0);
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
  expect(JSON.stringify(summary)).toContain('Fixed assets');
});
