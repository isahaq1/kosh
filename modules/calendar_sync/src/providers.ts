/**
 * Calendar providers (RFC 0034 §2.4): what the sync needs of another calendar — the person's consent (OAuth 2.0,
 * the authorization code flow with PKCE), their events in a window of time, and creating, changing and deleting
 * one. Credentials of the company's app registration come from the environment, never from records:
 * `KOSH_CALSYNC_GOOGLE_CLIENT_ID` / `_SECRET`, `KOSH_CALSYNC_MICROSOFT_CLIENT_ID` / `_SECRET` (and `_TENANT`,
 * `common` by default).
 *
 * The Google and Microsoft adapters are written to their published REST APIs and tested against recorded shapes;
 * they are **to verify** with the company's own registrations. The fake provider keeps calendars in memory, for
 * tests and demonstrations.
 */
import type { EventFields, RemoteEvent } from './engine.js';

export interface Tokens {
  readonly access: string;
  /** Absent when the provider gave none this time (a refresh keeps the one it has). */
  readonly refresh: string | null;
  /** When the access token ends, in milliseconds. */
  readonly expiresAt: number;
}

export interface CalendarProvider {
  readonly code: string;
  readonly label: string;
  /** Whether the company's app registration is in the environment. */
  configured(): boolean;
  /** Where the person is sent to say yes. */
  authorizeUrl(input: {
    readonly state: string;
    readonly redirectUri: string;
    readonly challenge: string;
  }): string;
  /** The code the provider sent back, for tokens; and the address of the calendar's owner, when it says. */
  exchange(input: {
    readonly code: string;
    readonly redirectUri: string;
    readonly verifier: string;
  }): Promise<Tokens & { readonly email: string | null }>;
  refresh(refreshToken: string): Promise<Tokens>;
  /** The events that overlap the window, each occurrence of a repeating one by itself. */
  list(
    access: string,
    window: { readonly from: string; readonly to: string },
  ): Promise<RemoteEvent[]>;
  /** One event; `null` when it was deleted or cancelled there. */
  get(access: string, id: string): Promise<RemoteEvent | null>;
  create(access: string, fields: EventFields): Promise<{ id: string; etag: string }>;
  update(access: string, id: string, fields: EventFields): Promise<{ etag: string }>;
  /** Deletes it; one that is gone already is not an error. */
  remove(access: string, id: string): Promise<void>;
}

/** A provider answered with an error: its status, and what it said (never a token). */
export class ProviderError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message.slice(0, 300));
    this.name = 'ProviderError';
    this.status = status;
  }
}

type Fetch = typeof fetch;
type Json = Record<string, unknown>;

async function call(
  http: Fetch,
  url: string,
  init: {
    method?: string;
    access?: string;
    json?: unknown;
    form?: Record<string, string>;
    headers?: Record<string, string>;
  },
): Promise<{ status: number; json: Json }> {
  const res = await http(url, {
    method: init.method ?? 'GET',
    headers: {
      accept: 'application/json',
      ...(init.access === undefined ? {} : { authorization: `Bearer ${init.access}` }),
      ...(init.json === undefined ? {} : { 'content-type': 'application/json' }),
      ...(init.form === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded' }),
      ...init.headers,
    },
    ...(init.json !== undefined
      ? { body: JSON.stringify(init.json) }
      : init.form !== undefined
        ? { body: new URLSearchParams(init.form).toString() }
        : {}),
    signal: AbortSignal.timeout(20_000),
  });
  const raw = await res.text();
  let json: Json = {};
  try {
    json = raw === '' ? {} : (JSON.parse(raw) as Json);
  } catch {
    json = {};
  }
  return { status: res.status, json };
}

const fail = (what: string, status: number, json: Json): never => {
  const error = json['error'];
  const said =
    typeof error === 'string'
      ? `${error} ${String(json['error_description'] ?? '')}`
      : String((error as Json | undefined)?.['message'] ?? '');
  throw new ProviderError(status, `${what}: ${status} ${said}`.trim());
};

const tokensOf = (json: Json, now: number): Tokens => ({
  access: String(json['access_token'] ?? ''),
  refresh: typeof json['refresh_token'] === 'string' ? json['refresh_token'] : null,
  expiresAt: now + Math.max(60, Number(json['expires_in'] ?? 3600) - 60) * 1000,
});

const day = (iso: string): string => iso.slice(0, 10);

// ---- Google Calendar (v3)

const GOOGLE = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

function googleEvent(item: Json): RemoteEvent | null {
  if (item['status'] === 'cancelled' || typeof item['id'] !== 'string') return null;
  const start = (item['start'] ?? {}) as Json;
  const end = (item['end'] ?? {}) as Json;
  const allDay = typeof start['date'] === 'string';
  const from = allDay ? `${String(start['date'])}T00:00:00.000Z` : String(start['dateTime'] ?? '');
  const to = allDay ? `${String(end['date'])}T00:00:00.000Z` : String(end['dateTime'] ?? '');
  if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) return null;
  return {
    id: item['id'],
    etag: String(item['etag'] ?? item['updated'] ?? ''),
    fields: {
      title: String(item['summary'] ?? ''),
      start: new Date(from).toISOString(),
      stop: new Date(to).toISOString(),
      allDay,
      location: typeof item['location'] === 'string' ? item['location'] : null,
      description: typeof item['description'] === 'string' ? item['description'] : null,
    },
  };
}

