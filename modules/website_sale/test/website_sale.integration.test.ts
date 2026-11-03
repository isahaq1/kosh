/**
 * The Shop on real PostgreSQL through its public API (RFC 0024 §2.7): only published products, searched, sorted and in
 * Bangla; a cart held by its token, priced by the server; fees by zone and by weight, free from an amount; cash on
 * delivery confirmed within the site's limit and left to confirm above it, refused by a method without cash; an online
 * payment with the test provider that confirms, invoices and pays the order once; the demo data.
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
  installDemo,
  prepareApps,
  recordInstalledApps,
} from '@kosh/server';
import { type Driver, orm, pg } from '@kosh/server/orm';
import { settings } from '@kosh/settings';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { shipmentWorker, testCourier, websiteSale } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [base, settings, websiteSale];
const SHOP = '/api/v1/public/shop/bazar';

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let host: AppHost;
let company: number;
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
/** A visitor's call: no sign-in, the cart's token if any. */
async function visit(
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  cart?: string,
  payload?: unknown,
) {
  const res = await host.server.app.inject({
    method,
    url,
    headers: cart === undefined ? {} : { 'x-cart-token': cart },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: res.statusCode, json: (res.body === '' ? null : res.json()) as Json };
}
const newCart = async () => {
  const made = await visit('POST', `${SHOP}/cart`);
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  return made.json.token as string;
};
const put = (cart: string, product: number | undefined, quantity: string) =>
  visit('PUT', `${SHOP}/cart/lines`, cart, { product, quantity });
const customer = (carrier: number | undefined, payment: string, city = 'Dhaka') => ({
  name: 'Rina Akter',
  email: 'rina@example.com',
  phone: '01700000000',
  street: 'House 12, Road 5',
  city,
  carrier,
  payment,
});

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-website-sale-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({
      driver,
      catalogue,
      change: { install: ['settings', 'website_sale'] },
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
  await auth.createUser({
    login: 'dina',
    name: 'Dina',
    password: PASSWORD,
    company,
    companies: [company],
    groups: ['website_sale.manager', 'product.manager', 'account.manager', 'contacts.manager'],
  });
  expect(
    (await call('POST', '/api/v1/accounting/charts/install', 'dina', { template: 'generic' }))
      .status,
  ).toBe(200);
  const site = await call('POST', '/api/v1/models/website.site', 'dina', {
    name: 'Padma Traders',
    key: 'bazar',
    shop: true,
    codLimit: '3000',
  });
  expect(site.status, JSON.stringify(site.json)).toBe(201);
  ids['grocery'] = (
    await call('POST', '/api/v1/models/product.category', 'dina', { name: 'Grocery' })
  ).json.id;
  for (const [name, price, weight, published] of [
    ['Rice 5 kg', '500', '5', true],
    ['Mustard oil 1 L', '200', '1', true],
    ['Warehouse pallet', '50', '20', false],
  ] as const) {
    const made = await call('POST', '/api/v1/models/product.product', 'dina', {
      name,
      listPrice: price,
      weight,
      published,
      category: ids['grocery'],
    });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    ids[name] = made.json.id;
  }
  await call('PATCH', `/api/v1/models/product.product/${ids['Rice 5 kg']}`, 'dina', {
    related: { set: [ids['Mustard oil 1 L'], ids['Warehouse pallet']] },
    websiteDescription: { en_US: 'Fine aromatic rice.', bn_BD: 'সুগন্ধি চাল।' },
  });
  ids['zone'] = (
    await call('POST', '/api/v1/models/delivery.carrier', 'dina', {
      name: 'Home delivery',
      kind: 'zone',
      zoneCities: 'Dhaka, Narayanganj',
      priceInside: '60',
      priceOutside: '120',
      freeOver: '2000',
      cod: true,
    })
  ).json.id;
  ids['weight'] = (
    await call('POST', '/api/v1/models/delivery.carrier', 'dina', {
      name: 'Courier by weight',
      kind: 'weight',
      price: '80',
      pricePerKg: '20',
      cod: false,
    })
  ).json.id;
  const journals = (await call('GET', '/api/v1/models/account.journal?fields=id,type', 'dina')).json
    .items as Json[];
  ids['provider'] = (
    await call('POST', '/api/v1/models/payment.provider', 'dina', {
      name: 'Test payments',
      code: 'fake',
      journal: journals.find((j) => j.type === 'bank').id,
    })
  ).json.id;
}, 240_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('the catalogue: published products only, searched and sorted; a product page in Bangla', async () => {
  const all = await visit('GET', `${SHOP}/products?sort=price`);
  expect(all.status).toBe(200);
  expect(all.json.products.map((p: Json) => [p.name, p.price])).toEqual([
    ['Mustard oil 1 L', '200.00'],
    ['Rice 5 kg', '500.00'],
  ]);
  expect((await visit('GET', `${SHOP}/products?q=rice`)).json.total).toBe(1);
  expect((await visit('GET', `${SHOP}/products?min=300`)).json.products).toHaveLength(1);
  expect(
    (await visit('GET', `${SHOP}/products?category=${ids['grocery']}`)).json.products,
  ).toHaveLength(2);
  const rice = await visit('GET', `${SHOP}/products/${ids['Rice 5 kg']}?lang=bn`);
  expect(rice.json.description).toBe('সুগন্ধি চাল।');
  // Related products: the published ones.
  expect(rice.json.related.map((p: Json) => p.name)).toEqual(['Mustard oil 1 L']);
  expect((await visit('GET', `${SHOP}/products/${ids['Warehouse pallet']}`)).status).toBe(404);
  expect((await visit('GET', `${SHOP}/categories`)).json.categories).toEqual([
    { id: ids['grocery'], name: 'Grocery', parent: null },
  ]);
  expect((await visit('GET', '/api/v1/public/shop/nowhere/products')).status).toBe(404);
});

test('a cart held by its token, priced by the server; fees by zone and weight', async () => {
  expect((await visit('GET', `${SHOP}/cart`)).status).toBe(404);
  const cart = await newCart();
  const first = await put(cart, ids['Rice 5 kg'], '2');
  expect(first.status, JSON.stringify(first.json)).toBe(200);
  await put(cart, ids['Mustard oil 1 L'], '3');
  const updated = await put(cart, ids['Mustard oil 1 L'], '1');
  expect(updated.json.lines.map((l: Json) => [l.name, l.quantity, l.subtotal])).toEqual([
    ['Rice 5 kg', '2', '1000.00'],
    ['Mustard oil 1 L', '1', '200.00'],
  ]);
  expect(updated.json.total).toBe('1200.00');
  // Not on the shop; nobody else's token sees it.
  expect((await put(cart, ids['Warehouse pallet'], '1')).status).toBe(422);
  expect((await visit('GET', `${SHOP}/cart`, 'not-my-cart')).status).toBe(404);
  const fees = async (city: string) =>
    Object.fromEntries(
      (await visit('GET', `${SHOP}/carriers?city=${city}`, cart)).json.carriers.map((c: Json) => [
        c.name,
        c.fee,
      ]),
    );
  expect(await fees('Dhaka')).toEqual({ 'Home delivery': '60.00', 'Courier by weight': '280.00' });
  expect(await fees('Sylhet')).toEqual({
    'Home delivery': '120.00',
    'Courier by weight': '280.00',
  });
});

test('cash on delivery: confirmed within the limit, left to confirm above it; a method without cash refused', async () => {
  const cart = await newCart();
  await put(cart, ids['Rice 5 kg'], '2');
  await put(cart, ids['Mustard oil 1 L'], '1');
  expect(
    (await visit('POST', `${SHOP}/checkout`, cart, customer(ids['weight'], 'cod'))).status,
  ).toBe(422);
  const placed = await visit('POST', `${SHOP}/checkout`, cart, customer(ids['zone'], 'cod'));
  expect(placed.status, JSON.stringify(placed.json)).toBe(201);
  expect(placed.json).toMatchObject({ state: 'sale', total: '1260.00' });
  // Checked out: no longer a cart; the order is the token's to follow.
  expect((await visit('GET', `${SHOP}/cart`, cart)).status).toBe(404);
  const order = await visit('GET', `${SHOP}/order`, cart);
  expect(order.json).toMatchObject({ name: placed.json.order, state: 'sale', delivery: '60.00' });
  const [made] = (
    await call(
      'GET',
      `/api/v1/models/sale.order?filter=${encodeURIComponent(JSON.stringify({ name: placed.json.order }))}&fields=partner,shopNote,shopPayment`,
      'dina',
    )
  ).json.items as Json[];
  expect(made.shopPayment).toBe('cod');
  expect(made.shopNote).toContain('Deliver to: Rina Akter, 01700000000, House 12, Road 5, Dhaka');
  const partner = (
    await call('GET', `/api/v1/models/res.partner/${made.partner?.id ?? made.partner}`, 'dina')
  ).json;
  expect(partner).toMatchObject({ name: 'Rina Akter', email: 'rina@example.com', city: 'Dhaka' });

  // Above the limit (free delivery from 2 000): placed, left for the team to confirm.
  const big = await newCart();
  await put(big, ids['Rice 5 kg'], '10');
  const above = await visit(
    'POST',
    `${SHOP}/checkout`,
    big,
    customer(ids['zone'], 'cod', 'Sylhet'),
  );
  expect(above.json).toMatchObject({ state: 'draft', total: '5000.00' });
});

test('paid online: the test provider confirms; the order is confirmed, invoiced and paid once', async () => {
  const cart = await newCart();
  await put(cart, ids['Mustard oil 1 L'], '2');
  const providers = (await visit('GET', `${SHOP}/payments`)).json.providers;
  expect(providers.map((p: Json) => p.id)).toEqual([ids['provider']]);
  const started = await visit('POST', `${SHOP}/checkout`, cart, {
    ...customer(ids['zone'], String(ids['provider'])),
    returnUrl: 'https://shop.padma.example/thanks',
  });
  expect(started.status, JSON.stringify(started.json)).toBe(201);
  expect(started.json).toMatchObject({ state: 'draft', total: '460.00' });
  const { reference, redirectUrl } = started.json;
  expect((await host.server.app.inject({ method: 'GET', url: redirectUrl })).statusCode).toBe(200);
  const paid = await host.server.app.inject({
    method: 'POST',
    url: `${redirectUrl}?outcome=paid`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: '',
  });
  expect(paid.statusCode).toBe(303);
  const back = await host.server.app.inject({
    method: 'GET',
    url: `/api/v1/payment/return/${reference}`,
  });
  expect(back.headers.location).toBe(`https://shop.padma.example/thanks?payment=${reference}`);
  const workers = webhookWorkers({
    shutro: host.server.shutro,
    registry: host.server.registry,
    auth: host.server.auth,
  });
  for (let round = 0; round < 2; round++) for (const w of workers) await w.drain();
  const order = await visit('GET', `${SHOP}/order`, cart);
  expect(order.json).toMatchObject({ state: 'sale', paymentState: 'done', total: '460.00' });
  const [made] = (
    await call(
      'GET',
      `/api/v1/models/sale.order?filter=${encodeURIComponent(JSON.stringify({ name: started.json.order }))}&fields=invoiceState`,
      'dina',
    )
  ).json.items as Json[];
  expect(made.invoiceState).toBe('invoiced');
  const [invoice] = (
    await call(
      'GET',
      `/api/v1/models/account.move?filter=${encodeURIComponent(JSON.stringify({ saleOrder: made.id }))}&fields=state,amountResidual`,
      'dina',
    )
  ).json.items as Json[];
  expect(invoice.state).toBe('posted');
  expect(invoice.amountResidual.amount ?? invoice.amountResidual).toBe('0.00');
}, 30_000);

test('a courier: the confirmed order’s shipment drafted once, booked, tracked to delivered with the cash collected; followed by its token', async () => {
  const worker = shipmentWorker({ shutro: host.server.shutro });
  await worker.drain(); // the orders placed before
  await call('PATCH', `/api/v1/models/delivery.carrier/${ids['zone']}`, 'dina', {
    courier: 'fake',
  });
  const cart = await newCart();
  await put(cart, ids['Rice 5 kg'], '1');
  const placed = await visit('POST', `${SHOP}/checkout`, cart, customer(ids['zone'], 'cod'));
  expect(placed.json.state).toBe('sale');
  expect(await worker.drain()).toBe(1);
  const S = '/api/v1/models/delivery.shipment';
  const q = encodeURIComponent(JSON.stringify({ 'order.name': placed.json.order }));
  const shipments = async () =>
    (
      await call(
        'GET',
        `${S}?filter=${q}&fields=name,state,cod,weight,recipient,city,trackingRef,codCollected`,
        'dina',
      )
    ).json.items as Json[];
  const [draft] = await shipments();
  expect(draft).toMatchObject({ state: 'draft', recipient: 'Rina Akter', city: 'Dhaka' });
  expect(Number(draft.cod)).toBe(560); // 500 and the 60 fee, paid on delivery
  expect(Number(draft.weight)).toBe(5);
  // Confirmed again (a replay): no second shipment.
  const [order] = (
    await call(
      'GET',
      `/api/v1/models/sale.order?filter=${encodeURIComponent(JSON.stringify({ name: placed.json.order }))}&fields=id`,
      'dina',
    )
  ).json.items as Json[];
  await host.server.shutro.bootstrap({ reason: 'test: replay', company }, (env) =>
    env.emit('sale.order.confirmed', { id: order.id }),
  );
  await worker.drain();
  expect(await shipments()).toHaveLength(1);

  expect((await call('POST', `${S}/${draft.id}/transitions/book`, 'dina')).status).toBe(200);
  const [booked] = await shipments();
  expect(booked.state).toBe('booked');
  expect(booked.trackingRef).toMatch(/^FAKE-/);
  testCourier.advance(booked.trackingRef, 'in_transit', 'At the Dhaka hub');
  testCourier.advance(booked.trackingRef, 'delivered', 'Delivered, cash collected');
  expect(
    (await call('POST', '/api/v1/shop/shipments/refresh', 'dina', { shipments: [draft.id] })).json
      .moved,
  ).toBe(1);
  const [done] = await shipments();
  expect(done).toMatchObject({ state: 'delivered', codCollected: true });
  const followed = (await visit('GET', `${SHOP}/order`, cart)).json;
  expect(followed.shipments[0].state).toBe('delivered');
  expect(followed.shipments[0].events.map((e: Json) => e.status)).toEqual([
    'booked',
    'in_transit',
    'delivered',
  ]);
  // Delivered: no longer cancellable.
  expect((await call('POST', `${S}/${draft.id}/transitions/cancel`, 'dina')).status).toBe(409);
}, 30_000);

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
  expect(JSON.stringify(summary)).toContain('Shop');
});
