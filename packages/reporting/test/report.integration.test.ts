/**
 * The report query and exports (RFC 0005) on real PostgreSQL: one statement for every level, per-currency totals,
 * drill-down domains that find exactly the records behind a cell, record rules and field security, period
 * comparisons, `asOf`, and formatted XLSX / CSV exports gated by the export permission and audited.
 */
import { inflateRawSync } from 'node:zlib';
import { type Authenticator, createServer, type KoshServer } from '@kosh/server';
import { orm } from '@kosh/server/orm';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Header, ReportResult } from '../src/index.js';
import { sale } from './fixtures/sales.js';

const USERS: Record<string, { user: number; groups: string[] }> = {
  manager: { user: 1, groups: ['sale.manager'] },
  alice: { user: 2, groups: ['sale.user'] },
};
const authenticate: Authenticator = async (request) => {
  const u = USERS[String(request.headers['x-test-user'])];
  return u === undefined ? null : { user: u.user, company: 1, companies: [1], groups: u.groups };
};

let pg: StartedPostgreSqlContainer;
let server: KoshServer;
const call = (url: string, as: string, body?: unknown) =>
  server.app.inject({
    method: body === undefined ? 'GET' : 'POST',
    url,
    headers: { 'x-test-user': as },
    ...(body === undefined ? {} : { payload: body as object }),
  });

const REPORT = '/api/v1/models/sale.order/report';

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:18').start();
  server = await createServer({
    databaseUrl: pg.getConnectionUri(),
    modules: [sale],
    authenticate,
    logger: false,
    rateLimit: { max: 0, timeWindow: '1 minute' },
  });
  for (const statement of orm.createTableStatements(server.registry.registry))
    await server.driver.query(statement);
  for (const text of [
    "INSERT INTO res_users (login, name) VALUES ('manager', 'Manager'), ('alice', 'Alice')",
    "INSERT INTO res_currency (name, decimal_places) VALUES ('BDT', 2), ('USD', 2)",
    "INSERT INTO res_company (name, currency_id) VALUES ('Dhaka Ltd', 1)",
    "INSERT INTO res_partner (name, city) VALUES ('Acme', 'Dhaka'), ('Globex', 'Chattogram')",
  ])
    await server.driver.query({ text, params: [] });
  const orders: [number, number, string, string, number, string, string][] = [
    // user, partner, state, date, currency, amount, margin
    [1, 1, 'sale', '2026-08-10', 1, '100.00', '10'],
    [1, 1, 'sale', '2026-09-03', 1, '200.00', '20'],
    [1, 1, 'draft', '2026-09-20', 1, '50.00', '5'],
    [1, 2, 'sale', '2026-09-25', 2, '7.00', '1'],
    [2, 2, 'sale', '2026-09-28', 1, '1000.00', '100'],
    [1, 1, 'sale', '2025-09-15', 1, '80.00', '8'], // last year
  ];
  for (const [user, partner, state, date, currency, amount, margin] of orders)
    await server.driver.query({
      text: 'INSERT INTO sale_order (name, partner_id, state, date_order, currency_id, amount, margin, created_by_id, updated_by_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, now(), now())',
      params: [`${user}-${date}`, partner, state, date, currency, amount, margin, user],
    });
}, 240_000);

afterAll(async () => {
  await server?.close();
  await pg?.stop();
});

const find = (node: Header, label: string): Header => {
  const hit = node.children.find((c) => c.label === label);
  if (hit === undefined)
    throw new Error(
      `no header ${label} under ${node.label}: ${node.children.map((c) => c.label).join(', ')}`,
    );
  return hit;
};

