/**
 * The ledger core on real PostgreSQL through the HTTP API (RFC 0009 step 1): installing Accounting brings its
 * dependencies; a manager installs the Bangladesh chart once; an accountant posts a balanced entry that gets the
 * journal type's number (gapless, drafts leave no gap) and a posting time; an unbalanced entry, an entry on or
 * before the lock date and an entry without lines are refused with the reason; a posted entry and its lines are
 * immutable (API and database); a reversal is a linked, negated entry; a foreign-currency entry is converted at
 * the rate of its date; invoicing users may not post entries and outsiders see nothing.
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
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { accounting } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [base, accounting];

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let host: AppHost;
let company: number;
let bdt: number;
let usd: number;
const accounts: Record<string, number> = {};
const journals: Record<string, number> = {};
const tokens = new Map<string, string>();

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function call(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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

const year = new Date().getUTCFullYear();
const today = new Date().toISOString().slice(0, 10);
const plusDays = (days: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** A miscellaneous entry: an expense against the bank, as `as` would create it. */
const entry = (
  as: string,
  lines: readonly { account: number; debit?: string; credit?: string; amountCurrency?: string }[],
  extra: Record<string, unknown> = {},
) =>
  call('POST', '/api/v1/models/account.move', as, {
    journal: journals['MISC'],
    currency: bdt,
    date: today,
    ref: 'test',
    lines: { create: lines.map((l) => ({ name: 'line', debit: '0', credit: '0', ...l })) },
    ...extra,
  });
const expectStatus = (r: { status: number; json: Json }, status: number) =>
  expect(r.status, JSON.stringify(r.json)).toBe(status);
const post = (id: number, as = 'rahim') =>
  call('POST', `/api/v1/models/account.move/${id}/transitions/post`, as);

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-accounting-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({ driver, catalogue, change: { install: ['accounting'] }, dir }),
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
    ['maria', ['account.manager']],
    ['rahim', ['account.user']],
    ['eve', ['account.invoicing']],
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
  const ids = await host.server.shutro.bootstrap({ reason: 'test: data', company }, async (env) => {
    const [row] = await env.sql<{ id: number }>`SELECT id FROM res_currency WHERE name = 'BDT'`;
    const created = await (
      env.model('res.currency' as never) as unknown as {
        create(rows: unknown[]): Promise<{ ids: number[] }>;
      }
    ).create([{ name: 'USD', rounding: '0.01', decimalPlaces: 2 }]);
    return { bdt: row?.id as number, usd: created.ids[0] as number };
  });
  bdt = ids.bdt;
  usd = ids.usd;
}, 180_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('installing Accounting brings its dependencies; the chart installs once, by a manager', async () => {
  const installed = await driver.query<{ name: string }>({
    text: 'SELECT name FROM kosh_module ORDER BY name',
    params: [],
  });
  expect(installed.map((r) => r.name)).toEqual([
    'accounting',
    'base',
    'contacts',
    'messaging',
    'permissions',
    'product',
    'reporting',
    'storage',
  ]);
  const before = await call('GET', '/api/v1/accounting/charts', 'maria');
  expect(before.json).toEqual({
    installed: null,
    templates: [{ code: 'generic', label: 'Generic' }],
  });
  // An accountant may not create accounts, so cannot install a chart.
  expect(
    (await call('POST', '/api/v1/accounting/charts/install', 'rahim', { template: 'generic' }))
      .status,
  ).toBe(403);
  // A tax without an account: the chart links it.
  await host.server.shutro.bootstrap({ reason: 'test: a tax', company }, (env) =>
    (
      env.model('account.tax' as never) as unknown as { create(r: unknown[]): Promise<unknown> }
    ).create([{ name: 'VAT 15 % (test)', use: 'sale', rate: '0.15' }]),
  );
  expect(
    (await call('POST', '/api/v1/accounting/charts/install', 'maria', { template: 'nope' })).status,
  ).toBe(400);
  const result = await call('POST', '/api/v1/accounting/charts/install', 'maria', {
    template: 'generic',
  });
  expectStatus(result, 200);
  expect(result.json).toMatchObject({ template: 'generic', journals: 5 });
  expect(result.json.accounts).toBeGreaterThan(25);
  expect(result.json.taxes).toBe(1); // the tax without an account now posts somewhere
  const again = await call('POST', '/api/v1/accounting/charts/install', 'maria', {
    template: 'generic',
  });
  expectStatus(again, 409);
  expect((await call('GET', '/api/v1/accounting/charts', 'maria')).json.installed).toBe('generic');

  const accountRows = await call(
    'GET',
    '/api/v1/models/account.account?fields=id,code,type&limit=200&order=code+asc',
    'rahim',
  );
  for (const a of accountRows.json.items as { id: number; code: string }[]) accounts[a.code] = a.id;
  expect(accounts['2200']).toBeDefined(); // output tax
  const journalRows = await call(
    'GET',
    '/api/v1/models/account.journal?fields=id,code,type',
    'rahim',
  );
  for (const j of journalRows.json.items as { id: number; code: string }[]) journals[j.code] = j.id;
  expect(Object.keys(journals).sort()).toEqual(['BILL', 'BNK', 'CSH', 'INV', 'MISC']);
  // The company's defaults point at the template's accounts.
  const [c] = await driver.query<{ account_receivable_id: number; chart_template: string }>({
    text: 'SELECT account_receivable_id, chart_template FROM res_company WHERE id = $1',
    params: [company],
  });
  expect(c?.chart_template).toBe('generic');
  expect(c?.account_receivable_id).toBe(accounts['1100']);
});

