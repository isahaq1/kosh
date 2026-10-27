/**
 * Purchase in the vendor portal on real PostgreSQL (RFC 0015 step 4): a vendor's portal user sees the requests for
 * quotation sent to their company — not drafts, not another vendor's — with the lines, writes on them, and gets an
 * email when one is sent.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryMailer } from '@kosh/mail';
import { portalAnnouncer } from '@kosh/portal';
import {
  type AppHost,
  applyApps,
  base,
  createAppHost,
  installBase,
  prepareApps,
  recordInstalledApps,
} from '@kosh/server';
import { type Driver, orm, pg } from '@kosh/server/orm';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { purchasePortal } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [base, purchasePortal];
const mailer = createMemoryMailer();

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let host: AppHost;
let announcer: ReturnType<typeof portalAnnouncer>;
const tokens = new Map<string, string>();
const orders: Record<string, number> = {};
const partners: Record<string, number> = {};

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function call(method: 'GET' | 'POST', url: string, as: string, payload?: unknown) {
  let token = tokens.get(as);
  if (token === undefined) {
    const res = await host.server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { login: as, password: PASSWORD },
    });
    token = (res.json() as { token: string }).token;
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
async function portalUser(partner: number): Promise<void> {
  const granted = await call('POST', '/api/v1/portal/access', 'maria', { partner });
  const token = new URL(granted.json.activationUrl).searchParams.get('token');
  const res = await host.server.app.inject({
    method: 'POST',
    url: '/api/portal/v1/activate',
    payload: { token, password: PASSWORD },
  });
  expect(res.statusCode).toBe(200);
}

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-purchase-portal-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({ driver, catalogue, change: { install: ['purchase_portal'] }, dir }),
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
  const maria = await auth.createUser({
    login: 'maria',
    name: 'Maria',
    password: PASSWORD,
    company,
    companies: [company],
    groups: ['purchase.manager', 'portal.manager'],
  });
  type Model = { create(rows: unknown[]): Promise<{ ids: number[] }> };
  await host.server.shutro.bootstrap({ reason: 'test', company }, async (env) => {
    const model = (name: string) => env.model(name as never) as unknown as Model;
    const [bdt] = await env.sql<{ id: number }>`SELECT id FROM res_currency WHERE name = 'BDT'`;
    const [jute, globex] = (
      await model('res.partner').create([
        { name: 'Jute Mills Ltd', isCompany: true, isVendor: true },
        { name: 'Globex', isCompany: true, isVendor: true },
      ])
    ).ids;
    const [rina, bina] = (
      await model('res.partner').create([
        { name: 'Rina Akter', email: 'rina@jute.test', parent: jute },
        { name: 'Bina Das', email: 'bina@globex.test', parent: globex },
      ])
    ).ids;
    Object.assign(partners, { jute, globex, rina, bina });
    const [product] = (
      await model('product.product').create([{ name: 'Raw jute', listPrice: '0' }])
    ).ids;
    const line = { product, name: 'Raw jute', quantity: '100', priceUnit: '80' };
    const base = { user: maria, currency: bdt?.id };
    const created = (
      await model('purchase.order').create([
        { ...base, partner: jute, lines: { create: [line] } }, // sent
        { ...base, partner: jute, lines: { create: [line] } }, // a draft
        { ...base, partner: globex, lines: { create: [line] } }, // another vendor's, sent
      ])
    ).ids;
    Object.assign(orders, { sent: created[0], draft: created[1], other: created[2] });
    await env.flush();
  });
  announcer = portalAnnouncer(
    { app: host.server.app, shutro: host.server.shutro, registry: host.server.registry } as never,
    { portalUrl: 'https://portal.test', mailer },
  );
  await announcer.drain();
  await portalUser(partners['rina'] as number);
  await portalUser(partners['bina'] as number);
  for (const id of [orders['sent'], orders['other']])
    expect(
      (await call('POST', `/api/v1/models/purchase.order/${id}/transitions/send`, 'maria')).status,
    ).toBe(200);
}, 180_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('a vendor sees the requests sent to their company, with the lines; never drafts or another vendor’s', async () => {
  const list = await call('GET', '/api/portal/v1/documents/purchases', 'rina@jute.test');
  expect(list.json.items.map((i: Json) => i.id)).toEqual([orders['sent']]);
  for (const id of [orders['draft'], orders['other']])
    expect(
      (await call('GET', `/api/portal/v1/documents/purchases/${id}`, 'rina@jute.test')).status,
    ).toBe(404);
  const doc = await call(
    'GET',
    `/api/portal/v1/documents/purchases/${orders['sent']}`,
    'rina@jute.test',
  );
  expect(doc.json.record.state).toBe('sent');
  expect(doc.json.lines[0]).toMatchObject({ name: 'Raw jute', product: { name: 'Raw jute' } });
  expect(doc.json).toMatchObject({ pdf: false, thread: true, actions: [] });
  const posted = await call(
    'POST',
    `/api/portal/v1/documents/purchases/${orders['sent']}/thread`,
    'rina@jute.test',
    { body: 'We can deliver on the 12th.' },
  );
  expect(posted.status).toBe(201);
});

test('a sent request is announced to its vendor', async () => {
  await announcer.drain();
  expect(mailer.sent.map((m) => m.to).sort()).toEqual(['bina@globex.test', 'rina@jute.test']);
  expect(mailer.sent.find((m) => m.to === 'rina@jute.test')?.html).toContain(
    `https://portal.test/d/purchases/${orders['sent']}`,
  );
});
