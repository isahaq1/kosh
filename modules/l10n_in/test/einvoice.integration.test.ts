/**
 * E-invoicing and e-way bills on real PostgreSQL with the fake provider (RFC 0016 step 5, part 4): the company's GST
 * settings; a posted invoice to a registered customer registered by the subscriber, with the IRN the IRP computes and
 * the signed QR code; what the IRP would refuse said beforehand (no GSTIN, no HSN) and kept on the document; a second
 * registration refused; cancellation within 24 hours only; an e-way bill with its validity by distance, cancelled;
 * the IRN fields read-only to users; users without the right refused.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accounting } from '@kosh/accounting';
import { contacts } from '@kosh/contacts';
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
import { createFakeGstProvider, einvoiceWorker, irnOf, l10nInModule } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const provider = createFakeGstProvider();
const catalogue = [base, contacts, accounting, l10nInModule({ provider, workers: false })];

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let host: AppHost;
let company: number;
let inr: number;
let journal: number;
let gst18: number;
let laptop: number;
let noHsn: number;
const tokens = new Map<string, string>();

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function call(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
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

async function customer(payload: Record<string, unknown>): Promise<number> {
  const created = await call('POST', '/api/v1/models/res.partner', 'maria', {
    isCompany: true,
    isCustomer: true,
    ...payload,
  });
  expectStatus(created, 201);
  return created.json.id as number;
}

async function invoice(
  partner: number,
  product = laptop,
  price = '75000',
): Promise<{ id: number; name: string; date: string }> {
  const created = await call('POST', '/api/v1/models/account.move', 'maria', {
    kind: 'out_invoice',
    journal,
    partner,
    currency: inr,
    lines: {
      create: [
        {
          lineKind: 'product',
          product,
          name: 'Laptop',
          quantity: '1',
          priceUnit: price,
          taxes: { set: [gst18] },
        },
      ],
    },
  });
  expectStatus(created, 201);
  const posted = await call(
    'POST',
    `/api/v1/models/account.move/${created.json.id}/transitions/post`,
    'maria',
  );
  expectStatus(posted, 200);
  return { id: created.json.id, name: posted.json.name, date: posted.json.date };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-einvoice-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({
      driver,
      catalogue,
      change: { install: ['contacts', 'accounting', 'l10n_in'] },
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
    company: { name: 'Sahyadri Traders', currency: 'INR' },
    admin: { login: 'admin', name: 'Administrator', password: PASSWORD },
  }));
  await installDefaults(host.server.shutro, host.server.registry.loaded.modules, { company });
  for (const [login, groups] of [
    ['maria', ['account.manager', 'contacts.user']],
    ['omar', ['contacts.user']],
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
    const [cur] = await env.sql<{ id: number }>`SELECT id FROM res_currency WHERE name = 'INR'`;
    const [inv] = await env.sql<{ id: number }>`SELECT id FROM account_journal WHERE code = 'INV'`;
    return {
      inr: cur?.id as number,
      journal: inv?.id as number,
      gst18: Number(await env.refId('account.tax' as never, 'l10n_in.gst_sale_18')),
    };
  });
  ({ inr, journal, gst18 } = ids);
  const product = async (payload: Record<string, unknown>) => {
    const created = await call('POST', '/api/v1/models/product.product', 'maria', payload);
    expectStatus(created, 201);
    return created.json.id as number;
  };
  laptop = await product({ name: 'Laptop', hsnCode: '8471' });
  noHsn = await product({ name: 'Mystery box' });
}, 180_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('the GST settings: the company in Maharashtra, its GSTIN checked, e-invoicing on (managers)', async () => {
  expectStatus(await call('PUT', '/api/v1/accounting/settings', 'maria', { state: 'IN-MH' }), 200);
  const wrong = await call('PUT', '/api/v1/l10n_in/settings', 'maria', {
    gstin: '29AAGCB7383J1Z4',
  });
  expect(wrong.status).toBe(422); // a Karnataka GSTIN for a Maharashtra company
  const saved = await call('PUT', '/api/v1/l10n_in/settings', 'maria', {
    gstin: '27aapfu0939f1zv',
    street: '14 FC Road',
    city: 'Pune',
    zip: '411004',
    einvoiceEnabled: true,
  });
  expectStatus(saved, 200);
  expect(saved.json).toMatchObject({
    provider: 'fake',
    gstin: '27AAPFU0939F1ZV',
    zip: '411004',
    state: 'IN-MH',
    einvoiceEnabled: true,
  });
  expect(
    (await call('PUT', '/api/v1/l10n_in/settings', 'omar', { einvoiceEnabled: false })).status,
  ).toBe(403);
});

test('a posted invoice to a registered customer is registered by the subscriber: the IRN, the signed QR', async () => {
  const bengaluru = await customer({
    name: 'Bengaluru Labs',
    country: 'IN',
    state: 'IN-KA',
    gstin: '29AAGCB7383J1Z4',
    street: '5 MG Road',
    city: 'Bengaluru',
    zip: '560001',
  });
  const doc = await invoice(bengaluru);
  const worker = einvoiceWorker(host.server, provider);
  await worker.drain();
  const state = await call('GET', `/api/v1/l10n_in/einvoice/${doc.id}`, 'maria');
  expectStatus(state, 200);
  expect(state.json).toMatchObject({
    applicable: true,
    provider: 'fake',
    status: 'registered',
    error: null,
  });
  expect(state.json.irn).toBe(irnOf('27AAPFU0939F1ZV', 'INV', doc.name, doc.date));
  expect(state.json.ackNo).toMatch(/^\d{15}$/);
  const qr = JSON.parse(
    JSON.parse(Buffer.from(String(state.json.signedQr).split('.')[1] ?? '', 'base64url').toString())
      .data,
  );
  expect(qr).toMatchObject({
    SellerGstin: '27AAPFU0939F1ZV',
    BuyerGstin: '29AAGCB7383J1Z4',
    DocNo: doc.name,
    DocTyp: 'INV',
    TotInvVal: 88500,
    ItemCnt: 1,
    MainHsnCode: '8471',
  });
  // Once only; and the IRN is the IRP's to give, not the users'.
  expect((await call('POST', `/api/v1/l10n_in/einvoice/${doc.id}`, 'maria')).status).toBe(409);
  const edited = await call('PATCH', `/api/v1/models/account.move/${doc.id}`, 'maria', {
    irn: 'x',
  });
  expect(edited.status).toBeGreaterThanOrEqual(400);
  // The tax invoice prints it.
  const listed = await call('GET', '/api/v1/models/account.move/documents', 'maria');
  const template = (listed.json.templates as Json[]).find((t) => t.name === 'Tax invoice (GST)');
  const html = await host.server.app.inject({
    method: 'POST',
    url: `/api/v1/models/account.move/documents/${template.id}?format=html`,
    headers: { authorization: `Bearer ${tokens.get('maria') ?? ''}` },
    payload: { ids: [doc.id] },
  });
  expect(html.body).toContain(state.json.irn);

  // Cancelled within 24 hours; once.
  const cancelled = await call('POST', `/api/v1/l10n_in/einvoice/${doc.id}/cancel`, 'maria', {
    reason: '2',
    remark: 'Wrong rate',
  });
  expectStatus(cancelled, 200);
  expect(cancelled.json.status).toBe('cancelled');
  expect(
    (await call('POST', `/api/v1/l10n_in/einvoice/${doc.id}/cancel`, 'maria', { reason: '2' }))
      .status,
  ).toBe(409);
});

test('what the IRP would refuse is said beforehand and kept on the document', async () => {
  const unregistered = await customer({
    name: 'Walk-in Pune',
    country: 'IN',
    state: 'IN-MH',
    zip: '411001',
  });
  const b2c = await invoice(unregistered);
  // Unregistered customers are not e-invoiced: the subscriber leaves them alone; asked anyway, the reason.
  await einvoiceWorker(host.server, provider).drain();
  expect((await call('GET', `/api/v1/l10n_in/einvoice/${b2c.id}`, 'maria')).json.status).toBeNull();
  const asked = await call('POST', `/api/v1/l10n_in/einvoice/${b2c.id}`, 'maria');
  expect(asked.status).toBe(422);
  expect(asked.json.detail).toContain('has no GSTIN');

  const registered = await customer({
    name: 'Nashik Agro',
    country: 'IN',
    state: 'IN-MH',
    gstin: '27AAPFU0939F1ZV',
    zip: '422001',
  });
  const missing = await invoice(registered, noHsn, '1000');
  await einvoiceWorker(host.server, provider).drain();
  const state = await call('GET', `/api/v1/l10n_in/einvoice/${missing.id}`, 'maria');
  expect(state.json.status).toBe('failed');
  expect(state.json.error).toContain('no HSN / SAC code');
  // A user without the right to change entries may not register.
  expect((await call('POST', `/api/v1/l10n_in/einvoice/${missing.id}`, 'omar')).status).toBe(403);
});

test('an IRN older than 24 hours is not cancelled', async () => {
  const mumbai = await customer({
    name: 'Mumbai Wholesale',
    country: 'IN',
    state: 'IN-MH',
    gstin: '27AAPFU0939F1ZV',
    zip: '400001',
  });
  const doc = await invoice(mumbai);
  expectStatus(await call('POST', `/api/v1/l10n_in/einvoice/${doc.id}`, 'maria'), 200);
  await host.server.shutro.bootstrap(
    { reason: 'test: two days ago', company },
    (env) =>
      env.sql`UPDATE l10n_in_einvoice SET irn_ack_date = now() - interval '2 days' WHERE move_id = ${doc.id}`,
  );
  const late = await call('POST', `/api/v1/l10n_in/einvoice/${doc.id}/cancel`, 'maria', {
    reason: '4',
  });
  expect(late.status).toBe(409);
  expect(late.json.detail).toContain('credit note');
});

test('an e-way bill: part B checked, valid one day per 200 km, cancelled', async () => {
  const kolhapur = await customer({
    name: 'Kolhapur Traders',
    country: 'IN',
    state: 'IN-MH',
    gstin: '27AAPFU0939F1ZV',
    zip: '416001',
  });
  const doc = await invoice(kolhapur);
  const bad = await call('POST', `/api/v1/l10n_in/ewaybill/${doc.id}`, 'maria', {
    mode: 'road',
    distanceKm: 450,
    vehicleNo: 'not a plate',
  });
  expect(bad.status).toBe(422);
  expect(bad.json.detail).toContain('MH12AB1234');
  const made = await call('POST', `/api/v1/l10n_in/ewaybill/${doc.id}`, 'maria', {
    mode: 'road',
    distanceKm: 450,
    vehicleNo: 'mh 09 ab 4321',
  });
  expectStatus(made, 200);
  expect(made.json.ewayBill).toMatchObject({
    status: 'generated',
    vehicleNo: 'MH09AB4321',
    distanceKm: 450,
    error: null,
  });
  expect(made.json.ewayBill.number).toMatch(/^\d{12}$/);
  const days = Math.round(
    (new Date(made.json.ewayBill.validUntil).getTime() -
      new Date(made.json.ewayBill.date).getTime()) /
      86_400_000,
  );
  expect(days).toBeGreaterThanOrEqual(3); // ceil(450 / 200) days, to the end of the last one
  expect(days).toBeLessThanOrEqual(4);
  const cancelled = await call('POST', `/api/v1/l10n_in/ewaybill/${doc.id}/cancel`, 'maria', {
    reason: '3',
  });
  expectStatus(cancelled, 200);
  expect(cancelled.json.ewayBill.status).toBe('cancelled');
});