test('posting: balanced entries get the journal type number (gapless) and a posting time; the rest is refused', async () => {
  const unbalanced = await entry('rahim', [
    { account: accounts['6100'] as number, debit: '1000' },
    { account: accounts['1010'] as number, credit: '900' },
  ]);
  expectStatus(unbalanced, 201);
  const refused = await post(unbalanced.json.id);
  expectStatus(refused, 422);
  expect(refused.json.detail).toContain('does not balance');
  expect(refused.json.detail).toContain('100.00');

  const empty = await entry('rahim', []);
  expect((await post(empty.json.id)).json.detail).toContain('no lines');

  // A draft deleted before posting leaves no gap in the numbering.
  expect(
    (await call('DELETE', `/api/v1/models/account.move/${empty.json.id}`, 'rahim')).status,
  ).toBe(200);

  const rent = await entry('rahim', [
    { account: accounts['6100'] as number, debit: '1000' },
    { account: accounts['1010'] as number, credit: '1000' },
  ]);
  expect(rent.json.name).toBe('/'); // not numbered until posted
  const posted = await post(rent.json.id);
  expectStatus(posted, 200);
  expect(posted.json.name).toBe(`MISC/${year}/00001`);
  expect(posted.json.state).toBe('posted');
  expect(posted.json.postedAt).not.toBeNull();
  expect(posted.json.rate).toBe('1'); // the company currency
  expect(posted.json.amountDebit).toMatchObject({ amount: '1000.00' });

  const second = await entry('rahim', [
    { account: accounts['6200'] as number, debit: '250.50' },
    { account: accounts['1000'] as number, credit: '250.50' },
  ]);
  expect((await post(second.json.id)).json.name).toBe(`MISC/${year}/00002`);

  // Lines of a company-currency entry carry the signed amount in currency.
  const lines = await call(
    'GET',
    `/api/v1/models/account.move.line?filter=${encodeURIComponent(JSON.stringify({ move: rent.json.id }))}&fields=debit,credit,amountCurrency,date`,
    'rahim',
  );
  expect(lines.json.items.map((l: Json) => l.amountCurrency.amount).sort()).toEqual([
    '-1000.00',
    '1000.00',
  ]);
  expect(lines.json.items[0].date).toBe(today);
});

