/**
 * The import API on real PostgreSQL (RFC 0014 step 1): only import users with the `import` and `create` permissions
 * reach it; a CSV or XLSX upload comes back with its guessed mapping; a dry run reports every error on its row and
 * column and keeps nothing; relations match by external id, unique code and name, never guessing between several;
 * field security and SQL constraints apply; a commit is all-or-nothing, audited, idempotent and final; sessions are
 * their uploader's own.
 */
import { defineModule as defineKoshModule } from '@kosh/modules-sdk';
import { workbook } from '@kosh/reporting';
import { base, baseShutro, createServer, installBase, type KoshServer, totp } from '@kosh/server';
import { orm } from '@kosh/server/orm';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createImport } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const { defineGroup, defineModel, defineModule, f } = orm;

const Customer = defineModel('shop.customer', {
  label: 'Customer',
  companyScoped: { required: true },
  access: { 'shop.user': ['read', 'write', 'create', 'import'] },
  fields: {
    name: f.char({ required: true }),
    code: f.char(),
  },
  sqlConstraints: {
    codeUnique: { unique: ['company', 'code'], message: 'Customer codes are unique.' },
  },
});
const Tag = defineModel('shop.tag', {
  label: 'Tag',
  access: { 'shop.user': ['read'] },
  fields: { name: f.char({ required: true }) },
});
const Order = defineModel('shop.order', {
  label: 'Order',
  companyScoped: { required: true },
  access: {
    'shop.user': ['read', 'write', 'create', 'import'],
    'shop.manager': ['read', 'write', 'create', 'import', 'unlink'],
    'shop.reader': ['read', 'import'],
  },
  fields: {
    name: f.char({ required: true }),
    customer: f.many2one('shop.customer', { required: true }),
    amount: f.decimal({ scale: 2, default: '0' }),
    ordered: f.date({ label: 'Order date' }),
    urgent: f.boolean({ default: false }),
    state: f.selection({ draft: 'Draft', sent: 'Sent' }, { default: 'draft' }),
    tags: f.many2many('shop.tag'),
    /** Field security: managers only. */
    margin: f.decimal({ scale: 2, groups: ['shop.manager'] }),
    lines: f.one2many('shop.order.line', 'order'),
  },
  sqlConstraints: {
    nameUnique: { unique: ['company', 'name'], message: 'Order references are unique.' },
    amountPositive: { check: orm.sql`amount >= 0`, message: 'An amount is never negative.' },
  },
});
const OrderLine = defineModel('shop.order.line', {
  label: 'Order line',
  access: { 'shop.user': ['read', 'write', 'create', 'unlink'] },
  fields: {
    order: f.many2one('shop.order', { required: true, ondelete: 'cascade' }),
    product: f.char({ required: true }),
    qty: f.integer({ default: 1, label: 'Quantity' }),
    price: f.decimal({ scale: 2, default: '0' }),
  },
});
const shop = defineKoshModule({
  shutro: defineModule({
    name: 'shop',
    version: '1.0.0',
    depends: [baseShutro],
    groups: [
      defineGroup({ code: 'shop.reader', label: 'Shop reader', implies: ['base.user'] }),
      defineGroup({ code: 'shop.user', label: 'Shop', implies: ['base.user'] }),
      defineGroup({ code: 'shop.manager', label: 'Shop manager', implies: ['shop.user'] }),
    ],
    models: [Customer, Tag, Order, OrderLine],
  }),
  kosh: '^0.1.0',
  depends: [base],
  accessLevels: { user: { label: 'User', groups: ['shop.user'] } },
});

