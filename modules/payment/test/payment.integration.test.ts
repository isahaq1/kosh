/**
 * Online payments on real PostgreSQL (RFC 0017 step 4) with the fake provider: a customer's portal user pays an open
 * invoice (Pay now → the provider's page → its signed callback through an inbound webhook) and Accounting registers
 * the payment, reconciled, once — a repeated callback and a return before the callback do not pay twice; a declined
 * payment leaves the invoice open; another customer cannot pay or see it; employees do not use the portal's routes.
 * SSLCommerz with its sandbox simulated: the session, IPNs confirmed with its validation API (forged and changed
 * ones refused), a failure then a retry, and the transaction query when the customer is back first. bKash with its
 * API simulated: executed on the customer's return (once), a forged return refused by bKash, a cancellation.
 * Razorpay with Payment Links simulated: its signed webhook (checked with the endpoint's secret, deduplicated by event
 * id), the return answered by fetching the link, an expired link. Stripe with Checkout Sessions simulated: events
 * signed with the secret Stripe gives (pasted into the endpoint), old or wrong signatures refused, the return
 * answered by fetching the session.
 */

import { createHmac } from 'node:crypto';
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
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  ADAPTERS,
  bkashAdapter,
  fromSubunits,
  paymentModule,
  razorpayAdapter,
  sslcommerzAdapter,
  stripeAdapter,
  toSubunits,
} from '../src/index.js';

const PASSWORD = 'correct horse battery';
const PORTAL = 'https://portal.example.test';
const API_URL = 'https://api.example.test';

