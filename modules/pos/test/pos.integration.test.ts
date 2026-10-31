/**
 * Counter on real PostgreSQL (RFC 0021): a cashier's session opened with its cash; a sale posted whole with two
 * payments, paid at once, the change given; the same sale from the device accepted once; a sale not covered by
 * its payments refused; a cashier sees only their own sessions; closing needs the count and a reason for a
 * difference; one open session per cashier.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accounting } from '@kosh/accounting';
import { contacts } from '@kosh/contacts';
import { createMemoryMailer } from '@kosh/mail';
import { messaging } from '@kosh/messaging';
import { createMemoryMessenger } from '@kosh/notify';
import { permissions } from '@kosh/permissions';
import { product } from '@kosh/product';
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
import { settings } from '@kosh/settings';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { posModule } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const mailer = createMemoryMailer();
const messenger = createMemoryMessenger();
const pos = posModule({ mailer, messenger });
const catalogue = [
  base,
  settings,
  contacts,
  product,
  accounting,
  messaging,
  permissions,
  reporting,
  pos,
];

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let host: AppHost;
const tokens = new Map<string, string>();
const ids: Record<string, number> = {};

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function call(
  login: string,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  payload?: unknown,
): Promise<{ status: number; json: Json }> {
  let token = tokens.get(login);
  if (token === undefined) {
    const res = await host.server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { login, password: PASSWORD },
    });
    token = (res.json() as { token: string }).token;
    tokens.set(login, token);
  }
  const res = await host.server.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: res.statusCode, json: res.body === '' ? null : res.json() };
}

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-pos-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({ driver, catalogue, change: { install: ['settings', 'pos'] }, dir }),
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
  for (const [login, groups] of [
    ['maria', ['pos.manager', 'product.manager', 'account.manager']],
    ['rahim', ['pos.cashier']],
    ['sam', ['pos.cashier']],
  ] as const)
    await auth.createUser({
      login,
      name: login,
      password: PASSWORD,
      company,
      companies: [company],
      groups: [...groups],
    });
  const tea = await call('maria', 'POST', '/api/v1/models/product.product', {
    name: 'Tea 500 g',
    listPrice: '250',
    standardPrice: '180',
  });
  expect(tea.status, JSON.stringify(tea.json)).toBe(201);
  ids['tea'] = tea.json.id;
  const shop = await call('maria', 'POST', '/api/v1/models/pos.shop', {
    name: 'Padma Shop',
    pricesIncludeTax: true,
    methods: {
      create: [
        { name: 'Cash', kind: 'cash', sequence: 1 },
        { name: 'Card', kind: 'card', sequence: 2 },
      ],
    },
  });
  expect(shop.status, JSON.stringify(shop.json)).toBe(201);
  ids['shop'] = shop.json.id;
  const shops = await call('rahim', 'GET', '/api/v1/counter/shops');
  expect(shops.status, JSON.stringify(shops.json)).toBe(200);
  for (const m of shops.json.shops[0].methods as { id: number; kind: string }[]) ids[m.kind] = m.id;
}, 240_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('a session opened with its cash; the catalogue for the register; one open session per cashier', async () => {
  expect(
    (await call('rahim', 'GET', `/api/v1/counter/session?shop=${ids['shop']}`)).json.session,
  ).toBeNull();
  const opened = await call('rahim', 'POST', '/api/v1/counter/sessions', {
    shop: ids['shop'],
    openingCash: '1000',
  });
  expect(opened.status, JSON.stringify(opened.json)).toBe(201);
  expect(opened.json.session.state).toBe('open');
  expect(Number(opened.json.session.openingCash)).toBe(1000);
  expect(Number(opened.json.session.expectedCash)).toBe(1000);
  ids['session'] = opened.json.session.id;
  const again = await call('rahim', 'POST', '/api/v1/counter/sessions', {
    shop: ids['shop'],
    openingCash: '5',
  });
  expect(again.status).toBe(422);
  const catalogue = await call('rahim', 'GET', `/api/v1/counter/catalogue?shop=${ids['shop']}`);
  expect(catalogue.json.products.map((p: { name: string }) => p.name)).toContain('Tea 500 g');
});

test('a sale with two payments, paid at once, the change given; the device sends it twice, accepted once', async () => {
  const sale = {
    session: ids['session'],
    clientId: 'device-1-0001',
    lines: [{ product: ids['tea'], quantity: '2' }],
    payments: [
      { method: ids['card'], amount: '300' },
      { method: ids['cash'], amount: '250' },
    ],
  };
  const first = await call('rahim', 'POST', '/api/v1/counter/orders', sale);
  expect(first.status, JSON.stringify(first.json)).toBe(201);
  expect(first.json.order.state).toBe('paid');
  expect(Number(first.json.order.total)).toBe(500);
  expect(Number(first.json.order.amountPaid)).toBe(550);
  expect(Number(first.json.order.change)).toBe(50);
  const second = await call('rahim', 'POST', '/api/v1/counter/orders', sale);
  expect(second.status).toBe(200);
  expect(second.json).toMatchObject({ repeated: true, order: { id: first.json.order.id } });
  // The drawer: 1,000 + 250 in cash − 50 change.
  const session = await call('rahim', 'GET', `/api/v1/counter/session?shop=${ids['shop']}`);
  expect(Number(session.json.session.expectedCash)).toBe(1200);
  expect(session.json.session.orderCount).toBe(1);
  expect(Number(session.json.session.total)).toBe(500);
});

test('a sale not covered by its payments is refused; a cashier sees only their own sessions', async () => {
  const short = await call('rahim', 'POST', '/api/v1/counter/orders', {
    session: ids['session'],
    lines: [{ product: ids['tea'], quantity: '1' }],
    payments: [{ method: ids['cash'], amount: '100' }],
  });
  expect(short.status).toBe(409);
  expect(short.json.detail).toContain('cover the total');
  const mine = await call('sam', 'GET', '/api/v1/models/pos.session?fields=name');
  expect(mine.json.items).toEqual([]);
  expect(
    (await call('sam', 'GET', `/api/v1/counter/session?shop=${ids['shop']}`)).json.session,
  ).toBeNull();
  expect(
    (await call('maria', 'GET', '/api/v1/models/pos.session?fields=name')).json.items,
  ).toHaveLength(1);
});

test('closing: the count is needed, a difference needs a reason; closed with the difference kept', async () => {
  const noCount = await call(
    'rahim',
    'POST',
    `/api/v1/counter/sessions/${ids['session']}/close`,
    {},
  );
  expect(noCount.status).toBe(422);
  const unexplained = await call(
    'rahim',
    'POST',
    `/api/v1/counter/sessions/${ids['session']}/close`,
    {
      closingCash: '1150',
    },
  );
  expect(unexplained.status).toBe(422);
  expect(unexplained.json.detail).toContain('why');
  const closed = await call('rahim', 'POST', `/api/v1/counter/sessions/${ids['session']}/close`, {
    closingCash: '1150',
    differenceReason: 'A 50 note given as change by mistake',
  });
  expect(closed.status, JSON.stringify(closed.json)).toBe(200);
  expect(closed.json.session.state).toBe('closed');
  expect(Number(closed.json.session.closingDifference)).toBe(-50);
  expect(
    (await call('rahim', 'GET', `/api/v1/counter/session?shop=${ids['shop']}`)).json.session,
  ).toBeNull();
  // A receipt for the sale, through the record's templates.
  const templates = await call('rahim', 'GET', '/api/v1/models/pos.order/documents');
  expect(templates.status, JSON.stringify(templates.json)).toBe(200);
  const receiptTemplate = (templates.json.templates as { id: number; name: string }[]).find(
    (tpl) => tpl.name === 'Receipt',
  );
  expect(receiptTemplate).toBeDefined();
  const order = (await call('rahim', 'GET', '/api/v1/models/pos.order?fields=name')).json.items[0];
  const receipt = await host.server.app.inject({
    method: 'POST',
    url: `/api/v1/models/pos.order/documents/${receiptTemplate?.id}?format=html`,
    headers: { authorization: `Bearer ${tokens.get('rahim')}` },
    payload: { ids: [order.id] },
  });
  expect(receipt.statusCode, receipt.body.slice(0, 200)).toBe(200);
  expect(receipt.body).toContain('Tea 500 g');
});

test('step 2: a closed session books one posted entry; the receipt goes by email and by text', async () => {
  // The chart, the shop's sales journal and the methods' journals.
  const me = await call('maria', 'GET', '/api/v1/auth/me');
  const installed = await call('maria', 'POST', '/api/v1/accounting/charts/install', {
    template: 'generic',
  });
  expect(installed.status, `${JSON.stringify(installed.json)} as ${JSON.stringify(me.json)}`).toBe(
    200,
  );
  const journals = (await call('maria', 'GET', '/api/v1/models/account.journal?fields=code')).json
    .items as { id: number; code: string }[];
  const journal = (code: string) => journals.find((j) => j.code === code)?.id;
  expect(journal('INV')).toBeTruthy();
  expect(
    (
      await call('maria', 'PATCH', `/api/v1/models/pos.shop/${ids['shop']}`, {
        salesJournal: journal('INV'),
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await call('maria', 'PATCH', `/api/v1/models/pos.payment.method/${ids['cash']}`, {
        journal: journal('CSH'),
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await call('maria', 'PATCH', `/api/v1/models/pos.payment.method/${ids['card']}`, {
        journal: journal('BNK'),
      })
    ).status,
  ).toBe(200);
  // Another cashier's session: a sale half by card, half in cash, then closed on the count.
  const opened = await call('sam', 'POST', '/api/v1/counter/sessions', {
    shop: ids['shop'],
    openingCash: '100',
  });
  expect(opened.status, JSON.stringify(opened.json)).toBe(201);
  const session = opened.json.session.id;
  const sale = await call('sam', 'POST', '/api/v1/counter/orders', {
    session,
    lines: [{ product: ids['tea'], quantity: '2' }],
    payments: [
      { method: ids['card'], amount: '300' },
      { method: ids['cash'], amount: '200' },
    ],
  });
  expect(sale.status, JSON.stringify(sale.json)).toBe(201);
  const closed = await call('sam', 'POST', `/api/v1/counter/sessions/${session}/close`, {
    closingCash: '300',
  });
  expect(closed.status, JSON.stringify(closed.json)).toBe(200);
  const read = await call('maria', 'GET', `/api/v1/models/pos.session/${session}?fields=entry`);
  const entryId = read.json.entry?.id ?? read.json.entry;
  expect(entryId).toBeTruthy();
  const entry = await call(
    'maria',
    'GET',
    `/api/v1/models/account.move/${entryId}?fields=state,kind,ref`,
  );
  expect(entry.json).toMatchObject({ state: 'posted', kind: 'entry' });
  const lines = (
    await call(
      'maria',
      'GET',
      `/api/v1/models/account.move.line?filter=${encodeURIComponent(JSON.stringify({ move: entryId }))}&fields=debit,credit,name`,
    )
  ).json.items as { debit: unknown; credit: unknown; name: string }[];
  const amount = (v: unknown) => Number((v as { amount?: unknown })?.amount ?? v);
  const debit = lines.reduce((sum, l) => sum + amount(l.debit), 0);
  const credit = lines.reduce((sum, l) => sum + amount(l.credit), 0);
  expect(debit).toBeCloseTo(500, 2);
  expect(debit).toBeCloseTo(credit, 2);
  // The receipt by email (the document) and by text (a summary).
  const sent = await call('sam', 'POST', `/api/v1/counter/orders/${sale.json.order.id}/receipt`, {
    email: 'buyer@example.test',
    phone: '+8801711000000',
  });
  expect(sent.status, JSON.stringify(sent.json)).toBe(200);
  expect(sent.json.sent).toEqual(['email', 'sms']);
  expect(mailer.sent).toHaveLength(1);
  expect(mailer.sent[0]?.subject).toMatch(/^Receipt R/);
  expect(mailer.sent[0]?.html).toContain('Tea 500 g');
  expect(messenger.sent).toHaveLength(1);
  expect(messenger.sent[0]?.text).toContain('Total 500');
});

test('step 3: a refund with its reason is a negative sale paid back, linked; only the own open session or a manager; the entry nets it', async () => {
  // Sam's new session: a sale of two teas, one brought back.
  const opened = await call('sam', 'POST', '/api/v1/counter/sessions', {
    shop: ids['shop'],
    openingCash: '0',
  });
  expect(opened.status, JSON.stringify(opened.json)).toBe(201);
  const session = opened.json.session.id;
  const sale = await call('sam', 'POST', '/api/v1/counter/orders', {
    session,
    lines: [{ product: ids['tea'], quantity: '2' }],
    payments: [{ method: ids['cash'], amount: '500' }],
  });
  expect(sale.status, JSON.stringify(sale.json)).toBe(201);
  const noReason = await call(
    'sam',
    'POST',
    `/api/v1/counter/orders/${sale.json.order.id}/refund`,
    {
      session,
      lines: [{ product: ids['tea'], quantity: '1' }],
    },
  );
  expect(noReason.status).toBe(422);
  const tooMany = await call('sam', 'POST', `/api/v1/counter/orders/${sale.json.order.id}/refund`, {
    session,
    reason: 'Broken seal',
    lines: [{ product: ids['tea'], quantity: '3' }],
  });
  expect(tooMany.status).toBe(422);
  const refund = await call('sam', 'POST', `/api/v1/counter/orders/${sale.json.order.id}/refund`, {
    session,
    reason: 'Broken seal',
    lines: [{ product: ids['tea'], quantity: '1' }],
  });
  expect(refund.status, JSON.stringify(refund.json)).toBe(201);
  expect(refund.json.order).toMatchObject({ state: 'paid' });
  expect(Number(refund.json.order.total)).toBe(-250);
  expect(Number(refund.json.order.change)).toBe(0);
  const linked = await call(
    'sam',
    'GET',
    `/api/v1/models/pos.order/${refund.json.order.id}?fields=refundOf,refundReason`,
  );
  expect(linked.json.refundOf?.id ?? linked.json.refundOf).toBe(sale.json.order.id);
  expect(linked.json.refundReason).toBe('Broken seal');
  // A sale of Sam's earlier, closed session: not this session's, and Sam is no manager.
  const earlier = (
    await call(
      'sam',
      'GET',
      `/api/v1/models/pos.order?filter=${encodeURIComponent(JSON.stringify({ state: 'paid', 'session.state': 'closed' }))}&fields=name`,
    )
  ).json.items as { id: number }[];
  expect(earlier.length).toBeGreaterThan(0);
  const other = earlier[0] as { id: number };
  const forbidden = await call('sam', 'POST', `/api/v1/counter/orders/${other.id}/refund`, {
    session,
    reason: 'Changed mind',
  });
  expect(forbidden.status, JSON.stringify(forbidden.json)).toBe(403);
  // Maria, a manager, refunds it in full into her own open session.
  const hers = await call('maria', 'POST', '/api/v1/counter/sessions', {
    shop: ids['shop'],
    openingCash: '1000',
  });
  expect(hers.status, JSON.stringify(hers.json)).toBe(201);
  const managerRefund = await call('maria', 'POST', `/api/v1/counter/orders/${other.id}/refund`, {
    session: hers.json.session.id,
    reason: 'Changed mind',
  });
  expect(managerRefund.status, JSON.stringify(managerRefund.json)).toBe(201);
  expect(Number(managerRefund.json.order.total)).toBeLessThan(0);
  // Sam's session expects 250 in the drawer (500 taken, 250 given back) and books the net.
  const read = await call(
    'maria',
    'GET',
    `/api/v1/models/pos.session/${session}?fields=expectedCash`,
  );
  expect(Number(read.json.expectedCash)).toBe(250);
  const closed = await call('sam', 'POST', `/api/v1/counter/sessions/${session}/close`, {
    closingCash: '250',
  });
  expect(closed.status, JSON.stringify(closed.json)).toBe(200);
  const booked = await call('maria', 'GET', `/api/v1/models/pos.session/${session}?fields=entry`);
  const entryId = booked.json.entry?.id ?? booked.json.entry;
  expect(entryId).toBeTruthy();
  const lines = (
    await call(
      'maria',
      'GET',
      `/api/v1/models/account.move.line?filter=${encodeURIComponent(JSON.stringify({ move: entryId }))}&fields=debit,credit`,
    )
  ).json.items as { debit: unknown; credit: unknown }[];
  const amount = (v: unknown) => Number((v as { amount?: unknown })?.amount ?? v);
  expect(lines.reduce((sum, l) => sum + amount(l.debit), 0)).toBeCloseTo(250, 2);
  expect(lines.reduce((sum, l) => sum + amount(l.credit), 0)).toBeCloseTo(250, 2);
});
