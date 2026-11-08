/**
 * Requests on real PostgreSQL through the HTTP API (RFC 0032 §3.1): an indent goes to the requester's department
 * head, then to the approvers of its products' group — never the requester —, who may lower a quantity but not raise
 * it; the store issues what was approved by a transfer, partly, the rest still owed and issued later; the requester
 * acknowledges; people see their own indents and those they decide only; issued goods leave stock.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installApprovalPolicies } from '@kosh/permissions';
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
import { indent } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [base, settings, indent];
const R = '/api/v1/models/indent.request';
const L = '/api/v1/models/indent.request.line';

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let host: AppHost;
let company: number;
const users: Record<string, number> = {};
const tokens = new Map<string, string>();
let warehouse: number;
let stockLocation: number;
let internalUse: number;
let bolt: number;
let oil: number;

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function token(as: string): Promise<string> {
  let t = tokens.get(as);
  if (t === undefined) {
    const login = await host.server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { login: as, password: PASSWORD },
    });
    t = (login.json() as { token: string }).token;
    tokens.set(as, t);
  }
  return t;
}
async function call(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  as: string,
  payload?: unknown,
): Promise<{ status: number; json: Json }> {
  const res = await host.server.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${await token(as)}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: res.statusCode, json: res.body === '' ? null : res.json() };
}
const run = (model: string, id: number, transition: string, as: string) =>
  call('POST', `/api/v1/models/${model}/${id}/transitions/${transition}`, as);
const decide = async (id: number, who: string) => {
  const inbox = (await call('GET', '/api/v1/approvals/inbox', who)).json.requests as Json[];
  const mine = inbox.filter((r) => r.targetModel === 'indent.request' && r.targetId === id);
  for (const r of mine) {
    const res = await call('POST', `/api/v1/approvals/requests/${r.id}/approve`, who);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
  }
  return mine.length;
};
const linesOf = async (id: number, as: string) => {
  const res = await call(
    'GET',
    `${L}?filter=${encodeURIComponent(JSON.stringify({ request: id }))}&fields=product,group,quantity,qtyApproved,qtyIssued,qtyRemaining,onHand,qtyShipped,inTransit,qtyShort`,
    as,
  );
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json.items as Json[];
};
const newIndent = async (as: string, lines: [number, string][]) => {
  const res = await call('POST', R, as, {
    warehouse,
    destination: internalUse,
    dateRequired: '2026-11-20',
    purpose: 'Maintenance',
    lines: { create: lines.map(([product, quantity]) => ({ product, quantity })) },
  });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return res.json.id as number;
};
/** Validates a transfer with done quantities by product (a partial validation leaves a backorder). */
async function validate(picking: number, done: Record<number, string>) {
  const moves = (
    await call(
      'GET',
      `/api/v1/models/stock.move?filter=${encodeURIComponent(JSON.stringify({ picking }))}&fields=product`,
      'stan',
    )
  ).json.items as Json[];
  for (const m of moves) {
    const product = m.product?.id ?? m.product;
    const res = await call('PATCH', `/api/v1/models/stock.move/${m.id}`, 'stan', {
      quantityDone: done[product] ?? '0',
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
  }
  const res = await run('stock.picking', picking, 'validate', 'stan');
  expect(res.status, JSON.stringify(res.json)).toBe(200);
}

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-indent-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({ driver, catalogue, change: { install: ['settings', 'indent'] }, dir }),
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
    company: { name: 'Padma Feeds', currency: 'BDT' },
    admin: { login: 'admin', name: 'Administrator', password: PASSWORD },
  }));
  await installDefaults(host.server.shutro, host.server.registry.loaded.modules, { company });
  await host.server.shutro.bootstrap({ reason: 'test policies', company }, (env) =>
    installApprovalPolicies(env, host.server.registry.loaded.modules),
  );
  for (const [login, groups] of [
    ['hana', ['hr.manager', 'stock.manager', 'product.manager']],
    ['mona', ['indent.manager']],
    ['head', ['indent.user']],
    ['gina', ['indent.user']],
    ['stan', ['indent.store']],
    ['rahim', ['indent.user']],
    ['sumi', ['indent.user']],
  ] as const)
    users[login] = await auth.createUser({
      login,
      name: login,
      password: PASSWORD,
      company,
      companies: [company],
      groups: [...groups],
    });
  // The maintenance department, headed by "head"; Rahim and Sumi work in it.
  const headEmployee = (
    await call('POST', '/api/v1/models/hr.employee', 'hana', { name: 'Head', user: users['head'] })
  ).json.id;
  const department = (
    await call('POST', '/api/v1/models/hr.department', 'hana', {
      name: 'Maintenance',
      head: headEmployee,
    })
  ).json.id;
  for (const who of ['rahim', 'sumi'])
    expect(
      (
        await call('POST', '/api/v1/models/hr.employee', 'hana', {
          name: who,
          user: users[who],
          department,
        })
      ).status,
    ).toBe(201);
  // Spare parts: a category whose group Gina approves.
  const category = (
    await call('POST', '/api/v1/models/product.category', 'hana', { name: 'Spare parts' })
  ).json.id;
  bolt = (
    await call('POST', '/api/v1/models/product.product', 'hana', {
      name: 'Bolt M12',
      kind: 'goods',
      category,
    })
  ).json.id;
  oil = (
    await call('POST', '/api/v1/models/product.product', 'hana', {
      name: 'Gear oil',
      kind: 'goods',
    })
  ).json.id;
  const group = await call('POST', '/api/v1/models/indent.product.group', 'mona', {
    name: 'Spare parts',
    categories: { set: [category] },
    approvalUsers: { set: [users['gina']] },
  });
  expect(group.status, JSON.stringify(group.json)).toBe(201);
  // The store: 100 bolts and 50 litres of oil in WH/Stock.
  const wh = (await call('GET', '/api/v1/models/stock.warehouse?fields=name', 'hana')).json
    .items as Json[];
  warehouse = wh[0].id;
  const locations = (
    await call(
      'GET',
      `/api/v1/models/stock.location?filter=${encodeURIComponent(JSON.stringify({ usage: { in: ['internal', 'consumption', 'adjustment'] } }))}&fields=usage,warehouse,name&order=id`,
      'hana',
    )
  ).json.items as Json[];
  stockLocation = locations.find((l) => l.usage === 'internal' && l.warehouse !== null).id;
  internalUse = locations.find((l) => l.usage === 'consumption').id;
  const adjustment = locations.find((l) => l.usage === 'adjustment').id;
  const receipt = await call('POST', '/api/v1/models/stock.picking', 'hana', {
    kind: 'adjustment',
    source: adjustment,
    destination: stockLocation,
    moves: {
      create: [
        { product: bolt, quantity: '100' },
        { product: oil, quantity: '50' },
      ],
    },
  });
  expect(receipt.status, JSON.stringify(receipt.json)).toBe(201);
  expect((await run('stock.picking', receipt.json.id, 'confirm', 'hana')).status).toBe(200);
  expect((await run('stock.picking', receipt.json.id, 'validate', 'hana')).status).toBe(200);
}, 240_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('the requester fills in the department and the store; lines take their product group', async () => {
  const filled = await call('POST', `${R}/onchange`, 'rahim', {
    values: { requester: users['rahim'] },
    changed: ['requester'],
  });
  expect(filled.status, JSON.stringify(filled.json)).toBe(200);
  expect(filled.json.values.warehouse).toBe(warehouse);
  expect(filled.json.values.destination).toBe(internalUse);
  expect(filled.json.values.department).not.toBeNull();
  const id = await newIndent('rahim', [
    [bolt, '30'],
    [oil, '10'],
  ]);
  const lines = await linesOf(id, 'rahim');
  expect(lines[0].group).not.toBeNull();
  expect(lines[1].group).toBeNull();
  expect(Number(lines[0].onHand)).toBe(100);
  // Not to an internal location: goods are issued where they are used.
  const wrong = await call('PATCH', `${R}/${id}`, 'rahim', { destination: stockLocation });
  expect(wrong.status).toBe(422);
});

