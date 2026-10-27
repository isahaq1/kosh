/**
 * RFC 0014 step 3 on real PostgreSQL: a file above the inline limit runs as a background job (202, progress, the
 * outcome on the session, an `import.finished` event for its user, no second run while it runs); saved mappings
 * (own, shared, applied to a file with the same headers) and module templates (applied, downloadable as a workbook
 * that describes its columns).
 */
import { defineModule as defineKoshModule } from '@kosh/modules-sdk';
import { base, baseShutro, createServer, installBase, type KoshServer, totp } from '@kosh/server';
import { orm } from '@kosh/server/orm';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createImport, importWorker, readXlsx } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const { defineGroup, defineModel, defineModule, f } = orm;

const Customer = defineModel('shop.customer', {
  label: 'Customer',
  companyScoped: { required: true },
  access: { 'shop.user': ['read', 'write', 'create', 'import'] },
  fields: { name: f.char({ required: true }), code: f.char() },
  sqlConstraints: {
    codeUnique: { unique: ['company', 'code'], message: 'Customer codes are unique.' },
  },
});
const Order = defineModel('shop.order', {
  label: 'Order',
  companyScoped: { required: true },
  access: { 'shop.user': ['read', 'write', 'create', 'import'] },
  fields: {
    name: f.char({ required: true }),
    customer: f.many2one('shop.customer', { required: true }),
    amount: f.decimal({ scale: 2, default: '0' }),
    ordered: f.date({ label: 'Order date' }),
    state: f.selection({ draft: 'Draft', sent: 'Sent' }, { default: 'draft' }),
  },
  sqlConstraints: {
    amountPositive: { check: orm.sql`amount >= 0`, message: 'An amount is never negative.' },
  },
});
const shop = defineKoshModule({
  shutro: defineModule({
    name: 'shop',
    version: '1.0.0',
    depends: [baseShutro],
    groups: [defineGroup({ code: 'shop.user', label: 'Shop', implies: ['base.user'] })],
    models: [Customer, Order],
  }),
  kosh: '^0.1.0',
  depends: [base],
  accessLevels: { user: { label: 'User', groups: ['shop.user'] } },
  importTemplates: [
    {
      key: 'orders',
      model: 'shop.order',
      label: 'Orders from the old system',
      columns: [
        { header: 'Reference', field: 'name' },
        { header: 'Client', field: 'customer' },
        { header: 'Booked', field: 'ordered' },
      ],
      options: { dateOrder: 'mdy' },
    },
  ],
});

let container: StartedPostgreSqlContainer;
let server: KoshServer;
const tokens = new Map<string, string>();

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function call(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  as: string,
  payload?: unknown,
) {
  const res = await server.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${await tokenOf(as)}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return {
    status: res.statusCode,
    json: (res.body === '' || !res.headers['content-type']?.toString().includes('json')
      ? null
      : res.json()) as Json,
    raw: res.rawPayload,
    headers: res.headers,
  };
}
async function tokenOf(login: string): Promise<string> {
  const cached = tokens.get(login);
  if (cached !== undefined) return cached;
  const res = await server.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { login, password: PASSWORD },
  });
  const token = (res.json() as { token: string }).token;
  if (login === 'admin') {
    const headers = { authorization: `Bearer ${token}` };
    const setup = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/2fa/setup',
      headers,
      payload: {},
    });
    const { secret } = setup.json() as { secret: string };
    await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/2fa/enable',
      headers,
      payload: { code: totp(secret) },
    });
  }
  tokens.set(login, token);
  return token;
}
async function upload(as: string, csv: string, name = 'orders.csv') {
  const res = await server.app.inject({
    method: 'POST',
    url: '/api/v1/imports?model=shop.order',
    headers: {
      authorization: `Bearer ${await tokenOf(as)}`,
      'content-type': 'text/csv',
      'x-filename': encodeURIComponent(name),
    },
    payload: Buffer.from(csv, 'utf8'),
  });
  return res.json() as Json;
}
const worker = () =>
  importWorker({ shutro: server.shutro, driver: server.driver, registry: server.registry });
