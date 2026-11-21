/**
 * Two-way calendar sync without a database or a provider (RFC 0034 §2.4): what a sync does for every way two
 * calendars can differ; what two versions are compared by; the tokens at rest; and the Google and Microsoft
 * adapters against the shapes of their APIs.
 */
import { expect, test } from 'vitest';
import {
  type EventFields,
  type Link,
  type LocalEvent,
  normalise,
  plan,
  type RemoteEvent,
  stampOf,
  windowOf,
} from '../src/engine.js';
import { googleProvider, microsoftProvider, ProviderError } from '../src/providers.js';
import { open, seal, secretsKey } from '../src/secrets.js';

const fields = (title: string, over: Partial<EventFields> = {}): EventFields => ({
  title,
  start: '2026-12-01T09:00:00.000Z',
  stop: '2026-12-01T10:00:00.000Z',
  allDay: false,
  location: null,
  description: null,
  ...over,
});
const local = (id: number, title: string): LocalEvent => ({ id, fields: fields(title) });
const remote = (id: string, title: string, etag = '"1"'): RemoteEvent => ({
  id,
  etag,
  fields: fields(title),
});
const link = (
  id: number,
  event: number | null,
  remoteId: string,
  title: string,
  etag = '"1"',
): Link => ({
  id,
  event,
  remoteId,
  etag,
  stamp: stampOf(fields(title)),
});
const ops = (...args: Parameters<typeof plan>) => plan(...args).map((o) => o.op);

test('what two versions are compared by: spaces, empty text and fractions of a second do not count', () => {
  expect(stampOf(fields('  Stand-up  ', { location: ' ', description: '\r\n' }))).toBe(
    stampOf(fields('Stand-up')),
  );
  expect(stampOf(fields('A', { start: '2026-12-01T09:00:00.700Z' }))).toBe(stampOf(fields('A')));
  expect(stampOf(fields('A', { start: '2026-12-01T15:00:00+06:00' }))).toBe(stampOf(fields('A')));
  expect(stampOf(fields('A'))).not.toBe(stampOf(fields('B')));
  expect(stampOf(fields('A', { allDay: true }))).not.toBe(stampOf(fields('A')));
  expect(normalise(fields('x'.repeat(400))).title).toHaveLength(250);
  const window = windowOf(Date.UTC(2026, 10, 21));
  expect([window.from.slice(0, 10), window.to.slice(0, 10)]).toEqual(['2026-10-22', '2027-11-21']);
});

test('new on one side goes to the other; the same on both does nothing', () => {
  expect(plan([local(1, 'A')], [], [])).toEqual([
    { op: 'push-new', event: local(1, 'A'), replaces: null },
  ]);
  expect(plan([], [remote('r1', 'B')], [])).toEqual([
    { op: 'pull-new', remote: remote('r1', 'B') },
  ]);
  // Linked and unchanged: a second sync does nothing.
  expect(plan([local(1, 'A')], [remote('r1', 'A')], [link(7, 1, 'r1', 'A')])).toEqual([]);
});

test('changed on one side goes to the other; on both, the other calendar wins unless they agree', () => {
  const l = link(7, 1, 'r1', 'A');
  expect(ops([local(1, 'A2')], [remote('r1', 'A')], [l])).toEqual(['push-update']);
  expect(ops([local(1, 'A')], [remote('r1', 'A2', '"2"')], [l])).toEqual(['pull-update']);
  expect(ops([local(1, 'Mine')], [remote('r1', 'Theirs', '"2"')], [l])).toEqual(['pull-update']);
  // Both changed to the same thing: only what is remembered changes.
  expect(plan([local(1, 'Same')], [remote('r1', 'Same', '"2"')], [l])).toEqual([
    { op: 'remember', link: l, etag: '"2"', stamp: stampOf(fields('Same')) },
  ]);
  // The provider's tag moved but nothing we carry did, and here changed: here goes there.
  expect(ops([local(1, 'A2')], [remote('r1', 'A', '"9"')], [l])).toEqual(['push-update']);
  // Its tag moved and nothing else: remembered, no write on either side.
  expect(ops([local(1, 'A')], [remote('r1', 'A', '"9"')], [l])).toEqual(['remember']);
});