const googleBody = (f: EventFields): Json => ({
  summary: f.title,
  location: f.location ?? '',
  description: f.description ?? '',
  start: f.allDay ? { date: day(f.start) } : { dateTime: f.start },
  end: f.allDay ? { date: day(f.stop) } : { dateTime: f.stop },
});

export function googleProvider(options: {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly fetch?: Fetch;
  readonly now?: () => number;
}): CalendarProvider {
  const http = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const token = async (form: Record<string, string>): Promise<Json> => {
    const res = await call(http, 'https://oauth2.googleapis.com/token', {
      method: 'POST',
      form: { client_id: options.clientId, client_secret: options.clientSecret, ...form },
    });
    if (res.status !== 200) fail('Google did not give a token', res.status, res.json);
    return res.json;
  };
  return {
    code: 'google',
    label: 'Google Calendar',
    configured: () => options.clientId !== '' && options.clientSecret !== '',
    authorizeUrl: ({ state, redirectUri, challenge }) =>
      `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
        client_id: options.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid email https://www.googleapis.com/auth/calendar.events',
        // A refresh token, every time: the sync runs when the person is away.
        access_type: 'offline',
        prompt: 'consent',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }).toString()}`,
    async exchange({ code, redirectUri, verifier }) {
      const json = await token({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      });
      const tokens = tokensOf(json, now());
      const who = await call(http, 'https://www.googleapis.com/oauth2/v3/userinfo', {
        access: tokens.access,
      });
      return {
        ...tokens,
        email: typeof who.json['email'] === 'string' ? who.json['email'] : null,
      };
    },
    refresh: async (refreshToken) =>
      tokensOf(await token({ grant_type: 'refresh_token', refresh_token: refreshToken }), now()),
    async list(access, window) {
      const out: RemoteEvent[] = [];
      let page: string | undefined;
      for (let pages = 0; pages < 40; pages += 1) {
        const res = await call(
          http,
          `${GOOGLE}?${new URLSearchParams({
            singleEvents: 'true',
            showDeleted: 'false',
            timeMin: window.from,
            timeMax: window.to,
            maxResults: '250',
            ...(page === undefined ? {} : { pageToken: page }),
          }).toString()}`,
          { access },
        );
        if (res.status !== 200) fail('Google did not list the events', res.status, res.json);
        for (const item of (res.json['items'] ?? []) as Json[]) {
          const event = googleEvent(item);
          if (event !== null) out.push(event);
        }
        page =
          typeof res.json['nextPageToken'] === 'string' ? res.json['nextPageToken'] : undefined;
        if (page === undefined) break;
      }
      return out;
    },
    async get(access, id) {
      const res = await call(http, `${GOOGLE}/${encodeURIComponent(id)}`, { access });
      if (res.status === 404 || res.status === 410) return null;
      if (res.status !== 200) fail('Google did not give the event', res.status, res.json);
      return googleEvent(res.json);
    },
    async create(access, fields) {
      const res = await call(http, GOOGLE, { method: 'POST', access, json: googleBody(fields) });
      if (res.status !== 200 && res.status !== 201)
        fail('Google did not make the event', res.status, res.json);
      return { id: String(res.json['id'] ?? ''), etag: String(res.json['etag'] ?? '') };
    },
    async update(access, id, fields) {
      const res = await call(http, `${GOOGLE}/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        access,
        json: googleBody(fields),
      });
      if (res.status !== 200) fail('Google did not change the event', res.status, res.json);
      return { etag: String(res.json['etag'] ?? '') };
    },
    async remove(access, id) {
      const res = await call(http, `${GOOGLE}/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        access,
      });
      if (![200, 204, 404, 410].includes(res.status))
        fail('Google did not delete the event', res.status, res.json);
    },
  };
}

// ---- Microsoft 365 (Graph v1.0)

const GRAPH = 'https://graph.microsoft.com/v1.0/me';
const UTC = { prefer: 'outlook.timezone="UTC"' };