async function count(where = 'true'): Promise<number> {
  const [row] = await server.driver.query<{ n: number }>({
    text: `SELECT count(*)::int AS n FROM shop_order WHERE ${where}`,
    params: [],
  });
  return row?.n ?? 0;
}

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  container = await new PostgreSqlContainer('postgres:18').start();
  server = await createServer({
    databaseUrl: container.getConnectionUri(),
    modules: [shop, createImport({ inlineRows: 5, worker: false })],
    auth: { secureCookies: false, cacheMs: 0, loginLimit: 0 },
    rateLimit: { max: 0, timeWindow: '1 minute' },
    logger: false,
  });
  for (const statement of orm.createTableStatements(server.registry.registry))
    await server.driver.query(statement);
  const auth = server.auth;
  if (auth === undefined) throw new Error('base is installed');
  const { company } = await installBase(server.shutro, auth, {
    company: { name: 'Padma Traders', currency: 'BDT' },
    admin: { login: 'admin', name: 'Administrator', password: PASSWORD },
  });
  for (const login of ['ana', 'mgr'])
    await auth.createUser({
      login,
      name: login,
      password: PASSWORD,
      company,
      companies: [company],
      groups: ['import.user', 'shop.user'],
    });
  await server.shutro.bootstrap({ reason: 'test', company }, (env) =>
    (
      env.model('shop.customer' as never) as unknown as { create(r: unknown[]): Promise<unknown> }
    ).create([
      { name: 'Acme Trading', code: 'C-001', company },
      { name: 'Globex Dhaka', code: 'C-002', company },
    ]),
  );
}, 180_000);

afterAll(async () => {
  await server?.close();
  await container?.stop();
});

const rows = (n: number, from: number, amount = (i: number) => String(i)) =>
  [
    'Name,Customer,Amount',
    ...Array.from({ length: n }, (_, i) => `BG-${from + i},C-001,${amount(i)}`),
  ].join('\n');

test('a large file runs in the background: 202, progress, the outcome on the session, a finished event', async () => {
  const session = await upload('ana', rows(12, 1));
  expect(session.background).toBe(true);
  const dry = await call('POST', `/api/v1/imports/${session.id}/dry-run`, 'ana');
  expect(dry.status).toBe(202);
  expect(dry.json.state).toBe('running');
  expect(dry.json.progress).toEqual({ done: 0, total: 12 });
  // Nothing else runs on it meanwhile.
  expect((await call('POST', `/api/v1/imports/${session.id}/commit`, 'ana')).status).toBe(409);
  expect(
    (await call('PUT', `/api/v1/imports/${session.id}/mapping`, 'ana', { columns: [] })).status,
  ).toBe(409);
  expect(await worker().drain()).toBe(1);
  const checked = (await call('GET', `/api/v1/imports/${session.id}`, 'ana')).json;
  expect(checked.state).toBe('draft');
  expect(checked.resultDry).toBe(true);
  expect(checked.result).toMatchObject({ wouldCreate: 12, errors: [] });
  expect(checked.progress).toBeNull();
  expect(await count("name LIKE 'BG-%'")).toBe(0);

  const commit = await call('POST', `/api/v1/imports/${session.id}/commit`, 'ana');
  expect(commit.status).toBe(202);
  await worker().drain();
  const done = (await call('GET', `/api/v1/imports/${session.id}`, 'ana')).json;
  expect(done.state).toBe('done');
  expect(done.result.created).toHaveLength(12);
  expect(done.undoUntil).not.toBeNull();
  expect(await count("name LIKE 'BG-%'")).toBe(12);
  const [progress] = await server.driver.query<{ done: number; total: number }>({
    text: 'SELECT done, total FROM import_progress WHERE session_id = $1',
    params: [session.id],
  });
  expect(progress).toEqual({ done: 12, total: 12 });
  const events = await server.driver.query<{ payload: Json }>({
    text: `SELECT payload FROM shutro_outbox WHERE topic = 'import.finished' ORDER BY id`,
    params: [],
  });
  expect(events.map((e) => e.payload)).toEqual([
    {
      model: 'import.session',
      id: session.id,
      dry: true,
      file: 'orders.csv',
      created: 12,
      updated: 0,
      errors: 0,
    },
    {
      model: 'import.session',
      id: session.id,
      dry: false,
      file: 'orders.csv',
      created: 12,
      updated: 0,
      errors: 0,
    },
  ]);
});

test('a background import with errors keeps nothing, and says so on the session', async () => {
  const session = await upload(
    'ana',
    rows(8, 100, (i) => (i === 6 ? '-1' : '1')),
  );
  expect((await call('POST', `/api/v1/imports/${session.id}/commit`, 'ana')).status).toBe(202);
  await worker().drain();
  const after = (await call('GET', `/api/v1/imports/${session.id}`, 'ana')).json;
  expect(after.state).toBe('draft');
  expect(after.resultDry).toBe(false);
  expect(after.result.errors).toHaveLength(1);
  expect(after.result.errors[0].row).toBe(8);
  expect(await count("name LIKE 'BG-1__'")).toBe(0);
});

