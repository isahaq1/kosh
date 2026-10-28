/**
 * The India localization on real PostgreSQL (RFC 0016 step 5, part 2): installed with Accounting, its defaults set
 * the company up — the India chart, the accounts of every GST component and cess, the TDS withholdings, an April–March
 * year, lakh grouping, the country; GSTIN (format, check digit, state), PAN and HSN are checked; an invoice within
 * the state posts CGST and SGST, one to another state IGST, each line carrying its heads for the tax invoice; a bill
 * under reverse charge posts the credit and the liability.
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
import { gstinCheckDigit, l10nIn } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [base, contacts, accounting, l10nIn];

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let host: AppHost;
let company: number;
const tokens = new Map<string, string>();

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function call(
  method: 'GET' | 'POST' | 'PUT',
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

type SqlEnv = { sql<R>(strings: TemplateStringsArray, ...values: unknown[]): Promise<R[]> };
const sql = <T>(query: (env: SqlEnv) => Promise<T>) =>
  host.server.shutro.bootstrap({ reason: 'test: read', company }, (env) =>
    query(env as unknown as SqlEnv),
  );
const taxId = (externalId: string) =>
  host.server.shutro.bootstrap({ reason: 'test: tax', company }, async (env) =>
    Number(await env.refId('account.tax' as never, `l10n_in.${externalId}`)),
  );

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-l10n-in-'));
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
  await auth.createUser({
    login: 'maria',
    name: 'Maria',
    password: PASSWORD,
    company,
    companies: [company],
    groups: ['account.manager', 'contacts.user'],
  });
}, 180_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('installing it sets the company up for India', async () => {
  const charts = await call('GET', '/api/v1/accounting/charts', 'maria');
  expect(charts.json.installed).toBe('in');
  const settings = await call('GET', '/api/v1/accounting/settings', 'maria');
  expect(settings.json).toMatchObject({ country: 'IN', state: null });
  const [c] = await sql(
    (env) => env.sql<{ fiscal_year_start: number; number_grouping: string }>`
      SELECT fiscal_year_start, number_grouping FROM res_company WHERE id = ${company}`,
  );
  expect(c).toEqual({ fiscal_year_start: 4, number_grouping: 'lakh' });
  const [year] = await sql(
    (env) => env.sql<{ date_from: string }>`SELECT date_from::text FROM account_fiscal_year`,
  );
  expect(year?.date_from).toMatch(/-04-01$/);

  const components = await sql(
    (env) => env.sql<{
      tax: string;
      code: string;
      scope: string;
      account: string;
      rc: string | null;
    }>`
      SELECT t.name->>'en_US' AS tax, c.code, c.scope, a.code AS account, r.code AS rc
      FROM account_tax_component c JOIN account_tax t ON t.id = c.tax_id
      LEFT JOIN account_account a ON a.id = c.account_id
      LEFT JOIN account_account r ON r.id = c.reverse_charge_account_id
      WHERE t.name->>'en_US' IN ('GST 18%', 'GST 18% (purchases)', 'GST 18% (reverse charge)')
      ORDER BY 1, c.sequence`,
  );
  expect(components).toEqual([
    { tax: 'GST 18%', code: 'CGST', scope: 'intra', account: '2310', rc: null },
    { tax: 'GST 18%', code: 'SGST', scope: 'intra', account: '2311', rc: null },
    { tax: 'GST 18%', code: 'IGST', scope: 'inter', account: '2312', rc: null },
    { tax: 'GST 18% (purchases)', code: 'CGST', scope: 'intra', account: '1310', rc: null },
    { tax: 'GST 18% (purchases)', code: 'SGST', scope: 'intra', account: '1311', rc: null },
    { tax: 'GST 18% (purchases)', code: 'IGST', scope: 'inter', account: '1312', rc: null },
    { tax: 'GST 18% (reverse charge)', code: 'CGST', scope: 'intra', account: '1310', rc: '2320' },
    { tax: 'GST 18% (reverse charge)', code: 'SGST', scope: 'intra', account: '1311', rc: '2321' },
    { tax: 'GST 18% (reverse charge)', code: 'IGST', scope: 'inter', account: '1312', rc: '2322' },
  ]);
  const [names] = await sql(
    (env) => env.sql<{ components: string; cess: string; withholdings: number }>`
      SELECT (SELECT string_agg(DISTINCT name->>'en_US', ', ') FROM account_tax_component
              WHERE tax_id = (SELECT id FROM account_tax WHERE name->>'en_US' = 'GST 0.25%')) AS components,
             (SELECT a.code FROM account_tax t JOIN account_account a ON a.id = t.account_id
              WHERE t.name->>'en_US' = 'Cess 12%') AS cess,
             (SELECT count(*)::int FROM account_withholding) AS withholdings`,
  );
  expect(names).toEqual({
    components: 'CGST 0.125%, IGST 0.25%, SGST 0.125%',
    cess: '2313',
    withholdings: 7,
  });
});

test('GSTIN (format, check digit, state), PAN and HSN are checked', async () => {
  expect(gstinCheckDigit('27AAPFU0939F1Z')).toBe('V');
  const partner = (payload: Record<string, unknown>) =>
    call('POST', '/api/v1/models/res.partner', 'maria', {
      name: 'Test',
      isCompany: true,
      ...payload,
    });
  expectStatus(await partner({ country: 'IN', state: 'IN-MH', gstin: '27AAPFU0939F1ZV' }), 201);
  expect((await partner({ gstin: '27AAPFU0939F1ZA' })).status).toBe(422); // check digit
  const elsewhere = await partner({ state: 'IN-KA', gstin: '27AAPFU0939F1ZV' });
  expect(elsewhere.status).toBe(422); // a Maharashtra GSTIN for a Karnataka contact
  expect((await partner({ pan: 'AAPFU0939' })).status).toBe(422);
  const product = (hsnCode: string) =>
    call('POST', '/api/v1/models/product.product', 'maria', { name: `P ${hsnCode}`, hsnCode });
  expect((await product('123')).status).toBe(422);
  expectStatus(await product('847130'), 201);
});

test('within the state CGST + SGST, to another state IGST; each line carries its heads; the tax invoice', async () => {
  expectStatus(await call('PUT', '/api/v1/accounting/settings', 'maria', { state: 'IN-MH' }), 200);
  await host.server.shutro.bootstrap({ reason: 'test: company GSTIN', company }, (env) =>
    env.asSuperuser({ reason: 'test' }, async (su) => {
      await su
        .model('res.company' as never)
        .browse([orm.asId(company, 'res.company')] as never)
        .write({ gstin: '27AAPFU0939F1ZV' } as never);
      await su.flush();
    }),
  );
  const gst18 = await taxId('gst_sale_18');
  const ids = await sql(async (env) => {
    const [inr] = await env.sql<{ id: number }>`SELECT id FROM res_currency WHERE name = 'INR'`;
    const [inv] = await env.sql<{ id: number }>`SELECT id FROM account_journal WHERE code = 'INV'`;
    return { inr: inr?.id as number, inv: inv?.id as number };
  });
  const laptop = await call('POST', '/api/v1/models/product.product', 'maria', {
    name: 'Laptop',
    hsnCode: '8471',
  });
  expectStatus(laptop, 201);
  const customer = async (name: string, state: string, gstin?: string) => {
    const created = await call('POST', '/api/v1/models/res.partner', 'maria', {
      name,
      isCompany: true,
      isCustomer: true,
      country: 'IN',
      state,
      ...(gstin === undefined ? {} : { gstin }),
    });
    expectStatus(created, 201);
    return created.json.id as number;
  };
  const invoice = async (partner: number) => {
    const created = await call('POST', '/api/v1/models/account.move', 'maria', {
      kind: 'out_invoice',
      journal: ids.inv,
      partner,
      currency: ids.inr,
      lines: {
        create: [
          {
            lineKind: 'product',
            product: laptop.json.id,
            name: 'Laptop',
            quantity: '1',
            priceUnit: '50000',
            taxes: { set: [gst18] },
          },
        ],
      },
    });
    expectStatus(created, 201);
    const id = created.json.id as number;
    expectStatus(
      await call('POST', `/api/v1/models/account.move/${id}/transitions/post`, 'maria'),
      200,
    );
    const lines = await call(
      'GET',
      `/api/v1/models/account.move.line?filter=${encodeURIComponent(JSON.stringify({ invoice: id }))}&fields=cgstAmount,sgstAmount,igstAmount,gstRate,totalWithGst`,
      'maria',
    );
    const [l] = lines.json.items as Json[];
    const taxLines = await sql(
      (env) => env.sql<{ code: string; credit: string }>`
        SELECT a.code, l.credit::numeric(16, 2)::text AS credit FROM account_move_line l JOIN account_account a ON a.id = l.account_id
        WHERE l.move_id = ${id} AND l.line_kind = 'tax' ORDER BY a.code`,
    );
    return {
      id,
      heads: [
        l.cgstAmount.amount,
        l.sgstAmount.amount,
        l.igstAmount.amount,
        l.gstRate,
        l.totalWithGst.amount,
      ],
      taxLines,
    };
  };
  const pune = await invoice(await customer('Pune Retail', 'IN-MH'));
  expect(pune.heads).toEqual(['4500.00', '4500.00', '0.00', '18', '59000.00']);
  expect(pune.taxLines).toEqual([
    { code: '2310', credit: '4500.00' },
    { code: '2311', credit: '4500.00' },
  ]);
  const bengaluru = await invoice(await customer('Bengaluru Labs', 'IN-KA', '29AAGCB7383J1Z4'));
  expect(bengaluru.heads).toEqual(['0.00', '0.00', '9000.00', '18', '59000.00']);
  expect(bengaluru.taxLines).toEqual([{ code: '2312', credit: '9000.00' }]);

  const listed = await call('GET', '/api/v1/models/account.move/documents', 'maria');
  const template = (listed.json.templates as Json[]).find((t) => t.name === 'Tax invoice (GST)');
  expect(template, JSON.stringify(listed.json).slice(0, 300)).toBeDefined();
  expect((listed.json.templates as Json[]).map((t) => t.name)).toEqual(
    expect.arrayContaining(['Credit note (GST)', 'Debit note (GST)']),
  );
  const html = await host.server.app.inject({
    method: 'POST',
    url: `/api/v1/models/account.move/documents/${template.id}?format=html`,
    headers: { authorization: `Bearer ${tokens.get('maria') ?? ''}` },
    payload: { ids: [bengaluru.id] },
  });
  expect(html.statusCode, html.body.slice(0, 400)).toBe(200);
  for (const text of [
    'Tax invoice',
    '27AAPFU0939F1ZV',
    '29AAGCB7383J1Z4',
    'IN-KA',
    '8471',
    '9,000.00',
  ])
    expect(html.body).toContain(text);
});

test('reverse charge on a bill: input credit and the liability, the vendor paid without the tax', async () => {
  const rc = await taxId('gst_rc_18');
  const ids = await sql(async (env) => {
    const [inr] = await env.sql<{ id: number }>`SELECT id FROM res_currency WHERE name = 'INR'`;
    const [bill] = await env.sql<{
      id: number;
    }>`SELECT id FROM account_journal WHERE code = 'BILL'`;
    return { inr: inr?.id as number, bill: bill?.id as number };
  });
  const vendor = await call('POST', '/api/v1/models/res.partner', 'maria', {
    name: 'Delhi Advocates',
    isCompany: true,
    isVendor: true,
    country: 'IN',
    state: 'IN-DL',
  });
  const created = await call('POST', '/api/v1/models/account.move', 'maria', {
    kind: 'in_invoice',
    journal: ids.bill,
    partner: vendor.json.id,
    currency: ids.inr,
    lines: {
      create: [
        {
          lineKind: 'product',
          name: 'Legal services',
          quantity: '1',
          priceUnit: '10000',
          taxes: { set: [rc] },
        },
      ],
    },
  });
  expectStatus(created, 201);
  const id = created.json.id as number;
  const posted = await call('POST', `/api/v1/models/account.move/${id}/transitions/post`, 'maria');
  expectStatus(posted, 200);
  expect(posted.json.gstReverseCharge).toBe(true);
  expect(Number(posted.json.amountTotal.amount)).toBe(10000);
  const lines = await sql(
    (env) => env.sql<{ code: string; debit: string; credit: string }>`
      SELECT a.code, l.debit::numeric(16, 2)::text AS debit, l.credit::numeric(16, 2)::text AS credit FROM account_move_line l
      JOIN account_account a ON a.id = l.account_id
      WHERE l.move_id = ${id} AND l.line_kind <> 'product' ORDER BY a.code`,
  );
  expect(lines).toEqual([
    { code: '1312', debit: '1800.00', credit: '0.00' },
    { code: '2000', debit: '0.00', credit: '10000.00' },
    { code: '2322', debit: '0.00', credit: '1800.00' },
  ]);
});

test('the month in GSTR-1 (by section, the portal JSON) and GSTR-3B (by table, the tax payable)', async () => {
  const ids = await sql(async (env) => {
    const journal = async (code: string) =>
      (await env.sql<{ id: number }>`SELECT id FROM account_journal WHERE code = ${code}`)[0]
        ?.id as number;
    const [inr] = await env.sql<{ id: number }>`SELECT id FROM res_currency WHERE name = 'INR'`;
    return { inr: inr?.id as number, inv: await journal('INV'), bill: await journal('BILL') };
  });
  const tax = async (externalId: string) => taxId(externalId);
  const [gst18, gstPurchase18, lut, nilRated] = await Promise.all([
    tax('gst_sale_18'),
    tax('gst_purchase_18'),
    tax('gst_sale_lut'),
    tax('gst_sale_nil'),
  ]);
  const partner = async (payload: Record<string, unknown>) => {
    const created = await call('POST', '/api/v1/models/res.partner', 'maria', {
      isCompany: true,
      ...payload,
    });
    expectStatus(created, 201);
    return created.json.id as number;
  };
  const post = async (
    kind: string,
    partnerId: number,
    price: string,
    taxes: number[],
    extra = {},
  ) => {
    const created = await call('POST', '/api/v1/models/account.move', 'maria', {
      kind,
      journal: kind.startsWith('out_') ? ids.inv : ids.bill,
      partner: partnerId,
      currency: ids.inr,
      ...extra,
      lines: {
        create: [
          {
            lineKind: 'product',
            name: 'Goods',
            quantity: '1',
            priceUnit: price,
            taxes: { set: taxes },
          },
        ],
      },
    });
    expectStatus(created, 201);
    const id = created.json.id as number;
    expectStatus(
      await call('POST', `/api/v1/models/account.move/${id}/transitions/post`, 'maria'),
      200,
    );
    return id;
  };
  // Already posted this month: Pune (unregistered, Maharashtra) 50,000 and Bengaluru Labs (registered, Karnataka)
  // 50,000 at 18 %, and a bill under reverse charge from Delhi of 10,000.
  const boston = await partner({ name: 'Boston Imports', isCustomer: true, country: 'US' });
  await post('out_invoice', boston, '10000', [gst18]); // export with IGST paid
  await post('out_invoice', boston, '20000', [lut]); // export under LUT
  const kolkata = await partner({
    name: 'Kolkata Retail',
    isCustomer: true,
    country: 'IN',
    state: 'IN-WB',
  });
  await post('out_invoice', kolkata, '200000', [gst18]); // B2C large, between states
  const [bengaluru] = (
    await call(
      'GET',
      `/api/v1/models/res.partner?filter=${encodeURIComponent(JSON.stringify({ name: 'Bengaluru Labs' }))}&fields=id`,
      'maria',
    )
  ).json.items as Json[];
  await post('out_refund', bengaluru.id, '10000', [gst18], { ref: 'Returned' });
  const thane = await partner({
    name: 'Thane Kirana',
    isCustomer: true,
    country: 'IN',
    state: 'IN-MH',
  });
  await post('out_invoice', thane, '5000', [nilRated]);
  const vendor = await partner({
    name: 'Mumbai Supplies',
    isVendor: true,
    country: 'IN',
    state: 'IN-MH',
  });
  await post('in_invoice', vendor, '20000', [gstPurchase18]);
  const month = new Date().toISOString().slice(0, 7);

  const one = await call('GET', `/api/v1/l10n_in/gstr/1?month=${month}`, 'maria');
  expectStatus(one, 200);
  const r1 = one.json;
  expect(r1.gstin).toBe('27AAPFU0939F1ZV');
  expect(r1.b2b.map((d: Json) => [d.gstin, d.pos, d.items[0].txval, d.items[0].iamt])).toEqual([
    ['29AAGCB7383J1Z4', '29', '50000.00', '9000.00'],
  ]);
  expect(r1.b2cl.map((d: Json) => [d.partner, d.pos, d.value, d.items[0].iamt])).toEqual([
    ['Kolkata Retail', '19', '236000.00', '36000.00'],
  ]);
  expect(r1.b2cs).toEqual([
    {
      txval: '50000.00',
      iamt: '0.00',
      camt: '4500.00',
      samt: '4500.00',
      csamt: '0.00',
      supply: 'INTRA',
      pos: '27',
      rate: '18',
    },
  ]);
  expect(r1.exp.map((d: Json) => [d.exportType, d.pos, d.items[0].txval, d.items[0].iamt])).toEqual(
    [
      ['WPAY', '96', '10000.00', '1800.00'],
      ['WOPAY', '96', '20000.00', '0.00'],
    ],
  );
  expect(
    r1.cdnr.map((d: Json) => [d.noteType, d.gstin, d.items[0].txval, d.items[0].iamt]),
  ).toEqual([['C', '29AAGCB7383J1Z4', '10000.00', '1800.00']]);
  expect(r1.nil).toEqual([{ supply: 'INTRAB2C', nil: '5000.00', exempt: '0.00', nonGst: '0.00' }]);
  expect(r1.unclassified).toBe(0);

  const portal = await host.server.app.inject({
    method: 'GET',
    url: `/api/v1/l10n_in/gstr/1?month=${month}&format=portal`,
    headers: { authorization: `Bearer ${tokens.get('maria') ?? ''}` },
  });
  expect(portal.statusCode, portal.body.slice(0, 300)).toBe(200);
  const json = JSON.parse(portal.body);
  expect(json.fp).toBe(`${month.slice(5)}${month.slice(0, 4)}`);
  expect(json.b2b[0]).toMatchObject({
    ctin: '29AAGCB7383J1Z4',
    inv: [{ pos: '29', rchrg: 'N', inv_typ: 'R' }],
  });
  expect(json.b2b[0].inv[0].itms[0]).toEqual({
    num: 1,
    itm_det: { txval: 50000, rt: 18, iamt: 9000, camt: 0, samt: 0, csamt: 0 },
  });
  expect(json.exp.map((e: Json) => e.exp_typ)).toEqual(['WPAY', 'WOPAY']);
  expect(json.cdnr[0].nt[0]).toMatchObject({ ntty: 'C', val: 11800 });

  const three = await call('GET', `/api/v1/l10n_in/gstr/3b?month=${month}`, 'maria');
  expectStatus(three, 200);
  const r3 = three.json;
  // 50,000 + 50,000 + 2,00,000 − 10,000 (the credit note).
  expect(r3.outwardTaxable).toEqual({
    txval: '290000.00',
    iamt: '43200.00',
    camt: '4500.00',
    samt: '4500.00',
    csamt: '0.00',
  });
  expect(r3.outwardZeroRated).toMatchObject({ txval: '30000.00', iamt: '1800.00' });
  expect(r3.outwardNilExempt.txval).toBe('5000.00');
  expect(r3.inwardReverseCharge).toMatchObject({ txval: '10000.00', iamt: '1800.00' });
  expect(r3.itcReverseCharge.iamt).toBe('1800.00');
  expect(r3.itcOther).toMatchObject({ camt: '1800.00', samt: '1800.00' });
  expect(r3.payable).toEqual({
    igst: { tax: '46800.00', credit: '1800.00', net: '45000.00' },
    cgst: { tax: '4500.00', credit: '1800.00', net: '2700.00' },
    sgst: { tax: '4500.00', credit: '1800.00', net: '2700.00' },
    cess: { tax: '0.00', credit: '0.00', net: '0.00' },
  });

  // The files, an unknown return, a user without Accounting.
  for (const [form, format, magic] of [
    ['1', 'xlsx', 'PK'],
    ['3b', 'pdf', '%PDF'],
  ] as const) {
    const file = await host.server.app.inject({
      method: 'GET',
      url: `/api/v1/l10n_in/gstr/${form}?month=${month}&format=${format}`,
      headers: { authorization: `Bearer ${tokens.get('maria') ?? ''}` },
    });
    expect(file.statusCode, file.body.slice(0, 300)).toBe(200);
    expect(file.rawPayload.subarray(0, magic.length).toString()).toBe(magic);
  }
  expect((await call('GET', `/api/v1/l10n_in/gstr/2a?month=${month}`, 'maria')).status).toBe(404);
  await host.server.auth?.createUser({
    login: 'omar',
    name: 'Omar',
    password: PASSWORD,
    company,
    companies: [company],
    groups: ['contacts.user'],
  });
  expect((await call('GET', `/api/v1/l10n_in/gstr/3b?month=${month}`, 'omar')).status).toBe(403);
});
