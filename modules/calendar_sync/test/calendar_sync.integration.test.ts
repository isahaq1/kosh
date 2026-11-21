/**
 * Two-way calendar sync on real PostgreSQL (RFC 0034 §2.4), with the test calendar: a person connects their
 * calendar by a consent whose answer works once; their own events here appear there and what they add there
 * appears here, private; a second sync does nothing; changes and deletions travel both ways; a token that ended is
 * renewed; tokens are sealed and never served; a connected calendar is its person's alone; disconnecting leaves
 * the events where they are.
 */
import { type TestInstallation, testInstallation } from '@kosh/server/testing';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { calendarSyncModule, type EventFields, fakeProvider } from '../src/index.js';

let erp: TestInstallation;
const fake = fakeProvider();
const KEY = 'test-key-for-secrets-at-rest-0123456789';
const S = '/api/v1/agenda/sync';
const E = '/api/v1/models/calendar.event';
let account = 0;

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
const call = async (
  as: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  body?: unknown,
) => {
  const res = await erp.call(method, url, as, body);
  return { status: res.status, json: res.json as Json };
};
const at = (hour: number, day = 3): string => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + day);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};
const fields = (title: string, over: Partial<EventFields> = {}): EventFields => ({
  title,
  start: at(9),
  stop: at(10),
  allDay: false,
  location: null,
  description: null,
  ...over,
});
/** The person says yes at the provider, which sends their browser back with a code. */
const consent = async (as: string, calendar: string) => {
  const asked = await call(as, 'POST', `${S}/connect`, { provider: 'fake' });
  expect(asked.status, JSON.stringify(asked.json)).toBe(200);
  const state = new URL(asked.json.url, 'http://localhost').searchParams.get('state') ?? '';
  const back = await erp.host.server.app.inject({
    method: 'GET',
    url: `${S}/callback?${new URLSearchParams({ code: calendar, state }).toString()}`,
  });
  return { state, location: String(back.headers.location ?? ''), status: back.statusCode };
};
const run = async (as = 'dina') => {
  const res = await call(as, 'POST', `${S}/${account}/run`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json as { pushed: number; pulled: number; deletedHere: number; deletedThere: number };
};
const mine = () => fake.calendar('dina-cal').events;
const remoteTitles = (): string[] => [...mine().values()].map((e) => e.fields.title).sort();
const localTitles = async (as = 'dina'): Promise<string[]> =>
  ((await call(as, 'GET', `${E}?fields=name&limit=200`)).json.items as Json[])
    .map((e) => e.name as string)
    .sort();
const eventNamed = async (name: string): Promise<Json> =>
  (
    (await call('dina', 'GET', `${E}?fields=name,privacy,organizer,location,description,state`))
      .json.items as Json[]
  ).find((e) => e.name === name);

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  erp = await testInstallation({
    modules: [
      calendarSyncModule({
        providers: new Map([[fake.code, fake]]),
        secretsKey: KEY,
        workers: false,
        apiUrl: 'http://localhost:3000',
        webUrl: 'http://localhost:5173',
      }),
    ],
    users: {
      dina: ['calendar_sync.user'],
      rahim: ['calendar_sync.user'],
      // Of Agenda, but without the role that lets a calendar leave the company.
      bob: ['calendar.user'],
    },
    company: { name: 'Padma Traders', currency: 'BDT' },
  });
}, 300_000);

afterAll(async () => {
  await erp?.close();
});

test('connecting: a consent whose answer works once, for the person who asked', async () => {
  const before = await call('dina', 'GET', S);
  expect(before.json).toMatchObject({
    ready: true,
    providers: [{ code: 'fake', label: 'Test calendar', configured: true }],
    accounts: [],
  });
  // A state nobody was given, and a code without a state: refused, nothing connected.
  const forged = await erp.host.server.app.inject({
    method: 'GET',
    url: `${S}/callback?code=dina-cal&state=${'x'.repeat(32)}`,
  });
  expect(String(forged.headers.location)).toContain('sync=refused');
  expect((await call('dina', 'GET', S)).json.accounts).toEqual([]);
  // The real one: connected, and back to Agenda.
  const done = await consent('dina', 'dina-cal');
  expect(done.status).toBe(302);
  expect(done.location).toBe('http://localhost:5173/agenda/a/agenda.action_sync?sync=connected');
  const after = await call('dina', 'GET', S);
  expect(after.json.accounts).toMatchObject([
    { provider: 'fake', label: 'Test calendar', email: 'dina-cal@fake.example', lastError: null },
  ]);
  account = after.json.accounts[0].id;
  // The same answer again does nothing: a state works once.
  const again = await erp.host.server.app.inject({
    method: 'GET',
    url: `${S}/callback?code=someone-else&state=${done.state}`,
  });
  expect(String(again.headers.location)).toContain('sync=refused');
  expect((await call('dina', 'GET', S)).json.accounts).toHaveLength(1);
  // An unknown provider, and somebody of Agenda without the Calendar sync role.
  expect((await call('dina', 'POST', `${S}/connect`, { provider: 'nope' })).status).toBe(409);
  expect((await call('bob', 'POST', `${S}/connect`, { provider: 'fake' })).status).toBe(403);
  expect((await call('bob', 'GET', S)).status).toBe(403);
});