test('deleted on one side is deleted on the other — unless the other changed meanwhile', () => {
  // Deleted here (the link's event is gone).
  expect(ops([], [remote('r1', 'A')], [link(7, null, 'r1', 'A')])).toEqual(['delete-remote']);
  // …but changed there since: it is kept, and comes back here.
  expect(ops([], [remote('r1', 'A2', '"2"')], [link(7, null, 'r1', 'A')])).toEqual(['pull-update']);
  // Deleted there.
  expect(ops([local(1, 'A')], [], [link(7, 1, 'r1', 'A')])).toEqual(['delete-local']);
  // …but changed here since: it is kept, and made there again in the same link.
  expect(plan([local(1, 'A2')], [], [link(7, 1, 'r1', 'A')])).toEqual([
    { op: 'push-new', event: local(1, 'A2'), replaces: 7 },
  ]);
  // Gone on both sides.
  expect(ops([], [], [link(7, null, 'r1', 'A')])).toEqual(['forget']);
  // Out of the window here but still there: left alone, whatever the other side shows.
  expect(ops([], [], [link(7, 1, 'r1', 'A')], new Set([1]))).toEqual([]);
  expect(ops([], [remote('r1', 'A2', '"2"')], [link(7, 1, 'r1', 'A')], new Set([1]))).toEqual([]);
});

test('many at once: each event is carried once, none twice', () => {
  const done = plan(
    [local(1, 'kept'), local(2, 'new here'), local(3, 'renamed here')],
    [remote('r1', 'kept'), remote('r3', 'old name'), remote('r9', 'new there')],
    [link(1, 1, 'r1', 'kept'), link(3, 3, 'r3', 'old name'), link(4, null, 'r4', 'gone both')],
  );
  expect(done.map((o) => o.op).sort()).toEqual(['forget', 'pull-new', 'push-new', 'push-update']);
});

test('tokens at rest: sealed under the server’s key, opened by it alone', () => {
  const key = 'k'.repeat(40);
  const sealed = seal('ya29.secret-token', key);
  expect(sealed).toMatch(/^v1\./);
  expect(sealed).not.toContain('secret-token');
  expect(open(sealed, key)).toBe('ya29.secret-token');
  // Another seal of the same token is another text.
  expect(seal('ya29.secret-token', key)).not.toBe(sealed);
  // Another key, a changed text, or nothing: opens as nothing.
  expect(open(sealed, 'x'.repeat(40))).toBeNull();
  expect(open(`${sealed.slice(0, -2)}AA`, key)).toBeNull();
  for (const not of [null, undefined, '', 'plain', 'v2.a.b.c']) expect(open(not, key)).toBeNull();
  // A key is at least 32 characters, or there is none.
  expect(secretsKey({ KOSH_SECRETS_KEY: 'short' })).toBeNull();
  expect(secretsKey({ KOSH_SECRETS_KEY: key })).toBe(key);
  expect(secretsKey({})).toBeNull();
});

/** A stub of `fetch` that answers by a table and remembers what was asked. */
function stub(answers: Record<string, { status?: number; body: unknown }>) {
  const asked: { url: string; method: string; headers: Record<string, string>; body: string }[] =
    [];
  const http = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    asked.push({
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: String(init?.body ?? ''),
    });
    const hit = Object.entries(answers).find(([start]) => url.startsWith(start))?.[1];
    return new Response(JSON.stringify(hit?.body ?? {}), { status: hit?.status ?? 404 });
  }) as typeof fetch;
  return { http, asked };
}

