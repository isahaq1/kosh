/**
 * Sales in the portal on real PostgreSQL (RFC 0015 step 2): installing `sale_portal` brings the portal; a customer's
 * portal user sees the sent quotations and orders of their contact and company — never drafts, never another
 * customer's (404) — with the declared fields only; reads the thread without internal notes and writes on it;
 * declines with a reason; accepts with a signature (the order is confirmed, the signature kept with the document's
 * hash, audited); an action that no longer applies is refused; the quotation prints as a PDF.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryMailer } from '@kosh/mail';
import { portalAnnouncer } from '@kosh/portal';
import { closeDocuments, installTemplates } from '@kosh/reporting';
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
import { salePortal } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [base, salePortal];
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let host: AppHost;
const mailer = createMemoryMailer();
let announcer: ReturnType<typeof portalAnnouncer>;
const tokens = new Map<string, string>();
const orders: Record<string, number> = {};
const partners: Record<string, number> = {};

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
  return {
    status: res.statusCode,
    json: (res.headers['content-type']?.toString().includes('json') ? res.json() : null) as Json,
    raw: res.rawPayload,
    type: res.headers['content-type'],
  };
}
/** Grants portal access to a contact and activates it with the password. */
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
  dir = await mkdtemp(join(tmpdir(), 'kosh-sale-portal-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({ driver, catalogue, change: { install: ['sale_portal'] }, dir }),
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
    groups: ['sales.manager', 'portal.manager', 'messaging.user'],
  });
  type Model = { create(rows: unknown[]): Promise<{ ids: number[] }> };
  await host.server.shutro.bootstrap({ reason: 'test', company }, async (env) => {
    const model = (name: string) => env.model(name as never) as unknown as Model;
    await installTemplates(env, host.server.registry.loaded.modules);
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
    const [product] = (
      await model('product.product').create([{ name: 'Jute bag', listPrice: '1000' }])
    ).ids;
    const line = { product, name: 'Jute bag', quantity: '10', priceUnit: '1000' };
    const [bdt] = await env.sql<{ id: number }>`SELECT id FROM res_currency WHERE name = 'BDT'`;
    const order = { user: maria, currency: bdt?.id };
    const created = (
      await model('sale.order').create([
        { ...order, partner: acme, lines: { create: [line] } }, // A: the company's, sent
        { ...order, partner: rina, lines: { create: [line] } }, // B: hers, sent
        { ...order, partner: globex, lines: { create: [line] } }, // C: another customer's, sent
        { ...order, partner: acme, lines: { create: [line] } }, // D: the company's, a draft
      ])
    ).ids;
    Object.assign(orders, { a: created[0], b: created[1], c: created[2], d: created[3] });
    await env.flush(); // constraints run here, in the system scope (Shutro request #11)
  });
  // The announcer (the module's own is off in tests: KOSH_SCHEDULES=off), its cursor set before the changes.
  announcer = portalAnnouncer(
    { app: host.server.app, shutro: host.server.shutro, registry: host.server.registry } as never,
    { portalUrl: 'https://portal.test', mailer },
  );
  await announcer.drain();
  for (const id of [orders['a'], orders['b'], orders['c']])
    expect(
      (await call('POST', `/api/v1/models/sale.order/${id}/transitions/send`, 'maria')).status,
    ).toBe(200);
  await portalUser(partners['rina'] as number);
  await portalUser(partners['bina'] as number);
}, 180_000);