let container: StartedPostgreSqlContainer;
let server: KoshServer;
const tokens = new Map<string, string>();

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function call(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  url: string,
  as?: string,
  payload?: unknown,
  headers: Record<string, string> = {},
) {
  const token = as === undefined ? undefined : await tokenOf(as);
  const res = await server.app.inject({
    method,
    url,
    headers: { ...(token === undefined ? {} : { authorization: `Bearer ${token}` }), ...headers },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: res.statusCode, json: (res.body === '' ? null : res.json()) as Json };
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
async function upload(as: string, model: string, file: Uint8Array | string, name = 'orders.csv') {
  const token = await tokenOf(as);
  const res = await server.app.inject({
    method: 'POST',
    url: `/api/v1/imports?model=${model}`,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': name.endsWith('.xlsx')
        ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        : 'text/csv',
      'x-filename': encodeURIComponent(name),
    },
    payload: typeof file === 'string' ? Buffer.from(file, 'utf8') : Buffer.from(file),
  });
  return { status: res.statusCode, json: (res.body === '' ? null : res.json()) as Json };
}
async function count(table: string): Promise<number> {
  const [row] = await server.driver.query<{ n: number }>({
    text: `SELECT count(*)::int AS n FROM ${table}`,
    params: [],
  });
  return row?.n ?? 0;
}

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  container = await new PostgreSqlContainer('postgres:18').start();
  server = await createServer({
    databaseUrl: container.getConnectionUri(),
    modules: [shop, createImport({ maxRows: 50 })],
    auth: { secureCookies: false, cacheMs: 0, loginLimit: 0 },
    rateLimit: { max: 0, timeWindow: '1 minute' },
    logger: false,
  });
  for (const statement of orm.createTableStatements(server.registry.registry))
    await server.driver.query(statement);
  for (const statement of orm.externalIdTableStatements()) await server.driver.query(statement);
  const auth = server.auth;
  if (auth === undefined) throw new Error('base is installed');
  const { company } = await installBase(server.shutro, auth, {
    company: { name: 'Padma Traders', currency: 'BDT' },
    admin: { login: 'admin', name: 'Administrator', password: PASSWORD },
  });
  for (const [login, groups] of [
    ['ana', ['import.user', 'shop.user']],
    ['mgr', ['import.user', 'shop.manager']],
    ['bob', ['shop.user']],
    ['rita', ['import.user', 'shop.reader']],
  ] as const)
    await auth.createUser({
      login,
      name: login,
      password: PASSWORD,
      company,
      companies: [company],
      groups: [...groups],
    });
  await server.shutro.bootstrap({ reason: 'test', company }, async (env) => {
    const create = (model: string, rows: unknown[]) =>
      (
        env.model(model as never) as unknown as {
          create(r: unknown[]): Promise<{ ids: readonly number[] }>;
        }
      ).create(rows);
    const customers = await create('shop.customer', [
      { name: 'Acme Trading', code: 'C-001', company },
      { name: 'Globex Dhaka', code: 'C-002', company },
      { name: 'Globex Chattogram', code: 'C-003', company },
    ]);
    await create('shop.tag', [{ name: 'Wholesale' }, { name: 'Export' }]);
    await env.flush();
    await env.sql`INSERT INTO shutro_external_id (module, name, model, res_id) VALUES ('legacy', 'cust_9', 'shop.customer', ${customers.ids[2] ?? 0})`;
  });
}, 180_000);

afterAll(async () => {
  await server?.close();
  await container?.stop();
});

const GOOD = [
  'Name,Customer,Amount,Order date,Urgent,State,Tags',
  'SO-1,Acme Trading,"1,250.50",03/04/2026,yes,Sent,"Wholesale, Export"',
  'SO-2,C-002,99,2026-04-05,no,draft,',
  'SO-3,legacy.cust_9,০,৫/৪/২০২৬,,,Export',
].join('\n');

test('only import users with the import and create permissions on the model reach it', async () => {
  expect((await upload('bob', 'shop.order', GOOD)).status).toBe(403); // no Import data level
  expect((await upload('rita', 'shop.order', GOOD)).status).toBe(403); // import, but no create
  expect((await upload('ana', 'shop.nothing', GOOD)).status).toBe(404);
  const anonymous = await server.app.inject({
    method: 'POST',
    url: '/api/v1/imports?model=shop.order',
    headers: { 'content-type': 'text/csv' },
    payload: GOOD,
  });
  expect(anonymous.statusCode).toBe(401);
  expect(await count('import_session')).toBe(0);
});