test('Google: consent with PKCE and a refresh token; events read, written and deleted', async () => {
  const { http, asked } = stub({
    'https://oauth2.googleapis.com/token': {
      status: 200,
      body: { access_token: 'acc', refresh_token: 'ref', expires_in: 3600 },
    },
    'https://www.googleapis.com/oauth2/v3/userinfo': { status: 200, body: { email: 'd@x.test' } },
    'https://www.googleapis.com/calendar/v3/calendars/primary/events?': {
      status: 200,
      body: {
        items: [
          {
            id: 'g1',
            etag: '"e1"',
            summary: 'Review',
            location: 'Room 2',
            start: { dateTime: '2026-12-01T15:00:00+06:00' },
            end: { dateTime: '2026-12-01T16:00:00+06:00' },
          },
          {
            id: 'g2',
            etag: '"e2"',
            summary: 'Holiday',
            start: { date: '2026-12-16' },
            end: { date: '2026-12-17' },
          },
          { id: 'g3', status: 'cancelled' },
        ],
      },
    },
    'https://www.googleapis.com/calendar/v3/calendars/primary/events/gone': {
      status: 404,
      body: {},
    },
    'https://www.googleapis.com/calendar/v3/calendars/primary/events': {
      status: 200,
      body: { id: 'g9', etag: '"e9"' },
    },
  });
  const google = googleProvider({
    clientId: 'cid',
    clientSecret: 'sec',
    fetch: http,
    now: () => 0,
  });
  expect(google.configured()).toBe(true);
  expect(googleProvider({ clientId: '', clientSecret: '' }).configured()).toBe(false);
  const url = new URL(
    google.authorizeUrl({ state: 'st', redirectUri: 'https://erp.test/cb', challenge: 'ch' }),
  );
  expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
  expect(Object.fromEntries(url.searchParams)).toMatchObject({
    client_id: 'cid',
    redirect_uri: 'https://erp.test/cb',
    response_type: 'code',
    access_type: 'offline',
    state: 'st',
    code_challenge: 'ch',
    code_challenge_method: 'S256',
  });
  expect(url.searchParams.get('scope')).toContain('calendar.events');
  const tokens = await google.exchange({
    code: 'c',
    redirectUri: 'https://erp.test/cb',
    verifier: 'v',
  });
  expect(tokens).toEqual({
    access: 'acc',
    refresh: 'ref',
    expiresAt: 3_540_000,
    email: 'd@x.test',
  });
  expect(new URLSearchParams(asked[0]?.body).get('code_verifier')).toBe('v');
  const listed = await google.list('acc', {
    from: '2026-11-01T00:00:00.000Z',
    to: '2027-11-01T00:00:00.000Z',
  });
  expect(listed).toEqual([
    {
      id: 'g1',
      etag: '"e1"',
      fields: {
        title: 'Review',
        start: '2026-12-01T09:00:00.000Z',
        stop: '2026-12-01T10:00:00.000Z',
        allDay: false,
        location: 'Room 2',
        description: null,
      },
    },
    {
      id: 'g2',
      etag: '"e2"',
      fields: {
        title: 'Holiday',
        start: '2026-12-16T00:00:00.000Z',
        stop: '2026-12-17T00:00:00.000Z',
        allDay: true,
        location: null,
        description: null,
      },
    },
  ]);
  const list = asked.find((a) => a.url.includes('/events?'));
  expect(list?.url).toContain('singleEvents=true');
  expect(list?.headers['authorization']).toBe('Bearer acc');
  expect(await google.get('acc', 'gone')).toBeNull();
  expect(await google.create('acc', fields('New', { allDay: true }))).toEqual({
    id: 'g9',
    etag: '"e9"',
  });
  expect(JSON.parse(asked.at(-1)?.body ?? '{}')).toMatchObject({
    summary: 'New',
    start: { date: '2026-12-01' },
    end: { date: '2026-12-01' },
  });
  await google.remove('acc', 'gone');
  // An error of the provider is said without a token in it.
  const broken = googleProvider({
    clientId: 'cid',
    clientSecret: 'sec',
    fetch: stub({ 'https://': { status: 403, body: { error: { message: 'Forbidden' } } } }).http,
  });
  await expect(broken.list('acc-secret', windowOf(0))).rejects.toThrow(ProviderError);
  await expect(broken.list('acc-secret', windowOf(0))).rejects.not.toThrow(/acc-secret/);
});