function graphEvent(item: Json): RemoteEvent | null {
  if (item['isCancelled'] === true || typeof item['id'] !== 'string') return null;
  const at = (side: unknown): string => {
    const value = String((side as Json | undefined)?.['dateTime'] ?? '');
    // Graph gives UTC wall time without a zone when asked for UTC.
    return /[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`;
  };
  const from = at(item['start']);
  const to = at(item['end']);
  if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) return null;
  const body = (item['body'] ?? {}) as Json;
  const location = (item['location'] ?? {}) as Json;
  return {
    id: item['id'],
    etag: String(item['@odata.etag'] ?? item['changeKey'] ?? item['lastModifiedDateTime'] ?? ''),
    fields: {
      title: String(item['subject'] ?? ''),
      start: new Date(from).toISOString(),
      stop: new Date(to).toISOString(),
      allDay: item['isAllDay'] === true,
      location:
        typeof location['displayName'] === 'string' && location['displayName'] !== ''
          ? location['displayName']
          : null,
      // Asked for as text; what is not text is not carried.
      description:
        body['contentType'] === 'text' && typeof body['content'] === 'string'
          ? body['content']
          : null,
    },
  };
}

const graphBody = (f: EventFields): Json => ({
  subject: f.title,
  body: { contentType: 'text', content: f.description ?? '' },
  location: { displayName: f.location ?? '' },
  isAllDay: f.allDay,
  start: { dateTime: f.start.replace(/Z$/, ''), timeZone: 'UTC' },
  end: { dateTime: f.stop.replace(/Z$/, ''), timeZone: 'UTC' },
});

export function microsoftProvider(options: {
  readonly clientId: string;
  readonly clientSecret: string;
  /** `common`, `organizations`, or the company's tenant. */
  readonly tenant?: string;
  readonly fetch?: Fetch;
  readonly now?: () => number;
}): CalendarProvider {
  const http = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const login = `https://login.microsoftonline.com/${encodeURIComponent(options.tenant ?? 'common')}/oauth2/v2.0`;
  const scope = 'offline_access User.Read Calendars.ReadWrite';
  const text = { prefer: 'outlook.timezone="UTC", outlook.body-content-type="text"' };
  const token = async (form: Record<string, string>): Promise<Json> => {
    const res = await call(http, `${login}/token`, {
      method: 'POST',
      form: { client_id: options.clientId, client_secret: options.clientSecret, scope, ...form },
    });
    if (res.status !== 200) fail('Microsoft did not give a token', res.status, res.json);
    return res.json;
  };
  return {
    code: 'microsoft',
    label: 'Microsoft 365',
    configured: () => options.clientId !== '' && options.clientSecret !== '',
    authorizeUrl: ({ state, redirectUri, challenge }) =>
      `${login}/authorize?${new URLSearchParams({
        client_id: options.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        response_mode: 'query',
        scope,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }).toString()}`,
    async exchange({ code, redirectUri, verifier }) {
      const json = await token({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      });
      const tokens = tokensOf(json, now());
      const who = await call(http, `${GRAPH}?$select=mail,userPrincipalName`, {
        access: tokens.access,
      });
      const email = who.json['mail'] ?? who.json['userPrincipalName'];
      return { ...tokens, email: typeof email === 'string' ? email : null };
    },
    refresh: async (refreshToken) =>
      tokensOf(await token({ grant_type: 'refresh_token', refresh_token: refreshToken }), now()),
    async list(access, window) {
      const out: RemoteEvent[] = [];
      let url: string | undefined = `${GRAPH}/calendarView?${new URLSearchParams({
        startDateTime: window.from,
        endDateTime: window.to,
        $top: '100',
      }).toString()}`;
      for (let pages = 0; pages < 100 && url !== undefined; pages += 1) {
        const res = await call(http, url, { access, headers: text });
        if (res.status !== 200) fail('Microsoft did not list the events', res.status, res.json);
        for (const item of (res.json['value'] ?? []) as Json[]) {
          const event = graphEvent(item);
          if (event !== null) out.push(event);
        }
        const next = res.json['@odata.nextLink'];
        // Only Graph's own next page is followed.
        url =
          typeof next === 'string' && next.startsWith('https://graph.microsoft.com/')
            ? next
            : undefined;
      }
      return out;
    },
    async get(access, id) {
      const res = await call(http, `${GRAPH}/events/${encodeURIComponent(id)}`, {
        access,
        headers: text,
      });
      if (res.status === 404 || res.status === 410) return null;
      if (res.status !== 200) fail('Microsoft did not give the event', res.status, res.json);
      return graphEvent(res.json);
    },
    async create(access, fields) {
      const res = await call(http, `${GRAPH}/events`, {
        method: 'POST',
        access,
        json: graphBody(fields),
        headers: UTC,
      });
      if (res.status !== 201 && res.status !== 200)
        fail('Microsoft did not make the event', res.status, res.json);
      return { id: String(res.json['id'] ?? ''), etag: String(res.json['@odata.etag'] ?? '') };
    },
    async update(access, id, fields) {
      const res = await call(http, `${GRAPH}/events/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        access,
        json: graphBody(fields),
        headers: UTC,
      });
      if (res.status !== 200) fail('Microsoft did not change the event', res.status, res.json);
      return { etag: String(res.json['@odata.etag'] ?? '') };
    },
    async remove(access, id) {
      const res = await call(http, `${GRAPH}/events/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        access,
      });
      if (![200, 204, 404, 410].includes(res.status))
        fail('Microsoft did not delete the event', res.status, res.json);
    },
  };
}

// ---- the fake provider: calendars in memory

export interface FakeCalendar {
  readonly events: Map<string, { etag: number; fields: EventFields }>;
}

/**
 * A provider that keeps each person's calendar in memory (tests, demonstrations). Its authorize page is this
 * server's own (`/api/v1/agenda/sync/fake`), the code it gives is the name of a calendar, and its tokens say
 * which calendar they open.
 */
export function fakeProvider(): CalendarProvider & {
  /** The calendar of a name, made on first use. */
  calendar(name: string): FakeCalendar;
  /** Makes every access token given so far end now (to see a refresh). */
  expireAll(): void;
  readonly calls: { refresh: number };
} {
  const calendars = new Map<string, FakeCalendar>();
  let serial = 0;
  let generation = 0;
  const calls = { refresh: 0 };
  const calendar = (name: string): FakeCalendar => {
    let found = calendars.get(name);
    if (found === undefined) {
      found = { events: new Map() };
      calendars.set(name, found);
    }
    return found;
  };
  const opened = (access: string): FakeCalendar => {
    const [kind, name, gen] = access.split('|');
    if (kind !== 'access' || name === undefined || Number(gen) !== generation)
      throw new ProviderError(401, 'The fake provider does not know this token.');
    return calendar(name);
  };
  const tokens = (name: string): Tokens => ({
    access: `access|${name}|${generation}`,
    refresh: `refresh|${name}`,
    expiresAt: Date.now() + 3_600_000,
  });
  const out = (id: string, e: { etag: number; fields: EventFields }): RemoteEvent => ({
    id,
    etag: `"${e.etag}"`,
    fields: e.fields,
  });
  return {
    code: 'fake',
    label: 'Test calendar',
    calls,
    calendar,
    expireAll: () => {
      generation += 1;
    },
    configured: () => true,
    authorizeUrl: ({ state, redirectUri }) =>
      `/api/v1/agenda/sync/fake?${new URLSearchParams({ state, redirect_uri: redirectUri }).toString()}`,
    async exchange({ code }) {
      if (!/^[a-z0-9.@_-]{1,80}$/i.test(code))
        throw new ProviderError(400, 'The fake provider did not give this code.');
      return { ...tokens(code), email: code.includes('@') ? code : `${code}@fake.example` };
    },
    async refresh(refreshToken) {
      const [kind, name] = refreshToken.split('|');
      if (kind !== 'refresh' || name === undefined)
        throw new ProviderError(400, 'The fake provider does not know this refresh token.');
      calls.refresh += 1;
      return { ...tokens(name), refresh: null };
    },
    async list(access, window) {
      return [...opened(access).events.entries()]
        .filter(([, e]) => e.fields.stop > window.from && e.fields.start < window.to)
        .map(([id, e]) => out(id, e));
    },
    async get(access, id) {
      const e = opened(access).events.get(id);
      return e === undefined ? null : out(id, e);
    },
    async create(access, fields) {
      serial += 1;
      const id = `fake-${serial}`;
      opened(access).events.set(id, { etag: 1, fields });
      return { id, etag: '"1"' };
    },
    async update(access, id, fields) {
      const cal = opened(access);
      const e = cal.events.get(id);
      if (e === undefined) throw new ProviderError(404, 'No such event.');
      cal.events.set(id, { etag: e.etag + 1, fields });
      return { etag: `"${e.etag + 1}"` };
    },
    async remove(access, id) {
      opened(access).events.delete(id);
    },
  };
}

/** The providers of the environment: Google and Microsoft when their registrations are set. */
export function providersFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Map<string, CalendarProvider> {
  const out = new Map<string, CalendarProvider>();
  const google = googleProvider({
    clientId: env['KOSH_CALSYNC_GOOGLE_CLIENT_ID'] ?? '',
    clientSecret: env['KOSH_CALSYNC_GOOGLE_CLIENT_SECRET'] ?? '',
  });
  const microsoft = microsoftProvider({
    clientId: env['KOSH_CALSYNC_MICROSOFT_CLIENT_ID'] ?? '',
    clientSecret: env['KOSH_CALSYNC_MICROSOFT_CLIENT_SECRET'] ?? '',
    tenant: env['KOSH_CALSYNC_MICROSOFT_TENANT'] ?? 'common',
  });
  out.set(google.code, google);
  out.set(microsoft.code, microsoft);
  return out;
}
