/**
 * The automation engine (RFC 0011) on real PostgreSQL: rules fire once per change whoever makes it (the API,
 * the system, another rule's chain), with their watched fields, from / to values and condition; actions set
 * fields, run transitions, plan activities, post notes, create records, run a module action and notify; a rule
 * runs as its actor (refused and logged when they may not) or as the system; a rule never fires on its own
 * writes; an event rule fires on an outbox event; a dry run and a retry; the run log and its permissions.
 */

import { createServer as createHttpServer, type IncomingMessage } from 'node:http';
import { messaging } from '@kosh/messaging';
import { defineModule as defineKoshModule } from '@kosh/modules-sdk';
import { inboxWorkers, notifyModule } from '@kosh/notify';
import { base, baseShutro, createServer, installBase, type KoshServer } from '@kosh/server';
import { type Env, orm } from '@kosh/server/orm';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  automationContext,
  automationModule,
  pollAudit,
  pollOutbox,
  pollTimed,
  signWebhook,
  webhookWorker,
} from '../src/index.js';

const PASSWORD = 'correct horse battery';
const { defineGroup, defineModel, defineModule, f } = orm;

const Partner = defineModel('res.partner', {
  recName: 'name',
  access: { 'crm.user': ['read', 'create'], 'crm.manager': ['read', 'write', 'create'] },
  fields: { name: f.char({ required: true }), vip: f.boolean({ default: false }) },
});
const Deal = defineModel('crm.deal', {
  recName: 'name',
  companyScoped: { required: true },
  tracking: ['amount', 'state', 'partner'],
  access: {
    'crm.user': ['read', 'write', 'create', 'unlink'],
    'crm.manager': ['read', 'write', 'create', 'unlink'],
  },
  rules: {
    own: {
      groups: ['crm.user'],
      perms: ['read', 'write', 'create', 'unlink'],
      domain: { user: { $env: 'uid' } },
    },
    all: { groups: ['crm.manager'], perms: ['read', 'write', 'create', 'unlink'], domain: {} },
  },
  fields: {
    name: f.char({ required: true }),
    partner: f.many2one('res.partner'),
    user: f.many2one('res.users', { default: (env: Env) => orm.asId(env.uid, 'res.users') }),
    amount: f.decimal({ scale: 2, default: '0' }),
    closeDate: f.date(),
    /** Untracked: a rule watching it is refused. */
    notes: f.text(),
    priority: f.selection({ low: 'Low', high: 'High' }, { default: 'low' }),
    state: f.state({
      states: { new: 'New', won: 'Won', lost: 'Lost' },
      initial: 'new',
      transitions: {
        win: { from: ['new'], to: 'won' },
        lose: { from: ['new'], to: 'lost' },
      },
    }),
  },
});
const Note = defineModel('crm.note', {
  access: { 'crm.user': ['read', 'create'] },
  fields: { text: f.char({ required: true }), deal: f.many2one('crm.deal') },
});
const crm = defineKoshModule({
  shutro: defineModule({
    name: 'crm',
    version: '0.1.0',
    depends: [baseShutro],
    groups: [
      defineGroup({ code: 'crm.user', label: 'CRM', implies: ['base.user'] }),
      defineGroup({ code: 'crm.manager', label: 'CRM manager', implies: ['crm.user'] }),
    ],
    models: [Partner, Deal, Note],
  }),
  kosh: '^0.1.0',
  depends: [base],
  accessLevels: { user: { label: 'User', groups: ['crm.user'] } },
  automationActions: [
    {
      key: 'crm.flag_vip',
      label: 'Mark the partner VIP',
      model: 'crm.deal',
      run: async (raw, record) => {
        const env = raw as Env;
        type Rows = {
          load(k: string[]): Promise<{ read(k: string[]): Record<string, unknown>[] }>;
        };
        const [deal] = (
          await (env.model('crm.deal' as never) as unknown as { browse(ids: number[]): Rows })
            .browse([record.id as number])
            .load(['partner'])
        ).read(['partner']);
        const partner = deal?.['partner'];
        if (typeof partner !== 'number') return 'no partner';
        await (
          env.model('res.partner' as never) as unknown as {
            browse(ids: number[]): { write(v: unknown): Promise<void> };
          }
        )
          .browse([partner])
          .write({ vip: true });
        return `partner ${partner} VIP`;
      },
    },
  ],
});