/** SSLCommerz's sandbox, simulated: sessions, the order validation API and the transaction query. */
interface SslSession {
  fields: Record<string, string>;
  attempts: { status: string; val_id: string; bank_tran_id: string }[];
}
const ssl = new Map<string, SslSession>();
const sslFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  expect(url.origin).toBe('https://sandbox.sslcommerz.com');
  if (url.pathname === '/gwprocess/v4/api.php') {
    const fields = Object.fromEntries(new URLSearchParams(String(init?.body)));
    if (fields['store_passwd'] !== 'store-secret')
      return json({ status: 'FAILED', failedreason: 'Store Credential Error' });
    ssl.set(fields['tran_id'] as string, { fields, attempts: [] });
    return json({
      status: 'SUCCESS',
      sessionkey: 'S1',
      GatewayPageURL: `https://sandbox.sslcommerz.com/EasyCheckOut/${fields['tran_id']}`,
    });
  }
  const q = Object.fromEntries(url.searchParams);
  expect(q['store_id']).toBe('padma');
  if (url.pathname === '/validator/api/validationserverAPI.php') {
    for (const [tranId, session] of ssl) {
      const attempt = session.attempts.find((a) => a.val_id === q['val_id']);
      if (attempt?.status === 'VALID')
        return json({
          status: 'VALID',
          tran_id: tranId,
          val_id: attempt.val_id,
          amount: session.fields['total_amount'],
          currency: 'BDT',
          currency_type: 'BDT',
          currency_amount: session.fields['total_amount'],
          bank_tran_id: attempt.bank_tran_id,
        });
    }
    return json({ status: 'INVALID_TRANSACTION' });
  }
  if (url.pathname === '/validator/api/merchantTransIDvalidationAPI.php') {
    const session = ssl.get(q['tran_id'] ?? '');
    return json({
      APIConnect: 'DONE',
      no_of_trans_found: session?.attempts.length ?? 0,
      element: (session?.attempts ?? []).map((a) => ({
        ...a,
        tran_id: q['tran_id'],
        amount: session?.fields['total_amount'],
        currency: 'BDT',
      })),
    });
  }
  throw new Error(`unexpected ${url}`);
}) as typeof fetch;
/** The customer pays (or fails) on SSLCommerz: the attempt it records, and the IPN form it would post. */
function sslAttempt(reference: string, status: 'VALID' | 'FAILED', amount?: string): string {
  const session = ssl.get(reference);
  if (session === undefined) throw new Error(`no session ${reference}`);
  const attempt = {
    status,
    val_id: `VAL${session.attempts.length + 1}${reference.slice(-4)}`,
    bank_tran_id: `BTX${session.attempts.length + 1}`,
  };
  session.attempts.push(attempt);
  const paid = amount ?? (session.fields['total_amount'] as string);
  return new URLSearchParams({
    status,
    tran_id: reference,
    val_id: attempt.val_id,
    amount: paid,
    currency: 'BDT',
    currency_type: 'BDT',
    currency_amount: paid,
    bank_tran_id: attempt.bank_tran_id,
    tran_date: '2026-10-28 12:00:00',
  }).toString();
}
/** bKash's tokenized checkout (v2), simulated: grant, create, execute, query. */
interface BkPayment {
  paymentId: string;
  amount: string;
  invoice: string;
  callbackURL: string;
  authorized: boolean;
  executed: boolean;
  trxId?: string;
}
const bk = new Map<string, BkPayment>();
let bkGrants = 0;
const bkFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, string>;
  const headers = new Headers(init?.headers);
  const json = (b: unknown) =>
    new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } });
  expect(url.origin).toBe('https://tokenized.sandbox.bka.sh');
  const path = url.pathname.replace('/v2/tokenized-checkout', '');
  if (path === '/auth/grant-token') {
    bkGrants++;
    if (headers.get('username') !== 'padma' || body['app_secret'] !== 'app-secret')
      return json({ statusCode: '9999', statusMessage: 'Invalid credentials' });
    return json({ id_token: 'tok-1', expires_in: 3600, token_type: 'Bearer', statusCode: '0000' });
  }
  expect(headers.get('authorization')).toBe('Bearer tok-1');
  expect(headers.get('x-app-key')).toBe('app-key');
  if (path === '/payment/create') {
    const paymentId = `TR00${bk.size + 1}`;
    bk.set(paymentId, {
      paymentId,
      amount: body['amount'] as string,
      invoice: body['merchantInvoiceNumber'] as string,
      callbackURL: body['callbackURL'] as string,
      authorized: false,
      executed: false,
    });
    return json({
      paymentId,
      bkashURL: `https://sandbox.payment.bkash.com/?paymentId=${paymentId}&mode=0011`,
      transactionStatus: 'Initiated',
      amount: body['amount'],
      currency: 'BDT',
      merchantInvoiceNumber: body['merchantInvoiceNumber'],
    });
  }
  const payment = bk.get(body['paymentId'] ?? '');
  if (payment === undefined)
    return json({ externalCode: '2002', errorMessageEn: 'Invalid Payment ID' });
  const completed = {
    paymentId: payment.paymentId,
    transactionStatus: 'Completed',
    amount: payment.amount,
    currency: 'BDT',
  };
  if (path === '/payment/execute') {
    if (payment.trxId !== undefined)
      return json({
        externalCode: '2062',
        errorMessageEn: 'The payment has already been completed',
      });
    if (payment.executed || !payment.authorized) {
      payment.executed = true; // a paymentId is executed once, whatever the result
      return json({ externalCode: '2056', errorMessageEn: 'Invalid Payment State' });
    }
    payment.executed = true;
    payment.trxId = `TRX${payment.paymentId}`;
    return json({ ...completed, trxId: payment.trxId, merchantInvoiceNumber: payment.invoice });
  }
  if (path === '/query/payment')
    return json(
      payment.trxId === undefined
        ? { paymentId: payment.paymentId, transactionStatus: 'Initiated', amount: payment.amount }
        : { ...completed, trxId: payment.trxId, merchantInvoice: payment.invoice },
    );
  throw new Error(`unexpected ${url}`);
}) as typeof fetch;
/** Razorpay's Payment Links, simulated. */
const rzp = new Map<string, Record<string, unknown>>();
const rzpFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  expect(new Headers(init?.headers).get('authorization')).toBe(
    `Basic ${Buffer.from('rzp_test_padma:rzp-secret').toString('base64')}`,
  );
  if (url.pathname === '/v1/payment_links' && init?.method === 'POST') {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    const id = `plink_${rzp.size + 1}`;
    const link = {
      ...body,
      id,
      short_url: `https://rzp.io/i/${id}`,
      status: 'created',
      amount_paid: 0,
      payments: null,
    };
    rzp.set(id, link);
    return json(link);
  }
  const link = rzp.get(decodeURIComponent(url.pathname.replace('/v1/payment_links/', '')));
  if (link === undefined)
    return json({ error: { description: 'The id provided does not exist' } }, 400);
  return json(link);
}) as typeof fetch;
/** The customer pays the link on Razorpay. */
function rzpPay(id: string): Record<string, unknown> {
  const link = rzp.get(id) as Record<string, unknown>;
  Object.assign(link, {
    status: 'paid',
    amount_paid: link['amount'],
    payments: [
      { payment_id: `pay_${id}`, amount: link['amount'], status: 'captured', plink_id: id },
    ],
  });
  return link;
}
/** Stripe's Checkout Sessions, simulated. */
const stripeSessions = new Map<string, Record<string, unknown>>();
const stripeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (b: unknown) =>
    new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } });
  expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sk_test_padma');
  if (url.pathname === '/v1/checkout/sessions' && init?.method === 'POST') {
    const f = Object.fromEntries(new URLSearchParams(String(init.body)));
    const id = `cs_test_${stripeSessions.size + 1}`;
    const made = {
      id,
      object: 'checkout.session',
      url: `https://checkout.stripe.com/c/pay/${id}`,
      status: 'open',
      payment_status: 'unpaid',
      client_reference_id: f['client_reference_id'],
      metadata: { reference: f['metadata[reference]'] },
      amount_total: Number(f['line_items[0][price_data][unit_amount]']),
      currency: f['line_items[0][price_data][currency]'],
      payment_intent: null,
      form: f,
    };
    stripeSessions.set(id, made);
    return json(made);
  }
  const found = stripeSessions.get(url.pathname.replace('/v1/checkout/sessions/', ''));
  return found === undefined ? new Response('{}', { status: 404 }) : json(found);
}) as typeof fetch;
const catalogue = [
  base,
  paymentModule({
    portalUrl: PORTAL,
    apiUrl: API_URL,
    adapters: new Map([
      ...ADAPTERS,
      [
        'sslcommerz',
        sslcommerzAdapter({ storeId: 'padma', storePassword: 'store-secret', fetch: sslFetch }),
      ],
      ['stripe', stripeAdapter({ secretKey: 'sk_test_padma', fetch: stripeFetch })],
      [
        'razorpay',
        razorpayAdapter({ keyId: 'rzp_test_padma', keySecret: 'rzp-secret', fetch: rzpFetch }),
      ],
      [
        'bkash',
        bkashAdapter({
          username: 'padma',
          password: 'pw',
          appKey: 'app-key',
          appSecret: 'app-secret',
          fetch: bkFetch,
        }),
      ],
    ]),
  }),
];

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
async function call(method: 'GET' | 'POST' | 'PATCH', url: string, as: string, payload?: unknown) {
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
  // Back through the server's return route, on to the invoice in the portal.
  expect(paid.location).toBe(`${API_URL}/api/v1/payment/return/${reference}`);
  const back = await host.server.app.inject({
    method: 'POST',
    url: `/api/v1/payment/return/${reference}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'status=VALID',
  });
  expect(back.statusCode).toBe(303);
  expect(back.headers.location).toBe(`${PORTAL}/d/invoices/${id}?payment=${reference}`);
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

describe('SSLCommerz (its sandbox simulated)', () => {
  let sslProvider = 0;
  const ipn = async (reference: string, body: string) => {
    const path = new URL(ssl.get(reference)?.fields['ipn_url'] ?? '').pathname;
    return host.server.app.inject({
      method: 'POST',
      url: path,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: body,
    });
  };
  const start = async (amount: string) => {
    const id = await invoice(partners['acme'] as number, amount);
    const res = await call('POST', '/api/portal/v1/payments', RINA, {
      document: 'invoices',
      id,
      provider: sslProvider,
    });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    return { id, ...(res.json as { reference: string; redirectUrl: string }) };
  };

  test('a session on SSLCommerz; its IPN, confirmed with the validation API, pays the invoice once', async () => {
    const made = await call('POST', '/api/v1/models/payment.provider', 'maria', {
      name: 'SSLCommerz',
      code: 'sslcommerz',
      journal: bank,
    });
    expect(made.status).toBe(201);
    sslProvider = made.json.id;
    const offered = (await call('GET', '/api/portal/v1/payments/providers', RINA)).json.providers;
    expect(offered.map((p: Json) => p.name)).toEqual(['Test payments', 'SSLCommerz']); // bKash not yet set up

    const { id, reference, redirectUrl } = await start('1200');
    expect(redirectUrl).toBe(`https://sandbox.sslcommerz.com/EasyCheckOut/${reference}`);
    const sent = ssl.get(reference)?.fields ?? {};
    expect(sent).toMatchObject({
      total_amount: '1200.00',
      currency: 'BDT',
      tran_id: reference,
      success_url: `${API_URL}/api/v1/payment/return/${reference}`,
      cus_name: 'Acme Trading',
      cus_country: 'Bangladesh',
      shipping_method: 'NO',
    });
    expect(sent['ipn_url']?.startsWith(`${API_URL}/api/v1/hooks/`)).toBe(true);

    const body = sslAttempt(reference, 'VALID');
    expect((await ipn(reference, body)).statusCode).toBe(202);
    expect((await ipn(reference, body)).statusCode).toBe(200); // the same val_id again: a duplicate
    await drain();
    expect(await tx(reference)).toMatchObject({ state: 'done', providerReference: 'BTX1' });
    expect((await move(id)).amountResidual.amount).toBe('0.00');
    expect(await paymentsFor(id)).toHaveLength(1);
  });

  test('IPNs SSLCommerz does not confirm are refused: an unknown val_id, a changed amount', async () => {
    const { id, reference } = await start('600');
    const forged = new URLSearchParams({
      status: 'VALID',
      tran_id: reference,
      val_id: 'FORGED',
      amount: '600.00',
      currency: 'BDT',
    }).toString();
    expect((await ipn(reference, forged)).statusCode).toBe(401);
    // A real payment of this transaction, with the amount changed on the way: refused.
    const real = sslAttempt(reference, 'VALID');
    const changed = real.replaceAll('600.00', '6.00');
    expect((await ipn(reference, changed)).statusCode).toBe(401);
    await drain();
    expect(await tx(reference)).toMatchObject({ state: 'pending' });
    expect(await paymentsFor(id)).toHaveLength(0);
    // The genuine IPN still pays it.
    expect((await ipn(reference, real)).statusCode).toBe(202);
    await drain();
    expect(await tx(reference)).toMatchObject({ state: 'done' });
  });

  test('a failure, then a successful retry; back before the IPN, the transaction query answers', async () => {
    const first = await start('300');
    expect((await ipn(first.reference, sslAttempt(first.reference, 'FAILED'))).statusCode).toBe(
      202,
    );
    await drain();
    expect(await tx(first.reference)).toMatchObject({ state: 'failed' });
    expect((await ipn(first.reference, sslAttempt(first.reference, 'VALID'))).statusCode).toBe(202);
    await drain();
    expect(await tx(first.reference)).toMatchObject({ state: 'done' });
    expect(await paymentsFor(first.id)).toHaveLength(1);

    const second = await start('250');
    sslAttempt(second.reference, 'VALID'); // paid at SSLCommerz; the IPN is late
    const state = await call('GET', `/api/portal/v1/payments/${second.reference}`, RINA);
    expect(state.json).toMatchObject({ state: 'done', amount: '250.00' });
    expect(await paymentsFor(second.id)).toHaveLength(1);
  });

  test('without credentials SSLCommerz is not offered', () => {
    expect(sslcommerzAdapter({}).configured('test')).toBe(false);
    expect(sslcommerzAdapter({ storeId: 'a', storePassword: 'b' }).configured('live')).toBe(false);
    expect(
      sslcommerzAdapter({ storeId: 'a', storePassword: 'b', sandbox: false }).configured('live'),
    ).toBe(true);
  });
});