describe('report query', () => {
  test('rows × columns × measures: every level and total in one statement, per currency', async () => {
    const res = await call(REPORT, 'manager', {
      rows: ['partner', 'state'],
      cols: ['dateOrder:month'],
      measures: { orders: 'count', total: { sum: 'amount' } },
      where: { dateOrder: { gte: '2026-01-01' } },
    });
    expect(res.statusCode, res.body).toBe(200);
    const report = res.json() as ReportResult;
    expect(report.statements).toBe(1);
    expect(report.rows.children.map((h) => h.label)).toEqual(['Acme', 'Globex']);
    expect(find(report.rows, 'Acme').children.map((h) => h.label)).toEqual(['Draft', 'Confirmed']);
    expect(report.cols.children.map((h) => h.value)).toEqual(['2026-08-01', '2026-09-01']);
    const acme = find(report.rows, 'Acme');
    const sep = report.cols.children[1] as Header;
    expect(report.cells[acme.key]?.[sep.key]).toEqual({
      orders: 2,
      total: [{ amount: '250.00', currency: 'BDT' }],
    });
    // Globex in September: BDT and USD are never added.
    const globex = find(report.rows, 'Globex');
    expect(report.cells[globex.key]?.[sep.key]?.['total']).toEqual([
      { amount: '1000.00', currency: 'BDT' },
      { amount: '7.00', currency: 'USD' },
    ]);
    // Grand total and column totals.
    expect(report.cells[report.rows.key]?.[report.cols.key]).toEqual({
      orders: 5,
      total: [
        { amount: '1350.00', currency: 'BDT' },
        { amount: '7.00', currency: 'USD' },
      ],
    });
    expect(report.cells[report.rows.key]?.[sep.key]?.['orders']).toBe(4);
  });

  test('drill-down: the domain of a cell finds exactly the records behind it', async () => {
    const report = (
      await call(REPORT, 'manager', {
        rows: ['partner'],
        cols: ['dateOrder:month'],
        measures: { orders: 'count' },
      })
    ).json() as ReportResult;
    const acme = find(report.rows, 'Acme');
    const sep = report.cols.children.find((c) => c.value === '2026-09-01') as Header;
    expect(sep.domain).toEqual({ dateOrder: { gte: '2026-09-01', lt: '2026-10-01' } });
    const domain = { and: [acme.domain, sep.domain] };
    const records = await call(
      `/api/v1/models/sale.order?fields=name&filter=${encodeURIComponent(JSON.stringify(domain))}`,
      'manager',
    );
    expect(records.json().items).toHaveLength(
      report.cells[acme.key]?.[sep.key]?.['orders'] as number,
    );
    expect(records.json().items).toHaveLength(2);
  });

  test('record rules apply at every level; restricted fields cannot be measured', async () => {
    const own = (
      await call(REPORT, 'alice', { rows: ['partner'], measures: { orders: 'count' } })
    ).json() as ReportResult;
    expect(own.cells[own.rows.key]?.[own.cols.key]).toEqual({ orders: 1 }); // alice created one order
    expect(own.rows.children.map((h) => h.label)).toEqual(['Globex']);
    const margin = await call(REPORT, 'alice', {
      rows: ['partner'],
      measures: { m: { sum: 'margin' } },
    });
    expect(margin.statusCode).toBe(403);
    const managerMargin = (
      await call(REPORT, 'manager', { rows: [], measures: { m: { sum: 'margin' } } })
    ).json() as ReportResult;
    expect(managerMargin.cells['[]']?.['[]']?.['m']).toBe('144');
  });

  test('comparisons: this September vs last year, and vs the previous period', async () => {
    const yoy = (
      await call(REPORT, 'manager', {
        rows: ['partner'],
        cols: ['dateOrder:month'],
        measures: { total: { sum: 'amount' } },
        where: { currency: 1 },
        comparison: { field: 'dateOrder', from: '2026-09-01', to: '2026-10-01', mode: 'yoy' },
      })
    ).json() as ReportResult;
    expect(yoy.statements).toBe(2);
    expect(yoy.comparison).toMatchObject({ from: '2025-09-01', to: '2025-10-01' });
    const acme = find(yoy.rows, 'Acme');
    const sep = yoy.cols.children[0] as Header;
    expect(yoy.cells[acme.key]?.[sep.key]?.['total']).toEqual([
      { amount: '250.00', currency: 'BDT' },
    ]);
    // Last September's bucket is moved onto this September's column, so the cells line up.
    expect(yoy.comparison?.cells[acme.key]?.[sep.key]?.['total']).toEqual([
      { amount: '80.00', currency: 'BDT' },
    ]);

    const previous = (
      await call(REPORT, 'manager', {
        rows: [],
        measures: { orders: 'count' },
        comparison: { field: 'dateOrder', from: '2026-09-01', to: '2026-10-01', mode: 'previous' },
      })
    ).json() as ReportResult;
    expect(previous.comparison).toMatchObject({ from: '2026-08-02', to: '2026-09-01' });
    expect(previous.cells['[]']?.['[]']?.['orders']).toBe(4);
    expect(previous.comparison?.cells['[]']?.['[]']?.['orders']).toBe(1);
  });

  test('asOf: the report as it was before a change (models with history)', async () => {
    const before = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 50));
    const change = await server.app.inject({
      method: 'POST',
      url: '/api/v1/models/sale.order',
      headers: { 'x-test-user': 'manager' },
      payload: {
        name: 'late',
        partner: 1,
        dateOrder: '2026-09-30',
        currency: 1,
        amount: '1.00',
        state: 'sale',
      },
    });
    expect(change.statusCode, change.body).toBe(201);
    const now = (
      await call(REPORT, 'manager', { rows: [], measures: { orders: 'count' } })
    ).json() as ReportResult;
    const then = await call(REPORT, 'manager', {
      rows: [],
      measures: { orders: 'count' },
      asOf: before,
    });
    expect(then.statusCode, then.body).toBe(200);
    expect((then.json() as ReportResult).cells['[]']?.['[]']?.['orders']).toBe(
      (now.cells['[]']?.['[]']?.['orders'] as number) - 1,
    );
    await server.driver.query({ text: "DELETE FROM sale_order WHERE name = 'late'", params: [] });
  });

  test('invalid queries are 400', async () => {
    expect(
      (await call(REPORT, 'manager', { rows: ['nope'], measures: { n: 'count' } })).statusCode,
    ).toBe(400);
    expect((await call(REPORT, 'manager', { rows: ['partner'], measures: {} })).statusCode).toBe(
      400,
    );
    expect(
      (await call(REPORT, 'manager', { rows: ['partner', 'partner'], measures: { n: 'count' } }))
        .statusCode,
    ).toBe(400);
  });
});