test('a posted entry is immutable at the API and in the database; a reversal is a linked, negated entry', async () => {
  const rent = await call(
    'GET',
    `/api/v1/models/account.move?filter=${encodeURIComponent(JSON.stringify({ name: `MISC/${year}/00001` }))}&fields=id,name`,
    'rahim',
  );
  const id = rent.json.items[0].id as number;
  const edit = await call('PATCH', `/api/v1/models/account.move/${id}`, 'rahim', {
    ref: 'changed',
  });
  expectStatus(edit, 422);
  expect(edit.json.detail).toContain('cannot be changed');
  const lines = await call(
    'GET',
    `/api/v1/models/account.move.line?filter=${encodeURIComponent(JSON.stringify({ move: id }))}&fields=id,debit`,
    'rahim',
  );
  const lineId = lines.json.items[0].id as number;
  expect(
    (await call('PATCH', `/api/v1/models/account.move.line/${lineId}`, 'rahim', { debit: '5' }))
      .status,
  ).toBe(422);
  expect(
    (await call('DELETE', `/api/v1/models/account.move/${id}`, 'maria')).status,
  ).toBeGreaterThanOrEqual(400);
  // Raw SQL is stopped by the trigger too.
  await expect(
    driver.query({
      text: 'UPDATE account_move_line SET debit = 5 WHERE id = $1',
      params: [lineId],
    }),
  ).rejects.toThrow(/posted entry/);
  await expect(
    driver.query({ text: 'DELETE FROM account_move WHERE id = $1', params: [id] }),
  ).rejects.toThrow(/posted entry/);

  const notPosted = await entry('rahim', [{ account: accounts['6100'] as number, debit: '1' }]);
  expect(
    (await call('POST', `/api/v1/accounting/moves/${notPosted.json.id}/reverse`, 'rahim', {}))
      .status,
  ).toBe(409);

  const reversed = await call('POST', `/api/v1/accounting/moves/${id}/reverse`, 'rahim', {
    post: true,
  });
  expectStatus(reversed, 200);
  expect(reversed.json).toMatchObject({ name: `MISC/${year}/00003`, state: 'posted' });
  const reversal = await call(
    'GET',
    `/api/v1/models/account.move/${reversed.json.id}?fields=reversalOf,ref,amountDebit`,
    'rahim',
  );
  expect(reversal.json.reversalOf).toBe(id);
  expect(reversal.json.ref).toBe(`Reversal of MISC/${year}/00001`);
  expect(reversal.json.amountDebit.amount).toBe('1000.00');
  const original = await call(
    'GET',
    `/api/v1/models/account.move/${id}?fields=reversedBy`,
    'rahim',
  );
  expect(original.json.reversedBy).toBe(reversed.json.id);
  const swapped = await call(
    'GET',
    `/api/v1/models/account.move.line?filter=${encodeURIComponent(JSON.stringify({ move: reversed.json.id }))}&fields=account,debit,credit`,
    'rahim',
  );
  const bank = swapped.json.items.find((l: Json) => l.account === accounts['1010']);
  expect(bank.debit.amount).toBe('1000.00'); // the bank was credited; the reversal debits it
  expect((await call('POST', `/api/v1/accounting/moves/${id}/reverse`, 'rahim', {})).status).toBe(
    409,
  ); // once
});