test('department head, then product group approvers; lowered, issued partly, acknowledged', async () => {
  const id = await newIndent('rahim', [
    [bolt, '30'],
    [oil, '10'],
  ]);
  expect((await run('indent.request', id, 'submit', 'rahim')).status).toBe(200);
  // Never the requester; the head first, then Gina for the spare parts.
  const rahimInbox = (await call('GET', '/api/v1/approvals/inbox', 'rahim')).json
    .requests as Json[];
  expect(rahimInbox.filter((r) => r.targetId === id && r.targetModel === 'indent.request')).toEqual(
    [],
  );
  expect(await decide(id, 'gina')).toBe(0);
  // Gina, while it waits, may lower the bolts but never raise them; Sumi sees nothing of it.
  const lines = await linesOf(id, 'gina');
  expect(lines.length).toBe(2);
  expect((await call('GET', `${R}/${id}`, 'sumi')).status).toBe(403);
  expect(await decide(id, 'head')).toBe(1);
  expect((await call('PATCH', `${L}/${lines[0].id}`, 'gina', { qtyApproved: '40' })).status).toBe(
    422,
  );
  expect((await call('PATCH', `${L}/${lines[0].id}`, 'gina', { qtyApproved: '20' })).status).toBe(
    200,
  );
  expect(await decide(id, 'gina')).toBe(1);
  expect((await call('GET', `${R}/${id}?fields=state`, 'rahim')).json.state).toBe('approved');

  // Only the store issues; the requester cannot acknowledge before anything arrived.
  expect((await run('indent.request', id, 'issue', 'rahim')).status).toBe(403);
  expect((await run('indent.request', id, 'acknowledge', 'rahim')).status).toBe(409);
  const issuing = await run('indent.request', id, 'issue', 'stan');
  expect(issuing.status, JSON.stringify(issuing.json)).toBe(200);
  // Issued once: nothing more is owed while the transfer waits.
  expect((await run('indent.request', id, 'issue', 'stan')).status).toBe(409);
  const issued = (await call('GET', `${R}/${id}?fields=pickings`, 'stan')).json;
  const picking = (issued.pickings[0]?.id ?? issued.pickings[0]) as number;
  // 15 of the 20 bolts and all the oil: the rest of the bolts follows on a backorder.
  await validate(picking, { [bolt]: '15', [oil]: '10' });
  const after = await linesOf(id, 'rahim');
  expect(after.map((l) => [Number(l.qtyApproved), Number(l.qtyIssued)])).toEqual([
    [20, 15],
    [10, 10],
  ]);
  expect((await call('GET', `${R}/${id}?fields=issueStatus`, 'rahim')).json.issueStatus).toBe(
    'partial',
  );
  const all = (await call('GET', `${R}/${id}?fields=pickings`, 'stan')).json.pickings as Json[];
  expect(all.length).toBe(2);
  const backorder = all.map((p) => p.id ?? p).find((p) => p !== picking) as number;
  await validate(backorder, { [bolt]: '5' });
  expect((await call('GET', `${R}/${id}?fields=issueStatus`, 'rahim')).json.issueStatus).toBe(
    'full',
  );
  // The goods left the store.
  expect(Number((await linesOf(id, 'rahim'))[0].onHand)).toBe(80);
  // Only the requester acknowledges.
  expect((await run('indent.request', id, 'acknowledge', 'stan')).status).toBe(409);
  expect((await run('indent.request', id, 'acknowledge', 'rahim')).status).toBe(200);
  expect((await call('GET', `${R}/${id}?fields=state,acknowledgedOn`, 'rahim')).json).toMatchObject(
    { state: 'acknowledged' },
  );
});

