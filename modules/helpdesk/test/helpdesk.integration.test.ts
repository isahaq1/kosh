/**
 * Helpdesk on real PostgreSQL through the HTTP API (RFC 0024 §2.4): tickets assigned in turn with the SLA policy
 * that matches them (urgent ones the faster); agents see their team's tickets only; the first reply read from the
 * chatter; waiting on the customer pauses the resolution clock and the customer's email resumes it; a breach; the
 * rating link, once; merging; canned replies; tickets from email with the sender as the customer; the demo data.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { helpdesk, ticketFromEmail } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [base, settings, helpdesk];
const T = '/api/v1/models/helpdesk.ticket';

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let host: AppHost;
let company: number;
let team: number;
const users: Record<string, number> = {};
const tickets: Record<string, number> = {};
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
  const json =
    res.headers['content-type']?.toString().includes('json') && res.body !== '' ? res.json() : null;
  return { status: res.statusCode, json: json as Json, body: res.body };
}
const refresh = async () =>
  expect((await call('POST', '/api/v1/helpdesk/refresh', 'mona')).status).toBe(200);
const read = async (id: number, fields: string) =>
  (await call('GET', `${T}/${id}?fields=${fields}`, 'mona')).json;
const ago = (id: number, column: string, interval: string) =>
  driver.query({
    text: `UPDATE helpdesk_ticket SET ${column} = ${column} - interval '${interval}' WHERE id = $1`,
    params: [id],
  });

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-helpdesk-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({ driver, catalogue, change: { install: ['settings', 'helpdesk'] }, dir }),
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
    ['mona', ['helpdesk.manager']],
    ['ali', ['helpdesk.user']],
    ['bea', ['helpdesk.user']],
    ['cid', ['helpdesk.user']],
  ] as const)
    users[login] = await auth.createUser({
      login,
      name: login,
      password: PASSWORD,
      company,
      companies: [company],
      groups: [...groups],
    });
  // Open around the clock, so the deadlines are hours from now whatever the time the test runs.
  team = (
    await call('POST', '/api/v1/models/helpdesk.team', 'mona', {
      name: 'Support',
      members: { set: [users['ali'], users['bea']] },
      assignment: 'round_robin',
      open: '00:00',
      close: '23:59',
      weekend: 'none',
    })
  ).json.id;
  for (const policy of [
    {
      name: 'Urgent',
      sequence: 5,
      team,
      priority: 'urgent',
      firstReplyHours: '1',
      resolveHours: '8',
    },
    { name: 'Standard', sequence: 20, team, firstReplyHours: '4', resolveHours: '24' },
  ])
    expect((await call('POST', '/api/v1/models/helpdesk.sla', 'mona', policy)).status).toBe(201);
}, 240_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('assigned in turn, the matching SLA, the team’s tickets only', async () => {
  for (const [key, priority] of [
    ['a', 'normal'],
    ['b', 'urgent'],
  ] as const)
    tickets[key] = (
      await call('POST', T, 'mona', {
        subject: `Ticket ${key}`,
        team,
        priority,
        email: `${key}@customer.example`,
      })
    ).json.id;
  await refresh();
  const a = await read(
    tickets['a'] as number,
    'assignee,sla,slaStatus,firstReplyDeadline,resolveDeadline',
  );
  const b = await read(tickets['b'] as number, 'assignee,sla,slaStatus');
  const assignees = [a.assignee?.id ?? a.assignee, b.assignee?.id ?? b.assignee];
  expect(new Set(assignees)).toEqual(new Set([users['ali'], users['bea']])); // in turn: one each
  expect(a.slaStatus).toBe('on_track');
  const hoursAhead = (iso: string) => (Date.parse(iso) - Date.now()) / 3_600_000;
  expect(hoursAhead(a.firstReplyDeadline)).toBeGreaterThan(3.8);
  expect(hoursAhead(a.resolveDeadline)).toBeGreaterThan(23.5);
  const policies = (await call('GET', '/api/v1/models/helpdesk.sla?fields=name', 'mona')).json
    .items as Json[];
  const urgent = policies.find((p) => p.name === 'Urgent').id;
  expect(b.sla?.id ?? b.sla).toBe(urgent);
  // Cid is in no team: nothing to see; Ali sees the team's.
  expect((await call('GET', `${T}?fields=subject`, 'cid')).json.items).toEqual([]);
  expect((await call('GET', `${T}?fields=subject`, 'ali')).json.items).toHaveLength(2);
});

test('the first reply from the chatter; waiting pauses the clock, the customer’s email resumes it; a breach', async () => {
  const a = tickets['a'] as number;
  const posted = await call('POST', `/api/v1/chatter/helpdesk.ticket/${a}/messages`, 'ali', {
    kind: 'comment',
    text: 'Looking into it.',
  });
  expect(posted.status, posted.body).toBe(201);
  await refresh();
  expect((await read(a, 'firstRepliedAt')).firstRepliedAt).toBeTruthy();

  expect((await call('POST', `${T}/${a}/transitions/wait`, 'ali')).status).toBe(200);
  const before = Date.parse((await read(a, 'resolveDeadline')).resolveDeadline);
  await ago(a, 'waiting_since', '2 hours'); // as if it had waited two hours
  // The customer writes back by email (a message without an author, naming the sender).
  await host.server.shutro.bootstrap({ reason: 'test inbound', company }, async (env) => {
    await (
      env.model('mail.message' as never) as unknown as { create(rows: unknown[]): Promise<unknown> }
    ).create([
      {
        resModel: 'helpdesk.ticket',
        resId: a,
        kind: 'comment',
        authorEmail: 'a@customer.example',
        authorName: 'A Customer',
        text: 'Here is the screenshot.',
        body: '<p>Here is the screenshot.</p>',
      },
    ]);
    await env.flush();
  });
  await refresh();
  const resumed = await read(a, 'state,pausedMinutes,resolveDeadline');
  expect(resumed.state).toBe('open');
  expect(resumed.pausedMinutes).toBeGreaterThanOrEqual(115); // two hours, the night minute aside
  expect(Date.parse(resumed.resolveDeadline) - before).toBeGreaterThan(110 * 60_000);

  // B, urgent, opened nine hours ago without a reply: breached.
  await ago(tickets['b'] as number, 'created_at', '9 hours');
  await refresh();
  expect((await read(tickets['b'] as number, 'slaStatus')).slaStatus).toBe('breached');
});

test('solved: met, the rating link once; merging; canned replies', async () => {
  const a = tickets['a'] as number;
  expect((await call('POST', `${T}/${a}/transitions/solve`, 'ali')).status).toBe(200);
  await refresh();
  const solved = await read(a, 'slaStatus,ratingToken,solvedAt');
  expect(solved.slaStatus).toBe('met');
  expect(solved.ratingToken).toHaveLength(32);
  expect(
    (await call('GET', `${T}/${a}?fields=ratingToken`, 'ali')).json.ratingToken,
  ).toBeUndefined();
  const link = `/api/v1/public/helpdesk/rate?token=${solved.ratingToken}&score=5`;
  const first = await host.server.app.inject({ method: 'GET', url: link });
  expect(first.statusCode).toBe(200);
  expect(first.body).toContain('★★★★★');
  expect((await host.server.app.inject({ method: 'GET', url: link })).statusCode).toBe(404);
  expect((await read(a, 'rating')).rating).toBe(5);

  // A duplicate merged into B, its conversation with it.
  const dup = (await call('POST', T, 'ali', { subject: 'Same as B', team })).json.id as number;
  await call('POST', `/api/v1/chatter/helpdesk.ticket/${dup}/messages`, 'ali', {
    kind: 'note',
    text: 'dup',
  });
  const merged = await call('POST', `/api/v1/helpdesk/tickets/${dup}/merge`, 'ali', {
    into: tickets['b'],
  });
  expect(merged.status, merged.body).toBe(200);
  expect(merged.json.moved).toBeGreaterThanOrEqual(1);
  expect((await read(dup, 'state,mergedInto')).state).toBe('merged');
  expect(
    (await call('POST', `/api/v1/helpdesk/tickets/${dup}/merge`, 'cid', { into: tickets['b'] }))
      .status,
  ).toBe(404);

  const canned = (
    await call('POST', '/api/v1/models/helpdesk.canned', 'mona', {
      name: 'Ack',
      body: 'Dear {{customer}}, about {{ticket}}: on it. {{agent}}',
    })
  ).json.id;
  const filled = await call(
    'GET',
    `/api/v1/helpdesk/tickets/${tickets['b']}/canned/${canned}`,
    'ali',
  );
  expect(filled.json.text).toMatch(/^Dear b@customer\.example, about HD\/\d{4}\/\d+: on it\./);
});

test('from email: the sender found or added as a contact, the first team', async () => {
  const values = await host.server.shutro.bootstrap(
    { reason: 'test alias', company },
    async (env) => {
      const one = await ticketFromEmail(env, {
        address: 'Rina@Meghna.example',
        name: 'Rina Akter',
      });
      const two = await ticketFromEmail(env, { address: 'rina@meghna.example', name: null });
      return [one, two];
    },
  );
  expect(values[0]).toMatchObject({ team, email: 'rina@meghna.example' });
  expect(values[1]?.['partner']).toBe(values[0]?.['partner']);
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
  expect(JSON.stringify(summary)).toContain('Helpdesk');
});