let container: StartedPostgreSqlContainer;
let server: KoshServer;
let company: number;
const users: Record<string, number> = {};
const tokens = new Map<string, string>();
let engine: ReturnType<typeof automationContext>;

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function call(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  as: string,
  payload?: unknown,
) {
  let token = tokens.get(as);
  if (token === undefined) {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { login: as, password: PASSWORD },
    });
    token = (res.json() as { token: string }).token;
    tokens.set(as, token);
  }
  const res = await server.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: res.statusCode, json: (res.body === '' ? null : res.json()) as Json };
}
const ok = async (
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  as: string,
  payload?: unknown,
): Promise<Json> => {
  const res = await call(method, url, as, payload);
  expect([200, 201, 204], `${method} ${url}: ${res.status} ${JSON.stringify(res.json)}`).toContain(
    res.status,
  );
  return res.json;
};
const rule = (values: Record<string, unknown>) =>
  ok('POST', '/api/v1/models/automation.rule', 'admin', {
    targetModel: 'crm.deal',
    trigger: 'created',
    actions: [],
    ...values,
  });
const runsOf = async (ruleId: number): Promise<Json[]> =>
  (
    await ok(
      'GET',
      `/api/v1/models/automation.run?fields=id,state,reason,outcomes,error,targetId,trigger&filter=${encodeURIComponent(JSON.stringify({ rule: ruleId }))}&order=id+asc`,
      'admin',
    )
  ).items;
const deal = async (as: string, values: Record<string, unknown>): Promise<number> =>
  (await ok('POST', '/api/v1/models/crm.deal', as, values)).id as number;
const read = (id: number, fields: string) =>
  ok('GET', `/api/v1/models/crm.deal/${id}?fields=${fields}`, 'dina');
const poll = async () => {
  let total = 0;
  for (;;) {
    const result = await pollAudit(engine, { limit: 50 });
    if (result === null || result.changes === 0) return total;
    total += result.runs;
  }
};

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  container = await new PostgreSqlContainer('postgres:18').start();
  server = await createServer({
    databaseUrl: container.getConnectionUri(),
    modules: [
      crm,
      messaging,
      notifyModule({ workers: false }),
      automationModule({ workers: false }),
    ],
    auth: { secureCookies: false, cacheMs: 0, loginLimit: 0 },
    rateLimit: { max: 0, timeWindow: '1 minute' },
    logger: false,
  });
  for (const statement of orm.createTableStatements(server.registry.registry))
    await server.driver.query(statement);
  for (const statement of orm.eventTableStatements()) await server.driver.query(statement);
  const auth = server.auth;
  if (auth === undefined) throw new Error('base is installed');
  ({ company } = await installBase(server.shutro, auth, {
    company: { name: 'Padma Traders', currency: 'BDT' },
    admin: { login: 'admin', name: 'Administrator', password: PASSWORD },
  }));
  for (const [login, name, groups] of [
    ['rahim', 'Rahim Uddin', ['crm.user', 'messaging.user']],
    ['dina', 'Dina Rahman', ['crm.manager', 'messaging.user', 'automation.user']],
    ['bob', 'Bob Smith', ['base.user']],
  ] as const)
    users[login] = await auth.createUser({
      login,
      name,
      password: PASSWORD,
      company,
      companies: [company],
      groups: [...groups],
    });
  await server.shutro.bootstrap({ reason: 'test', company }, async (env) => {
    await (
      env.model('mail.activity.type' as never) as unknown as {
        create(r: unknown[]): Promise<unknown>;
      }
    ).create([{ name: 'To-do', key: 'messaging.todo' }]);
  });
  // The administrator (2FA pending) has no rights beyond base; the rule routes need automation.manager.
  await auth.createUser({
    login: 'auto',
    name: 'Automation Manager',
    password: PASSWORD,
    company,
    companies: [company],
    groups: ['automation.manager', 'crm.manager', 'messaging.user'],
  });
  tokens.set(
    'admin',
    (
      await server.app
        .inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { login: 'auto', password: PASSWORD },
        })
        .then((r) => r.json() as { token: string })
    ).token,
  );
  engine = automationContext({
    shutro: server.shutro,
    driver: server.driver,
    registry: server.registry,
    auth: server.auth,
    app: server.app,
  } as never);
  await poll(); // the cursor starts after the set-up
}, 180_000);