test('a transfer to a depot: shipped into transit, received partly, the rest written off', async () => {
  // The depot: another warehouse with its stock location.
  const depot = (
    await call('POST', '/api/v1/models/stock.warehouse', 'hana', { name: 'Depot', code: 'DP' })
  ).json.id as number;
  const depotStock = (
    await call('POST', '/api/v1/models/stock.location', 'hana', {
      name: 'Stock',
      usage: 'internal',
      warehouse: depot,
    })
  ).json.id as number;
  // Not to the store itself, nor to internal use.
  const wrong = await call('POST', R, 'rahim', {
    kind: 'transfer',
    warehouse,
    destination: internalUse,
    dateRequired: '2026-11-20',
    lines: { create: [{ product: bolt, quantity: '10' }] },
  });
  expect(wrong.status).toBe(422);
  const made = await call('POST', R, 'rahim', {
    kind: 'transfer',
    warehouse,
    destination: depotStock,
    dateRequired: '2026-11-20',
    lines: { create: [{ product: bolt, quantity: '10' }] },
  });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  const id = made.json.id as number;
  const before = Number((await linesOf(id, 'rahim'))[0].onHand);
  expect((await run('indent.request', id, 'submit', 'rahim')).status).toBe(200);
  expect(await decide(id, 'head')).toBe(1);
  expect(await decide(id, 'gina')).toBe(1);
  expect((await run('indent.request', id, 'issue', 'stan')).status).toBe(200);
  const notes = async () =>
    (
      await call(
        'GET',
        `/api/v1/models/stock.picking?filter=${encodeURIComponent(JSON.stringify({ indent: id }))}&fields=noteKind,state,destination&order=id`,
        'stan',
      )
    ).json.items as Json[];
  const [stn] = await notes();
  expect(stn.noteKind).toBe('stn');
  await validate(stn.id, { [bolt]: '10' });
  // Shipped: out of the store, in transit, and the receive note waits for it at the depot.
  let line = (await linesOf(id, 'rahim'))[0];
  expect([Number(line.qtyShipped), Number(line.inTransit), Number(line.onHand)]).toEqual([
    10,
    10,
    before - 10,
  ]);
  const srn = (await notes()).find((p) => p.noteKind === 'srn');
  expect(srn).toMatchObject({ state: 'confirmed' });
  expect(srn.destination?.id ?? srn.destination).toBe(depotStock);
  // 7 arrive; 3 stay in transit on the backorder.
  await validate(srn.id, { [bolt]: '7' });
  line = (await linesOf(id, 'rahim'))[0];
  expect([Number(line.qtyIssued), Number(line.inTransit)]).toEqual([7, 3]);
  // The shortage needs its reason, then leaves transit as a loss.
  expect((await run('indent.request', id, 'shortage', 'stan')).status).toBe(409);
  expect(
    (await call('PATCH', `${R}/${id}`, 'stan', { shortageReason: 'Bag torn on the road' })).status,
  ).toBe(200);
  const written = await run('indent.request', id, 'shortage', 'stan');
  expect(written.status, JSON.stringify(written.json)).toBe(200);
  line = (await linesOf(id, 'rahim'))[0];
  expect([Number(line.qtyShort), Number(line.inTransit)]).toEqual([3, 0]);
  expect((await call('GET', `${R}/${id}?fields=issueStatus`, 'rahim')).json.issueStatus).toBe(
    'full',
  );
  const atDepot = (
    await call(
      'GET',
      `/api/v1/models/stock.quant?filter=${encodeURIComponent(JSON.stringify({ location: depotStock, product: bolt }))}&fields=quantity`,
      'hana',
    )
  ).json.items as Json[];
  expect(atDepot.reduce((t, q) => t + Number(q.quantity), 0)).toBe(7);
  expect((await run('indent.request', id, 'acknowledge', 'rahim')).status).toBe(200);
});

test('the demo data loads', async () => {
  const auth = host.server.auth;
  if (auth === undefined) throw new Error('base is installed');
  const result = await installDemo({
    shutro: host.server.shutro,
    auth,
    driver,
    modules: host.server.registry.loaded.modules,
    company,
  });
  expect(JSON.stringify(result)).toContain('Requests');
});
