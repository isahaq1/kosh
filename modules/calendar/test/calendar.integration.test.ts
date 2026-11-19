/**
 * Agenda on real PostgreSQL through the HTTP API (RFC 0021): public events for every Agenda user, private ones for
 * their organizer and attendees; only the organizer changes an event, each attendee answers for themself; a room is
 * never double-booked, not even against someone else's private event; free / busy names only what the caller may
 * see; the end follows the start by the default length of App settings; the demo data loads.
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
  installDemo,
  prepareApps,
  recordInstalledApps,
} from '@kosh/server';
import { type Driver, orm, pg } from '@kosh/server/orm';
import { type TestDatabase, testDatabase } from '@kosh/server/testing';
import { settings } from '@kosh/settings';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { calendarApp } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [base, settings, calendarApp];
const E = '/api/v1/models/calendar.event';

let container: TestDatabase;
let driver: Driver;
let dir: string;
let host: AppHost;
let company: number;
let room = 0;
const users: Record<string, number> = {};
const tokens = new Map<string, string>();

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function call(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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
const titles = async (as: string) =>
  ((await call('GET', `${E}?fields=name&order=name+asc`, as)).json.items as Json[]).map(
    (e) => e.name,
  );

beforeAll(async () => {
  container = await testDatabase();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-calendar-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({ driver, catalogue, change: { install: ['settings', 'calendar'] }, dir }),
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
  for (const [login, groups] of [
    ['dina', ['calendar.manager']],
    ['rahim', ['calendar.user']],
    ['sumi', ['calendar.user']],
    ['bob', ['base.user']],
  ] as const)
    users[login] = await auth.createUser({
      login,
      name: login,
      password: PASSWORD,
      company,
      companies: [company],
      groups: [...groups],
    });
  room = (
    await call('POST', '/api/v1/models/calendar.room', 'dina', { name: 'Board room', capacity: 10 })
  ).json.id;
}, 240_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('public for everyone, private for organizer and attendees; the organizer changes it, attendees answer', async () => {
  const review = await call('POST', E, 'rahim', {
    name: 'Review',
    start: '2026-11-02T09:00:00Z',
    stop: '2026-11-02T10:00:00Z',
    attendees: { create: [{ user: users['sumi'] }] },
  });
  expect(review.status, JSON.stringify(review.json)).toBe(201);
  const secret = await call('POST', E, 'rahim', {
    name: 'Doctor',
    start: '2026-11-03T09:00:00Z',
    stop: '2026-11-03T10:00:00Z',
    privacy: 'private',
  });
  expect(secret.status).toBe(201);

  expect(await titles('rahim')).toEqual(['Doctor', 'Review']);
  expect(await titles('sumi')).toEqual(['Review']);
  expect(await titles('dina')).toEqual(['Doctor', 'Review']); // the manager
  expect((await call('GET', E, 'bob')).status).toBe(403);

  expect((await call('PATCH', `${E}/${review.json.id}`, 'sumi', { name: 'Mine now' })).status).toBe(
    403,
  );
  const answer = await call('POST', `/api/v1/agenda/events/${review.json.id}/respond`, 'sumi', {
    response: 'accepted',
  });
  expect(answer.status, JSON.stringify(answer.json)).toBe(200);
  expect(
    (
      await call('POST', `/api/v1/agenda/events/${review.json.id}/respond`, 'sumi', {
        response: 'maybe',
      })
    ).status,
  ).toBe(422);
  expect(
    (
      await call('POST', `/api/v1/agenda/events/${secret.json.id}/respond`, 'sumi', {
        response: 'accepted',
      })
    ).status,
  ).toBe(404);
  const [row] = await driver.query<{ response: string }>({
    text: 'SELECT response FROM calendar_attendee WHERE event_id = $1',
    params: [review.json.id],
  });
  expect(row?.response).toBe('accepted');
});

test('a room is never double-booked, not even against a private event; free / busy hides what is private', async () => {
  const booked = await call('POST', E, 'rahim', {
    name: 'Interview',
    start: '2026-11-04T09:00:00Z',
    stop: '2026-11-04T10:00:00Z',
    room,
    privacy: 'private',
  });
  expect(booked.status, JSON.stringify(booked.json)).toBe(201);
  const clash = await call('POST', E, 'sumi', {
    name: 'Planning',
    start: '2026-11-04T09:30:00Z',
    stop: '2026-11-04T10:30:00Z',
    room,
  });
  expect(clash.status).toBe(422);
  expect(JSON.stringify(clash.json)).toContain('already booked');
  // Right after is fine; a cancelled booking frees the room.
  expect(
    (
      await call('POST', E, 'sumi', {
        name: 'After',
        start: '2026-11-04T10:00:00Z',
        stop: '2026-11-04T11:00:00Z',
        room,
      })
    ).status,
  ).toBe(201);
  expect((await call('POST', `${E}/${booked.json.id}/transitions/cancel`, 'rahim')).status).toBe(
    200,
  );
  expect(
    (
      await call('POST', E, 'sumi', {
        name: 'Planning',
        start: '2026-11-04T09:00:00Z',
        stop: '2026-11-04T09:30:00Z',
        room,
      })
    ).status,
  ).toBe(201);
  expect(
    (
      await call('POST', E, 'sumi', {
        name: 'Backwards',
        start: '2026-11-05T10:00:00Z',
        stop: '2026-11-05T09:00:00Z',
      })
    ).status,
  ).toBe(422);

  const busy = await call(
    'GET',
    `/api/v1/agenda/busy?users=${users['rahim']}&rooms=${room}&from=2026-11-01T00:00:00Z&to=2026-11-06T00:00:00Z`,
    'sumi',
  );
  expect(busy.status, JSON.stringify(busy.json)).toBe(200);
  const rahim = busy.json.users[String(users['rahim'])] as Json[];
  // His private Doctor: busy only, no title.
  expect(rahim.map((b) => b.title)).toEqual(expect.arrayContaining([null, 'Review']));
  expect(rahim).toHaveLength(2);
  expect((busy.json.rooms[String(room)] as Json[]).map((b) => b.title).sort()).toEqual([
    'After',
    'Planning',
  ]);
  expect((await call('GET', `/api/v1/agenda/busy?users=1&from=x&to=y`, 'sumi')).status).toBe(400);
  expect(
    (
      await call(
        'GET',
        `/api/v1/agenda/busy?users=1&from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z`,
        'bob',
      )
    ).status,
  ).toBe(403);
});

test('the end follows the start by the default length of App settings', async () => {
  const onchange = async () =>
    (
      await call('POST', `${E}/onchange`, 'rahim', {
        values: { name: 'Call', start: '2026-11-06T09:00:00Z' },
        changed: ['start'],
      })
    ).json;
  expect(new Date((await onchange()).values.stop).toISOString()).toBe('2026-11-06T10:00:00.000Z');
  const set = await call('PATCH', '/api/v1/settings/app-settings/calendar/events', 'dina', {
    values: { defaultMinutes: 30 },
  });
  expect(set.status, JSON.stringify(set.json)).toBe(200);
  expect(new Date((await onchange()).values.stop).toISOString()).toBe('2026-11-06T09:30:00.000Z');
  expect(
    (
      await call('PATCH', '/api/v1/settings/app-settings/calendar/events', 'rahim', {
        values: { defaultMinutes: 45 },
      })
    ).status,
  ).toBe(403);
});

test('a repeating event: generated as events of their own, redone after a change, stopped; a taken room refuses it (RFC 0034)', async () => {
  const R = '/api/v1/models/calendar.recurrence';
  const step = (id: number, name: string, as: string) =>
    call('POST', `${R}/${id}/transitions/${name}`, as);
  /** The series' occurrences as `MM-DD HH:MM title` in UTC, in order. */
  const occurrencesOf = async (id: number, as = 'rahim') =>
    (
      (
        await call(
          'GET',
          `${E}?filter=${encodeURIComponent(JSON.stringify({ recurrence: id }))}&fields=name,start,stop,room,detached&order=start%20asc&limit=400`,
          as,
        )
      ).json.items as Json[]
    ).map((e) => ({
      ...e,
      at: `${String(e.start).slice(5, 10)} ${String(e.start).slice(11, 16)} ${e.name}`,
    }));

  // A rule without an end, or repeating every 0, is refused.
  const base = {
    name: 'Weekly review',
    start: '2030-01-07T04:00:00Z', // Monday 10:00 in Dhaka
    stop: '2030-01-07T05:00:00Z',
    freq: 'weekly',
    onMon: true,
    onWed: true,
    room,
    people: { set: [users['sumi']] },
  };
  expect((await call('POST', R, 'rahim', base)).status).toBe(422);
  expect((await call('POST', R, 'rahim', { ...base, count: 4, interval: 0 })).status).toBe(422);
  const made = await call('POST', R, 'rahim', { ...base, count: 4 });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  const id = made.json.id as number;
  expect((await call('GET', `${R}/${id}?fields=summary,state`, 'rahim')).json).toMatchObject({
    summary: 'Every week on Monday and Wednesday, 4 times',
    state: 'draft',
  });
  // Not someone else's to generate; nobody outside Agenda sees it.
  expect((await step(id, 'generate', 'sumi')).status).toBe(403);
  expect((await call('GET', R, 'bob')).status).toBe(403);

  expect((await step(id, 'generate', 'rahim')).status).toBe(200);
  let events = await occurrencesOf(id);
  expect(events.map((e) => e.at)).toEqual([
    '01-07 04:00 Weekly review',
    '01-09 04:00 Weekly review',
    '01-14 04:00 Weekly review',
    '01-16 04:00 Weekly review',
  ]);
  // Each is an event of its own: an hour long, in the room, with Sumi invited — who sees them.
  expect(String(events[0]?.stop).slice(11, 16)).toBe('05:00');
  expect(events.every((e) => (e.room?.id ?? e.room) === room)).toBe(true);
  expect(await occurrencesOf(id, 'sumi')).toHaveLength(4);
  const attendees = (
    await call(
      'GET',
      `/api/v1/models/calendar.attendee?filter=${encodeURIComponent(JSON.stringify({ event: events[0]?.id }))}&fields=user,response`,
      'rahim',
    )
  ).json.items as Json[];
  expect(attendees.map((a) => [a.user?.id ?? a.user, a.response])).toEqual([
    [users['sumi'], 'needs_action'],
  ]);

  // Another series in the same room at that hour is refused, naming the date; nothing of it is made.
  const other = await call('POST', R, 'sumi', {
    name: 'Stand-up',
    start: '2030-01-14T04:30:00Z',
    stop: '2030-01-14T04:45:00Z',
    freq: 'daily',
    count: 3,
    room,
  });
  expect(other.status, JSON.stringify(other.json)).toBe(201);
  const refused = await step(other.json.id, 'generate', 'sumi');
  expect(refused.status).toBe(422);
  expect(JSON.stringify(refused.json)).toContain('already booked on 2030-01-14');
  expect(await occurrencesOf(other.json.id, 'sumi')).toEqual([]);
  expect((await call('GET', `${R}/${other.json.id}?fields=state`, 'sumi')).json.state).toBe(
    'draft',
  );

  // One occurrence is moved by hand, another is kept as it is; then the series changes: renamed, six times.
  expect(
    (
      await call('PATCH', `${E}/${events[1]?.id}`, 'rahim', {
        start: '2030-01-09T08:00:00Z',
        stop: '2030-01-09T09:00:00Z',
      })
    ).status,
  ).toBe(200);
  expect((await call('PATCH', `${E}/${events[2]?.id}`, 'rahim', { detached: true })).status).toBe(
    200,
  );
  expect((await call('PATCH', `${R}/${id}`, 'rahim', { name: 'Review', count: 6 })).status).toBe(
    200,
  );
  expect((await step(id, 'generate', 'rahim')).status).toBe(200);
  events = await occurrencesOf(id);
  expect(events.map((e) => e.at)).toEqual([
    '01-07 04:00 Review',
    '01-09 08:00 Weekly review', // moved by hand: left alone
    '01-14 04:00 Weekly review', // kept as it is
    '01-16 04:00 Review',
    '01-21 04:00 Review',
    '01-23 04:00 Review',
  ]);

  // Stopped: what was still the series' own is removed; the two that are their own stay.
  expect((await step(id, 'halt', 'rahim')).status).toBe(200);
  expect((await occurrencesOf(id)).map((e) => e.at)).toEqual([
    '01-09 08:00 Weekly review',
    '01-14 04:00 Weekly review',
  ]);
  expect((await call('GET', `${R}/${id}?fields=state`, 'rahim')).json.state).toBe('stopped');
});

