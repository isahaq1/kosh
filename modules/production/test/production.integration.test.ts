/**
 * Production on real PostgreSQL through the HTTP API (RFC 0021): the bill of materials valid on an order's date
 * (versions with effective dates); an order lists what is required, available and short, and what it costs
 * (materials and operations), before it starts; Confirm reserves the components through Stockroom; Produce waits
 * for them, then consumes them and puts the product in stock; cancelling releases; the checks; access; the demo.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contacts } from '@kosh/contacts';
import { messaging } from '@kosh/messaging';
import { product } from '@kosh/product';
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
import { stock } from '@kosh/stock';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { production, schedule } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [base, settings, contacts, product, messaging, stock, production];
const P = '/api/v1/models/production.order';
const T = '/api/v1/models/stock.picking';

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let host: AppHost;
let company: number;
const ids: Record<string, number> = {};
const tokens = new Map<string, string>();

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function call(
  method: 'GET' | 'POST' | 'PATCH',
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
const find = async (model: string, filter: unknown, fields: string, as = 'maria') =>
  (
    await call(
      'GET',
      `/api/v1/models/${model}?filter=${encodeURIComponent(JSON.stringify(filter))}&fields=${fields}&order=id+asc`,
      as,
    )
  ).json.items as Json[];
const run = (id: number, transition: string, as = 'rahim') =>
  call('POST', `${P}/${id}/transitions/${transition}`, as);
async function receive(name: string, quantity: string): Promise<void> {
  const made = await call('POST', T, 'maria', {
    kind: 'receipt',
    source: ids['vendors'],
    destination: ids['stock'],
    moves: { create: [{ product: ids[name], quantity }] },
  });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  await call('POST', `${T}/${made.json.id}/transitions/confirm`, 'maria');
  expect((await call('POST', `${T}/${made.json.id}/transitions/validate`, 'maria')).status).toBe(
    200,
  );
}
const onHand = async (name: string) =>
  Number(
    (await call('GET', `/api/v1/models/product.product/${ids[name]}`, 'maria')).json.qtyOnHand,
  );

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-production-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({ driver, catalogue, change: { install: ['settings', 'production'] }, dir }),
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
    ['maria', ['production.manager', 'stock.manager', 'product.manager']],
    ['rahim', ['production.user']],
    ['mona', ['production.manager']],
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
  for (const l of await find('stock.location', {}, 'usage'))
    ids[l.usage === 'internal' ? 'stock' : l.usage === 'vendor' ? 'vendors' : String(l.usage)] =
      l.id;
  for (const u of await find('uom.uom', {}, 'name')) ids[u.name] = u.id;
  for (const [name, uom, standardPrice] of [
    ['Fixture', 'Units', '0'],
    ['Panel', 'Units', '100'],
    ['Cable', 'm', '10'],
  ] as const)
    ids[name] = (
      await call('POST', '/api/v1/models/product.product', 'maria', {
        name,
        uom: ids[uom],
        standardPrice,
      })
    ).json.id;
  ids['assembly'] = (
    await call('POST', '/api/v1/models/production.workcenter', 'maria', {
      name: 'Assembly',
      costPerHour: '600',
    })
  ).json.id;
  for (const [version, cable, validFrom] of [
    ['v1', '3', null],
    ['v2', '2', '2026-12-01'],
  ] as const) {
    const bom = await call('POST', '/api/v1/models/production.bom', 'maria', {
      product: ids['Fixture'],
      version,
      validFrom,
      lines: {
        create: [
          { product: ids['Panel'], quantity: '1' },
          { product: ids['Cable'], quantity: cable, uom: ids['m'] },
        ],
      },
      operations: {
        create: [{ name: 'Assemble', workcenter: ids['assembly'], minutes: '20' }],
      },
    });
    expect(bom.status, JSON.stringify(bom.json)).toBe(201);
    ids[version] = bom.json.id;
  }
}, 240_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('the bill valid on the order’s date: a new version from its first day', async () => {
  const proposed = async (date: string) =>
    (
      await call('POST', `${P}/onchange`, 'rahim', {
        values: { product: ids['Fixture'], date },
        changed: ['product'],
      })
    ).json.values.bom;
  expect(await proposed('2026-11-15')).toBe(ids['v1']);
  expect(await proposed('2026-12-05')).toBe(ids['v2']);
});

test('what is short and what it costs, before it starts; then made through Stockroom', async () => {
  const made = await call('POST', P, 'rahim', {
    product: ids['Fixture'],
    quantity: '5',
    bom: ids['v1'],
    date: '2026-11-15',
  });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  const id = made.json.id as number;
  expect((await run(id, 'check')).status).toBe(200);
  const needs = await find(
    'production.order.component',
    { production: id },
    'product,required,available,short,cost',
    'rahim',
  );
  expect(needs.map((n) => [n.product, n.required, n.available, n.short, n.cost])).toEqual([
    [ids['Panel'], '5', '0', '5', '500'],
    [ids['Cable'], '15', '0', '15', '150'],
  ]);
  const order = (await call('GET', `${P}/${id}`, 'rahim')).json;
  // 650 of materials; 5 × 20 minutes at 600 an hour = 1,000; 1,650 for 5.
  expect(order).toMatchObject({
    materialCost: '650',
    operationCost: '1000',
    totalCost: '1650',
    unitCost: '330',
    status: 'draft',
  });

  await receive('Panel', '3');
  await receive('Cable', '20');
  expect((await run(id, 'confirm')).status).toBe(200);
  const confirmed = (await call('GET', `${P}/${id}`, 'rahim')).json;
  expect(confirmed.status).toBe('waiting');
  const consumption = (await call('GET', `${T}/${confirmed.consumption}`, 'maria')).json;
  expect(consumption).toMatchObject({ kind: 'production', availability: 'partial' });
  const short = await run(id, 'produce');
  expect(short.status).toBe(409);
  expect(JSON.stringify(short.json)).toContain('Components are short');

  await receive('Panel', '2');
  expect((await run(id, 'reserve')).status).toBe(200);
  expect((await call('GET', `${P}/${id}`, 'rahim')).json.status).toBe('ready');
  const produced = await run(id, 'produce');
  expect(produced.status, JSON.stringify(produced.json)).toBe(200);
  const done = (await call('GET', `${P}/${id}`, 'rahim')).json;
  expect(done.status).toBe('done');
  expect((await call('GET', `${T}/${done.output}`, 'maria')).json).toMatchObject({
    kind: 'production',
    state: 'done',
  });
  expect(await onHand('Fixture')).toBe(5);
  expect(await onHand('Panel')).toBe(0);
  expect(await onHand('Cable')).toBe(5);
});

test('cancelling a confirmed order releases its components', async () => {
  await receive('Panel', '1');
  const id = (
    await call('POST', P, 'rahim', { product: ids['Fixture'], quantity: '1', bom: ids['v1'] })
  ).json.id as number;
  await run(id, 'confirm');
  const panel = async () =>
    (await call('GET', `/api/v1/models/product.product/${ids['Panel']}`, 'maria')).json;
  expect(Number((await panel()).qtyReserved)).toBe(1);
  expect((await run(id, 'cancel')).status).toBe(200);
  expect(Number((await panel()).qtyReserved)).toBe(0);
});

test('the checks; access by role', async () => {
  const other = await call('POST', '/api/v1/models/production.bom', 'maria', {
    product: ids['Panel'],
    lines: { create: [{ product: ids['Cable'], quantity: '1' }] },
  });
  expect(other.status).toBe(201);
  expect(
    (await call('POST', P, 'rahim', { product: ids['Fixture'], quantity: '1', bom: other.json.id }))
      .status,
  ).toBe(422);
  expect((await call('POST', P, 'rahim', { product: ids['Fixture'], quantity: '0' })).status).toBe(
    422,
  );
  expect(
    (
      await call('POST', '/api/v1/models/production.bom', 'maria', {
        product: ids['Panel'],
        lines: { create: [{ product: ids['Panel'], quantity: '1' }] },
      })
    ).status,
  ).toBe(422);
  expect(
    (await call('POST', '/api/v1/models/production.bom', 'rahim', { product: ids['Panel'] }))
      .status,
  ).toBe(403);
  expect((await call('GET', P, 'bob')).status).toBe(403);
});

test('scrap on an order, with its reason; by-products of a bill must be other products', async () => {
  const order = (
    await call('POST', P, 'rahim', { product: ids['Fixture'], quantity: '1', bom: ids['v1'] })
  ).json.id as number;
  await receive('Panel', '1');
  const scrap = await call('POST', '/api/v1/models/stock.scrap', 'rahim', {
    product: ids['Panel'],
    quantity: '1',
    reason: 'defect',
    production: order,
  });
  expect(scrap.status, JSON.stringify(scrap.json)).toBe(201);
  expect(
    (
      await call(
        'POST',
        `/api/v1/models/stock.scrap/${scrap.json.id}/transitions/validate`,
        'rahim',
      )
    ).status,
  ).toBe(200);
  const listed = await find('stock.scrap', { production: order }, 'reason,state', 'rahim');
  expect(listed.map((x) => [x.reason, x.state])).toEqual([['defect', 'done']]);
  const itself = await call('POST', '/api/v1/models/production.bom.byproduct', 'maria', {
    bom: ids['v1'],
    product: ids['Fixture'],
    quantity: '1',
  });
  expect(itself.status).toBe(422);
  const all = await call('POST', '/api/v1/models/production.bom.byproduct', 'maria', {
    bom: ids['v1'],
    product: ids['Cable'],
    quantity: '1',
    costShare: '100',
  });
  expect(all.status).toBe(422);
});

test('the scheduler: what does not fit in a day continues the next day', () => {
  const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime();
  const one = schedule(new Date(2026, 10, 16, 6), 600, 8);
  expect([one.start.getTime(), one.stop.getTime()]).toEqual([at(16, 8), at(17, 10)]);
  const late = schedule(new Date(2026, 10, 16, 17), 30, 8);
  expect([late.start.getTime(), late.stop.getTime()]).toEqual([at(17, 8), at(17, 8, 30)]);
});

test('work orders: scheduled at their centre after what it has, on the Gantt; capacity by day', async () => {
  const paint = (
    await call('POST', '/api/v1/models/production.workcenter', 'maria', {
      name: 'Paint',
      hoursPerDay: '4',
    })
  ).json.id;
  const chair = (await call('POST', '/api/v1/models/product.product', 'maria', { name: 'Chair' }))
    .json.id;
  const bill = (
    await call('POST', '/api/v1/models/production.bom', 'maria', {
      product: chair,
      operations: { create: [{ name: 'Paint', workcenter: paint, minutes: '300' }] },
    })
  ).json.id;
  const order = async () => {
    const id = (
      await call('POST', P, 'rahim', {
        product: chair,
        quantity: '1',
        bom: bill,
        date: '2026-11-16',
      })
    ).json.id as number;
    const confirmed = await run(id, 'confirm');
    expect(confirmed.status, JSON.stringify(confirmed.json)).toBe(200);
    return id;
  };
  const first = await order();
  const second = await order();
  const at = (d: number, h: number) => new Date(2026, 10, d, h).getTime();
  const plan = async (production: number) =>
    (
      await find('production.workorder', { production }, 'plannedStart,plannedStop,state', 'rahim')
    ).map((w) => [new Date(w.plannedStart).getTime(), new Date(w.plannedStop).getTime(), w.state]);
  // 5 hours at 4 a day: 16th 8–12, 17th 8–9; the next order after it: 17th 9–12, 18th 8–10.
  expect(await plan(first)).toEqual([[at(16, 8), at(17, 9), 'ready']]);
  expect(await plan(second)).toEqual([[at(17, 9), at(18, 10), 'ready']]);
  const capacity = await call(
    'GET',
    '/api/v1/production/capacity?from=2026-11-16&to=2026-11-18',
    'rahim',
  );
  expect(capacity.status, JSON.stringify(capacity.json)).toBe(200);
  const row = (capacity.json.workcenters as Json[]).find((w) => w.id === paint);
  expect(row.days.map((d: Json) => [d.day, d.plannedHours, d.load])).toEqual([
    ['2026-11-16', '4.00', 100],
    ['2026-11-17', '4.00', 100],
    ['2026-11-18', '2.00', 50],
  ]);

  // Started and finished: the minutes taken; producing closes what is left; cancelling cancels.
  const [step] = await find('production.workorder', { production: first }, 'id', 'rahim');
  const W = '/api/v1/models/production.workorder';
  expect((await call('POST', `${W}/${step.id}/transitions/start`, 'rahim')).status).toBe(200);
  expect((await call('POST', `${W}/${step.id}/transitions/finish`, 'rahim')).status).toBe(200);
  const done = (await call('GET', `${W}/${step.id}`, 'rahim')).json;
  expect(done.state).toBe('done');
  expect(Number(done.actualMinutes)).toBeGreaterThanOrEqual(0);
  expect((await run(second, 'cancel')).status).toBe(200);
  expect((await plan(second))[0]?.[2]).toBe('cancel');
  expect(
    (await call('GET', '/api/v1/production/capacity?from=2026-11-18&to=2026-11-16', 'rahim'))
      .status,
  ).toBe(400);
});

test('reorder rules that make: a confirmed production order with the valid bill, counted as on order', async () => {
  const R = '/api/v1/models/stock.reorder';
  const [main] = await find('stock.warehouse', {}, 'id');
  const rule = await call('POST', R, 'maria', {
    product: ids['Fixture'],
    warehouse: main.id,
    method: 'make',
    minimum: '50',
    maximum: '60',
    multiple: '5',
  });
  expect(rule.status, JSON.stringify(rule.json)).toBe(201);
  await call('POST', '/api/v1/stockroom/replenishment/refresh', 'maria', {
    rules: [rule.json.id],
  });
  const before = (await call('GET', `${R}/${rule.json.id}`, 'maria')).json;
  expect(Number(before.proposed)).toBeGreaterThan(0);
  const ordered = await call('POST', '/api/v1/stockroom/replenishment/order', 'maria', {
    rules: [rule.json.id],
  });
  expect(ordered.status, JSON.stringify(ordered.json)).toBe(200);
  const [made] = ordered.json.ordered;
  expect(made.document).toMatch(/^MO\//);
  const [production] = await find(
    'production.order',
    { name: made.document },
    'state,quantity,bom',
  );
  expect(production.state).toBe('confirmed');
  expect(Number(production.quantity)).toBe(Number(before.proposed));
  expect(production.bom?.id ?? production.bom).toBeTruthy();
  const after = (await call('GET', `${R}/${rule.json.id}`, 'maria')).json;
  expect(Number(after.proposed)).toBe(0);
  expect(after.explanation).toContain(made.document);

  // Without a bill of materials, making is refused with the reason.
  const bracket = (
    await call('POST', '/api/v1/models/product.product', 'maria', { name: 'Bracket' })
  ).json.id;
  const brackets = await call('POST', R, 'maria', {
    product: bracket,
    warehouse: main.id,
    method: 'make',
    minimum: '1000',
    maximum: '1000',
  });
  const refused = await call('POST', '/api/v1/stockroom/replenishment/order', 'maria', {
    rules: [brackets.json.id],
  });
  expect(refused.status).toBe(422);
  expect(JSON.stringify(refused.json)).toContain('no bill of materials');
});

test('bills in depth (RFC 0031 step 2): a formula with ratios, losses and specifications; eligibility; approval when the company asks; a revision', async () => {
  const B = '/api/v1/models/production.bom';
  const protein = (
    await call('POST', '/api/v1/models/production.spec.parameter', 'maria', {
      name: 'Protein',
      unit: '%',
    })
  ).json.id as number;
  for (const [name, value] of [
    ['Panel', '20'],
    ['Cable', '50'],
  ] as const)
    expect(
      (
        await call('POST', '/api/v1/models/production.product.spec', 'maria', {
          product: ids[name],
          parameter: protein,
          value,
        })
      ).status,
    ).toBe(201);
  // A formula for 100 of the fixture: 60 % panels with 5 % loss, 40 % cable; protein 20–40 wanted, 32 reached.
  const formula = await call('POST', B, 'maria', {
    product: ids['Fixture'],
    kind: 'formula',
    quantity: '100',
    version: 'f1',
    lines: {
      create: [
        { product: ids['Panel'], quantity: '1', ratio: '60', loss: '5' },
        { product: ids['Cable'], quantity: '1', ratio: '40' },
      ],
    },
    specs: { create: [{ parameter: protein, minimum: '20', maximum: '40' }] },
  });
  expect(formula.status, JSON.stringify(formula.json)).toBe(201);
  const fid = formula.json.id as number;
  const lines = (
    await call(
      'GET',
      `/api/v1/models/production.bom.line?filter=${encodeURIComponent(JSON.stringify({ bom: fid }))}&fields=ratio,netQuantity,grossQuantity&order=id+asc`,
      'maria',
    )
  ).json.items as Json[];
  expect(lines.map((l) => [Number(l.netQuantity), Number(l.grossQuantity)])).toEqual([
    [60, 63],
    [40, 40],
  ]);
  const [spec] = (
    await call(
      'GET',
      `/api/v1/models/production.bom.spec?filter=${encodeURIComponent(JSON.stringify({ bom: fid }))}&fields=value,within`,
      'maria',
    )
  ).json.items as Json[];
  expect([Number(spec.value), spec.within]).toEqual([32, true]);
  // Ratios that do not add up are refused at review; 60 + 40 pass, and without a policy decider it is active.
  expect(
    (
      await call('PATCH', `/api/v1/models/production.bom.line/${lines[1].id}`, 'maria', {
        ratio: '30',
      })
    ).status,
  ).toBe(200);
  expect((await call('POST', `${B}/${fid}/transitions/submit`, 'maria')).status).toBe(409);
  expect(
    (
      await call('PATCH', `/api/v1/models/production.bom.line/${lines[1].id}`, 'maria', {
        ratio: '40',
      })
    ).status,
  ).toBe(200);
  expect((await call('POST', `${B}/${fid}/transitions/submit`, 'maria')).status).toBe(200);
  // The shipped policy asks a Production manager other than the one who submitted.
  const inbox = (await call('GET', '/api/v1/approvals/inbox', 'mona')).json.requests as Json[];
  const mine = inbox.filter((r) => r.targetModel === 'production.bom' && r.targetId === fid);
  expect(mine.length).toBe(1);
  for (const r of mine)
    expect((await call('POST', `/api/v1/approvals/requests/${r.id}/approve`, 'mona')).status).toBe(
      200,
    );
  const active = (await call('GET', `${B}/${fid}?fields=state,unitCost`, 'maria')).json;
  expect(active.state).toBe('active');
  // 63 panels at 100 and 40 m of cable at 10, per 100 made.
  expect(Number(active.unitCost)).toBe(67);
  const costs = (
    await call(
      'GET',
      `/api/v1/models/production.bom.cost?filter=${encodeURIComponent(JSON.stringify({ bom: fid }))}&fields=unitCost`,
      'maria',
    )
  ).json.items as Json[];
  expect(costs.length).toBe(1);
  // A revision: f2 in draft with the same lines and specifications.
  expect((await call('POST', `${B}/${fid}/transitions/revise`, 'maria')).status).toBe(200);
  const [revision] = (
    await call(
      'GET',
      `${B}?filter=${encodeURIComponent(JSON.stringify({ product: ids['Fixture'], version: 'f2' }))}&fields=state,kind,lines,specs`,
      'maria',
    )
  ).json.items as Json[];
  expect(revision).toMatchObject({ state: 'draft', kind: 'formula' });
  expect(revision.lines.length).toBe(2);
  expect(revision.specs.length).toBe(1);
  // Eligibility: formula components limited to a category the cable is not in.
  const category = (
    await call('POST', '/api/v1/models/product.category', 'maria', { name: 'Feed raw materials' })
  ).json.id as number;
  expect(
    (await call('PATCH', `/api/v1/models/product.product/${ids['Panel']}`, 'maria', { category }))
      .status,
  ).toBe(200);
  expect(
    (
      await call('POST', '/api/v1/models/production.bom.eligibility', 'maria', {
        kind: 'formula',
        categories: { set: [category] },
      })
    ).status,
  ).toBe(201);
  const refused = await call('POST', B, 'maria', {
    product: ids['Fixture'],
    kind: 'formula',
    version: 'f3',
    lines: { create: [{ product: ids['Cable'], quantity: '1', ratio: '100' }] },
  });
  expect(refused.status).toBe(422);
  expect(JSON.stringify(refused.json)).toContain('not an allowed component');
  // Approval required: a draft bill no longer makes products; an active one does.
  const setApproval = (on: boolean) =>
    host.server.shutro.bootstrap({ reason: 'test: bills need approval', company }, async (env) => {
      await (
        env as unknown as {
          model(n: string): { browse(ids: number[]): { write(v: unknown): Promise<void> } };
        }
      )
        .model('res.company')
        .browse([company])
        .write({ bomApproval: on });
    });
  await setApproval(true);
  const draftOrder = await call('POST', P, 'rahim', {
    product: ids['Fixture'],
    quantity: '10',
    bom: revision.id,
  });
  expect(draftOrder.status, JSON.stringify(draftOrder.json)).toBe(201);
  expect((await run(draftOrder.json.id, 'confirm')).status).toBe(409);
  const activeOrder = await call('POST', P, 'rahim', {
    product: ids['Fixture'],
    quantity: '10',
    bom: fid,
  });
  expect((await run(activeOrder.json.id, 'confirm')).status).toBe(200);
  await setApproval(false);
  // Work centres: batches, effectiveness, alternatives; shifts with checked times.
  expect(
    (
      await call('PATCH', `/api/v1/models/production.workcenter/${ids['assembly']}`, 'maria', {
        batchMin: '50',
        batchMax: '500',
        setupMinutes: '15',
        cleanupMinutes: '10',
        oeeTarget: '80',
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await call('POST', '/api/v1/models/production.shift', 'maria', {
        name: 'Night',
        start: '22:00',
        end: '06:00',
      })
    ).json.hours as string,
  ).toBe('8');
  expect(
    (
      await call('POST', '/api/v1/models/production.shift', 'maria', {
        name: 'Bad',
        start: '25:00',
        end: '06:00',
      })
    ).status,
  ).toBe(422);
});

test('a production plan (RFC 0031 step 3): the multi-level forecast, capacity refused with the reason, approval, scheduling into orders', async () => {
  const PL = '/api/v1/models/production.plan';
  // 60 fixtures (Assembly's minimum batch is 50, set above) in one day at 8 h a day: 60 × 20 min = 1200 min do
  // not fit 480.
  const made = await call('POST', PL, 'maria', {
    title: 'Week 48',
    dateFrom: '2026-11-23',
    dateTo: '2026-11-27',
    workcenters: { set: [ids['assembly']] },
    lines: {
      create: [
        {
          product: ids['Fixture'],
          bom: ids['v1'],
          quantity: '60',
          workcenter: ids['assembly'],
          start: '2026-11-23T08:00:00Z',
          end: '2026-11-23T18:00:00Z',
        },
      ],
    },
  });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  const id = made.json.id as number;
  expect((await call('POST', `${PL}/${id}/transitions/submit`, 'maria')).status).toBe(409); // not forecast yet
  const forecast = await call('POST', `${PL}/${id}/transitions/forecast`, 'maria');
  expect(forecast.status, JSON.stringify(forecast.json)).toBe(200);
  const materials = (
    await call(
      'GET',
      `/api/v1/models/production.plan.material?filter=${encodeURIComponent(JSON.stringify({ plan: id }))}&fields=product,required,onHand,onOrder,shortage`,
      'maria',
    )
  ).json.items as Json[];
  const of = (name: string) => materials.find((m) => (m.product?.id ?? m.product) === ids[name]);
  // v1: 1 panel and 3 m of cable per fixture; the panel has a bill of its own (1 m of cable, made above), so the
  // forecast explodes it too: no panels to buy, 180 + 60 m of cable.
  expect(of('Panel')).toBeUndefined();
  expect(Number(of('Cable').required)).toBe(240);
  expect(Number(of('Cable').shortage)).toBe(
    Math.max(0, 240 - Number(of('Cable').onHand) - Number(of('Cable').onOrder)),
  );
  // Capacity: refused with the reason on the line; a wider slot fits.
  const refused = await call('POST', `${PL}/${id}/transitions/submit`, 'maria');
  expect(refused.status).toBe(409);
  const [line] = (
    await call(
      'GET',
      `/api/v1/models/production.plan.line?filter=${encodeURIComponent(JSON.stringify({ plan: id }))}&fields=minutes,capacityNote`,
      'maria',
    )
  ).json.items as Json[];
  expect(Number(line.minutes)).toBe(1200);
  expect(line.capacityNote).toContain('minutes needed');
  expect(line.capacityNote).toContain('Assembly');
  expect(
    (
      await call('PATCH', `/api/v1/models/production.plan.line/${line.id}`, 'maria', {
        end: '2026-11-25T18:00:00Z',
      })
    ).status,
  ).toBe(200);
  expect((await call('POST', `${PL}/${id}/transitions/submit`, 'maria')).status).toBe(200);
  const inbox = (await call('GET', '/api/v1/approvals/inbox', 'mona')).json.requests as Json[];
  for (const r of inbox.filter((x) => x.targetModel === 'production.plan' && x.targetId === id))
    expect((await call('POST', `/api/v1/approvals/requests/${r.id}/approve`, 'mona')).status).toBe(
      200,
    );
  expect((await call('GET', `${PL}/${id}?fields=state`, 'maria')).json.state).toBe('approved');
  // Scheduled: one confirmed production order, linked both ways.
  const scheduled = await call('POST', `${PL}/${id}/transitions/schedule`, 'maria');
  expect(scheduled.status, JSON.stringify(scheduled.json)).toBe(200);
  const orders = (
    await call(
      'GET',
      `${P}?filter=${encodeURIComponent(JSON.stringify({ plan: id }))}&fields=state,quantity,date`,
      'maria',
    )
  ).json.items as Json[];
  expect(orders.length).toBe(1);
  expect(orders[0].state).toBe('confirmed');
  expect(Number(orders[0].quantity)).toBe(60);
  const [after] = (
    await call(
      'GET',
      `/api/v1/models/production.plan.line?filter=${encodeURIComponent(JSON.stringify({ plan: id }))}&fields=order`,
      'maria',
    )
  ).json.items as Json[];
  expect(after.order).not.toBeNull();
  // Procure on a forecast plan with a shortage: no Purchase here, so the material says why nothing was ordered.
  const other = await call('POST', PL, 'maria', {
    title: 'Week 49',
    dateFrom: '2026-11-30',
    dateTo: '2026-12-04',
    lines: {
      create: [
        {
          product: ids['Fixture'],
          bom: ids['v1'],
          quantity: '500',
          workcenter: ids['assembly'],
          start: '2026-11-30T08:00:00Z',
          end: '2026-12-04T18:00:00Z',
        },
      ],
    },
  });
  expect((await call('POST', `${PL}/${other.json.id}/transitions/forecast`, 'maria')).status).toBe(
    200,
  );
  const procured = await call('POST', `${PL}/${other.json.id}/transitions/procure`, 'maria');
  expect(procured.status, JSON.stringify(procured.json)).toBe(200);
  const short = (
    await call(
      'GET',
      `/api/v1/models/production.plan.material?filter=${encodeURIComponent(JSON.stringify({ plan: other.json.id, shortage: { gt: 0 } }))}&fields=document,note`,
      'maria',
    )
  ).json.items as Json[];
  expect(short.length).toBeGreaterThan(0);
  expect(short.every((m) => m.document === null && m.note !== null)).toBe(true);
});

test('the demo data loads', async () => {
  const auth = host.server.auth;
  if (auth === undefined) throw new Error('base is installed');
  const summary = await installDemo({
    shutro: host.server.shutro,
    auth,
    driver,
    modules: host.server.registry.loaded.modules,
    company,
  });
  expect(JSON.stringify(summary)).toContain('Production');
});

test('the overview of the app (RFC 0022 step 2) is served to a user', async () => {
  const overview = await call('GET', '/api/v1/reports/overview?app=production', 'rahim');
  expect(overview.status, JSON.stringify(overview.json)).toBe(200);
  expect(overview.json.cards.map((c: { id: string }) => c.id)).toContain('confirmed');
});