describe('bKash (its API simulated)', () => {
  let bkashProvider = 0;
  const start = async (amount: string) => {
    const id = await invoice(partners['acme'] as number, amount);
    const res = await call('POST', '/api/portal/v1/payments', RINA, {
      document: 'invoices',
      id,
      provider: bkashProvider,
    });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    return { id, ...(res.json as { reference: string; redirectUrl: string }) };
  };
  /** bKash sends the customer back: `<callbackURL>?paymentID=…&status=…`. */
  const back = async (reference: string, query: string) => {
    const res = await host.server.app.inject({
      method: 'GET',
      url: `/api/v1/payment/return/${reference}?${query}`,
    });
    expect(res.statusCode).toBe(303);
    return String(res.headers.location);
  };

  test('created on bKash; executed when the customer is back with success; once', async () => {
    const made = await call('POST', '/api/v1/models/payment.provider', 'maria', {
      name: 'bKash',
      code: 'bkash',
      journal: bank,
    });
    expect(made.status).toBe(201);
    bkashProvider = made.json.id;
    const { id, reference, redirectUrl } = await start('1500');
    expect(redirectUrl).toMatch(/^https:\/\/sandbox\.payment\.bkash\.com\/\?paymentId=TR00\d+/);
    const payment = [...bk.values()].find((p) => p.invoice === reference);
    expect(payment).toMatchObject({ amount: '1500.00' });
    expect(payment?.callbackURL).toBe(`${API_URL}/api/v1/payment/return/${reference}`);
    expect(await tx(reference)).toMatchObject({
      state: 'pending',
      providerReference: payment?.paymentId,
    });
    // Still on bKash's page: pending.
    expect((await call('GET', `/api/portal/v1/payments/${reference}`, RINA)).json.state).toBe(
      'pending',
    );

    if (payment !== undefined) payment.authorized = true; // PIN and OTP entered
    const location = await back(
      reference,
      `paymentID=${payment?.paymentId}&status=success&signature=x`,
    );
    expect(location).toBe(`${PORTAL}/d/invoices/${id}?payment=${reference}`);
    expect(await tx(reference)).toMatchObject({
      state: 'done',
      providerReference: `TRX${payment?.paymentId}`,
    });
    expect((await move(id)).amountResidual.amount).toBe('0.00');
    await back(reference, `paymentID=${payment?.paymentId}&status=success`); // reloaded: nothing more
    expect(await paymentsFor(id)).toHaveLength(1);
    expect(bkGrants).toBe(1); // the token is kept for its hour
  });

  test('a forged "success" is not proof: bKash refuses to execute; a cancellation', async () => {
    const first = await start('700');
    // Someone opens the return URL with status=success and another payment's id before the customer paid.
    await back(first.reference, 'paymentID=TR001&status=success');
    expect(await tx(first.reference)).toMatchObject({ state: 'failed', payment: null });
    expect((await tx(first.reference)).error).toContain('Invalid Payment State');
    expect(await paymentsFor(first.id)).toHaveLength(0);

    const second = await start('300');
    const payment = [...bk.values()].find((p) => p.invoice === second.reference);
    await back(second.reference, `paymentID=${payment?.paymentId}&status=cancel`);
    expect(await tx(second.reference)).toMatchObject({ state: 'cancelled' });
    expect((await move(second.id)).amountResidual.amount).toBe('300.00');
  });

  test('without credentials bKash is not offered; BDT only', async () => {
    expect(bkashAdapter({}).configured('test')).toBe(false);
    await expect(
      bkashAdapter({
        username: 'a',
        password: 'b',
        appKey: 'c',
        appSecret: 'd',
        fetch: bkFetch,
      }).createPayment({
        reference: 'PAY-X',
        amount: '10.00',
        currency: 'USD',
        description: 'Invoice',
        customer: {
          name: '',
          email: null,
          phone: null,
          street: null,
          city: null,
          zip: null,
          country: null,
        },
        returnUrl: 'https://x',
        callbackUrl: 'https://y',
        mode: 'test',
      }),
    ).rejects.toThrow('BDT only');
  });
});