test('an upload: headers, sample rows, the guessed mapping and the fields the user may import', async () => {
  const { status, json } = await upload('ana', 'shop.order', GOOD);
  expect(status).toBe(201);
  expect(json.fileType).toBe('csv');
  expect(json.rowCount).toBe(3);
  expect(json.headers).toEqual([
    'Name',
    'Customer',
    'Amount',
    'Order date',
    'Urgent',
    'State',
    'Tags',
  ]);
  expect(json.sample[0]).toEqual([
    'SO-1',
    'Acme Trading',
    '1,250.50',
    '03/04/2026',
    'yes',
    'Sent',
    'Wholesale, Export',
  ]);
  expect(json.columns.map((c: Json) => c.field)).toEqual([
    'name',
    'customer',
    'amount',
    'ordered',
    'urgent',
    'state',
    'tags',
  ]);
  const keys = json.fields.map((f: Json) => f.key);
  expect(keys).toContain('customer');
  expect(keys).not.toContain('margin'); // field security: managers only
  expect(json.fields.find((f: Json) => f.key === 'customer')).toMatchObject({
    required: true,
    target: 'shop.customer',
  });
  // A field the user may not write cannot be mapped.
  const margin = await call('PUT', `/api/v1/imports/${json.id}/mapping`, 'ana', {
    columns: [{ index: 0, field: 'margin' }],
  });
  expect(margin.status).toBe(422);
  // Another user's session does not exist for them.
  expect((await call('GET', `/api/v1/imports/${json.id}`, 'mgr')).status).toBe(404);
});

test('a dry run reports every error on its row and column and keeps nothing', async () => {
  const bad = [
    'Name,Customer,Amount,Order date,State',
    'SO-10,Acme Trading,12abc,03/04/2026,Sent', // not a number
    'SO-11,Globex,5,31/02/2026,Draft', // ambiguous customer, impossible date
    'SO-12,Nobody Ltd,5,,Cancelled', // unknown customer, not an option
    ',Acme Trading,-5,,', // no name (required), negative amount (SQL check)
    'SO-14,C-001,-1,,', // negative amount: refused by the database constraint
    'SO-15,acme trading,7,,', // fine: matched by name, ignoring case
  ].join('\n');
  const session = (await upload('ana', 'shop.order', bad)).json;
  const before = await count('shop_order');
  const { status, json } = await call('POST', `/api/v1/imports/${session.id}/dry-run`, 'ana');
  expect(status).toBe(200);
  expect(json.rows).toBe(6);
  expect(json.created).toEqual([]);
  expect(json.wouldCreate).toBe(1);
  const errors = json.errors.map((e: Json) => [e.row, e.column, e.code]);
  expect(errors).toEqual([
    [2, 2, 'not-a-number'],
    [3, 1, 'ambiguous'],
    [3, 3, 'not-a-date'],
    [4, 1, 'not-found'],
    [4, 4, 'not-an-option'],
    [5, 0, 'rejected'], // the name is required (Shutro names the field)
    [6, null, 'rejected'],
  ]);
  expect(json.errors[1].message).toBe(
    'Customer: "Globex" matches several records; use its code or external id.',
  );
  expect(json.errors[6].message).toContain('An amount is never negative.');
  expect(json.matches.customer['acme trading']).toEqual({ id: expect.any(Number), by: 'name' });
  expect(await count('shop_order')).toBe(before);
  // A commit with errors keeps nothing either, and the session stays a draft.
  const commit = await call('POST', `/api/v1/imports/${session.id}/commit`, 'ana');
  expect(commit.status).toBe(422);
  expect(commit.json.errors).toHaveLength(7);
  expect(await count('shop_order')).toBe(before);
  expect((await call('GET', `/api/v1/imports/${session.id}`, 'ana')).json.state).toBe('draft');
});