test('both ways: mine goes there, theirs comes here as private; a second sync does nothing', async () => {
  const made = await call('dina', 'POST', E, {
    name: 'Budget review',
    start: at(9),
    stop: at(10),
    location: 'Room 2',
    description: '<p>Bring the <b>figures</b>.</p>',
  });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  // Rahim's event is his own: it is not Dina's to send to her calendar.
  expect(
    (await call('rahim', 'POST', E, { name: 'Rahim only', start: at(11), stop: at(12) })).status,
  ).toBe(201);
  mine().set('there-1', { etag: 1, fields: fields('Dentist', { start: at(14), stop: at(15) }) });
  expect(await run()).toEqual({ pushed: 1, pulled: 1, deletedHere: 0, deletedThere: 0 });
  expect(remoteTitles()).toEqual(['Budget review', 'Dentist']);
  const pushed = [...mine().values()].find((e) => e.fields.title === 'Budget review');
  // Rich text goes as its words.
  expect(pushed?.fields).toMatchObject({ location: 'Room 2', description: 'Bring the figures.' });
  // What came from her own calendar is hers, and private: Rahim sees no dentist.
  const dentist = await eventNamed('Dentist');
  expect(dentist).toMatchObject({ privacy: 'private', state: 'confirmed' });
  expect(await localTitles('rahim')).not.toContain('Dentist');
  // Again: nothing to do.
  expect(await run()).toEqual({ pushed: 0, pulled: 0, deletedHere: 0, deletedThere: 0 });
  expect(await run()).toEqual({ pushed: 0, pulled: 0, deletedHere: 0, deletedThere: 0 });
  expect(remoteTitles()).toEqual(['Budget review', 'Dentist']);
  expect((await call('dina', 'GET', S)).json.accounts[0].lastResult).toBe('0 in, 0 out, 0 deleted');
});

test('changes travel both ways; changed on both, the other calendar wins', async () => {
  const review = await eventNamed('Budget review');
  expect(
    (await call('dina', 'PATCH', `${E}/${review.id}`, { name: 'Budget review Q4' })).status,
  ).toBe(200);
  const there = mine().get('there-1');
  mine().set('there-1', {
    etag: 2,
    fields: {
      ...(there?.fields as EventFields),
      title: 'Dentist (moved)',
      location: '<b>Clinic</b>',
    },
  });
  expect(await run()).toMatchObject({ pushed: 1, pulled: 1 });
  expect(remoteTitles()).toEqual(['Budget review Q4', 'Dentist (moved)']);
  // What the other calendar said is text here, never markup.
  expect((await eventNamed('Dentist (moved)')).location).toBe('<b>Clinic</b>');
  expect(await run()).toEqual({ pushed: 0, pulled: 0, deletedHere: 0, deletedThere: 0 });
  // Both sides rename the same event.
  const dentist = await eventNamed('Dentist (moved)');
  await call('dina', 'PATCH', `${E}/${dentist.id}`, { name: 'Dentist — mine' });
  const now = mine().get('there-1');
  mine().set('there-1', {
    etag: 3,
    fields: { ...(now?.fields as EventFields), title: 'Dentist — theirs' },
  });
  expect(await run()).toMatchObject({ pushed: 0, pulled: 1 });
  expect(await localTitles()).toContain('Dentist — theirs');
  expect(await localTitles()).not.toContain('Dentist — mine');
});