afterAll(async () => {
  await server?.close();
  await container?.stop();
});

test('created: a note and a field set as the actor, once; a second poll adds nothing; the run log says what ran', async () => {
  const r = await rule({
    name: 'Welcome',
    actions: [
      {
        kind: 'set',
        values: {
          priority: 'high',
          amount: '1001',
          notes: 'Made by {{actor.name}} on {{today}}: {{name}}',
        },
      },
      { kind: 'note', text: 'Welcome, {{name}}!' },
    ],
  });
  const id = await deal('rahim', { name: 'Deal A', amount: '1000' });
  expect(await poll()).toBe(1);
  const got = await read(id, 'priority,notes,amount');
  expect(got.priority).toBe('high');
  expect(got.amount).toBe('1001');
  expect(got.notes).toMatch(/^Made by Rahim Uddin on \d{4}-\d{2}-\d{2}: Deal A$/);
  const chatter = await ok('GET', `/api/v1/chatter/crm.deal/${id}`, 'rahim');
  expect(chatter.items.find((i: Json) => i.type === 'message')?.body).toBe(
    '<p>Welcome, Deal A!</p>',
  );
  expect(await poll()).toBe(0); // the rule's own writes do not fire it again (loop guard), nothing else changed
  const runs = await runsOf(r.id);
  expect(runs).toHaveLength(2); // the creation (done), then the rule's own write (skipped: loop)
  expect(runs[0]).toMatchObject({ state: 'done', targetId: id, trigger: 'created' });
  expect(runs[0].outcomes.map((o: Json) => o.kind)).toEqual(['set', 'note']);
  expect(runs[1]).toMatchObject({ state: 'skipped', reason: 'loop' });
  await ok('PATCH', `/api/v1/models/automation.rule/${r.id}`, 'admin', { enabled: false });
});

test('updated: watched tracked fields, from / to values, a condition; an untracked field is refused', async () => {
  const r = await rule({
    name: 'Big deals',
    trigger: 'updated',
    watchFields: ['amount'],
    condition: { amount: { gte: '5000' } },
    actions: [{ kind: 'set', values: { priority: 'high' } }],
  });
  const untracked = await rule({
    name: 'Notes',
    trigger: 'updated',
    watchFields: ['notes'],
    actions: [{ kind: 'set', values: { priority: 'high' } }],
  });
  const won = await rule({
    name: 'Won',
    trigger: 'transition',
    fromValues: { state: 'new' },
    toValues: { state: 'won' },
    actions: [
      {
        kind: 'create',
        model: 'crm.note',
        values: { text: 'Won: {{name}} for {{amount}}', deal: '{{id}}' },
      },
    ],
  });
  const id = await deal('rahim', { name: 'Deal B', amount: '100' });
  await poll();
  await ok('PATCH', `/api/v1/models/crm.deal/${id}`, 'rahim', { amount: '200', notes: 'x' });
  await poll();
  expect((await runsOf(r.id)).map((x: Json) => [x.state, x.reason])).toEqual([
    ['skipped', 'trigger'],
    ['skipped', 'condition'],
  ]);
  expect((await read(id, 'priority')).priority).toBe('low'); // condition false
  await ok('PATCH', `/api/v1/models/crm.deal/${id}`, 'rahim', { amount: '9000' });
  await poll();
  expect((await read(id, 'priority')).priority).toBe('high');
  expect((await runsOf(untracked.id)).map((x: Json) => [x.state, x.reason])).toContainEqual([
    'skipped',
    'untracked',
  ]);
  await ok('POST', `/api/v1/models/crm.deal/${id}/transitions/win`, 'rahim');
  await poll();
  const notes = await ok('GET', `/api/v1/models/crm.note?fields=text,deal`, 'rahim');
  expect(notes.items).toEqual([
    expect.objectContaining({ text: 'Won: Deal B for 9000', deal: id }),
  ]);
  const wonRuns = await runsOf(won.id);
  expect(wonRuns.filter((x: Json) => x.state === 'done')).toHaveLength(1);
  for (const x of [r, untracked, won])
    await ok('PATCH', `/api/v1/models/automation.rule/${x.id}`, 'admin', { enabled: false });
});

