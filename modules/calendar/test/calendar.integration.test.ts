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
import { settings } from '@kosh/settings';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { calendarApp } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [base, settings, calendarApp];
const E = '/api/v1/models/calendar.event';

let container: StartedPostgreSqlContainer;
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
  container = await new PostgreSqlContainer('postgres:18').start();
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