test('a repeating event on a day off: moved to the working day after, by the working calendar', async () => {
  const R = '/api/v1/models/calendar.recurrence';
  // Fridays from 4 January 2030, 11:00 in Dhaka; Friday and Saturday are the weekend.
  const made = await call('POST', R, 'sumi', {
    name: 'Site visit',
    start: '2030-01-04T05:00:00Z',
    stop: '2030-01-04T06:00:00Z',
    freq: 'weekly',
    count: 2,
    onDayOff: 'after',
  });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  expect((await call('POST', `${R}/${made.json.id}/transitions/generate`, 'sumi')).status).toBe(
    200,
  );
  const events = (
    await call(
      'GET',
      `${E}?filter=${encodeURIComponent(JSON.stringify({ recurrence: made.json.id }))}&fields=start&order=start%20asc`,
      'sumi',
    )
  ).json.items as Json[];
  // Sunday the 6th and Sunday the 13th, at the same time of day.
  expect(events.map((e) => new Date(e.start).toISOString())).toEqual([
    '2030-01-06T05:00:00.000Z',
    '2030-01-13T05:00:00.000Z',
  ]);
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
  expect(JSON.stringify(summary)).toContain('Agenda');
});

test('the overview of the app (RFC 0022 step 2) is served to a user', async () => {
  const overview = await call('GET', '/api/v1/reports/overview?app=agenda', 'rahim');
  expect(overview.status, JSON.stringify(overview.json)).toBe(200);
  expect(overview.json.cards.map((c: { id: string }) => c.id)).toContain('month');
});
