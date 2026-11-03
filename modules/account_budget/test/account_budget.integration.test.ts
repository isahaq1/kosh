/**
 * Budgets on real PostgreSQL (RFC 0024 §2.5): approved by an Accounting manager; a posted bill is actual, a confirmed
 * order committed; an order within what is left goes on; one beyond a warn line is marked and waits for an
 * Accounting manager's approval, then is confirmed; one beyond a block line is refused with the shortfall; billing
 * moves the commitment to the actual, the order line's cost centre carried onto the bill; the demo data loads.
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
  installDemo,
  prepareApps,
  recordInstalledApps,
} from '@kosh/server';
import { type Driver, orm, pg } from '@kosh/server/orm';
import { settings } from '@kosh/settings';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { accountBudget } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [base, settings, accountBudget];
const PO = '/api/v1/models/purchase.order';

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let host: AppHost;
let company: number;
let budget: number;
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
const num = (v: unknown) => Number((v as { amount?: unknown })?.amount ?? v);
const q = (f: Record<string, unknown>) => encodeURIComponent(JSON.stringify(f));
const order = async (analytic: number, price: string) => {
  const made = await call('POST', PO, 'bob', {
    partner: ids['vendor'],
    currency: ids['bdt'],
    dateOrder: '2026-05-10',
    lines: {
      create: [{ product: ids['paper'], name: 'Paper', quantity: '1', priceUnit: price, analytic }],
    },
  });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  return made.json.id as number;
};
const lines = async () =>
  Object.fromEntries(
    (
      (
        await call(
          'GET',
          `/api/v1/models/account.budget.line?filter=${q({ budget })}&fields=name,actual,committed,available`,
          'pia',
        )
      ).json.items as Json[]
    ).map((l) => [
      l.name,
      { actual: num(l.actual), committed: num(l.committed), available: num(l.available) },
    ]),
  );
const refresh = async () =>
  expect((await call('POST', '/api/v1/budgets/refresh', 'pia', { budgets: [budget] })).status).toBe(
    200,
  );

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-account-budget-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({
      driver,
      catalogue,
      change: { install: ['settings', 'account_budget'] },
      dir,
    }),
    {
      driver,
      dir,
      actor: 'test',
    },
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
    ['pia', ['account.manager', 'purchase.manager']],
    ['bob', ['purchase.user', 'account.user']],
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
    ids[`acc${a.code}`] = a.id;
  for (const j of (await call('GET', '/api/v1/models/account.journal?fields=code', 'pia')).json
    .items as Json[])
    ids[`j${j.code}`] = j.id;
  ids['bdt'] = (
    await call('GET', '/api/v1/models/res.currency?fields=name', 'pia')
  ).json.items.find((c: Json) => c.name === 'BDT').id;
  ids['ops'] = (
    await call('POST', '/api/v1/models/account.analytic', 'pia', {
      code: 'OPS',
      name: 'Operations',
    })
  ).json.id;
  ids['it'] = (
    await call('POST', '/api/v1/models/account.analytic', 'pia', { code: 'IT', name: 'IT' })
  ).json.id;
  ids['vendor'] = (
    await call('POST', '/api/v1/models/res.partner', 'pia', { name: 'Paper House', isVendor: true })
  ).json.id;
  ids['paper'] = (
    await call('POST', '/api/v1/models/product.product', 'pia', {
      name: 'Paper',
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

test('a budget approved by a manager; a bill is actual, an order committed, within what is left', async () => {
  const made = await call('POST', '/api/v1/models/account.budget', 'pia', {
    name: 'Budget 2026',
    dateFrom: '2026-01-01',
    dateTo: '2026-12-31',
    lines: {
      create: [
        { name: 'Operations', analytic: ids['ops'], planned: '100000', control: 'warn' },
        { name: 'IT', analytic: ids['it'], planned: '50000', control: 'block' },
      ],
    },
  });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  budget = made.json.id;
  expect(
    (await call('POST', `/api/v1/models/account.budget/${budget}/transitions/approve`, 'bob'))
      .status,
  ).toBe(403);
  expect(
    (await call('POST', `/api/v1/models/account.budget/${budget}/transitions/approve`, 'pia'))
      .status,
  ).toBe(200);

  // A bill of 30 000 on Operations, posted.
  const bill = await call('POST', '/api/v1/models/account.move', 'pia', {
    kind: 'in_invoice',
    journal: ids['jBILL'],
    partner: ids['vendor'],
    currency: ids['bdt'],
    date: '2026-04-05',
    lines: {
      create: [
        {
          lineKind: 'product',
          name: 'Toner',
          quantity: '1',
          priceUnit: '30000.00',
          account: ids['acc6300'],
          analytic: ids['ops'],
        },
      ],
    },
  });
  for (const t of ['submit', 'post'])
    expect(
      (await call('POST', `/api/v1/models/account.move/${bill.json.id}/transitions/${t}`, 'pia'))
        .status,
    ).toBe(200);
  // An order of 60 000 fits the 70 000 left: submitted and confirmed as usual.
  ids['po1'] = await order(ids['ops'] as number, '60000.00');
  expect((await call('POST', `${PO}/${ids['po1']}/transitions/submit`, 'bob')).status).toBe(200);
  expect((await call('GET', `${PO}/${ids['po1']}?fields=overBudget`, 'bob')).json.overBudget).toBe(
    false,
  );
  expect((await call('POST', `${PO}/${ids['po1']}/transitions/confirm`, 'bob')).status).toBe(200);
  await refresh();
  expect((await lines())['Operations']).toEqual({
    actual: 30000,
    committed: 60000,
    available: 10000,
  });
});

test('beyond a warn line: marked, waits for an Accounting manager, then confirmed; beyond a block line: refused', async () => {
  const po2 = await order(ids['ops'] as number, '20000.00');
  expect((await call('POST', `${PO}/${po2}/transitions/submit`, 'bob')).status).toBe(200);
  const marked = (await call('GET', `${PO}/${po2}?fields=overBudget,budgetNote,state`, 'bob')).json;
  expect(marked.overBudget).toBe(true);
  expect(marked.budgetNote).toContain('10000.00 left');
  expect((await call('POST', `${PO}/${po2}/transitions/confirm`, 'bob')).status).toBe(409);
  const request = (
    (await call('GET', '/api/v1/approvals/inbox', 'pia')).json.requests as Json[]
  ).find((r) => r.targetModel === 'purchase.order' && r.targetId === po2);
  expect(request.levelName).toBe('Beyond the budget');
  expect(
    (await call('POST', `/api/v1/approvals/requests/${request.id}/approve`, 'pia')).status,
  ).toBe(200);
  expect((await call('GET', `${PO}/${po2}?fields=state`, 'bob')).json.state).toBe('purchase');

  const po3 = await order(ids['it'] as number, '60000.00');
  const refused = await call('POST', `${PO}/${po3}/transitions/submit`, 'bob');
  expect(refused.status).toBe(422);
  expect(JSON.stringify(refused.json)).toContain('Beyond the budget');
  expect(JSON.stringify(refused.json)).toContain('10000.00 beyond');
  expect((await call('GET', `${PO}/${po3}?fields=state`, 'bob')).json.state).toBe('draft');
});

test('billing moves the commitment to the actual, the cost centre carried onto the bill', async () => {
  const billed = await call('POST', `${PO}/${ids['po1']}/transitions/bill`, 'pia');
  expect(billed.status, JSON.stringify(billed.json)).toBe(200);
  const [bill] = (
    await call(
      'GET',
      `/api/v1/models/account.move?filter=${q({ purchaseOrder: ids['po1'] })}&fields=state`,
      'pia',
    )
  ).json.items as Json[];
  const billLines = (
    await call(
      'GET',
      `/api/v1/models/account.move.line?filter=${q({ move: bill.id, lineKind: 'product' })}&fields=analytic`,
      'pia',
    )
  ).json.items as Json[];
  expect(billLines.every((l) => (l.analytic?.id ?? l.analytic) === ids['ops'])).toBe(true);
  for (const t of ['submit', 'post'])
    expect(
      (await call('POST', `/api/v1/models/account.move/${bill.id}/transitions/${t}`, 'pia')).status,
    ).toBe(200);
  await refresh();
  const ops = (await lines())['Operations'];
  expect(ops?.actual).toBe(90000); // the bill of 30 000 and the order's 60 000, billed
  expect(ops?.committed).toBe(20000); // the second order, not billed yet
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
  expect(JSON.stringify(summary)).toContain('Budgets');
});
