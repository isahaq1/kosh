/**
 * Payment follow-ups on real PostgreSQL (RFC 0029 §3.4): the default levels; who is late and at which level; the
 * daily run sending each customer one reminder by email (and a text at the levels that say so), once per level,
 * noted on the invoices; a pause respected by the run and overridden by Send now; sales stopped at the final
 * level; only accountants see and act.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accounting, configureFollowups, runFollowups } from '@kosh/accounting';
import { createMemoryMailer } from '@kosh/mail';
import { createMemoryMessenger } from '@kosh/notify';
import { sales } from '@kosh/sales';
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
import { saleAccount } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [base, sales, accounting, saleAccount];
const mailer = createMemoryMailer();
const messenger = createMemoryMessenger(['sms']);

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let host: AppHost;
let company: number;
let bdt: number;
let product: number;
const customers: Record<string, number> = {};
const journals: Record<string, number> = {};
const tokens = new Map<string, string>();

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function call(
  method: 'GET' | 'POST',
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
const expectStatus = (r: { status: number; json: Json }, status: number) =>
  expect(r.status, JSON.stringify(r.json)).toBe(status);
const daysAgo = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
const run = () =>
  host.server.shutro.bootstrap({ reason: 'test: follow-ups', company }, (env) =>
    runFollowups(env as never),
  );

/** A posted customer invoice of 1,000, due `due` days ago. */
async function invoice(partner: number, due: number): Promise<number> {
  const created = await call('POST', '/api/v1/models/account.move', 'rahim', {
    kind: 'out_invoice',
    journal: journals['INV'],
    partner,
    currency: bdt,
    date: daysAgo(due + 30),
    dateDue: daysAgo(due),
    lines: { create: [{ lineKind: 'product', name: 'Goods', quantity: '1', priceUnit: '1000' }] },
  });
  expectStatus(created, 201);
  expectStatus(
    await call('POST', `/api/v1/models/account.move/${created.json.id}/transitions/post`, 'rahim'),
    200,
  );
  return created.json.id as number;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-followups-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({ driver, catalogue, change: { install: ['sales', 'accounting'] }, dir }),
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
  configureFollowups({ mailer, messenger, portalUrl: 'https://portal.test' });
  const auth = host.server.auth;
  if (auth === undefined) throw new Error('base is installed');
  ({ company } = await installBase(host.server.shutro, auth, {
    company: { name: 'Padma Traders', currency: 'BDT' },
    admin: { login: 'admin', name: 'Administrator', password: PASSWORD },
  }));
  await installDefaults(host.server.shutro, host.server.registry.loaded.modules, { company });
  for (const [login, groups] of [
    ['maria', ['account.manager', 'sales.manager']],
    ['rahim', ['account.user', 'sales.user']],
    ['sumi', ['sales.user']],
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
    await call('POST', '/api/v1/accounting/charts/install', 'maria', { template: 'generic' }),
    200,
  );
  const ids = await host.server.shutro.bootstrap({ reason: 'test: data', company }, async (env) => {
    type Model = { create(rows: unknown[]): Promise<{ ids: number[] }> };
    const model = (name: string) => env.model(name as never) as unknown as Model;
    const [row] = await env.sql<{ id: number }>`SELECT id FROM res_currency WHERE name = 'BDT'`;
    const p = await model('product.product').create([{ name: 'Steel beam', listPrice: '1000' }]);
    const c = await model('res.partner').create([
      { name: 'Bengal Steel', isCompany: true, isCustomer: true, email: 'ap@bengal.test' },
      {
        name: 'Meghna Mills',
        isCompany: true,
        isCustomer: true,
        email: 'ap@meghna.test',
        mobile: '+8801711000001',
      },
      { name: 'Padma Foods', isCompany: true, isCustomer: true, email: 'ap@padma.test' },
    ]);
    return { bdt: row?.id as number, product: p.ids[0] as number, customers: c.ids };
  });
  bdt = ids.bdt;
  product = ids.product;
  ['bengal', 'meghna', 'padma'].forEach((key, i) => {
    customers[key] = ids.customers[i] as number;
  });
  const journalRows = await call('GET', '/api/v1/models/account.journal?fields=id,code', 'maria');
  for (const j of journalRows.json.items as { id: number; code: string }[]) journals[j.code] = j.id;
}, 180_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('the late customers by level; one reminder per level, a text at the final one; sales on hold', async () => {
  const levels = await call(
    'GET',
    '/api/v1/models/account.followup.level?fields=days,name',
    'maria',
  );
  expect(levels.json.items.map((l: Json) => l.days)).toEqual([15, 30, 60]);

  const bengal = await invoice(customers['bengal'] as number, 20);
  await invoice(customers['meghna'] as number, 70);
  await invoice(customers['meghna'] as number, 5); // overdue but under every level on its own

  expect((await call('GET', '/api/v1/accounting/followups', 'sumi')).status).toBe(403);
  const rows = await call('GET', '/api/v1/accounting/followups', 'rahim');
  expectStatus(rows, 200);
  const byName = new Map((rows.json.rows as Json[]).map((r) => [r.name, r]));
  expect(byName.get('Bengal Steel')).toMatchObject({ days: 20, due: { name: 'First reminder' } });
  expect(byName.get('Meghna Mills')).toMatchObject({ days: 70, due: { name: 'Final notice' } });
  expect(byName.get('Meghna Mills').invoices).toHaveLength(2);

  expect(await run()).toBe(2);
  expect(mailer.sent.map((m) => m.to).sort()).toEqual(['ap@bengal.test', 'ap@meghna.test']);
  const meghnaMail = mailer.sent.find((m) => m.to === 'ap@meghna.test');
  expect(meghnaMail?.subject).toBe('Padma Traders: final notice');
  expect(meghnaMail?.text).toContain('https://portal.test/d/invoices/');
  expect(meghnaMail?.text).toContain('2,000.00 BDT');
  expect(messenger.sent).toEqual([
    expect.objectContaining({ channel: 'sms', to: '+8801711000001' }),
  ]);
  // Once per level: the next run sends nothing.
  expect(await run()).toBe(0);
  expect(mailer.sent).toHaveLength(2);
  // Noted on the invoice's chatter.
  const chatter = await call('GET', `/api/v1/chatter/account.move/${bengal}`, 'rahim');
  expect(
    (chatter.json.items as Json[]).some(
      (i) => i.kind === 'note' && String(i.body).includes('First reminder'),
    ),
  ).toBe(true);

  // The final level stops sales to Meghna Mills.
  const order = await call('POST', '/api/v1/models/sale.order', 'rahim', {
    partner: customers['meghna'],
    currency: bdt,
    lines: { create: [{ product, name: 'Steel beam', quantity: '1', priceUnit: '1000' }] },
  });
  expectStatus(order, 201);
  const confirm = await call(
    'POST',
    `/api/v1/models/sale.order/${order.json.id}/transitions/confirm`,
    'rahim',
  );
  expect(confirm.status).toBe(422);
  expect(JSON.stringify(confirm.json)).toContain('on hold');
});

test('a pause holds the daily reminders until its date; Send now sends anyway', async () => {
  const padma = customers['padma'] as number;
  await invoice(padma, 16);
  expect(
    (
      await call('POST', `/api/v1/accounting/followups/${padma}/pause`, 'rahim', {
        until: daysAgo(1),
      })
    ).status,
  ).toBe(400);
  expectStatus(
    await call('POST', `/api/v1/accounting/followups/${padma}/pause`, 'rahim', {
      until: daysAgo(-10),
      note: 'Pays on the 20th',
    }),
    200,
  );
  const before = mailer.sent.length;
  expect(await run()).toBe(0);
  expect(mailer.sent).toHaveLength(before);
  const row = (await call('GET', '/api/v1/accounting/followups', 'rahim')).json.rows.find(
    (r: Json) => r.name === 'Padma Foods',
  );
  expect(row).toMatchObject({ pausedUntil: daysAgo(-10), pauseNote: 'Pays on the 20th' });

  const now = await call('POST', `/api/v1/accounting/followups/${padma}/send`, 'rahim');
  expectStatus(now, 200);
  expect(now.json).toEqual({ level: 'First reminder', channels: ['email'] });
  expect(mailer.sent.at(-1)?.to).toBe('ap@padma.test');
  const log = await call(
    'GET',
    `/api/v1/models/account.followup.sent?filter=${encodeURIComponent(JSON.stringify({ partner: padma }))}&fields=channels,automatic`,
    'rahim',
  );
  expect(log.json.items).toEqual([
    expect.objectContaining({ channels: 'email', automatic: false }),
  ]);
});