test('deleted or cancelled on one side goes on the other; restored, it is there again', async () => {
  // Deleted there: gone here.
  mine().delete('there-1');
  expect(await run()).toMatchObject({ deletedHere: 1, deletedThere: 0 });
  expect(await localTitles()).not.toContain('Dentist — theirs');
  // Cancelled here: gone there. Restored: made there again.
  const review = await eventNamed('Budget review Q4');
  expect((await call('dina', 'POST', `${E}/${review.id}/transitions/cancel`)).status).toBe(200);
  expect(await run()).toMatchObject({ deletedThere: 1, deletedHere: 0 });
  expect(remoteTitles()).toEqual([]);
  expect((await call('dina', 'POST', `${E}/${review.id}/transitions/restore`)).status).toBe(200);
  expect(await run()).toMatchObject({ pushed: 1 });
  expect(remoteTitles()).toEqual(['Budget review Q4']);
  // Deleted here: gone there.
  expect((await call('dina', 'DELETE', `${E}/${review.id}`)).status).toBeLessThan(300);
  expect(await run()).toMatchObject({ deletedThere: 1 });
  expect(remoteTitles()).toEqual([]);
  expect(await run()).toEqual({ pushed: 0, pulled: 0, deletedHere: 0, deletedThere: 0 });
});

test('a token that ended is renewed; tokens are sealed and never served', async () => {
  fake.expireAll();
  // The access token kept no longer opens the calendar, and is also past its time here.
  await erp.host.server.driver.query({
    text: `UPDATE calendar_sync_account SET expires_at = now() - interval '1 hour'`,
    params: [],
  });
  const refreshes = fake.calls.refresh;
  mine().set('there-2', { etag: 1, fields: fields('After the refresh') });
  expect(await run()).toMatchObject({ pulled: 1 });
  expect(fake.calls.refresh).toBe(refreshes + 1);
  // At rest: sealed, not the tokens themselves.
  const [row] = await erp.host.server.driver.query<{ access: string; refresh: string }>({
    text: 'SELECT access_sealed AS access, refresh_sealed AS refresh FROM calendar_sync_account',
    params: [],
  });
  expect(row?.access).toMatch(/^v1\./);
  expect(`${row?.access}${row?.refresh}`).not.toContain('dina-cal');
  // Served to nobody, not even their owner or by name.
  const read = await call(
    'dina',
    'GET',
    `/api/v1/models/calendar.sync.account/${account}?fields=accessSealed,refreshSealed,email`,
  );
  expect(JSON.stringify(read.json)).not.toContain('v1.');
  // What was the same last time, and a consent under way, are not models of the API at all.
  for (const model of ['calendar.sync.link', 'calendar.sync.state'])
    expect((await call('dina', 'GET', `/api/v1/models/${model}`)).status).toBeGreaterThanOrEqual(
      400,
    );
});

test('a connected calendar is its person’s alone; disconnecting leaves the events where they are', async () => {
  // Rahim neither sees it, syncs it nor disconnects it.
  expect((await call('rahim', 'GET', S)).json.accounts).toEqual([]);
  expect((await call('rahim', 'POST', `${S}/${account}/run`)).status).toBe(404);
  expect((await call('rahim', 'DELETE', `${S}/${account}`)).status).toBe(404);
  expect(
    (await call('rahim', 'GET', '/api/v1/models/calendar.sync.account?fields=email')).json.items,
  ).toEqual([]);
  // Nor does she change what the server keeps about it.
  expect(
    (
      await call('dina', 'PATCH', `/api/v1/models/calendar.sync.account/${account}`, {
        email: 'someone@else.test',
      })
    ).status,
  ).toBeGreaterThanOrEqual(400);
  // Rahim connects a calendar of his own: his event goes to his, not to hers.
  expect((await consent('rahim', 'rahim-cal')).location).toContain('sync=connected');
  expect([...fake.calendar('rahim-cal').events.values()].map((e) => e.fields.title)).toEqual([
    'Rahim only',
  ]);
  expect(remoteTitles()).toEqual(['After the refresh']);
  // Dina disconnects: both sides keep what they have, and nothing more is carried.
  const gone = await call('dina', 'DELETE', `${S}/${account}`);
  expect(gone.status, JSON.stringify(gone.json)).toBe(204);
  expect((await call('dina', 'GET', S)).json.accounts).toEqual([]);
  expect(await localTitles()).toContain('After the refresh');
  expect(remoteTitles()).toEqual(['After the refresh']);
  expect((await call('dina', 'POST', `${S}/${account}/run`)).status).toBe(404);
});