test('module templates apply to files with their headers and download as a workbook that explains them', async () => {
  const session = await upload('ana', 'Reference,Client,Booked\nT-1,C-002,04/05/2026');
  expect(session.applied).toEqual({ id: 'shop.orders', name: 'Orders from the old system' });
  expect(session.columns.map((c: Json) => c.field)).toEqual(['name', 'customer', 'ordered']);
  expect(session.options).toEqual({ dateOrder: 'mdy' });
  expect((await call('POST', `/api/v1/imports/${session.id}/commit`, 'ana')).status).toBe(201);
  const [order] = await server.driver.query<{ ordered: string }>({
    text: `SELECT ordered::text AS ordered FROM shop_order WHERE name = 'T-1'`,
    params: [],
  });
  expect(order?.ordered).toBe('2026-04-05');

  const template = await call(
    'GET',
    '/api/v1/import-templates/shop.order?mapping=shop.orders',
    'ana',
  );
  expect(template.status).toBe(200);
  expect(template.headers['content-type']).toBe(
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  const file = new Uint8Array(template.raw);
  expect(readXlsx(file).rows).toEqual([['Reference', 'Client', 'Booked']]);
  expect(readXlsx(file, 'Columns').rows).toEqual([
    ['Column', 'Field', 'Required', 'What to write'],
    ['Reference', 'name', 'Yes', 'Text'],
    ['Client', 'customer', 'Yes', 'The name, code or external id of a record (shop.customer)'],
    ['Booked', 'ordered', null, 'A date: DD/MM/YYYY or YYYY-MM-DD'],
  ]);
  // Without a mapping: every field of the record, required ones first.
  const all = await call('GET', '/api/v1/import-templates/shop.order', 'ana');
  const [headers] = readXlsx(new Uint8Array(all.raw)).rows;
  expect(headers?.slice(0, 2)).toEqual(['Name', 'Customer']);
  expect(headers).toContain('State');
  expect(readXlsx(new Uint8Array(all.raw), 'Columns').rows.find((r) => r[0] === 'State')?.[3]).toBe(
    'One of: Draft, Sent',
  );
});

test('saved mappings: by header, own or shared, applied on upload; only their owner deletes them', async () => {
  const first = await upload('ana', 'Ref,Who,Total\nM-1,C-001,5');
  expect(first.applied).toBeNull();
  await call('PUT', `/api/v1/imports/${first.id}/mapping`, 'ana', {
    columns: [
      { index: 0, field: 'name' },
      { index: 1, field: 'customer' },
      { index: 2, field: 'amount' },
    ],
    options: { decimal: ',' },
  });
  const mine = await call('POST', `/api/v1/imports/${first.id}/save-mapping`, 'ana', {
    name: 'Branch orders',
  });
  expect(mine.status).toBe(201);
  const shared = await call('POST', `/api/v1/imports/${first.id}/save-mapping`, 'ana', {
    name: 'Branch orders (team)',
    shared: true,
  });
  // The columns in another order, and one more: the saved mapping still fits, by header.
  const second = await upload('ana', 'Total,Note,Who,Ref\n"7,5",x,C-002,M-2');
  expect(second.applied?.name).toMatch(/^Branch orders/);
  expect(second.columns.map((c: Json) => c.field)).toEqual(['amount', null, 'customer', 'name']);
  expect(second.options).toEqual({ decimal: ',' });
  expect((await call('POST', `/api/v1/imports/${second.id}/commit`, 'ana')).status).toBe(201);
  const [order] = await server.driver.query<{ amount: string }>({
    text: `SELECT amount::text AS amount FROM shop_order WHERE name = 'M-2'`,
    params: [],
  });
  expect(order?.amount).toBe('7.50');

  const listed = async (as: string) =>
    (await call('GET', '/api/v1/import-mappings?model=shop.order', as)).json.mappings.map(
      (m: Json) => [m.name, m.template, m.own],
    );
  expect(await listed('ana')).toEqual([
    ['Orders from the old system', true, false],
    ['Branch orders', false, true],
    ['Branch orders (team)', false, true],
  ]);
  expect(await listed('mgr')).toEqual([
    ['Orders from the old system', true, false],
    ['Branch orders (team)', false, false],
  ]);
  // Another user applies the shared one, but cannot delete it; its owner can.
  const theirs = await upload('mgr', 'Ref,Who,Total\nM-3,C-001,1');
  const applied = await call('POST', `/api/v1/imports/${theirs.id}/apply-mapping`, 'mgr', {
    mapping: shared.json.id,
  });
  expect(applied.json.columns.map((c: Json) => c.field)).toEqual(['name', 'customer', 'amount']);
  expect((await call('DELETE', `/api/v1/import-mappings/${shared.json.id}`, 'mgr')).status).toBe(
    403,
  );
  expect((await call('DELETE', `/api/v1/import-mappings/${mine.json.id}`, 'mgr')).status).toBe(404);
  expect((await call('DELETE', `/api/v1/import-mappings/${shared.json.id}`, 'ana')).status).toBe(
    204,
  );
});
