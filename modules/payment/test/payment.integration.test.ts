/**
 * Online payments on real PostgreSQL (RFC 0017 step 4) with the fake provider: a customer's portal user pays an open
 * invoice (Pay now → the provider's page → its signed callback through an inbound webhook) and Accounting registers
 * the payment, reconciled, once — a repeated callback and a return before the callback do not pay twice; a declined
 * payment leaves the invoice open; another customer cannot pay or see it; employees do not use the portal's routes.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webhookWorkers } from '@kosh/integrations';
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
import { paymentModule } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const PORTAL = 'https://portal.example.test';
const catalogue = [base, paymentModule({ portalUrl: PORTAL, apiUrl: 'https://api.example.test' })];

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let host: AppHost;
let provider = 0;
const tokens = new Map<string, string>();
const partners: Record<string, number> = {};
const journals: Record<string, number> = {};
let bdt = 0;
let bank = 0;

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
/** The customer on the provider's page (no session). */
async function checkout(redirectUrl: string, outcome: 'paid' | 'declined') {
  const page = await host.server.app.inject({ method: 'GET', url: redirectUrl });
  expect(page.statusCode).toBe(200);
  // As a browser posts the page's form.
  const res = await host.server.app.inject({
    method: 'POST',
    url: `${redirectUrl}?outcome=${outcome}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: '',
  });
  return { page: page.body, status: res.statusCode, location: String(res.headers.location ?? '') };
}
const today = new Date().toISOString().slice(0, 10);
async function invoice(partner: number, amount: string): Promise<number> {
  const created = await call('POST', '/api/v1/models/account.move', 'maria', {
    kind: 'out_invoice',
    journal: journals['INV'],
    partner,
    currency: bdt,
    date: today,
    dateDue: today,
    lines: { create: [{ lineKind: 'product', name: 'Goods', quantity: '1', priceUnit: amount }] },
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const posted = await call(
    'POST',
    `/api/v1/models/account.move/${created.json.id}/transitions/post`,
    'maria',
  );
  expect(posted.status).toBe(200);
  return created.json.id as number;
}
async function move(id: number): Promise<Json> {
  return (
    await call(
      'GET',
      `/api/v1/models/account.move/${id}?fields=paymentState,amountResidual`,
      'maria',
    )
  ).json;
}
async function paymentsFor(id: number): Promise<Json[]> {
  return (
    await call(
      'GET',
      '/api/v1/models/account.payment?fields=id,amount,memo,documents,state',
      'maria',
    )
  ).json.items.filter((p: Json) => (p.documents as number[]).includes(id));
}
async function tx(reference: string): Promise<Json> {
  const all = (
    await call(
      'GET',
      '/api/v1/models/payment.transaction?fields=reference,state,amount,payment,providerReference,error',
      'maria',
    )
  ).json.items as Json[];
  return all.find((t) => t.reference === reference);
}
async function drain(): Promise<void> {
  const workers = webhookWorkers({
    shutro: host.server.shutro,
    registry: host.server.registry,
    auth: host.server.auth,
  });
  for (let round = 0; round < 2; round++) for (const w of workers) await w.drain();
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
  dir = await mkdtemp(join(tmpdir(), 'kosh-payment-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(await prepareApps({ driver, catalogue, change: { install: ['payment'] }, dir }), {
    driver,
    dir,
    actor: 'test',
  });
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
    groups: ['account.manager', 'portal.manager', 'integrations.manager'],
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
  for (const j of (await call('GET', '/api/v1/models/account.journal?fields=id,code,type', 'maria'))
    .json.items as { id: number; code: string; type: string }[]) {
    journals[j.code] = j.id;
    if (j.type === 'bank' && bank === 0) bank = j.id;
  }
  const made = await call('POST', '/api/v1/models/payment.provider', 'maria', {
    name: 'Test payments',
    code: 'fake',
    journal: bank,
  });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  provider = made.json.id;
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
const BINA = 'bina@globex.test';

test('Pay now: the provider’s page, its callback, the payment registered and reconciled once', async () => {
  const id = await invoice(partners['acme'] as number, '1500');
  const doc = await call('GET', `/api/portal/v1/documents/invoices/${id}`, RINA);
  expect(doc.json.payable).toBe(true);
  const providers = await call('GET', '/api/portal/v1/payments/providers', RINA);
  expect(providers.json.providers).toEqual([{ id: provider, name: 'Test payments', test: true }]);

  const started = await call('POST', '/api/portal/v1/payments', RINA, {
    document: 'invoices',
    id,
    provider,
  });
  expect(started.status, JSON.stringify(started.json)).toBe(201);
  const { reference, redirectUrl } = started.json;
  expect(reference).toMatch(/^PAY-/);
  const paid = await checkout(redirectUrl, 'paid');
  expect(paid.page).toContain('1500.00 BDT');
  expect(paid.status).toBe(303);
  expect(paid.location).toBe(`${PORTAL}/d/invoices/${id}?payment=${reference}`);
  await drain();

  expect(await tx(reference)).toMatchObject({ state: 'done', amount: { amount: '1500.00' } });
  expect((await tx(reference)).providerReference).toMatch(/^FAKE-/);
  expect((await move(id)).amountResidual.amount).toBe('0.00');
  const payments = await paymentsFor(id);
  expect(payments).toHaveLength(1);
  expect(payments[0]).toMatchObject({ state: 'posted', amount: { amount: '1500.00' } });
  expect(payments[0].memo).toContain('Test payments FAKE-');
  expect((await call('GET', `/api/portal/v1/payments/${reference}`, RINA)).json).toMatchObject({
    reference,
    state: 'done',
  });
  expect((await call('GET', `/api/portal/v1/documents/invoices/${id}`, RINA)).json.payable).toBe(
    false,
  );

  // The provider calls again (a replay of the logged call): nothing is paid twice.
  const calls = (
    await call('GET', '/api/v1/models/webhook.inbound?fields=id,state,result', 'maria')
  ).json.items as Json[];
  expect(calls[0]).toMatchObject({ state: 'done', result: `${reference}: done` });
  expect(
    (await call('POST', `/api/v1/webhooks/inbound/${calls[0].id}/replay`, 'maria')).status,
  ).toBe(202);
  await drain();
  expect(await paymentsFor(id)).toHaveLength(1);
  // The endpoint was made with the provider's first payment.
  const endpoints = (await call('GET', '/api/v1/models/webhook.endpoint?fields=hook', 'maria')).json
    .items as Json[];
  expect(endpoints.map((e) => e.hook)).toEqual(['payment.fake']);
});

test('back before the callback: the provider is asked; the late callback pays nothing more', async () => {
  const id = await invoice(partners['acme'] as number, '800');
  const { reference, redirectUrl } = (
    await call('POST', '/api/portal/v1/payments', RINA, { document: 'invoices', id, provider })
  ).json;
  await checkout(redirectUrl, 'paid'); // the callback is queued, not handled yet
  const back = await call('GET', `/api/portal/v1/payments/${reference}`, RINA);
  expect(back.json).toMatchObject({ state: 'done', amount: '800.00', currency: 'BDT' });
  expect(await paymentsFor(id)).toHaveLength(1);
  await drain();
  expect(await paymentsFor(id)).toHaveLength(1);
  expect((await move(id)).amountResidual.amount).toBe('0.00');
});

test('a declined payment leaves the invoice open; others cannot pay it or see the payment', async () => {
  const id = await invoice(partners['acme'] as number, '450');
  const { reference, redirectUrl } = (
    await call('POST', '/api/portal/v1/payments', RINA, { document: 'invoices', id, provider })
  ).json;
  await checkout(redirectUrl, 'declined');
  await drain();
  expect(await tx(reference)).toMatchObject({ state: 'failed', payment: null });
  expect((await move(id)).amountResidual.amount).toBe('450.00');
  expect(await paymentsFor(id)).toHaveLength(0);
  // The fake checkout is done with it.
  expect((await host.server.app.inject({ method: 'GET', url: redirectUrl })).statusCode).toBe(404);

  // Another customer: not theirs to pay or to look at.
  expect(
    (await call('POST', '/api/portal/v1/payments', BINA, { document: 'invoices', id, provider }))
      .status,
  ).toBe(409);
  expect((await call('GET', `/api/portal/v1/payments/${reference}`, BINA)).status).toBe(404);
  // Employees use Accounting, not the portal's routes; documents that are not paid online are refused.
  expect(
    (await call('POST', '/api/portal/v1/payments', 'maria', { document: 'invoices', id, provider }))
      .status,
  ).toBe(403);
  expect(
    (await call('POST', '/api/portal/v1/payments', RINA, { document: 'bills', id, provider }))
      .status,
  ).toBe(404);
  // A provider that is not offered.
  expect(
    (
      await call('POST', '/api/portal/v1/payments', RINA, {
        document: 'invoices',
        id,
        provider: 999,
      })
    ).status,
  ).toBe(422);
});
