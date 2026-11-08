/**
 * Purchase on real PostgreSQL through the HTTP API (RFC 0008, RFC 0003 §5.3): installing Purchase brings Contacts,
 * Products, the chatter and Permissions, and its default approval policy; an order above the manager threshold
 * waits for a purchase manager (the buyer cannot confirm it, nor approve it), and the manager's approval confirms
 * it; a small order confirms right after it is submitted; buyers see their own orders and users without Purchase
 * are refused.
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
import { purchase } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [base, purchase];

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let host: AppHost;
let product: number;
let vendor: number;
let currency: number;
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

const order = (quantity: string) =>
  call('POST', '/api/v1/models/purchase.order', 'farid', {
    partner: vendor,
    currency,
    lines: { create: [{ product, name: 'Raw jute (kg)', quantity, priceUnit: '100' }] },
  });
const run = (id: number, transition: string, as = 'farid') =>
  call('POST', `/api/v1/models/purchase.order/${id}/transitions/${transition}`, as);

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-purchase-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({ driver, catalogue, change: { install: ['purchase'] }, dir }),
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
  const { company } = await installBase(host.server.shutro, auth, {
    company: { name: 'Padma Traders', currency: 'BDT' },
    admin: { login: 'admin', name: 'Administrator', password: PASSWORD },
  });
  // As kosh init does: the apps' defaults again, now that the company exists (approval policies are per company).
  await installDefaults(host.server.shutro, host.server.registry.loaded.modules, { company });
  for (const [login, groups] of [
    ['farid', ['purchase.user']],
    ['nadia', ['purchase.user']],
    ['dina', ['purchase.manager']],
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
  type Model = { create(rows: unknown[]): Promise<{ ids: number[] }> };
  const model = (env: unknown, name: string) => (env as { model(n: string): Model }).model(name);
  const ids = await host.server.shutro.bootstrap({ reason: 'test: data', company }, async (env) => {
    const [bdt] = await env.sql<{ id: number }>`SELECT id FROM res_currency WHERE name = 'BDT'`;
    const p = await model(env, 'product.product').create([
      { name: 'Raw jute', standardPrice: '100' },
    ]);
    const v = await model(env, 'res.partner').create([
      { name: 'Jessore Jute Mills', isCompany: true, isVendor: true },
    ]);
    return { product: p.ids[0] as number, vendor: v.ids[0] as number, currency: bdt?.id as number };
  });
  product = ids.product;
  vendor = ids.vendor;
  currency = ids.currency;
}, 180_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('installing Purchase brings its dependencies and its approval policy', async () => {
  const installed = await driver.query<{ name: string }>({
    text: 'SELECT name FROM kosh_module ORDER BY name',
    params: [],
  });
  expect(installed.map((r) => r.name)).toEqual(
    expect.arrayContaining(['contacts', 'messaging', 'permissions', 'product', 'purchase']),
  );
  const levels = await driver.query<{ name: string }>({
    text: 'SELECT name FROM approval_level ORDER BY sequence, id',
    params: [],
  });
  // The orders' two levels and the purchase requests' two (RFC 0032 §3.4).
  expect(levels.map((l) => l.name).sort()).toEqual([
    'Department head',
    'Purchase director',
    'Purchase director',
    'Purchase manager',
    'Purchase manager',
    'Purchase manager',
  ]);
});

test('a large order waits for a manager, whose approval confirms it', async () => {
  const created = await order('1500'); // 150,000: above the manager threshold, below the director's
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const id = created.json.id as number;
  expect(String(created.json.name)).toMatch(/^PO\/\d{4}\/\d{5}$/);

  const submitted = await run(id, 'submit');
  expect(submitted.status, JSON.stringify(submitted.json)).toBe(200);
  expect(submitted.json.state).toBe('to_approve');

  const early = await run(id, 'confirm');
  expect(early.status).toBe(409);
  expect(early.json.detail).toContain('Waiting for approvals');

  // The buyer has nothing to decide; the manager does.
  expect((await call('GET', '/api/v1/approvals/inbox', 'farid')).json.requests).toEqual([]);
  const inbox = await call('GET', '/api/v1/approvals/inbox', 'dina');
  expect(inbox.json.requests).toHaveLength(1);
  const request = inbox.json.requests[0];
  expect(request.levelName).toBe('Purchase manager');
  expect(
    (await call('POST', `/api/v1/approvals/requests/${request.id}/approve`, 'farid')).status,
  ).toBeGreaterThanOrEqual(400);

  const approved = await call('POST', `/api/v1/approvals/requests/${request.id}/approve`, 'dina', {
    comment: 'Within budget',
  });
  expect(approved.status, JSON.stringify(approved.json)).toBe(200);
  const read = await call('GET', `/api/v1/models/purchase.order/${id}`, 'farid');
  expect(read.json.state).toBe('purchase'); // the last approval ran `confirm`
});

test('a small order needs no approval: submit, then confirm', async () => {
  const created = await order('10'); // 1,000
  const id = created.json.id as number;
  expect((await run(id, 'submit')).json.state).toBe('to_approve');
  const confirmed = await run(id, 'confirm');
  expect(confirmed.status, JSON.stringify(confirmed.json)).toBe(200);
  expect(confirmed.json.state).toBe('purchase');
});

test('buyers see their own orders, managers all, others none', async () => {
  expect((await call('GET', '/api/v1/models/purchase.order', 'farid')).json.items).toHaveLength(2);
  expect((await call('GET', '/api/v1/models/purchase.order', 'nadia')).json.items).toEqual([]);
  expect((await call('GET', '/api/v1/models/purchase.order', 'dina')).json.items).toHaveLength(2);
  expect((await call('GET', '/api/v1/models/purchase.order', 'bob')).status).toBe(403);
  const menus = await call('GET', '/api/v1/menus?app=purchase', 'farid');
  expect(JSON.stringify(menus.json)).not.toContain('purchase.action_to_approve'); // managers only
  const managers = await call('GET', '/api/v1/menus?app=purchase', 'dina');
  expect(JSON.stringify(managers.json)).toContain('purchase.action_to_approve');
});

test('the Purchase overview (RFC 0022 step 2) is served to a purchase user', async () => {
  const overview = await call('GET', '/api/v1/reports/overview?app=purchase', 'farid');
  expect(overview.status, JSON.stringify(overview.json)).toBe(200);
  expect(overview.json.cards.map((c: { id: string }) => c.id)).toContain('spend_month');
});

test('a purchase request (RFC 0032 §3.4): approved, made into a request for quotation, followed by the line tracker', async () => {
  const R = '/api/v1/models/purchase.request';
  const L = '/api/v1/models/purchase.request.line';
  const made = await call('POST', R, 'nadia', {
    dateRequired: '2026-12-15',
    priority: 'high',
    vendor,
    purpose: 'Spare belts for the pellet mill',
    lines: { create: [{ product, quantity: '12' }] },
  });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  const id = made.json.id as number;
  // Nobody outside Purchase; a buyer sees nothing of a draft, so may not make RFQs before approval.
  expect((await call('GET', `${R}/${id}`, 'bob')).status).toBe(403);
  expect((await call('POST', `${R}/${id}/transitions/rfq`, 'farid')).status).toBe(403);
  expect((await call('POST', `${R}/${id}/transitions/submit`, 'nadia')).status).toBe(200);
  // No Workforce here: the department head level falls back to its role, a Purchase manager.
  const inbox = (await call('GET', '/api/v1/approvals/inbox', 'dina')).json.requests as Json[];
  const mine = inbox.filter((r) => r.targetModel === 'purchase.request' && r.targetId === id);
  expect(mine.length).toBeGreaterThanOrEqual(1);
  for (const r of mine)
    expect((await call('POST', `/api/v1/approvals/requests/${r.id}/approve`, 'dina')).status).toBe(
      200,
    );
  expect((await call('GET', `${R}/${id}?fields=state`, 'nadia')).json.state).toBe('approved');
  const lines = async () =>
    (
      await call(
        'GET',
        `${L}?filter=${encodeURIComponent(JSON.stringify({ request: id }))}&fields=status,qtyApproved,qtyOnRfq,qtyOrdered,qtyRemaining`,
        'farid',
      )
    ).json.items as Json[];
  expect((await lines())[0]).toMatchObject({ status: 'approved' });
  expect(Number((await lines())[0].qtyRemaining)).toBe(12);
  // The buyer makes the request for quotation: one to the preferred vendor, its line linked back.
  const rfq = await call('POST', `${R}/${id}/transitions/rfq`, 'farid');
  expect(rfq.status, JSON.stringify(rfq.json)).toBe(200);
  const orders = (
    await call(
      'GET',
      `/api/v1/models/purchase.order?filter=${encodeURIComponent(JSON.stringify({ origin: made.json.name ?? '' }))}&fields=partner,state,origin`,
      'farid',
    )
  ).json.items as Json[];
  const reference = (await call('GET', `${R}/${id}?fields=name`, 'farid')).json.name as string;
  const linked = (
    await call(
      'GET',
      `/api/v1/models/purchase.order?filter=${encodeURIComponent(JSON.stringify({ origin: reference }))}&fields=partner,state`,
      'farid',
    )
  ).json.items as Json[];
  void orders;
  expect(linked.length).toBe(1);
  expect(linked[0].partner?.id ?? linked[0].partner).toBe(vendor);
  let [line] = await lines();
  expect(line.status).toBe('rfq');
  expect(Number(line.qtyRemaining)).toBe(0);
  expect((await call('POST', `${R}/${id}/transitions/rfq`, 'farid')).status).toBe(409);
  // The order confirmed: the line is ordered.
  const order = linked[0].id as number;
  expect((await run(order, 'submit')).status).toBe(200);
  expect((await run(order, 'confirm')).status).toBe(200);
  [line] = await lines();
  expect(line.status).toBe('ordered');
  expect(Number(line.qtyOrdered)).toBe(12);
  // The tracker's filters.
  const tracked = (
    await call(
      'GET',
      `${L}?filter=${encodeURIComponent(JSON.stringify({ status: 'ordered' }))}&fields=request`,
      'dina',
    )
  ).json.items as Json[];
  expect(tracked.some((l) => (l.request?.id ?? l.request) === id)).toBe(true);
});

test('an RFQ to several vendors (RFC 0032 §3.4): responses with quote links, a quotation submitted through its link', async () => {
  const R = '/api/v1/models/purchase.request';
  const T = '/api/v1/models/purchase.tender';
  const made = await call('POST', R, 'nadia', {
    dateRequired: '2026-12-20',
    purpose: 'Rollers for the conveyor',
    lines: { create: [{ product, quantity: '30' }] },
  });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  const id = made.json.id as number;
  expect((await call('POST', `${R}/${id}/transitions/submit`, 'nadia')).status).toBe(200);
  const inbox = (await call('GET', '/api/v1/approvals/inbox', 'dina')).json.requests as Json[];
  for (const r of inbox.filter((x) => x.targetModel === 'purchase.request' && x.targetId === id))
    expect((await call('POST', `/api/v1/approvals/requests/${r.id}/approve`, 'dina')).status).toBe(
      200,
    );
  // The buyer asks several vendors: an RFQ with the request's lines, to send once the vendors are chosen.
  const asked = await call('POST', `${R}/${id}/transitions/tender`, 'farid');
  expect(asked.status, JSON.stringify(asked.json)).toBe(200);
  const [tender] = (
    await call(
      'GET',
      `${T}?filter=${encodeURIComponent(JSON.stringify({ request: id }))}&fields=name,state,deadline,lines`,
      'farid',
    )
  ).json.items as Json[];
  expect(tender.state).toBe('draft');
  expect((await call('POST', `${T}/${tender.id}/transitions/send`, 'farid')).status).toBe(409); // no vendors yet
  // The request line counts the RFQ as covering it.
  const [line] = (
    await call(
      'GET',
      `/api/v1/models/purchase.request.line?filter=${encodeURIComponent(JSON.stringify({ request: id }))}&fields=status,qtyOnRfq,qtyRemaining`,
      'farid',
    )
  ).json.items as Json[];
  expect([line.status, Number(line.qtyOnRfq), Number(line.qtyRemaining)]).toEqual(['rfq', 30, 0]);
  expect(
    (
      await call('PATCH', `${T}/${tender.id}`, 'farid', {
        vendors: { set: [vendor] },
        deadline: '2026-12-01',
      })
    ).status,
  ).toBe(200);
  const sent = await call('POST', `${T}/${tender.id}/transitions/send`, 'farid');
  expect(sent.status, JSON.stringify(sent.json)).toBe(200);
  const [response] = (
    await call(
      'GET',
      `/api/v1/models/purchase.tender.response?filter=${encodeURIComponent(JSON.stringify({ tender: tender.id }))}&fields=vendor,state,tokenHash`,
      'farid',
    )
  ).json.items as Json[];
  expect(response.state).toBe('invited');
  expect(response.vendor?.id ?? response.vendor).toBe(vendor);
  // A fresh quote link for the vendor; the page needs no sign-in.
  const link = await call('POST', `/api/v1/purchase/responses/${response.id}/link`, 'farid');
  expect(link.status, JSON.stringify(link.json)).toBe(200);
  const path = (link.json.url as string).replace(/^https?:\/\/[^/]+/, '');
  const page = await host.server.app.inject({ method: 'GET', url: path });
  expect(page.statusCode).toBe(200);
  expect(page.body).toContain('Request for quotation');
  expect((await host.server.app.inject({ method: 'GET', url: `${path}x` })).statusCode).toBe(404);
  const quoteLines = (
    await call(
      'GET',
      `/api/v1/models/purchase.tender.response.line?filter=${encodeURIComponent(JSON.stringify({ response: response.id }))}&fields=id`,
      'farid',
    )
  ).json.items as Json[];
  // Saved for later, then submitted once; the RFQ has its responses.
  const saved = await host.server.app.inject({
    method: 'POST',
    url: path,
    payload: {
      lines: quoteLines.map((l) => ({ id: l.id, priceUnit: '480.50' })),
      dateDelivery: '2026-12-10',
      paymentTerms: '30 days',
      submit: false,
    },
  });
  expect(saved.statusCode, saved.body).toBe(200);
  expect(
    (
      await call(
        'GET',
        `/api/v1/models/purchase.tender.response/${response.id}?fields=state`,
        'farid',
      )
    ).json.state,
  ).toBe('quoted');
  const submitted = await host.server.app.inject({
    method: 'POST',
    url: path,
    payload: { lines: quoteLines.map((l) => ({ id: l.id, priceUnit: '475' })), submit: true },
  });
  expect(submitted.statusCode, submitted.body).toBe(200);
  const after = (
    await call(
      'GET',
      `/api/v1/models/purchase.tender.response/${response.id}?fields=state,amountTotal,paymentTerms`,
      'farid',
    )
  ).json;
  expect(after.state).toBe('submitted');
  expect(Number(after.amountTotal)).toBe(14250);
  expect(after.paymentTerms).toBe('30 days');
  expect(
    (await call('GET', `${T}/${tender.id}?fields=state,responseCount`, 'farid')).json,
  ).toMatchObject({ state: 'received', responseCount: 1 });
  expect(
    (await host.server.app.inject({ method: 'POST', url: path, payload: { submit: true } }))
      .statusCode,
  ).toBe(409);
});

test('a comparative statement (RFC 0032 §3.4): the workspace from the responses, negotiated, approved, confirmed into orders', async () => {
  const T = '/api/v1/models/purchase.tender';
  const C = '/api/v1/models/purchase.comparison';
  // A second vendor who also quotes.
  const other = (await call('POST', '/api/v1/models/res.partner', 'dina', { name: 'Tamim Agro' }))
    .json.id as number;
  const tender = await call('POST', T, 'farid', {
    topic: 'Fish meal',
    deadline: '2026-12-01',
    vendors: { set: [vendor, other] },
    lines: { create: [{ product, quantity: '100' }] },
  });
  expect(tender.status, JSON.stringify(tender.json)).toBe(201);
  const tid = tender.json.id as number;
  expect((await call('POST', `${T}/${tid}/transitions/send`, 'farid')).status).toBe(200);
  const responses = (
    await call(
      'GET',
      `/api/v1/models/purchase.tender.response?filter=${encodeURIComponent(JSON.stringify({ tender: tid }))}&fields=vendor,lines`,
      'farid',
    )
  ).json.items as Json[];
  expect(responses.length).toBe(2);
  // The buyers type both quotations: 547 and 520.
  for (const [r, price] of [
    [responses[0], '547'],
    [responses[1], '520'],
  ] as const) {
    const lines = (
      await call(
        'GET',
        `/api/v1/models/purchase.tender.response.line?filter=${encodeURIComponent(JSON.stringify({ response: r.id }))}&fields=id`,
        'farid',
      )
    ).json.items as Json[];
    for (const l of lines)
      expect(
        (
          await call('PATCH', `/api/v1/models/purchase.tender.response.line/${l.id}`, 'farid', {
            priceUnit: price,
          })
        ).status,
      ).toBe(200);
    expect(
      (
        await call(
          'POST',
          `/api/v1/models/purchase.tender.response/${r.id}/transitions/submit`,
          'farid',
        )
      ).status,
    ).toBe(200);
  }
  expect((await call('GET', `${T}/${tid}?fields=state`, 'farid')).json.state).toBe('received');
  // The statement: its workspace filled from the RFQ, the lowest final price marked.
  const made = await call('POST', C, 'farid', { tender: tid });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  const cid = made.json.id as number;
  expect((await call('POST', `${C}/${cid}/transitions/fill`, 'farid')).status).toBe(200);
  const lines = async () =>
    (
      await call(
        'GET',
        `/api/v1/models/purchase.comparison.line?filter=${encodeURIComponent(JSON.stringify({ comparison: cid }))}&fields=response,quote,finalPrice,lowest,selected,total&order=id+asc`,
        'farid',
      )
    ).json.items as Json[];
  let rows = await lines();
  expect(rows.length).toBe(2);
  expect(rows.map((r) => [Number(r.quote), r.lowest])).toEqual([
    [547, false],
    [520, true],
  ]);
  // Nothing selected: refused. Negotiated to 500 with the first vendor, selected, the lowest moves.
  expect((await call('POST', `${C}/${cid}/transitions/submit`, 'farid')).status).toBe(409);
  const first = rows[0];
  expect(
    (
      await call('PATCH', `/api/v1/models/purchase.comparison.line/${first.id}`, 'farid', {
        nego1: '510',
        nego2: '500',
        finalPrice: '500',
        selected: true,
      })
    ).status,
  ).toBe(200);
  rows = await lines();
  expect(rows.map((r) => r.lowest)).toEqual([true, false]);
  expect(
    Number((await call('GET', `${C}/${cid}?fields=amountTotal`, 'farid')).json.amountTotal),
  ).toBe(50000);
  // Approved by a Purchase manager, confirmed by the buyer: one order to the first vendor at 500.
  expect((await call('POST', `${C}/${cid}/transitions/submit`, 'farid')).status).toBe(200);
  const inbox = (await call('GET', '/api/v1/approvals/inbox', 'dina')).json.requests as Json[];
  for (const r of inbox.filter(
    (x) => x.targetModel === 'purchase.comparison' && x.targetId === cid,
  ))
    expect((await call('POST', `/api/v1/approvals/requests/${r.id}/approve`, 'dina')).status).toBe(
      200,
    );
  expect((await call('GET', `${C}/${cid}?fields=state`, 'farid')).json.state).toBe('approved');
  const confirmed = await call('POST', `${C}/${cid}/transitions/confirm`, 'farid');
  expect(confirmed.status, JSON.stringify(confirmed.json)).toBe(200);
  const orders = (
    await call(
      'GET',
      `/api/v1/models/purchase.order?filter=${encodeURIComponent(JSON.stringify({ origin: { ilike: '%CS/%' } }))}&fields=partner,amountUntaxed,state`,
      'farid',
    )
  ).json.items as Json[];
  expect(orders.length).toBe(1);
  // To the vendor of the selected line (responses are not made in the vendors' order).
  const chosen = responses.find((r) => r.id === (first.response?.id ?? first.response));
  expect(orders[0].partner?.id ?? orders[0].partner).toBe(chosen.vendor?.id ?? chosen.vendor);
  expect(Number(orders[0].amountUntaxed?.amount ?? orders[0].amountUntaxed)).toBe(50000);
  expect((await call('GET', `${T}/${tid}?fields=state`, 'farid')).json.state).toBe('ordered');
});

test('the line onchange fills the product; the price comes from the vendor, else the cost, when saved', async () => {
  const res = await call('POST', '/api/v1/models/purchase.order.line/onchange', 'farid', {
    values: { product },
    changed: ['product'],
  });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  // The onchange no longer sets a price: one set there would be kept as typed in (RFC 0030 §3.1).
  expect(res.json.values.priceUnit).toBeUndefined();
  const created = await call('POST', '/api/v1/models/purchase.order', 'farid', {
    partner: vendor,
    currency,
    lines: { create: [{ product, name: 'Raw jute (kg)', quantity: '1' }] },
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const lines = await call(
    'GET',
    `/api/v1/models/purchase.order.line?filter=${encodeURIComponent(JSON.stringify({ order: created.json.id }))}&fields=priceUnit`,
    'farid',
  );
  expect(lines.json.items.map((l: { priceUnit: string }) => Number(l.priceUnit))).toEqual([100]);
});