describe('Razorpay (Payment Links simulated)', () => {
  let razorpayProvider = 0;
  const start = async (amount: string) => {
    const id = await invoice(partners['acme'] as number, amount);
    const res = await call('POST', '/api/portal/v1/payments', RINA, {
      document: 'invoices',
      id,
      provider: razorpayProvider,
    });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    return { id, ...(res.json as { reference: string; redirectUrl: string }) };
  };
  /** Razorpay's webhook, signed with the secret set in its dashboard (the endpoint's). */
  const webhook = async (
    event: string,
    link: Record<string, unknown>,
    eventId: string,
    secret?: string,
  ) => {
    const endpoint = (
      (await call('GET', '/api/v1/models/webhook.endpoint?fields=hook,token,secret', 'maria')).json
        .items as Json[]
    ).find((e) => e.hook === 'payment.razorpay');
    const body = JSON.stringify({
      entity: 'event',
      event,
      payload: {
        payment_link: { entity: link },
        payment: {
          entity: {
            id: `pay_${String(link['id'])}`,
            amount: link['amount_paid'],
            status: 'captured',
          },
        },
      },
    });
    const res = await host.server.app.inject({
      method: 'POST',
      url: `/api/v1/hooks/${endpoint.token}`,
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': createHmac('sha256', secret ?? endpoint.secret)
          .update(body)
          .digest('hex'),
        'x-razorpay-event-id': eventId,
      },
      payload: body,
    });
    return res.statusCode;
  };

  test('a payment link; its signed webhook pays the invoice once', async () => {
    const made = await call('POST', '/api/v1/models/payment.provider', 'maria', {
      name: 'Razorpay',
      code: 'razorpay',
      journal: bank,
    });
    expect(made.status).toBe(201);
    razorpayProvider = made.json.id;
    const { id, reference, redirectUrl } = await start('1500');
    const link = [...rzp.values()].find((l) => l['reference_id'] === reference) as Record<
      string,
      unknown
    >;
    expect(redirectUrl).toBe(`https://rzp.io/i/${String(link['id'])}`);
    expect(link).toMatchObject({
      amount: 150000,
      currency: 'BDT',
      callback_url: `${API_URL}/api/v1/payment/return/${reference}`,
      callback_method: 'get',
      notify: { sms: false, email: false },
    });
    expect(await tx(reference)).toMatchObject({ providerReference: link['id'] });

    const paid = rzpPay(String(link['id']));
    expect(await webhook('payment_link.paid', paid, 'evt_rzp_1', 'not the secret')).toBe(401);
    expect(await webhook('payment_link.paid', paid, 'evt_rzp_1')).toBe(202);
    expect(await webhook('payment_link.paid', paid, 'evt_rzp_1')).toBe(200); // redelivered: a duplicate
    await drain();
    expect(await tx(reference)).toMatchObject({
      state: 'done',
      providerReference: `pay_${String(link['id'])}`,
    });
    expect((await move(id)).amountResidual.amount).toBe('0.00');
    expect(await paymentsFor(id)).toHaveLength(1);
  });

  test('back before the webhook: the link fetched from Razorpay; an expired link', async () => {
    const first = await start('400');
    const link = [...rzp.values()].find((l) => l['reference_id'] === first.reference) as Record<
      string,
      unknown
    >;
    rzpPay(String(link['id']));
    // The browser's query is not used: the link is fetched.
    await host.server.app.inject({
      method: 'GET',
      url: `/api/v1/payment/return/${first.reference}?razorpay_payment_link_status=failed`,
    });
    expect(await tx(first.reference)).toMatchObject({ state: 'done' });
    expect(await paymentsFor(first.id)).toHaveLength(1);

    const second = await start('90');
    const other = [...rzp.values()].find((l) => l['reference_id'] === second.reference) as Record<
      string,
      unknown
    >;
    other['status'] = 'expired';
    expect(
      (await call('GET', `/api/portal/v1/payments/${second.reference}`, RINA)).json.state,
    ).toBe('cancelled');
  });

  test('subunits; test keys serve test providers', () => {
    expect(toSubunits('1500.00', 'INR')).toBe(150000);
    expect(toSubunits('12.5', 'KWD')).toBe(12500);
    expect(fromSubunits(150000, 'INR')).toBe('1500.00');
    expect(razorpayAdapter({ keyId: 'rzp_test_x', keySecret: 's' }).configured('test')).toBe(true);
    expect(razorpayAdapter({ keyId: 'rzp_test_x', keySecret: 's' }).configured('live')).toBe(false);
    expect(razorpayAdapter({}).configured('test')).toBe(false);
  });
});