test('runAs: the actor without rights fails and is logged; the system succeeds; a module action; an activity', async () => {
  // Rahim may not write partners: a rule running as him fails at the module action; as the system it works.
  const asActor = await rule({
    name: 'Flag (actor)',
    actions: [{ kind: 'action', key: 'crm.flag_vip' }],
    sequence: 1,
  });
  const asSystem = await rule({
    name: 'Flag (system)',
    runAs: 'system',
    sequence: 2,
    actions: [
      { kind: 'action', key: 'crm.flag_vip' },
      {
        kind: 'activity',
        type: 'To-do',
        summary: 'Call {{partner.name}}',
        assignee: ['field:user'],
        inDays: 2,
      },
      { kind: 'note', text: 'Flagged by the system' },
    ],
  });
  const partner = (await ok('POST', '/api/v1/models/res.partner', 'rahim', { name: 'Acme' }))
    .id as number;
  const id = await deal('rahim', { name: 'Deal C', partner });
  await poll();
  const actorRuns = await runsOf(asActor.id);
  expect(actorRuns[0]).toMatchObject({ state: 'failed', targetId: id });
  expect(actorRuns[0].outcomes[0]).toMatchObject({ kind: 'action', outcome: 'failed' });
  const systemRuns = await runsOf(asSystem.id);
  expect(systemRuns[0]).toMatchObject({ state: 'done', targetId: id });
  expect(systemRuns[0].outcomes.map((o: Json) => o.outcome)).toEqual(['done', 'done', 'done']);
  const noted = await ok('GET', `/api/v1/chatter/crm.deal/${id}`, 'rahim');
  expect(noted.items.find((i: Json) => i.type === 'message')).toMatchObject({
    author: null,
    authorName: 'Rule: Flag (system)',
    body: '<p>Flagged by the system</p>',
  });
  expect((await ok('GET', `/api/v1/models/res.partner/${partner}?fields=vip`, 'dina')).vip).toBe(
    true,
  );
  const activities = await ok('GET', '/api/v1/activities/mine', 'rahim'); // the deal's user
  expect(activities.activities.map((a: Json) => a.summary)).toContain('Call Acme');
  // A retry of the failed run, by a manager: it fails the same way, as a new run.
  const retried = await ok('POST', `/api/v1/automation/runs/${actorRuns[0].id}/retry`, 'admin');
  expect(retried.outcomes[0]).toMatchObject({ kind: 'action', outcome: 'failed' });
  for (const x of [asActor, asSystem])
    await ok('PATCH', `/api/v1/models/automation.rule/${x.id}`, 'admin', { enabled: false });
});

test('event: an outbox event fires an event rule; notify reaches the inbox through the pipeline', async () => {
  const r = await rule({
    name: 'Won event',
    trigger: 'event',
    topic: 'crm.deal.won',
    actions: [{ kind: 'notify', users: [users['dina']], text: 'We won {{name}}!' }],
  });
  await pollOutbox(engine); // the cursor starts after the set-up
  const inbox = inboxWorkers({
    shutro: server.shutro,
    driver: server.driver,
    registry: server.registry,
    auth: server.auth,
    baseUrl: 'http://x',
  });
  for (const w of inbox) await w.drain();
  const id = await deal('rahim', { name: 'Deal D' });
  // What an app does on its transition's `after` hook: the event in the same transaction.
  await server.shutro.run(
    { user: users['rahim'] as number, company, companies: [company], groups: ['crm.user'] },
    (env: Env) => env.emit('crm.deal.won', { model: 'crm.deal', id }),
  );
  await poll();
  const polled = await pollOutbox(engine);
  expect(polled?.runs).toBe(1);
  for (const w of inbox) await w.drain();
  expect((await runsOf(r.id))[0]).toMatchObject({ state: 'done', trigger: 'event', targetId: id });
  const notifications = await ok('GET', '/api/v1/notifications', 'dina');
  expect(notifications.items[0]).toMatchObject({
    kind: 'automation',
    params: { text: 'We won Deal D!' },
  });
  await ok('PATCH', `/api/v1/models/automation.rule/${r.id}`, 'admin', { enabled: false });
});