test('a required field without a column is said once', async () => {
  const session = (await upload('ana', 'shop.order', 'Name,Amount\nSO-20,5\nSO-21,6')).json;
  const { json } = await call('POST', `/api/v1/imports/${session.id}/dry-run`, 'ana');
  expect(json.errors).toEqual([
    {
      row: 1,
      column: null,
      field: 'customer',
      code: 'missing-required',
      message: 'Customer is required: map a column to it.',
    },
  ]);
});

test('a commit: every row or none, relations by name, code and external id, audited, idempotent, final', async () => {
  const session = (await upload('ana', 'shop.order', GOOD)).json;
  const dry = await call('POST', `/api/v1/imports/${session.id}/dry-run`, 'ana');
  expect(dry.json.errors).toEqual([]);
  expect(dry.json.wouldCreate).toBe(3);
  expect(dry.json.matches.customer).toEqual({
    'Acme Trading': { id: expect.any(Number), by: 'name' },
    'C-002': { id: expect.any(Number), by: 'key' },
    'legacy.cust_9': { id: expect.any(Number), by: 'external-id' },
  });
  const key = { 'idempotency-key': `import-${session.id}` };
  const commit = await call('POST', `/api/v1/imports/${session.id}/commit`, 'ana', {}, key);
  expect(commit.status).toBe(201);
  expect(commit.json.created).toHaveLength(3);
  const rows = await server.driver.query<Record<string, unknown>>({
    text: `SELECT o.name, c.code, o.amount::text AS amount, o.ordered::text AS ordered, o.urgent, o.state,
             (SELECT count(*)::int FROM shop_order_shop_tag_rel r WHERE r.shop_order_id = o.id) AS tags
           FROM shop_order o JOIN shop_customer c ON c.id = o.customer_id WHERE o.id = ANY($1) ORDER BY o.name`,
    params: [commit.json.created],
  });
  expect(rows).toEqual([
    {
      name: 'SO-1',
      code: 'C-001',
      amount: '1250.50',
      ordered: '2026-04-03',
      urgent: true,
      state: 'sent',
      tags: 2,
    },
    {
      name: 'SO-2',
      code: 'C-002',
      amount: '99.00',
      ordered: '2026-04-05',
      urgent: false,
      state: 'draft',
      tags: 0,
    },
    {
      name: 'SO-3',
      code: 'C-003',
      amount: '0.00',
      ordered: '2026-04-05',
      urgent: false,
      state: 'draft',
      tags: 1,
    },
  ]);
  // The same request again replays; a new one finds the file imported.
  const replay = await call('POST', `/api/v1/imports/${session.id}/commit`, 'ana', {}, key);
  expect(replay.status).toBe(201);
  expect(replay.json.created).toEqual(commit.json.created);
  expect((await call('POST', `/api/v1/imports/${session.id}/commit`, 'ana')).status).toBe(409);
  const [event] = await server.driver.query<{ summary: string }>({
    text: `SELECT summary FROM audit_event WHERE kind = 'data.import' ORDER BY id DESC LIMIT 1`,
    params: [],
  });
  expect(event?.summary).toBe(
    'Imported orders.csv into shop.order: 3 created, 0 updated, 0 left out.',
  );
});

