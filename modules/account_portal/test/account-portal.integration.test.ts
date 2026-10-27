/**
 * Accounting in the portal on real PostgreSQL (RFC 0015 step 2): a customer's portal user sees the posted invoices
 * of their company — not drafts, not another customer's — with what is still due, the unpaid ones on the portal's
 * home; a vendor's sees the bills recorded for them; nothing of the ledger is reachable otherwise.
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
import { accountPortal } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [base, accountPortal];

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let host: AppHost;
const tokens = new Map<string, string>();
const partners: Record<string, number> = {};
const moves: Record<string, number> = {};
const journals: Record<string, number> = {};
let bdt = 0;

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function tokenOf(login: string): Promise<string> {
  const cached = tokens.get(login);
  if (cached !== undefined) return cached;
  const res = await host.server.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { login, password: PASSWORD },
  });
  const token = (res.json() as { token: string }).token;
  tokens.set(login, token);
  return token;
}
async function call(method: 'GET' | 'POST', url: string, as: string, payload?: unknown) {
  const res = await host.server.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${await tokenOf(as)}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: res.statusCode, json: (res.body === '' ? null : res.json()) as Json };
}
const today = new Date().toISOString().slice(0, 10);
async function document(kind: string, partner: number, amount: string, post: boolean) {
  const created = await call('POST', '/api/v1/models/account.move', 'maria', {
    kind,
    journal: kind.startsWith('in_') ? journals['BILL'] : journals['INV'],
    partner,
    currency: bdt,
    date: today,
    dateDue: today,
    lines: { create: [{ lineKind: 'product', name: 'Goods', quantity: '1', priceUnit: amount }] },
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  if (post)
    expect(
      (
        await call(
          'POST',
          `/api/v1/models/account.move/${created.json.id}/transitions/post`,
          'maria',
        )
      ).status,
    ).toBe(200);
  return created.json.id as number;
}
async function portalUser(partner: number): Promise<string> {
  const granted = await call('POST', '/api/v1/portal/access', 'maria', { partner });
  expect(granted.status).toBe(201);
  const token = new URL(granted.json.activationUrl).searchParams.get('token');
  const activated = await host.server.app.inject({
    method: 'POST',
    url: '/api/portal/v1/activate',
    payload: { token, password: PASSWORD },
  });
  expect(activated.statusCode).toBe(200);
  return granted.json.login as string;
}

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-account-portal-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({ driver, catalogue, change: { install: ['account_portal'] }, dir }),
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
  await auth.createUser({
    login: 'maria',
    name: 'Maria',
    password: PASSWORD,
    company,
    companies: [company],
    groups: ['account.manager', 'portal.manager'],
  });
  expect(
    (await call('POST', '/api/v1/accounting/charts/install', 'maria', { template: 'generic' }))
      .status,
  ).toBe(200);
  await host.server.shutro.bootstrap({ reason: 'test', company }, async (env) => {
    type Model = { create(rows: unknown[]): Promise<{ ids: number[] }> };
    const model = (name: string) => env.model(name as never) as unknown as Model;
    const [row] = await env.sql<{ id: number }>`SELECT id FROM res_currency WHERE name = 'BDT'`;
    bdt = row?.id ?? 0;
    const [acme, globex] = (
      await model('res.partner').create([
        { name: 'Acme Trading', isCompany: true },
        { name: 'Globex', isCompany: true },
      ])
    ).ids;
    const [rina, bina] = (
      await model('res.partner').create([
        { name: 'Rina Akter', email: 'rina@acme.test', parent: acme },
        { name: 'Bina Das', email: 'bina@globex.test', parent: globex },
      ])
    ).ids;
    Object.assign(partners, { acme, globex, rina, bina });
  });
  for (const j of (await call('GET', '/api/v1/models/account.journal?fields=id,code', 'maria')).json
    .items as { id: number; code: string }[])
    journals[j.code] = j.id;
  moves['posted'] = await document('out_invoice', partners['acme'] as number, '1500', true);
  moves['draft'] = await document('out_invoice', partners['acme'] as number, '700', false);
  moves['other'] = await document('out_invoice', partners['globex'] as number, '900', true);
  moves['bill'] = await document('in_invoice', partners['acme'] as number, '300', true);
  await portalUser(partners['rina'] as number);
  await portalUser(partners['bina'] as number);
}, 180_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

const RINA = 'rina@acme.test';

test('posted invoices of the customer’s company, with what is due; never drafts or another customer’s', async () => {
  const list = await call('GET', '/api/portal/v1/documents/invoices', RINA);
  expect(list.json.items.map((i: Json) => i.id)).toEqual([moves['posted']]);
  expect(list.json.items[0]).toMatchObject({
    paymentState: 'not_paid',
    amountResidual: { amount: '1500.00', currency: 'BDT' },
  });
  for (const id of [moves['draft'], moves['other'], moves['bill']])
    expect((await call('GET', `/api/portal/v1/documents/invoices/${id}`, RINA)).status).toBe(404);
  const doc = await call('GET', `/api/portal/v1/documents/invoices/${moves['posted']}`, RINA);
  expect(doc.json.lines).toHaveLength(1);
  expect(doc.json.lines[0]).toMatchObject({ name: 'Goods' });
  expect(doc.json).toMatchObject({ pdf: true, thread: true, actions: [] });
  const home = await call('GET', '/api/portal/v1/home', RINA);
  expect(home.json.sections).toMatchObject([{ key: 'invoices', count: 1 }]);
  expect(
    (await call('GET', '/api/portal/v1/documents/invoices', 'bina@globex.test')).json.items,
  ).toHaveLength(1);
});

test('bills recorded for a vendor show under bills; the ledger stays closed', async () => {
  const bills = await call('GET', '/api/portal/v1/documents/bills', RINA);
  expect(bills.json.items.map((i: Json) => i.id)).toEqual([moves['bill']]);
  for (const url of [
    '/api/v1/models/account.move',
    `/api/v1/models/account.move/${moves['posted']}`,
    '/api/v1/models/account.move.line',
  ])
    expect((await call('GET', url, RINA)).status).toBe(403);
});