describe('Stripe (Checkout Sessions simulated)', () => {
  let stripeProvider = 0;
  const STRIPE_SECRET = 'whsec_from_stripe';
  const start = async (amount: string) => {
    const id = await invoice(partners['acme'] as number, amount);
    const res = await call('POST', '/api/portal/v1/payments', RINA, {
      document: 'invoices',
      id,
      provider: stripeProvider,
    });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    return { id, ...(res.json as { reference: string; redirectUrl: string }) };
  };
  const endpoint = async () =>
    (
      (await call('GET', '/api/v1/models/webhook.endpoint?fields=hook,token,secret', 'maria')).json
        .items as Json[]
    ).find((e) => e.hook === 'payment.stripe');
  /** Stripe's webhook: `Stripe-Signature: t=…,v1=HMAC("<t>.<body>")`. */
  const event = async (
    type: string,
    object: Record<string, unknown>,
    id: string,
    sign: { secret?: string; age?: number } = {},
  ) => {
    const body = JSON.stringify({ id, object: 'event', type, data: { object } });
    const t = Math.floor(Date.now() / 1000) - (sign.age ?? 0);
    const v1 = createHmac('sha256', sign.secret ?? STRIPE_SECRET)
      .update(`${t}.${body}`)
      .digest('hex');
    const res = await host.server.app.inject({
      method: 'POST',
      url: `/api/v1/hooks/${(await endpoint()).token}`,
      headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${v1}` },
      payload: body,
    });
    return res.statusCode;
  };
  const pay = (session: Record<string, unknown>) =>
    Object.assign(session, {
      status: 'complete',
      payment_status: 'paid',
      payment_intent: `pi_${String(session['id'])}`,
    });

  test('a Checkout Session; Stripe’s signed event pays the invoice once', async () => {
    const made = await call('POST', '/api/v1/models/payment.provider', 'maria', {
      name: 'Stripe',
      code: 'stripe',
      journal: bank,
    });
    expect(made.status).toBe(201);
    stripeProvider = made.json.id;
    const { id, reference, redirectUrl } = await start('1500');
    const session = [...stripeSessions.values()].find(
      (x) => x['client_reference_id'] === reference,
    ) as Record<string, unknown>;
    expect(redirectUrl).toBe(`https://checkout.stripe.com/c/pay/${String(session['id'])}`);
    expect(session['form']).toMatchObject({
      mode: 'payment',
      success_url: `${API_URL}/api/v1/payment/return/${reference}`,
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': 'bdt',
      'line_items[0][price_data][unit_amount]': '150000',
      'metadata[reference]': reference,
    });
    // Stripe's signing secret goes into the endpoint made with the first payment.
    const ep = await endpoint();
    expect(
      (
        await call('PATCH', `/api/v1/models/webhook.endpoint/${ep.id}`, 'maria', {
          secret: STRIPE_SECRET,
        })
      ).status,
    ).toBe(200);

    pay(session);
    expect(
      await event('checkout.session.completed', session, 'evt_1', { secret: 'whsec_wrong' }),
    ).toBe(401);
    expect(await event('checkout.session.completed', session, 'evt_1', { age: 3600 })).toBe(401); // replayed later
    expect(await event('checkout.session.completed', session, 'evt_1')).toBe(202);
    expect(await event('checkout.session.completed', session, 'evt_1')).toBe(200); // redelivered
    await drain();
    expect(await tx(reference)).toMatchObject({
      state: 'done',
      providerReference: `pi_${String(session['id'])}`,
    });
    expect((await move(id)).amountResidual.amount).toBe('0.00');
    expect(await paymentsFor(id)).toHaveLength(1);
  });

  test('back before the event: the session fetched; an expired session', async () => {
    const first = await start('640');
    const session = [...stripeSessions.values()].find(
      (x) => x['client_reference_id'] === first.reference,
    ) as Record<string, unknown>;
    pay(session);
    await host.server.app.inject({
      method: 'GET',
      url: `/api/v1/payment/return/${first.reference}`,
    });
    expect(await tx(first.reference)).toMatchObject({ state: 'done' });
    expect(await paymentsFor(first.id)).toHaveLength(1);

    const second = await start('75');
    const other = [...stripeSessions.values()].find(
      (x) => x['client_reference_id'] === second.reference,
    ) as Record<string, unknown>;
    other['status'] = 'expired';
    expect(
      (await call('GET', `/api/portal/v1/payments/${second.reference}`, RINA)).json.state,
    ).toBe('cancelled');
  });

  test('keys and modes', () => {
    expect(stripeAdapter({ secretKey: 'sk_test_x' }).configured('test')).toBe(true);
    expect(stripeAdapter({ secretKey: 'sk_test_x' }).configured('live')).toBe(false);
    expect(stripeAdapter({ secretKey: 'rk_live_x' }).configured('live')).toBe(true);
    expect(stripeAdapter({ secretKey: 'pk_test_x' }).configured('test')).toBe(false); // a publishable key
    expect(stripeAdapter({}).configured('test')).toBe(false);
  });
});
