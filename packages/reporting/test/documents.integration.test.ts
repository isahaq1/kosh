/**
 * Documents and scheduled reports (RFC 0005): templates installed from manifests, rendered to HTML and PDF as the
 * caller (record rules, formatted values, related records), list documents with totals, broken bindings refused;
 * schedules planned in the owner's time zone, enqueued once per due time, run as the owner, stored as outputs the
 * recipients can download, delivered to adapters.
 */
import { type Authenticator, createServer, type KoshServer } from '@kosh/server';
import { orm } from '@kosh/server/orm';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { engineOf, installTemplates, layoutProblems, nextRun } from '../src/index.js';
import { sale } from './fixtures/sales.js';

const USERS: Record<string, { user: number; groups: string[] }> = {
  manager: { user: 1, groups: ['sale.manager', 'reporting.designer'] },
  alice: { user: 2, groups: ['sale.user', 'reporting.user'] },
};
const authenticate: Authenticator = async (request) => {
  const u = USERS[String(request.headers['x-test-user'])];
  return u === undefined
    ? null
    : {
        user: u.user,
        company: 1,
        companies: [1],
        groups: u.groups,
        lang: 'en_US',
        tz: 'Asia/Dhaka',
      };
};

let pg: StartedPostgreSqlContainer;
let server: KoshServer;
const call = (method: 'GET' | 'POST' | 'PATCH', url: string, as: string, body?: unknown) =>
  server.app.inject({
    method,
    url,
    headers: { 'x-test-user': as },
    ...(body === undefined ? {} : { payload: body as object }),
  });
type Template = { id: number; name: string };
const templatesOf = async (as: string): Promise<Template[]> =>
  (await call('GET', '/api/v1/models/sale.order/documents', as)).json().templates as Template[];

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off'; // the tests drive the engine by hand
  pg = await new PostgreSqlContainer('postgres:18').start();
  server = await createServer({
    databaseUrl: pg.getConnectionUri(),
    modules: [sale],
    authenticate,
    logger: { level: 'error' },
    rateLimit: { max: 0, timeWindow: '1 minute' },
  });
  for (const statement of orm.createTableStatements(server.registry.registry))
    await server.driver.query(statement);
  for (const text of [
    "INSERT INTO res_users (login, name) VALUES ('manager', 'Manager'), ('alice', 'Alice')",
    // Group assignments as the admin API would store them: scheduled jobs run with the owner's stored groups.
    "INSERT INTO auth_user_group (user_id, \"group\", created_at, updated_at) VALUES (1, 'sale.manager', now(), now()), (1, 'reporting.designer', now(), now()), (2, 'sale.user', now(), now()), (2, 'reporting.user', now(), now())",
    "INSERT INTO res_currency (name, decimal_places) VALUES ('BDT', 2)",
    "INSERT INTO res_company (name, currency_id) VALUES ('Dhaka Ltd', 1)",
    "INSERT INTO res_partner (name, city) VALUES ('Acme', 'Dhaka'), ('Globex', 'Chattogram')",
    "INSERT INTO sale_order (name, partner_id, state, date_order, currency_id, amount, margin, created_by_id, updated_by_id, created_at, updated_at) VALUES ('SO-1', 1, 'sale', '2026-09-03', 1, '1250.50', '20', 1, 1, now(), now()), ('SO-2', 2, 'draft', '2026-09-20', 1, '80.00', '5', 2, 2, now(), now())",
  ])
    await server.driver.query({ text, params: [] });
  await server.shutro.bootstrap({ reason: 'install templates' }, (env) =>
    installTemplates(env, server.registry.loaded.modules),
  );
}, 240_000);

afterAll(async () => {
  await server?.close();
  await pg?.stop();
});