test('a dry run renders the actions without running them; permissions: users read runs, not rules', async () => {
  const r = await rule({
    name: 'Dry',
    condition: { amount: { gt: '10' } },
    actions: [{ kind: 'note', text: 'Hello {{name}}' }],
  });
  const id = await deal('rahim', { name: 'Deal E', amount: '50' });
  await poll();
  const dry = await ok('POST', `/api/v1/automation/rules/${r.id}/test`, 'admin', { record: id });
  expect(dry).toEqual({ matches: true, actions: [{ kind: 'note', text: 'Hello Deal E' }] });
  expect((await call('GET', '/api/v1/models/automation.rule', 'rahim')).status).toBe(403);
  expect((await call('GET', '/api/v1/models/automation.run', 'dina')).status).toBe(200);
  expect(
    (
      await call('POST', '/api/v1/models/automation.rule', 'dina', {
        name: 'x',
        targetModel: 'crm.deal',
        trigger: 'created',
        actions: [],
      })
    ).status,
  ).toBe(403);
  // "Run pending changes now": managers only; it reads the trail and the outbox once.
  expect((await call('POST', '/api/v1/automation/poll', 'rahim')).status).toBe(403);
  const polled = await ok('POST', '/api/v1/automation/poll', 'admin');
  expect(polled).toMatchObject({ changes: 0, runs: 0 }); // earlier events may still be counted, none fires a rule
  const info = await ok('GET', '/api/v1/automation/models/crm.deal', 'admin');
  expect(info.tracked.sort()).toEqual(['amount', 'partner', 'state']);
  expect(info.transitions).toContain('win');
});

const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

test('date: a record whose date is reached fires once per date value; a moved date fires again when reached', async () => {
  const r = await rule({
    name: 'Closing soon',
    trigger: 'date',
    dateField: 'closeDate',
    dateOffsetDays: -2, // two days before the date
    runAs: 'system',
    actions: [{ kind: 'note', text: '{{name}} closes on {{closeDate}}' }],
  });
  const soon = await deal('rahim', { name: 'Deal T1', closeDate: day(1) }); // in the window
  const later = await deal('rahim', { name: 'Deal T2', closeDate: day(30) }); // not yet
  await poll();
  expect((await pollTimed(engine)).runs).toBe(1);
  expect((await pollTimed(engine)).runs).toBe(0); // once per record and date
  expect((await runsOf(r.id)).map((x: Json) => [x.targetId, x.state])).toEqual([[soon, 'done']]);
  // The later deal moves closer: it fires now.
  await ok('PATCH', `/api/v1/models/crm.deal/${later}`, 'rahim', { closeDate: day(2) });
  expect((await pollTimed(engine)).runs).toBe(1);
  // The first deal's date moves, and is reached again: it fires again, for the new date.
  await ok('PATCH', `/api/v1/models/crm.deal/${soon}`, 'rahim', { closeDate: day(0) });
  expect((await pollTimed(engine)).runs).toBe(1);
  const notes = await ok('GET', `/api/v1/chatter/crm.deal/${soon}`, 'rahim');
  expect(notes.items.filter((i: Json) => i.type === 'message').map((i: Json) => i.body)).toEqual([
    `<p>Deal T1 closes on ${day(0)}</p>`,
    `<p>Deal T1 closes on ${day(1)}</p>`,
  ]);
  await ok('PATCH', `/api/v1/models/automation.rule/${r.id}`, 'admin', { enabled: false });
});