test('Microsoft: the tenant in the address, times in UTC, the body as text', async () => {
  const { http, asked } = stub({
    'https://login.microsoftonline.com/contoso/oauth2/v2.0/token': {
      status: 200,
      body: { access_token: 'acc', expires_in: 3600 },
    },
    'https://graph.microsoft.com/v1.0/me?': {
      status: 200,
      body: { userPrincipalName: 'd@contoso.test' },
    },
    'https://graph.microsoft.com/v1.0/me/calendarView': {
      status: 200,
      body: {
        value: [
          {
            id: 'm1',
            '@odata.etag': 'W/"t1"',
            subject: 'Sync',
            body: { contentType: 'text', content: 'Agenda' },
            location: { displayName: '' },
            start: { dateTime: '2026-12-01T09:00:00.0000000', timeZone: 'UTC' },
            end: { dateTime: '2026-12-01T10:00:00.0000000', timeZone: 'UTC' },
            isAllDay: false,
          },
          { id: 'm2', isCancelled: true },
        ],
        // A next page that is not Graph's own is not followed.
        '@odata.nextLink': 'https://evil.example/next',
      },
    },
    'https://graph.microsoft.com/v1.0/me/events': {
      status: 201,
      body: { id: 'm9', '@odata.etag': 'W/"t9"' },
    },
  });
  const microsoft = microsoftProvider({
    clientId: 'cid',
    clientSecret: 'sec',
    tenant: 'contoso',
    fetch: http,
    now: () => 0,
  });
  const url = new URL(
    microsoft.authorizeUrl({ state: 'st', redirectUri: 'https://erp.test/cb', challenge: 'ch' }),
  );
  expect(url.origin + url.pathname).toBe(
    'https://login.microsoftonline.com/contoso/oauth2/v2.0/authorize',
  );
  expect(url.searchParams.get('scope')).toBe('offline_access User.Read Calendars.ReadWrite');
  // No refresh token came back: the one kept stays.
  const fresh = await microsoft.refresh('ref');
  expect(fresh).toEqual({ access: 'acc', refresh: null, expiresAt: 3_540_000 });
  const tokens = await microsoft.exchange({
    code: 'c',
    redirectUri: 'https://erp.test/cb',
    verifier: 'v',
  });
  expect(tokens.email).toBe('d@contoso.test');
  const listed = await microsoft.list('acc', windowOf(Date.UTC(2026, 10, 21)));
  expect(listed).toEqual([
    {
      id: 'm1',
      etag: 'W/"t1"',
      fields: {
        title: 'Sync',
        start: '2026-12-01T09:00:00.000Z',
        stop: '2026-12-01T10:00:00.000Z',
        allDay: false,
        location: null,
        description: 'Agenda',
      },
    },
  ]);
  expect(asked.some((a) => a.url.startsWith('https://evil.example'))).toBe(false);
  const view = asked.find((a) => a.url.includes('calendarView'));
  expect(view?.headers['prefer']).toContain('outlook.timezone="UTC"');
  expect(await microsoft.create('acc', fields('New', { description: 'Notes' }))).toEqual({
    id: 'm9',
    etag: 'W/"t9"',
  });
  expect(JSON.parse(asked.at(-1)?.body ?? '{}')).toMatchObject({
    subject: 'New',
    body: { contentType: 'text', content: 'Notes' },
    start: { dateTime: '2026-12-01T09:00:00.000', timeZone: 'UTC' },
  });
});