test('XLSX: typed cells, a remapped column and options; the row limit', async () => {
  const file = workbook([
    {
      name: 'Orders',
      rows: [
        ['Reference', 'Client', 'Total', 'Date'],
        ['SO-30', 'C-001', { decimal: '1500.75' }, new Date(Date.UTC(2026, 5, 1))],
        ['SO-31', 'Acme Trading', 20, '06/02/2026'],
      ],
    },
  ]);
  const session = (await upload('ana', 'shop.order', file, 'orders.xlsx')).json;
  expect(session.fileType).toBe('xlsx');
  expect(session.sheets).toEqual(['Orders']);
  expect(session.columns.map((c: Json) => c.field)).toEqual([null, null, null, null]);
  const mapped = await call('PUT', `/api/v1/imports/${session.id}/mapping`, 'ana', {
    columns: [
      { index: 0, field: 'name' },
      { index: 1, field: 'customer' },
      { index: 2, field: 'amount' },
      { index: 3, field: 'ordered' },
    ],
    options: { dateOrder: 'mdy' },
  });
  expect(mapped.status).toBe(200);
  expect(mapped.json.options).toEqual({ dateOrder: 'mdy' });
  const commit = await call('POST', `/api/v1/imports/${session.id}/commit`, 'ana');
  expect(commit.json.errors ?? []).toEqual([]);
  expect(commit.status).toBe(201);
  const rows = await server.driver.query<{ amount: string; ordered: string }>({
    text: 'SELECT amount::text AS amount, ordered::text AS ordered FROM shop_order WHERE id = ANY($1) ORDER BY name',
    params: [commit.json.created],
  });
  expect(rows).toEqual([
    { amount: '1500.75', ordered: '2026-06-01' },
    { amount: '20.00', ordered: '2026-06-02' },
  ]);
  const many = [
    'Name,Customer',
    ...Array.from({ length: 51 }, (_, i) => `SO-${100 + i},C-001`),
  ].join('\n');
  const tooMany = await upload('ana', 'shop.order', many);
  expect(tooMany.status).toBe(413);
  expect(tooMany.json.title).toBe('Too many rows');
  expect((await upload('ana', 'shop.order', 'PK\u0003\u0004garbage', 'broken.xlsx')).status).toBe(
    422,
  );
});

// Step 2: keys, lines, skipping errors, undo.

async function importFile(
  as: string,
  csv: string,
  options: Record<string, unknown>,
  columns?: (string | null)[],
) {
  const session = (await upload(as, 'shop.order', csv)).json;
  const fields: (string | null)[] = columns ?? session.columns.map((c: Json) => c.field);
  const mapping = await call('PUT', `/api/v1/imports/${session.id}/mapping`, as, {
    columns: fields.map((field, index) => ({ index, field })),
    options,
  });
  expect(mapping.status).toBe(200);
  return session.id as number;
}
async function linesOf(name: string) {
  return server.driver.query<{ product: string; qty: number; price: string }>({
    text: `SELECT l.product, l.qty, l.price::text AS price FROM shop_order_line l JOIN shop_order o ON o.id = l.order_id
           WHERE o.name = $1 ORDER BY l.id`,
    params: [name],
  });
}
async function amountOf(name: string) {
  const [row] = await server.driver.query<{ amount: string }>({
    text: 'SELECT amount::text AS amount FROM shop_order WHERE name = $1',
    params: [name],
  });
  return row?.amount;
}

test('lines: rows with empty own columns continue the record above', async () => {
  const csv = [
    'Name,Customer,Amount,Lines › Product,Lines › Quantity,Lines › Price',
    'SO-50,C-001,100,Rice,2,50',
    ',,,Lentils,1,"1,200.50"',
    'SO-51,C-002,10,Salt,3,',
  ].join('\n');
  const session = (await upload('ana', 'shop.order', csv)).json;
  expect(session.columns.map((c: Json) => c.field)).toEqual([
    'name',
    'customer',
    'amount',
    'lines.product',
    'lines.qty',
    'lines.price',
  ]);
  const keys = session.fields.map((f: Json) => f.key);
  expect(keys).not.toContain('lines'); // the one2many itself is not a column
  expect(keys).not.toContain('lines.order'); // nor the link back
  expect(session.fields.find((f: Json) => f.key === 'name').keyable).toBe(true);
  const commit = await call('POST', `/api/v1/imports/${session.id}/commit`, 'ana');
  expect(commit.status).toBe(201);
  expect(commit.json.rows).toBe(2);
  expect(commit.json.undo).toBeUndefined(); // stays on the server
  expect(await linesOf('SO-50')).toEqual([
    { product: 'Rice', qty: 2, price: '50.00' },
    { product: 'Lentils', qty: 1, price: '1200.50' },
  ]);
  expect(await linesOf('SO-51')).toEqual([{ product: 'Salt', qty: 3, price: '0.00' }]);
});

