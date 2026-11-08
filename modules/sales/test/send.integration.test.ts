/**
 * Sending a quotation by email (RFC 0029 §3.3) on real PostgreSQL: the composition in the customer's language,
 * the edited text sent with the PDF, the message and the PDF on the chatter, the email delivered once by the
 * outbox; documents that are not sendable and users who may not read the order are refused.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryMailer, mailModule } from '@kosh/mail';
import { reporting } from '@kosh/reporting';
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
import { sales } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const mailer = createMemoryMailer();
const mail = mailModule({ mailer, workers: true });
const catalogue = [base, mail, reporting, sales];

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let files: string;
let host: AppHost;
let company: number;
let customer: number;
let product: number;
let currency: number;
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

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-send-'));
  files = await mkdtemp(join(tmpdir(), 'kosh-send-files-'));
  process.env['KOSH_STORAGE_DIR'] = files;
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({
      driver,
      catalogue,
      change: { install: ['mail', 'reporting', 'sales'] },
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
  for (const [login, groups] of [
    ['rahim', ['sales.user', 'reporting.user']],
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
  const ids = await host.server.shutro.bootstrap({ reason: 'test: data', company }, async (env) => {
    const model = (name: string) => env.model(name as never) as unknown as Model;
    const p = await model('res.partner').create([
      {
        name: 'Bengal Steel',
        isCompany: true,
        isCustomer: true,
        email: 'buy@bengal.test',
        lang: 'bn',
      },
    ]);
    const prod = await model('product.product').create([{ name: 'Jute bag', listPrice: '1000' }]);
    const [bdt] = await env.sql<{ id: number }>`SELECT id FROM res_currency WHERE name = 'BDT'`;
    return {
      customer: p.ids[0] as number,
      product: prod.ids[0] as number,
      currency: bdt?.id as number,
    };
  });
  customer = ids.customer;
  product = ids.product;
  currency = ids.currency;
}, 180_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  delete process.env['KOSH_STORAGE_DIR'];
  await rm(dir, { recursive: true, force: true });
  await rm(files, { recursive: true, force: true });
});

test('a quotation sent: composed in Bangla, edited, its PDF on the chatter and in the email, delivered once', async () => {
  const order = await call('POST', '/api/v1/models/sale.order', 'rahim', {
    partner: customer,
    currency,
    lines: { create: [{ product, name: 'Jute bag', quantity: '2', priceUnit: '1000' }] },
  });
  expectStatus(order, 201);
  const id = order.json.id as number;
  const name = (await call('GET', `/api/v1/models/sale.order/${id}?fields=name`, 'rahim')).json
    .name as string;
  const file = `${name.replaceAll('/', '-')}.pdf`;

  const sendable = await call('GET', '/api/v1/mail/sendable', 'rahim');
  expect(sendable.json.models).toContain('sale.order');
  // Not every model is sendable; users who cannot read the order cannot send it.
  expect((await call('GET', `/api/v1/mail/compose/res.partner/${customer}`, 'rahim')).status).toBe(
    404,
  );
  expect((await call('GET', `/api/v1/mail/compose/sale.order/${id}`, 'bob')).status).toBe(403);

  const composed = await call('GET', `/api/v1/mail/compose/sale.order/${id}`, 'rahim');
  expectStatus(composed, 200);
  expect(composed.json).toMatchObject({
    to: [{ name: 'Bengal Steel', email: 'buy@bengal.test' }],
    subject: `Padma Traders: ${name}`,
    attachment: file,
    lang: 'bn_BD',
    sent: 0,
  });
  expect(composed.json.body).toContain('প্রিয় Bengal Steel');

  expect(
    (
      await call('POST', `/api/v1/mail/send/sale.order/${id}`, 'rahim', {
        to: 'not an address',
        subject: 'x',
      })
    ).status,
  ).toBe(400);
  const sent = await call('POST', `/api/v1/mail/send/sale.order/${id}`, 'rahim', {
    to: 'buy@bengal.test',
    cc: ['boss@bengal.test'],
    subject: composed.json.subject,
    body: `${composed.json.body}\n\nP.S. Delivery next week.`,
  });
  expectStatus(sent, 200);
  expect(sent.json.attachment).toEqual(expect.any(Number));

  // On the chatter: the message with the PDF.
  const chatter = await call('GET', `/api/v1/chatter/sale.order/${id}`, 'rahim');
  expectStatus(chatter, 200);
  const message = (chatter.json.items as Json[]).find((i) => i.id === sent.json.message);
  expect(message?.attachments?.[0]?.name).toBe(file);

  // Delivered by the outbox, once, with the PDF and the copy.
  const deadline = Date.now() + 20_000;
  while (mailer.sent.length === 0 && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 200));
  const outgoing = await host.server.shutro.bootstrap(
    { reason: 'test: the outgoing row', company },
    (env) =>
      env.sql<{ state: string; error: string | null }>`SELECT state, error FROM mail_outgoing`,
  );
  expect(mailer.sent, JSON.stringify(outgoing)).toHaveLength(1);
  expect(outgoing.map((o) => o.state)).toEqual(['sent']);
  const [email] = mailer.sent;
  expect(email).toMatchObject({ to: 'buy@bengal.test', cc: ['boss@bengal.test'] });
  expect(email?.text).toContain('P.S. Delivery next week.');
  expect(email?.attachments?.[0]?.filename).toBe(file);
  expect(
    Buffer.from(email?.attachments?.[0]?.content ?? [])
      .subarray(0, 4)
      .toString(),
  ).toBe('%PDF');

  const again = await call('GET', `/api/v1/mail/compose/sale.order/${id}`, 'rahim');
  expect(again.json.sent).toBe(1);
  await new Promise((r) => setTimeout(r, 2500));
  expect(mailer.sent).toHaveLength(1);
}, 60_000);

test('a selection sent at once: each to its customer, the ones without an address skipped and said why', async () => {
  const before = mailer.sent.length;
  const other = await host.server.shutro.bootstrap({ reason: 'test: no address', company }, (env) =>
    (
      env.model('res.partner' as never) as unknown as {
        create(rows: unknown[]): Promise<{ ids: number[] }>;
      }
    ).create([{ name: 'No Mail Ltd', isCompany: true, isCustomer: true }]),
  );
  const order = async (partner: number) =>
    (
      await call('POST', '/api/v1/models/sale.order', 'rahim', {
        partner,
        currency,
        lines: { create: [{ product, name: 'Jute bag', quantity: '1', priceUnit: '1000' }] },
      })
    ).json.id as number;
  const ids = [await order(customer), await order(other.ids[0] as number)];
  expect(
    (await call('POST', '/api/v1/mail/send-many/sale.order', 'rahim', { ids: [] })).status,
  ).toBe(400);
  const batch = await call('POST', '/api/v1/mail/send-many/sale.order', 'rahim', { ids });
  expectStatus(batch, 200);
  expect(batch.json.sent).toBe(1);
  expect(batch.json.skipped).toEqual([{ id: ids[1], reason: 'No Mail Ltd has no email address.' }]);
  const deadline = Date.now() + 20_000;
  while (mailer.sent.length === before && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 200));
  expect(mailer.sent.length).toBe(before + 1);
  expect(mailer.sent.at(-1)?.to).toBe('buy@bengal.test');
}, 60_000);