afterAll(async () => {
  await closeDocuments();
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

const RINA = 'rina@acme.test';
const BINA = 'bina@globex.test';

test('sent quotations are announced to their customers by email, once', async () => {
  await announcer.drain();
  const sent = mailer.sent.map((m) => [m.to, m.subject]).sort();
  expect(sent).toEqual(
    [
      [BINA, expect.stringMatching(/^Padma Traders: Quotations and orders /)],
      [RINA, expect.stringMatching(/^Padma Traders: Quotations and orders /)],
      [RINA, expect.stringMatching(/^Padma Traders: Quotations and orders /)],
    ].sort(),
  );
  expect(mailer.sent.find((m) => m.to === BINA)?.html).toContain(
    `https://portal.test/d/quotations/${orders['c']}`,
  );
  const count = mailer.sent.length;
  await call('POST', `/api/v1/models/sale.order/${orders['d']}/transitions/send`, 'maria');
  await announcer.drain();
  expect(mailer.sent.slice(count).map((m) => m.to)).toEqual([RINA]);
  // Back to a draft and sent again: announced once already, so no second email.
  for (const step of ['cancel', 'redraft', 'send', 'cancel', 'redraft'])
    await call('POST', `/api/v1/models/sale.order/${orders['d']}/transitions/${step}`, 'maria');
  await announcer.drain();
  expect(mailer.sent).toHaveLength(count + 1);
});

test('a customer sees the sent quotations of their contact and company, never drafts or another customer’s', async () => {
  const types = await call('GET', '/api/portal/v1/documents', RINA);
  expect(types.json.documents).toEqual([
    { key: 'quotations', label: 'Quotations and orders', count: 2 },
  ]);
  const list = await call('GET', '/api/portal/v1/documents/quotations', RINA);
  expect(list.json.count).toBe(2);
  expect(list.json.items.map((i: Json) => i.id).sort()).toEqual([orders['a'], orders['b']].sort());
  expect(list.json.fields.map((f: Json) => f.key)).toEqual([
    'name',
    'dateOrder',
    'validityDate',
    'state',
    'amountTotal',
  ]);
  expect(Object.keys(list.json.items[0]).sort()).toEqual(
    ['id', 'name', 'dateOrder', 'validityDate', 'state', 'amountTotal'].sort(),
  );
  const home = await call('GET', '/api/portal/v1/home', RINA);
  expect(home.json.sections).toMatchObject([{ key: 'quotations', count: 2 }]);
  for (const id of [orders['c'], orders['d'], 999_999])
    expect((await call('GET', `/api/portal/v1/documents/quotations/${id}`, RINA)).status).toBe(404);
  expect(
    (await call('GET', `/api/portal/v1/documents/quotations/${orders['a']}`, BINA)).status,
  ).toBe(404);
  expect((await call('GET', '/api/portal/v1/documents/quotations', BINA)).json.count).toBe(1);
  // Staff use the back-office, not the portal API.
  expect((await call('GET', '/api/portal/v1/documents', 'maria')).status).toBe(403);
});

test('a document: the declared fields and lines, relations by name, the actions that apply', async () => {
  const doc = await call('GET', `/api/portal/v1/documents/quotations/${orders['a']}`, RINA);
  expect(doc.status).toBe(200);
  expect(Object.keys(doc.json.record).sort()).toEqual(
    [
      'id',
      'name',
      'state',
      'dateOrder',
      'validityDate',
      'clientReference',
      'user',
      'amountUntaxed',
      'amountTax',
      'amountTotal',
      'note',
    ].sort(),
  );
  expect(doc.json.record.state).toBe('sent');
  expect(doc.json.record.user).toEqual({ id: expect.any(Number), name: 'Maria' });
  expect(doc.json.lines).toHaveLength(1);
  expect(doc.json.lines[0].product).toEqual({ id: expect.any(Number), name: 'Jute bag' });
  expect(doc.json.actions.map((a: Json) => [a.key, a.signature, a.message])).toEqual([
    ['accept', true, false],
    ['decline', false, true],
  ]);
  expect(doc.json.fields.find((f: Json) => f.key === 'state').options).toContainEqual({
    value: 'sent',
    label: 'Quotation sent',
  });
  expect(doc.json).toMatchObject({ pdf: true, thread: true });
});

test('the thread: comments both ways, never internal notes', async () => {
  const note = await call('POST', `/api/v1/chatter/sale.order/${orders['a']}/messages`, 'maria', {
    kind: 'note',
    text: 'Margin is thin on this one.',
  });
  expect(note.status).toBe(201);
  const comment = await call(
    'POST',
    `/api/v1/chatter/sale.order/${orders['a']}/messages`,
    'maria',
    {
      kind: 'comment',
      text: 'Delivery in two weeks.',
    },
  );
  expect(comment.status).toBe(201);
  const posted = await call(
    'POST',
    `/api/portal/v1/documents/quotations/${orders['a']}/thread`,
    RINA,
    {
      body: 'Can you deliver to Narayanganj?',
    },
  );
  expect(posted.status).toBe(201);
  const thread = await call(
    'GET',
    `/api/portal/v1/documents/quotations/${orders['a']}/thread`,
    RINA,
  );
  const texts = thread.json.messages.map((m: Json) => String(m.body));
  expect(texts.some((t: string) => t.includes('Narayanganj'))).toBe(true);
  expect(texts.some((t: string) => t.includes('two weeks'))).toBe(true);
  expect(texts.some((t: string) => t.includes('Margin'))).toBe(false);
  expect(
    thread.json.messages.find((m: Json) => String(m.body).includes('Narayanganj')),
  ).toMatchObject({
    author: 'Rina Akter',
  });
});

test('decline needs a reason; accept needs a signature; both run once and leave their record', async () => {
  const decline = `/api/portal/v1/documents/quotations/${orders['b']}/actions/decline`;
  expect((await call('POST', decline, RINA, {})).status).toBe(422);
  expect((await call('POST', decline, RINA, { message: 'Found it cheaper.' })).status).toBe(200);
  const [b] = await driver.query<{ state: string }>({
    text: 'SELECT state FROM sale_order WHERE id = $1',
    params: [orders['b']],
  });
  expect(b?.state).toBe('cancel');
  // A cancelled quotation leaves the portal.
  expect(
    (await call('GET', `/api/portal/v1/documents/quotations/${orders['b']}`, RINA)).status,
  ).toBe(404);

  const accept = `/api/portal/v1/documents/quotations/${orders['a']}/actions/accept`;
  expect((await call('POST', accept, RINA, {})).status).toBe(422);
  expect(
    (
      await call('POST', accept, RINA, {
        signature: { name: 'Rina Akter', image: 'data:text/plain,x' },
      })
    ).status,
  ).toBe(422);
  expect(
    (await call('POST', accept, BINA, { signature: { name: 'Bina', image: PNG } })).status,
  ).toBe(404);
  const ok = await call('POST', accept, RINA, { signature: { name: 'Rina Akter', image: PNG } });
  expect(ok.status).toBe(200);
  const [a] = await driver.query<{ state: string }>({
    text: 'SELECT state FROM sale_order WHERE id = $1',
    params: [orders['a']],
  });
  expect(a?.state).toBe('sale');
  const [signature] = await driver.query<{
    signed_name: string;
    document_hash: string;
    action: string;
  }>({
    text: 'SELECT signed_name, document_hash, action FROM portal_signature WHERE res_id = $1',
    params: [orders['a']],
  });
  expect(signature).toMatchObject({ signed_name: 'Rina Akter', action: 'accept' });
  expect(signature?.document_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(
    (await call('POST', accept, RINA, { signature: { name: 'Rina Akter', image: PNG } })).status,
  ).toBe(409);
  const doc = await call('GET', `/api/portal/v1/documents/quotations/${orders['a']}`, RINA);
  expect(doc.json.record.state).toBe('sale');
  expect(doc.json.actions).toEqual([]);
  const thread = await call(
    'GET',
    `/api/portal/v1/documents/quotations/${orders['a']}/thread`,
    RINA,
  );
  expect(
    thread.json.messages.some((m: Json) => String(m.body).includes('signed as “Rina Akter”')),
  ).toBe(true);
  const events = await driver.query<{ kind: string; actor_id: number | null }>({
    text: `SELECT kind, actor_id FROM audit_event WHERE kind = 'portal.action' ORDER BY id`,
    params: [],
  });
  expect(events).toHaveLength(2);
});

test('the quotation prints as a PDF for its customer only', async () => {
  const pdf = await call('GET', `/api/portal/v1/documents/quotations/${orders['a']}/pdf`, RINA);
  expect(pdf.status).toBe(200);
  expect(pdf.type).toBe('application/pdf');
  expect(Buffer.from(pdf.raw).subarray(0, 4).toString()).toBe('%PDF');
  expect(
    (await call('GET', `/api/portal/v1/documents/quotations/${orders['a']}/pdf`, BINA)).status,
  ).toBe(404);
}, 60_000);