test('upsert by a unique field: existing records updated (their lines replaced), new ones created; undo', async () => {
  const id = await importFile(
    'mgr',
    ['Name,Customer,Amount,Lines › Product', 'SO-50,C-001,175,Sugar', 'SO-52,C-003,5,'].join('\n'),
    { mode: 'upsert', key: 'name' },
  );
  const dry = await call('POST', `/api/v1/imports/${id}/dry-run`, 'mgr');
  expect([dry.json.wouldCreate, dry.json.wouldUpdate, dry.json.errors]).toEqual([1, 1, []]);
  const commit = await call('POST', `/api/v1/imports/${id}/commit`, 'mgr');
  expect([commit.json.created.length, commit.json.updated.length]).toEqual([1, 1]);
  expect(await amountOf('SO-50')).toBe('175.00');
  expect(await linesOf('SO-50')).toEqual([{ product: 'Sugar', qty: 1, price: '0.00' }]);
  expect(await amountOf('SO-52')).toBe('5.00');
  const session = await call('GET', `/api/v1/imports/${id}`, 'mgr');
  expect(session.json.state).toBe('done');
  expect(session.json.undoUntil).not.toBeNull();
  // Undo: the created order goes, the updated one gets its values and lines back.
  const undo = await call('POST', `/api/v1/imports/${id}/undo`, 'mgr');
  expect(undo.status).toBe(200);
  expect(undo.json).toEqual({ deleted: 1, restored: 1, changed: [] });
  expect(await amountOf('SO-52')).toBeUndefined();
  expect(await amountOf('SO-50')).toBe('100.00');
  expect(await linesOf('SO-50')).toEqual([
    { product: 'Rice', qty: 2, price: '50.00' },
    { product: 'Lentils', qty: 1, price: '1200.50' },
  ]);
  expect((await call('POST', `/api/v1/imports/${id}/undo`, 'mgr')).status).toBe(409);
  const [event] = await server.driver.query<{ summary: string }>({
    text: `SELECT summary FROM audit_event WHERE kind = 'data.import.undo' ORDER BY id DESC LIMIT 1`,
    params: [],
  });
  expect(event?.summary).toContain('1 deleted, 1 restored, 0 changed since');
});

test('keys: external ids given on create, found on update; unknown, duplicate and missing keys', async () => {
  const created = await importFile(
    'ana',
    ['Ref,Name,Customer', 'ord_60,SO-60,C-001', 'legacy.ord_61,SO-61,C-002'].join('\n'),
    { mode: 'create', key: 'externalId' },
    ['externalId', 'name', 'customer'],
  );
  const made = await call('POST', `/api/v1/imports/${created}/commit`, 'ana');
  expect(made.json.created).toHaveLength(2);
  const ids = await server.driver.query<{ module: string; name: string }>({
    text: `SELECT module, name FROM shutro_external_id WHERE model = 'shop.order' ORDER BY name`,
    params: [],
  });
  expect(ids).toEqual([
    { module: '__import__', name: 'ord_60' },
    { module: 'legacy', name: 'ord_61' },
  ]);
  // The same id again in create mode: it exists.
  const again = await importFile(
    'ana',
    'Ref,Name,Customer\nord_60,SO-62,C-001',
    { key: 'externalId' },
    ['externalId', 'name', 'customer'],
  );
  const exists = await call('POST', `/api/v1/imports/${again}/dry-run`, 'ana');
  expect(exists.json.errors[0].code).toBe('exists');
  const update = await importFile(
    'ana',
    ['Ref,Amount', 'ord_60,60', 'ord_nope,1', 'ord_60,61', ',3'].join('\n'),
    { mode: 'update', key: 'externalId' },
    ['externalId', 'amount'],
  );
  const dry = await call('POST', `/api/v1/imports/${update}/dry-run`, 'ana');
  expect(dry.json.errors.map((e: Json) => [e.row, e.column, e.code])).toEqual([
    [3, 0, 'no-match'],
    [4, 0, 'duplicate-key'],
    [5, 0, 'missing-key'],
  ]);
  expect(dry.json.wouldUpdate).toBe(1);
  // Updating needs a key column.
  const keyless = await importFile('ana', 'Amount\n5', { mode: 'update' }, ['amount']);
  const noKey = await call('POST', `/api/v1/imports/${keyless}/dry-run`, 'ana');
  expect(noKey.json.errors[0].code).toBe('missing-key');
  // A key must find records: a plain field cannot.
  const notKey = await upload('ana', 'shop.order', 'Amount\n5');
  const refused = await call('PUT', `/api/v1/imports/${notKey.json.id}/mapping`, 'ana', {
    columns: [{ index: 0, field: 'amount' }],
    options: { mode: 'update', key: 'amount' },
  });
  expect(refused.status).toBe(422);
});