/** The files of a ZIP archive (deflate entries), to read back the XLSX. */
function unzip(buffer: Buffer): Map<string, string> {
  const files = new Map<string, string>();
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const size = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extra = buffer.readUInt16LE(offset + 28);
    const name = buffer.toString('utf8', offset + 30, offset + 30 + nameLength);
    const start = offset + 30 + nameLength + extra;
    const data = buffer.subarray(start, start + size);
    files.set(name, (method === 8 ? inflateRawSync(data) : data).toString('utf8'));
    offset = start + size;
  }
  return files;
}

describe('exports', () => {
  test('the report as a formatted XLSX: rows indented, totals, money formats; audited; export permission needed', async () => {
    const query = {
      rows: ['partner', 'state'],
      cols: ['dateOrder:month'],
      measures: { total: { sum: 'amount' } },
      where: { currency: 1, dateOrder: { gte: '2026-01-01' } },
      format: 'xlsx',
      title: 'Spend by partner',
    };
    const refused = await call(`${REPORT}/export`, 'alice', query);
    expect(refused.statusCode).toBe(403);
    const res = await server.app.inject({
      method: 'POST',
      url: `${REPORT}/export`,
      headers: { 'x-test-user': 'manager' },
      payload: query,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    const files = unzip(res.rawPayload);
    expect([...files.keys()]).toEqual(
      expect.arrayContaining([
        '[Content_Types].xml',
        'xl/workbook.xml',
        'xl/worksheets/sheet1.xml',
        'xl/styles.xml',
      ]),
    );
    const sheet = files.get('xl/worksheets/sheet1.xml') ?? '';
    expect(sheet).toContain('>Acme<');
    expect(sheet).toContain('>  Confirmed<'); // indented second level
    expect(sheet).toContain('<v>1350.00</v>'); // grand total as a number
    expect(files.get('xl/styles.xml')).toContain('#,##0.00 &quot;BDT&quot;');
    expect(files.get('xl/workbook.xml')).toContain('name="Spend by partner"');
    const [event] = await server.driver.query<{ kind: string; summary: string }>({
      text: "SELECT kind, summary FROM audit_event WHERE kind = 'data.export' ORDER BY id DESC LIMIT 1",
      params: [],
    });
    expect(event?.summary).toContain('Spend by partner');
  });

  test('the report as CSV', async () => {
    const res = await call(`${REPORT}/export`, 'manager', {
      rows: ['partner'],
      measures: { orders: 'count' },
      format: 'csv',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.split('\r\n').slice(0, 4)).toEqual([
      ',Total · Count',
      'Acme,4',
      'Globex,2',
      'Total,6',
    ]);
  });

  test('a list as XLSX: many2one names, dates and money as typed cells', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/v1/models/sale.order/export/xlsx',
      headers: { 'x-test-user': 'manager' },
      payload: {
        fields: ['name', 'partner', 'dateOrder', 'amount', 'state'],
        filter: { currency: 2 },
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    const sheet = unzip(res.rawPayload).get('xl/worksheets/sheet1.xml') ?? '';
    expect(sheet).toContain('>Globex<');
    expect(sheet).toContain('>Confirmed<');
    expect(sheet).toMatch(/<c r="C2" s="2"><v>46290<\/v><\/c>/); // 2026-09-25 as an Excel date
    expect(sheet).toContain('<v>7.00</v>');
  });

  test('streamed CSV of a list: all rows, header first', async () => {
    const res = await call('/api/v1/models/sale.order/export', 'manager', {
      fields: ['name', 'state'],
    });
    expect(res.statusCode).toBe(200);
    const lines = res.body.trim().split('\r\n');
    expect(lines[0]).toBe('id,name,state');
    expect(lines).toHaveLength(7);
  });
});