test('lock dates and closed years refuse postings on or before them', async () => {
  await host.server.shutro.bootstrap({ reason: 'test: lock', company }, async (env) => {
    await env.sql`UPDATE res_company SET lock_date = ${today} WHERE id = ${company}`;
  });
  const locked = await entry('rahim', [
    { account: accounts['6100'] as number, debit: '10' },
    { account: accounts['1010'] as number, credit: '10' },
  ]);
  const refused = await post(locked.json.id);
  expectStatus(refused, 422);
  expect(refused.json.detail).toContain('lock date');
  // Dated after the lock date: fine.
  await call('PATCH', `/api/v1/models/account.move/${locked.json.id}`, 'rahim', {
    date: plusDays(1),
  });
  expect((await post(locked.json.id)).status).toBe(200);
  await host.server.shutro.bootstrap({ reason: 'test: unlock', company }, async (env) => {
    await env.sql`UPDATE res_company SET lock_date = NULL WHERE id = ${company}`;
  });

  // A closed fiscal year covering today.
  const fy = await call('POST', '/api/v1/models/account.fiscal.year', 'maria', {
    name: 'FY closed',
    dateFrom: plusDays(-10),
    dateTo: plusDays(-1),
    state: 'closed',
  });
  expectStatus(fy, 201);
  const overlapping = await call('POST', '/api/v1/models/account.fiscal.year', 'maria', {
    name: 'FY overlap',
    dateFrom: plusDays(-5),
    dateTo: plusDays(20),
  });
  expectStatus(overlapping, 422);
  const inClosed = await entry(
    'rahim',
    [
      { account: accounts['6100'] as number, debit: '10' },
      { account: accounts['1010'] as number, credit: '10' },
    ],
    { date: plusDays(-3) },
  );
  const closedRefused = await post(inClosed.json.id);
  expectStatus(closedRefused, 422);
  expect(closedRefused.json.detail).toContain('closed fiscal year');
});

test('a foreign-currency entry converts its lines at the rate of its date', async () => {
  expect(
    (
      await call('POST', '/api/v1/models/res.currency.rate', 'maria', {
        currency: usd,
        date: plusDays(-30),
        rate: '0.0085', // USD per BDT
      })
    ).status,
  ).toBe(201);
  const move = await call('POST', '/api/v1/models/account.move', 'rahim', {
    journal: journals['BNK'],
    currency: usd,
    date: today,
    lines: {
      create: [
        { name: 'USD in', account: accounts['1010'], amountCurrency: '100' },
        { name: 'USD fee', account: accounts['6500'], amountCurrency: '-100' },
      ],
    },
  });
  expectStatus(move, 201);
  const posted = await post(move.json.id);
  expectStatus(posted, 200);
  expect(posted.json.name).toBe(`BNK/${year}/00001`);
  expect(posted.json.rate).toBe('0.0085');
  expect(posted.json.amountDebit).toMatchObject({ amount: '11764.71', currency: 'BDT' }); // 100 / 0.0085
  const lines = await call(
    'GET',
    `/api/v1/models/account.move.line?filter=${encodeURIComponent(JSON.stringify({ move: move.json.id }))}&fields=debit,credit,amountCurrency`,
    'rahim',
  );
  const sides = lines.json.items.map((l: Json) => [
    l.debit.amount,
    l.credit.amount,
    l.amountCurrency.amount,
  ]);
  expect(sides).toEqual(
    expect.arrayContaining([
      ['11764.71', '0.00', '100.00'],
      ['0.00', '11764.71', '-100.00'],
    ]),
  );
  // No rate for the date: refused with the reason.
  const early = await call('POST', '/api/v1/models/account.move', 'rahim', {
    journal: journals['BNK'],
    currency: usd,
    date: plusDays(-60),
    lines: { create: [{ name: 'x', account: accounts['1010'], amountCurrency: '1' }] },
  });
  const noRate = await post(early.json.id);
  expect(noRate.status).toBeGreaterThanOrEqual(400);
});

test('invoicing users cannot post entries; outsiders see nothing', async () => {
  const draft = await entry('eve', [
    { account: accounts['6100'] as number, debit: '1' },
    { account: accounts['1010'] as number, credit: '1' },
  ]);
  expectStatus(draft, 201); // may create (invoices come in step 2)
  expect((await post(draft.json.id, 'eve')).status).toBe(403); // needs account.post
  expect((await call('GET', '/api/v1/models/account.move', 'bob')).status).toBe(403);
  expect((await call('GET', '/api/v1/models/account.account', 'bob')).status).toBe(403);
  expect((await call('GET', '/api/v1/accounting/charts', 'bob')).status).toBe(200); // the templates: public to signed-in users
});
