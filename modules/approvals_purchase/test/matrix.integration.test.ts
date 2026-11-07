/**
 * The approvals matrix on real PostgreSQL (RFC 0027 step 1), with Workforce and Purchase: a level decided by the head
 * of the requester's department, one by the department's approvers plus an extra person, one by the record (the
 * approvers of the lines' product categories); each request says how its approvers were found; a level's turn —
 * and its deadline — starts when the levels before it are approved; every step is in the log. Nobody to decide:
 * the submission refused with the reason, or the level skipped when the policy says so. Step 2: an approver who
 * already approved is not asked again; backups decide beside the approvers and are told; Approvals managers reassign
 * with a reason (never to the requester); waiting requests follow their level's changes, and "Sync now".
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalMailWorkers } from '@kosh/approvals';
import { hr } from '@kosh/hr';
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
import { approvalsPurchase } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [base, settings, hr, approvalsPurchase];
const PO = '/api/v1/models/purchase.order';

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let host: AppHost;
let company: number;
const ids: Record<string, number> = {};
const users: Record<string, number> = {};
const tokens = new Map<string, string>();

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function call(method: 'GET' | 'POST' | 'PATCH', url: string, as: string, payload?: unknown) {
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
  return { status: res.statusCode, json: (res.body === '' ? null : res.json()) as Json };
}
const expectStatus = (r: { status: number; json: Json }, status: number) =>
  expect(r.status, JSON.stringify(r.json)).toBe(status);

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-approvals-matrix-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({
      driver,
      catalogue,
      change: { install: ['settings', 'hr', 'approvals_purchase'] },
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
    company: { name: 'Paragon Feed', currency: 'BDT' },
    admin: { login: 'admin', name: 'Administrator', password: PASSWORD },
  }));
  await installDefaults(host.server.shutro, host.server.registry.loaded.modules, { company });
  for (const [login, groups] of [
    ['pia', ['approvals.manager', 'purchase.manager', 'product.manager', 'hr.manager']],
    ['bob', ['purchase.user']],
    ['dina', ['purchase.user']],
    ['karim', ['purchase.user']],
    ['cat', ['purchase.user']],
    ['extra', ['purchase.user']],
  ] as const)
    users[login] = await auth.createUser({
      login,
      name: login,
      password: PASSWORD,
      company,
      companies: [company],
      groups: [...groups],
    });
  // Only this test's policy: the shipped one archived.
  for (const p of (await call('GET', '/api/v1/models/approval.policy?fields=id', 'pia')).json
    .items as Json[])
    expectStatus(
      await call('PATCH', `/api/v1/models/approval.policy/${p.id}`, 'pia', { active: false }),
      200,
    );
  // Workforce: Bob in Operations, headed by Dina, approved for by Karim.
  const dinaEmployee = (
    await call('POST', '/api/v1/models/hr.employee', 'pia', { name: 'Dina', user: users['dina'] })
  ).json.id;
  const ops = await call('POST', '/api/v1/models/hr.department', 'pia', {
    name: 'Operations',
    head: dinaEmployee,
    approvalUsers: { set: [users['karim']] },
  });
  expectStatus(ops, 201);
  expectStatus(
    await call('POST', '/api/v1/models/hr.employee', 'pia', {
      name: 'Bob',
      user: users['bob'],
      department: ops.json.id,
    }),
    201,
  );
  // Products: cement's purchases approved by Cat, through its parent category.
  const building = await call('POST', '/api/v1/models/product.category', 'pia', {
    name: 'Building',
    approvalUsers: { set: [users['cat']] },
  });
  const cement = await call('POST', '/api/v1/models/product.category', 'pia', {
    name: 'Cement',
    parent: building.json.id,
  });
  ids['cement'] = (
    await call('POST', '/api/v1/models/product.product', 'pia', {
      name: 'Cement bag',
      purchaseOk: true,
      kind: 'goods',
      category: cement.json.id,
    })
  ).json.id;
  ids['currency'] = (
    await call('GET', `/api/v1/models/res.company/${company}?fields=currency`, 'pia')
  ).json.currency;
  ids['vendor'] = (
    await call('POST', '/api/v1/models/res.partner', 'pia', { name: 'Cement Co', isVendor: true })
  ).json.id;
  const policy = await call('POST', '/api/v1/models/approval.policy', 'pia', {
    name: 'Matrix',
    targetModel: 'purchase.order',
    onApproved: 'confirm',
    onRejected: 'reject',
    levels: {
      create: [
        { sequence: 10, name: 'Head', approverKind: 'department_head', deadlineHours: 4 },
        {
          sequence: 20,
          name: 'Department',
          approverKind: 'department_approvers',
          extraUsers: { set: [users['extra']] },
          deadlineHours: 2,
        },
        { sequence: 30, name: 'Category', approverKind: 'record' },
      ],
    },
  });
  expectStatus(policy, 201);
  ids['policy'] = policy.json.id;
}, 240_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

async function order(as: string): Promise<number> {
  const made = await call('POST', PO, as, {
    partner: ids['vendor'],
    currency: ids['currency'],
    lines: {
      create: [{ product: ids['cement'], name: 'Cement', quantity: '10', priceUnit: '550' }],
    },
  });
  expectStatus(made, 201);
  return made.json.id as number;
}
type Request = {
  id: number;
  levelName: string;
  approvers: number[];
  state: string;
  startedAt: string | null;
  dueAt: string | null;
  explanation: string | null;
};
const approvalsOf = async (id: number) =>
  (await call('GET', `/api/v1/approvals/purchase.order/${id}`, 'pia')).json as {
    requests: Request[];
    events: { request: number; kind: string; note: string | null }[];
  };

test('the department’s head, its approvers and an extra person, the categories’ approvers; turns, deadlines, the log', async () => {
  const id = await order('bob');
  expectStatus(await call('POST', `${PO}/${id}/transitions/submit`, 'bob'), 200);
  let { requests } = await approvalsOf(id);
  const [head, department, category] = requests;
  expect(head).toMatchObject({ levelName: 'Head', approvers: [users['dina']] });
  expect(head?.explanation).toContain('Operations’s head: dina');
  expect(department?.approvers.sort()).toEqual([users['karim'], users['extra']].sort());
  expect(department?.explanation).toContain('Operations’s approvers: karim');
  expect(department?.explanation).toContain('Also: extra');
  expect(category).toMatchObject({ approvers: [users['cat']] });
  expect(category?.explanation).toContain('Named by the record: cat');
  // Only the first level's turn: its deadline counts from now; the next one's has not started.
  expect(head?.startedAt).not.toBeNull();
  expect(Date.parse(head?.dueAt ?? '') - Date.parse(head?.startedAt ?? '')).toBe(4 * 3_600_000);
  expect(department).toMatchObject({ startedAt: null, dueAt: null });
  // Not the department's turn yet.
  expectStatus(
    await call('POST', `/api/v1/approvals/requests/${department?.id}/approve`, 'karim'),
    409,
  );
  expectStatus(await call('POST', `/api/v1/approvals/requests/${head?.id}/approve`, 'dina'), 200);
  ({ requests } = await approvalsOf(id));
  const next = requests[1];
  expect(next?.startedAt).not.toBeNull();
  expect(Date.parse(next?.dueAt ?? '') - Date.parse(next?.startedAt ?? '')).toBe(2 * 3_600_000);
  expectStatus(await call('POST', `/api/v1/approvals/requests/${next?.id}/approve`, 'extra'), 200);
  expectStatus(
    await call('POST', `/api/v1/approvals/requests/${category?.id}/approve`, 'cat'),
    200,
  );
  expect((await call('GET', `${PO}/${id}?fields=state`, 'pia')).json.state).toBe('purchase');
  const { events } = await approvalsOf(id);
  const kinds = (request: number | undefined) =>
    events.filter((e) => e.request === request).map((e) => e.kind);
  expect(kinds(head?.id)).toEqual(['created', 'started', 'approved']);
  expect(kinds(department?.id)).toEqual(['created', 'started', 'approved']);
  expect(kinds(category?.id)).toEqual(['created', 'started', 'approved']);
});

test('nobody to decide: refused with the reason; skipped when the policy says so', async () => {
  // Pia is not an employee: no department, no head.
  const id = await order('pia');
  const refused = await call('POST', `${PO}/${id}/transitions/submit`, 'pia');
  expectStatus(refused, 422);
  expect(JSON.stringify(refused.json)).toContain('Head');
  expect(JSON.stringify(refused.json)).toContain('pia is not an employee in Workforce');
  expect((await call('GET', `${PO}/${id}?fields=state`, 'pia')).json.state).toBe('draft');

  expectStatus(
    await call('PATCH', `/api/v1/models/approval.policy/${ids['policy']}`, 'pia', {
      whenNobody: 'skip',
    }),
    200,
  );
  expectStatus(await call('POST', `${PO}/${id}/transitions/submit`, 'pia'), 200);
  const { requests, events } = await approvalsOf(id);
  const [head, department] = requests;
  expect(head).toMatchObject({ levelName: 'Head', state: 'approved' });
  expect(head?.explanation).toContain('skipped');
  expect(events.filter((e) => e.request === head?.id).map((e) => e.kind)).toEqual(['skipped']);
  // The skipped level does not hold the next one: the department's extra person decides now.
  expect(department).toMatchObject({ approvers: [users['extra']], state: 'pending' });
  expect(department?.startedAt).not.toBeNull();
});

test('approved already, backups, reassignment, waiting requests in step with their level', async () => {
  expectStatus(
    await call('PATCH', `/api/v1/models/approval.policy/${ids['policy']}`, 'pia', {
      active: false,
    }),
    200,
  );
  const made = await call('POST', '/api/v1/models/approval.policy', 'pia', {
    name: 'Matrix 2',
    targetModel: 'purchase.order',
    onApproved: 'confirm',
    onRejected: 'reject',
    skipDuplicates: true,
    levels: {
      create: [
        {
          sequence: 10,
          name: 'First',
          approverKind: 'users',
          approverUsers: { set: [users['dina']] },
        },
        {
          sequence: 20,
          name: 'Second',
          approverKind: 'users',
          approverUsers: { set: [users['dina'], users['extra']] },
        },
        {
          sequence: 30,
          name: 'Third',
          approverKind: 'users',
          approverUsers: { set: [users['cat']] },
          backupUsers: { set: [users['karim']] },
        },
      ],
    },
  });
  expectStatus(made, 201);
  const policy = made.json.id as number;
  const id = await order('bob');
  expectStatus(await call('POST', `${PO}/${id}/transitions/submit`, 'bob'), 200);
  let { requests } = await approvalsOf(id);
  const [first, second, third] = requests;
  expectStatus(await call('POST', `/api/v1/approvals/requests/${first?.id}/approve`, 'dina'), 200);
  // Dina approved First: Second, which she may decide too, is approved for her; Third's turn.
  let events: { request: number; kind: string; note: string | null }[];
  ({ requests, events } = await approvalsOf(id));
  expect(requests[1]?.state).toBe('approved');
  expect(events.filter((e) => e.request === second?.id).map((e) => e.kind)).toEqual([
    'created',
    'started',
    'auto',
  ]);
  expect(requests[2]?.startedAt).not.toBeNull();

  // Telling the backups: the approver may, the requester may not.
  expect(
    (await call('POST', `/api/v1/approvals/requests/${third?.id}/notify-backups`, 'bob')).status,
  ).toBe(403);
  const told = await call('POST', `/api/v1/approvals/requests/${third?.id}/notify-backups`, 'cat');
  expectStatus(told, 200);
  expect(told.json.notified).toBe(1);

  // Reassigning: Approvals managers only, a reason, never the requester.
  const R = `/api/v1/approvals/requests/${third?.id}/reassign`;
  expect((await call('POST', R, 'cat', { users: [users['extra']], reason: 'Away' })).status).toBe(
    403,
  );
  expect((await call('POST', R, 'pia', { users: [users['bob']], reason: 'Away' })).status).toBe(
    422,
  );
  expect((await call('POST', R, 'pia', { users: [users['extra']], reason: ' ' })).status).toBe(422);
  const moved = await call('POST', R, 'pia', {
    users: [users['extra']],
    mode: 'replace',
    reason: 'Cat is on leave',
  });
  expectStatus(moved, 200);
  expect(moved.json.approvers).toEqual([users['extra']]);
  expect(
    (await call('POST', `/api/v1/approvals/requests/${third?.id}/approve`, 'cat')).status,
  ).toBe(403);

  // Only the level's backups change (a many-to-many alone: Shutro request #35): once the change is served, the
  // waiting request follows, adding.
  const levels = (
    await call(
      'GET',
      `/api/v1/models/approval.level?fields=id,name&filter[policy]=${policy}`,
      'pia',
    )
  ).json.items as Json[];
  const thirdLevel = levels.find((l) => l.name === 'Third');
  expectStatus(
    await call('PATCH', `/api/v1/models/approval.level/${thirdLevel.id}`, 'pia', {
      backupUsers: { set: [users['dina']] },
    }),
    200,
  );
  for (const w of approvalMailWorkers({ shutro: host.server.shutro })) await w.drain();
  ({ requests } = await approvalsOf(id));
  // Adding: the level's own approver comes back beside the one it was reassigned to.
  expect([...(requests[2]?.approvers ?? [])].sort()).toEqual([users['extra'], users['cat']].sort());
  expect([...(requests[2] as Json).backups].sort()).toEqual([users['karim'], users['dina']].sort());
  // "Sync now", replacing: the level's people again, its backups as they are now.
  const synced = await call('POST', `/api/v1/approvals/policies/${policy}/sync`, 'pia', {
    mode: 'replace',
  });
  expectStatus(synced, 200);
  expect(synced.json.synced).toBe(1);
  ({ requests, events } = await approvalsOf(id));
  expect(requests[2]).toMatchObject({ approvers: [users['cat']], backups: [users['dina']] });
  expect(events.filter((e) => e.request === third?.id).map((e) => e.kind)).toEqual([
    'created',
    'started',
    'notified',
    'reassigned',
    'synced',
    'synced',
  ]);
  // A backup decides: the order is approved.
  expectStatus(await call('POST', `/api/v1/approvals/requests/${third?.id}/approve`, 'dina'), 200);
  expect((await call('GET', `${PO}/${id}?fields=state`, 'pia')).json.state).toBe('purchase');
});

test('policies by segment and companies: a segment covers its companies, an empty one none; the preview says which', async () => {
  for (const name of ['Matrix 2'])
    for (const p of (
      await call('GET', `/api/v1/models/approval.policy?fields=id&filter[name]=${name}`, 'pia')
    ).json.items as Json[])
      expectStatus(
        await call('PATCH', `/api/v1/models/approval.policy/${p.id}`, 'pia', { active: false }),
        200,
      );
  // Approvals managers make segments and put companies in them (the segment holds its companies).
  expect((await call('POST', '/api/v1/models/res.segment', 'bob', { name: 'Nope' })).status).toBe(
    403,
  );
  const feed = await call('POST', '/api/v1/models/res.segment', 'pia', {
    name: 'Feed',
    code: 'FD',
    companies: { set: [company] },
  });
  expectStatus(feed, 201);
  expect((await call('POST', '/api/v1/models/res.segment', 'pia', { name: 'Feed' })).status).toBe(
    422,
  );
  const dairy = await call('POST', '/api/v1/models/res.segment', 'pia', { name: 'Dairy' });
  expectStatus(dairy, 201);
  // A company is in one segment at most.
  expect(
    (
      await call('PATCH', `/api/v1/models/res.segment/${dairy.json.id}`, 'pia', {
        companies: { set: [company] },
      })
    ).status,
  ).toBe(422);
  const policy = async (name: string, scope: Record<string, unknown>, approver: string) => {
    const made = await call('POST', '/api/v1/models/approval.policy', 'pia', {
      name,
      targetModel: 'purchase.order',
      onApproved: 'confirm',
      onRejected: 'reject',
      ...scope,
      levels: {
        create: [{ name, approverKind: 'users', approverUsers: { set: [users[approver]] } }],
      },
    });
    expectStatus(made, 201);
    return made.json.id as number;
  };
  const forFeed = await policy('Feed segment', { segment: feed.json.id }, 'extra');
  const forDairy = await policy('Dairy segment', { segment: dairy.json.id }, 'cat');
  await policy('These companies', { companies: { set: [company] } }, 'karim');
  const id = await order('bob');
  expectStatus(await call('POST', `${PO}/${id}/transitions/submit`, 'bob'), 200);
  const { requests } = await approvalsOf(id);
  expect(requests.map((r) => r.levelName).sort()).toEqual(['Feed segment', 'These companies']);
  const preview = async (p: number) =>
    (await call('GET', `/api/v1/approvals/policies/${p}/preview`, 'pia')).json.covers;
  expect(await preview(forFeed)).toEqual({ all: false, companies: ['Paragon Feed'] });
  expect(await preview(forDairy)).toEqual({ all: false, companies: [] });
});

test('the matrix: cards per policy for my decisions and for others, time per level and bottlenecks for managers', async () => {
  const matrix = async (as: string, query: string) =>
    call('GET', `/api/v1/approvals/matrix?${query}`, as);
  expect((await matrix('dina', 'period=2w')).status).toBe(400);
  // Dina decided Matrix's Head level herself, and Matrix 2's Third as a backup.
  const mine = await matrix('dina', 'period=all&mode=direct');
  expectStatus(mine, 200);
  const cards = mine.json.cards as Json[];
  expect(cards.find((c) => c.title === 'Matrix')?.approved).toBeGreaterThanOrEqual(1);
  const forOthers = (await matrix('dina', 'period=all&mode=delegated')).json.cards as Json[];
  expect(forOthers.find((c) => c.title === 'Matrix 2')?.approved).toBe(1);
  // Not a manager: no levels, no bottlenecks; the requester sees no card of his own requests.
  expect(mine.json.levels).toBeNull();
  const bob = (await matrix('bob', 'period=all')).json;
  expect(bob.cards).toEqual([]);
  // Approvals managers: the hours each level takes, and who has the most waiting.
  const manager = (await matrix('pia', 'period=all')).json;
  expect(manager.levels.length).toBeGreaterThan(0);
  expect(manager.levels.every((l: Json) => typeof l.averageHours === 'number')).toBe(true);
  expect(Array.isArray(manager.bottlenecks)).toBe(true);
});