describe('documents', () => {
  test('templates from the manifest; HTML with formatted, related values; PDF; audited', async () => {
    const templates = await templatesOf('manager');
    expect(templates.map((t) => t.name)).toEqual(['Order list', 'Sales order']);
    const order = templates.find((t) => t.name === 'Sales order') as Template;
    const html = await call(
      'POST',
      `/api/v1/models/sale.order/documents/${order.id}?format=html`,
      'manager',
      { ids: [1] },
    );
    expect(html.statusCode, html.body).toBe(200);
    expect(html.body).toContain('<h1>Order SO-1</h1>');
    expect(html.body).toContain('Acme'); // partner.name through the relation
    expect(html.body).toContain('Sep 3, 2026'); // a formatted date
    expect(html.body).toContain('1,250.50 BDT'); // Money
    expect(html.body).toContain('Confirmed'); // the selection label
    expect(html.body).toContain('<header>Dhaka Ltd</header>');
    expect(html.body).toContain('Approved by');

    const pdf = await call('POST', `/api/v1/models/sale.order/documents/${order.id}`, 'manager', {
      ids: [1],
    });
    expect(pdf.statusCode, pdf.body.slice(0, 200)).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.headers['content-disposition']).toContain('Sales_order-SO-1.pdf');
    const [event] = await server.driver.query<{ kind: string; target_id: number }>({
      text: "SELECT kind, target_id FROM audit_event WHERE kind = 'document.rendered' ORDER BY id DESC LIMIT 1",
      params: [],
    });
    expect(event).toEqual({ kind: 'document.rendered', target_id: 1 });
  }, 120_000);

  test('record rules: a user cannot print an order they cannot read; list documents total their rows', async () => {
    const templates = await templatesOf('alice');
    const order = templates.find((t) => t.name === 'Sales order') as Template;
    const refused = await call(
      'POST',
      `/api/v1/models/sale.order/documents/${order.id}?format=html`,
      'alice',
      { ids: [1] },
    );
    expect([403, 404]).toContain(refused.statusCode);
    const listTemplate = templates.find((t) => t.name === 'Order list') as Template;
    const mine = await call(
      'POST',
      `/api/v1/models/sale.order/documents/${listTemplate.id}?format=html`,
      'alice',
      {},
    );
    expect(mine.statusCode).toBe(200);
    expect(mine.body).toContain('SO-2');
    expect(mine.body).not.toContain('SO-1');
    const all = await call(
      'POST',
      `/api/v1/models/sale.order/documents/${listTemplate.id}?format=html`,
      'manager',
      {},
    );
    expect(all.body).toContain('<strong>1,330.50</strong>'); // the sum row
  });

  test('broken bindings are refused when a template is saved; designers preview unsaved layouts', async () => {
    const bad = await call('POST', '/api/v1/models/report.template', 'manager', {
      name: 'Broken',
      targetModel: 'sale.order',
      layout: { blocks: [{ kind: 'field', id: 'x', bind: 'partner.nope' }] },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().detail).toContain("unknown field 'partner.nope'");
    const fields = new Map([
      [
        'sale.order',
        new Map([['partner', { label: 'P', kind: 'many2one', target: 'res.partner' }]]),
      ],
    ]);
    expect(
      layoutProblems(
        { blocks: [{ kind: 'table', id: 't', bind: 'partner', columns: [] }] },
        'sale.order',
        fields,
      ),
    ).toEqual(["table 'partner' is not a one2many / many2many of sale.order"]);
    const order = (await templatesOf('manager')).find((t) => t.name === 'Sales order') as Template;
    const preview = await call(
      'POST',
      `/api/v1/models/sale.order/documents/${order.id}?format=html`,
      'manager',
      {
        ids: [1],
        layout: { blocks: [{ kind: 'heading', id: 'h', text: 'Draft {{name}}' }] },
      },
    );
    expect(preview.body).toContain('<h1>Draft SO-1</h1>');
    const notDesigner = await call(
      'POST',
      `/api/v1/models/sale.order/documents/${order.id}?format=html`,
      'alice',
      { ids: [2], layout: { blocks: [] } },
    );
    expect(notDesigner.statusCode).toBe(403);
  });
});