test('skip errors: the good records are kept, the others come back as a file; undo leaves changed records alone', async () => {
  const id = await importFile(
    'mgr',
    [
      'Name,Customer,Amount',
      'SO-70,C-001,1',
      'SO-71,Nobody,2',
      'SO-72,C-002,=1+1',
      'SO-73,C-003,-4',
    ].join('\n'),
    { onError: 'skip' },
  );
  const commit = await call('POST', `/api/v1/imports/${id}/commit`, 'mgr');
  expect(commit.status).toBe(201);
  expect(commit.json.created).toHaveLength(1);
  expect(commit.json.skipped).toBe(3);
  expect(commit.json.errors.map((e: Json) => [e.row, e.code])).toEqual([
    [3, 'not-found'],
    [4, 'not-a-number'],
    [5, 'rejected'],
  ]);
  const rejected = await server.app.inject({
    method: 'GET',
    url: `/api/v1/imports/${id}/rejected`,
    headers: { authorization: `Bearer ${await tokenOf('mgr')}` },
  });
  expect(rejected.headers['content-type']).toBe('text/csv; charset=utf-8');
  expect(rejected.headers['content-disposition']).toBe(
    'attachment; filename="rejected-orders.csv"',
  );
  const lines = rejected.body.replace(/^﻿/, '').trim().split('\r\n');
  expect(lines[0]).toBe('Name,Customer,Amount,Error');
  expect(lines[1]).toBe('SO-71,Nobody,2,"Customer: no record ""Nobody"" was found."');
  expect(lines[2]?.startsWith("SO-72,C-002,'=1+1,")).toBe(true); // a formula stays text
  expect(lines[3]).toContain('An amount is never negative.');
  expect(lines).toHaveLength(4);
  // Someone edits the imported order: undo leaves it.
  const [order] = await server.driver.query<{ id: number }>({
    text: `SELECT id FROM shop_order WHERE name = 'SO-70'`,
    params: [],
  });
  const edit = await call('PATCH', `/api/v1/models/shop.order/${order?.id}`, 'mgr', {
    amount: '9',
  });
  expect(edit.status).toBe(200);
  const undo = await call('POST', `/api/v1/imports/${id}/undo`, 'mgr');
  expect(undo.json).toEqual({ deleted: 0, restored: 0, changed: [order?.id] });
  expect(await amountOf('SO-70')).toBe('9.00');
});

test('undo needs the permissions it uses: deleting the created records needs unlink', async () => {
  const id = await importFile('ana', 'Name,Customer\nSO-80,C-001', {});
  expect((await call('POST', `/api/v1/imports/${id}/commit`, 'ana')).status).toBe(201);
  expect((await call('POST', `/api/v1/imports/${id}/undo`, 'ana')).status).toBe(403);
  expect(await amountOf('SO-80')).toBe('0.00');
});