test('schedule: the rule runs on the records of its condition when its cron slot is due, once per slot', async () => {
  const r = await rule({
    name: 'Nightly',
    trigger: 'schedule',
    cron: '0 2 * * *',
    runAs: 'system',
    condition: { priority: 'high', name: { ilike: 'Deal A%' } },
    actions: [{ kind: 'note', text: 'Nightly check of {{name}}' }],
  });
  expect((await pollTimed(engine)).runs).toBe(0); // the next 02:00 has not come
  const tomorrow = new Date(Date.now() + 26 * 3_600_000);
  const due = await pollTimed(engine, { now: tomorrow });
  expect(due.runs).toBe(1); // Deal A is high priority
  expect((await pollTimed(engine, { now: tomorrow })).runs).toBe(0); // the slot is done
  const runs = await runsOf(r.id);
  expect(runs.filter((x: Json) => x.state === 'done')).toHaveLength(1);
  await ok('PATCH', `/api/v1/models/automation.rule/${r.id}`, 'admin', { enabled: false });
});

test('webhook: a signed JSON POST through a job, to an allowed host only; a failure is retried by the job', async () => {
  const received: { body: string; signature: string; rule: string }[] = [];
  let status = 200;
  const read = (request: IncomingMessage): Promise<string> =>
    new Promise((resolve) => {
      let data = '';
      request.on('data', (chunk) => {
        data += String(chunk);
      });
      request.on('end', () => resolve(data));
    });
  const hook = createHttpServer(async (request, response) => {
    received.push({
      body: await read(request),
      signature: String(request.headers['x-kosh-signature'] ?? ''),
      rule: String(request.headers['x-kosh-rule'] ?? ''),
    });
    response.writeHead(status);
    response.end();
  });
  await new Promise<void>((resolve) => hook.listen(0, '127.0.0.1', resolve));
  const address = hook.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  process.env['KOSH_AUTOMATION_WEBHOOK_HOSTS'] = '127.0.0.1';
  try {
    const r = await rule({
      name: 'To the CRM',
      actions: [
        {
          kind: 'webhook',
          url: `http://127.0.0.1:${address.port}/deals`,
          fields: ['name', 'amount'],
        },
      ],
    });
    const blocked = await rule({
      name: 'Elsewhere',
      actions: [{ kind: 'webhook', url: 'https://evil.test/x' }],
    });
    const id = await deal('rahim', { name: 'Deal W', amount: '42' });
    await poll();
    expect((await runsOf(blocked.id))[0]).toMatchObject({ state: 'failed' });
    expect((await runsOf(blocked.id))[0].error).toContain('allow-list');
    const worker = webhookWorker(engine);
    status = 500; // the first delivery fails
    await worker.drain();
    expect(received).toHaveLength(1);
    status = 200;
    await server.driver.query({
      text: "UPDATE shutro_job SET run_at = now() WHERE name = 'automation.webhook'",
      params: [],
    });
    await worker.drain();
    expect(received).toHaveLength(2); // retried
    const last = received[1] as { body: string; signature: string; rule: string };
    const body = JSON.parse(last.body) as Json;
    expect(body).toMatchObject({
      rule: { id: r.id, name: 'To the CRM' },
      trigger: 'created',
      model: 'crm.deal',
      id,
      record: { id, name: 'Deal W', amount: '42' },
    });
    const [secret] = await server.driver.query<{ webhook_secret: string }>({
      text: 'SELECT webhook_secret FROM automation_rule WHERE id = $1',
      params: [r.id],
    });
    expect(last.signature).toBe(signWebhook(secret?.webhook_secret as string, last.body));
    expect(last.rule).toBe(String(r.id));
    for (const x of [r, blocked])
      await ok('PATCH', `/api/v1/models/automation.rule/${x.id}`, 'admin', { enabled: false });
  } finally {
    delete process.env['KOSH_AUTOMATION_WEBHOOK_HOSTS'];
    await new Promise<void>((resolve) => hook.close(() => resolve()));
  }
});