describe('schedules', () => {
  test('next runs in the owner time zone', () => {
    const after = new Date('2026-10-18T10:00:00Z');
    expect(
      nextRun({ frequency: 'daily', hour: 8, day: 1, tz: 'Asia/Dhaka' }, after).toISOString(),
    ).toBe('2026-10-19T02:00:00.000Z'); // 08:00 Dhaka = 02:00 UTC
    expect(nextRun({ frequency: 'weekly', hour: 9, day: 1, tz: 'UTC' }, after).toISOString()).toBe(
      '2026-10-19T09:00:00.000Z',
    ); // next Monday
    expect(
      nextRun({ frequency: 'monthly', hour: 8, day: 1, tz: 'Asia/Dhaka' }, after).toISOString(),
    ).toBe('2026-11-01T02:00:00.000Z');
    expect(nextRun({ frequency: 'daily', hour: 23, day: 1, tz: 'UTC' }, after).toISOString()).toBe(
      '2026-10-18T23:00:00.000Z',
    ); // later today
  });

  test('a monthly XLSX pivot: due → enqueued once → run as the owner → output for the recipients', async () => {
    const engine = engineOf(server.app);
    if (engine === undefined) throw new Error('engine');
    const delivered: number[] = [];
    engine.use({ name: 'test', deliver: async (_env, output) => void delivered.push(output.id) });
    const created = await call('POST', '/api/v1/models/report.schedule', 'alice', {
      name: 'My orders by partner',
      targetModel: 'sale.order',
      kind: 'pivot',
      query: { rows: ['partner'], measures: { total: { sum: 'amount' } } },
      format: 'xlsx',
      frequency: 'monthly',
      hour: 8,
      day: 1,
      tz: 'Asia/Dhaka',
      recipients: { set: [1] },
      nextRunAt: '2026-01-01T02:00:00Z',
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id as number;
    expect(await engine.tick(new Date('2026-10-18T10:00:00Z'))).toBe(1);
    expect(await engine.tick(new Date('2026-10-18T10:00:00Z'))).toBe(0); // advanced: not due again
    const [schedule] = await server.driver.query<{ next_run_at: Date }>({
      text: 'SELECT next_run_at FROM report_schedule WHERE id = $1',
      params: [id],
    });
    expect(schedule?.next_run_at.toISOString()).toBe('2026-11-01T02:00:00.000Z');
    expect(await engine.worker().drain()).toBe(1);
    expect(delivered).toHaveLength(1);
    const outputs = await call(
      'GET',
      '/api/v1/models/report.output?fields=name,filename,mime,size',
      'manager',
    ); // a recipient
    expect(outputs.json().items).toHaveLength(1);
    expect(outputs.json().items[0]).toMatchObject({
      name: 'My orders by partner',
      filename: 'My_orders_by_partner.xlsx',
    });
    const download = await call(
      'GET',
      `/api/v1/reports/outputs/${outputs.json().items[0].id}/download`,
      'alice',
    );
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload.subarray(0, 2).toString()).toBe('PK'); // a zip: xlsx
    // The job ran as alice (its owner).
    const [ran] = await server.driver.query<{ last_error: string | null; created_by_id: number }>({
      text: 'SELECT last_error, created_by_id FROM report_schedule WHERE id = $1',
      params: [id],
    });
    expect(ran).toEqual({ last_error: null, created_by_id: 2 });
    expect((await call('GET', '/api/v1/models/report.output', 'alice')).json().items).toHaveLength(
      1,
    ); // the owner sees it too
  });

  test('run now: a document schedule as PDF; a failing render is recorded', async () => {
    const listTemplate = (await templatesOf('manager')).find(
      (t) => t.name === 'Order list',
    ) as Template;
    const created = await call('POST', '/api/v1/models/report.schedule', 'manager', {
      name: 'Weekly orders',
      targetModel: 'sale.order',
      kind: 'document',
      template: listTemplate.id,
      query: { filter: { state: 'sale' } },
      format: 'pdf',
      frequency: 'weekly',
    });
    expect(created.statusCode, created.body).toBe(201);
    const run = await call('POST', `/api/v1/reports/schedules/${created.json().id}/run`, 'manager');
    expect(run.statusCode, run.body).toBe(200);
    const download = await call(
      'GET',
      `/api/v1/reports/outputs/${run.json().output}/download`,
      'manager',
    );
    expect(download.headers['content-type']).toBe('application/pdf');
    expect(download.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');

    const broken = await call('POST', '/api/v1/models/report.schedule', 'manager', {
      name: 'Broken',
      targetModel: 'sale.order',
      kind: 'pivot',
      query: { rows: ['nope'], measures: { n: 'count' } },
      format: 'csv',
      frequency: 'daily',
    });
    const failed = await call(
      'POST',
      `/api/v1/reports/schedules/${broken.json().id}/run`,
      'manager',
    );
    expect(failed.statusCode).toBeGreaterThanOrEqual(400);
    const [row] = await server.driver.query<{ last_error: string }>({
      text: 'SELECT last_error FROM report_schedule WHERE id = $1',
      params: [broken.json().id],
    });
    expect(row?.last_error).toContain('nope');
  }, 120_000);
});
