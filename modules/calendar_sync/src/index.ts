/**
 * @packageDocumentation
 * `@kosh/calendar_sync` (RFC 0034 §2.4): a person's Agenda kept in step with their Google Calendar or Microsoft
 * 365 calendar, both ways. They connect it themselves (OAuth 2.0 with PKCE; the company's app registration is
 * in the environment), and from then on their own events here appear there and what they add there appears here,
 * as private events. Tokens are sealed under the server's `KOSH_SECRETS_KEY`.
 *
 * - `GET    /api/v1/agenda/sync`             what can be connected, and my connected calendars
 * - `POST   /api/v1/agenda/sync/connect`     `{ provider }` → `{ url }`: where to say yes
 * - `GET    /api/v1/agenda/sync/callback`    back from the provider (`code`, `state`): connected, on to Agenda
 * - `POST   /api/v1/agenda/sync/:id/run`     sync now
 * - `DELETE /api/v1/agenda/sync/:id`         disconnect (events stay where they are, on both sides)
 */
import { createHash, randomBytes } from 'node:crypto';
import { calendarApp } from '@kosh/calendar';
import { defineModule } from '@kosh/modules-sdk';
import { audit, HttpProblem, type ModuleContext } from '@kosh/server';
import { form, list, search } from '@kosh/views';
import type { Env } from './.kosh/bindings.js';
import { calendarSyncShutro, SyncAccount } from './module.js';
import { type CalendarProvider, ProviderError, providersFromEnvironment } from './providers.js';
import { open, seal, secretsKey } from './secrets.js';
import { type SyncDeps, syncAccount } from './sync.js';

export {
  type EventFields,
  type Link,
  type LocalEvent,
  normalise,
  type Op,
  plan,
  type RemoteEvent,
  stampOf,
  windowOf,
} from './engine.js';
export { calendarSyncShutro, SyncAccount, SyncLink, SyncState } from './module.js';
export {
  type CalendarProvider,
  type FakeCalendar,
  fakeProvider,
  googleProvider,
  microsoftProvider,
  ProviderError,
  providersFromEnvironment,
  type Tokens,
} from './providers.js';
export { open, seal, secretsKey } from './secrets.js';
export { type SyncDeps, type SyncResult, syncAccount } from './sync.js';

export interface CalendarSyncOptions {
  /** The providers by code (tests: the fake; default: Google and Microsoft from the environment). */
  readonly providers?: ReadonlyMap<string, CalendarProvider>;
  /** The key tokens are sealed under (default: `KOSH_SECRETS_KEY`). */
  readonly secretsKey?: string | null;
  /** The API's public address, where providers send people back (default: `KOSH_API_URL`). */
  readonly apiUrl?: string;
  /** The back-office's address, where people land once connected (default: `KOSH_BASE_URL`). */
  readonly webUrl?: string;
  /** Sync every connected calendar every few minutes (default: unless `KOSH_SCHEDULES=off`). */
  readonly workers?: boolean | undefined;
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
/** How long a consent may take. */
const STATE_MINUTES = 15;
/** How often every connected calendar is synced by itself. */
const EVERY_MS = 5 * 60_000;

function registerSyncRoutes(context: ModuleContext, options: CalendarSyncOptions): void {
  const { app, shutro } = context;
  const providers = options.providers ?? providersFromEnvironment();
  const key = 'secretsKey' in options ? (options.secretsKey ?? null) : secretsKey();
  const api = (options.apiUrl ?? process.env['KOSH_API_URL'] ?? 'http://localhost:3000').replace(
    /\/+$/,
    '',
  );
  const web = (options.webUrl ?? process.env['KOSH_BASE_URL'] ?? 'http://localhost:5173').replace(
    /\/+$/,
    '',
  );
  const redirectUri = `${api}/api/v1/agenda/sync/callback`;
  const landing = (said: string): string =>
    `${web}/agenda/a/agenda.action_sync?${new URLSearchParams({ sync: said }).toString()}`;
  const system = <T>(reason: string, fn: (env: Env) => Promise<T>): Promise<T> =>
    shutro.bootstrap({ reason }, (env) => fn(env as unknown as Env));
  const deps = (): SyncDeps => {
    if (key === null)
      throw new HttpProblem(
        503,
        'no-secrets-key',
        'Calendar sync is not set up',
        'The server has no key to keep calendar tokens under.',
        'Set KOSH_SECRETS_KEY (32 characters or more) and restart.',
      );
    return { system, providers, key };
  };
  const mine = (env: Env): void => {
    // A role of its own: sending a company's meetings to another calendar is not every Agenda user's by default.
    if (!(env.administrator || env.groups.has('calendar_sync.user')))
      throw new HttpProblem(403, 'access', 'Calendar sync', 'This needs the Calendar sync role.');
  };
  /** The caller's own connected calendar, by their read right (the record rule: theirs alone). */
  const own = async (env: Env, id: number): Promise<void> => {
    mine(env);
    const found = await env
      .model('calendar.sync.account')
      .search({ where: { id, user: env.userId } as never, limit: 1 });
    if (found.length === 0)
      throw new HttpProblem(404, 'missing-record', 'Not found', 'No such connected calendar.');
  };
  const idOf = (params: unknown): number => {
    const id = Number((params as { id?: unknown }).id);
    if (!Number.isSafeInteger(id) || id <= 0)
      throw new HttpProblem(400, 'invalid-id', 'Invalid id', 'A connected calendar’s id.');
    return id;
  };

  app.get('/api/v1/agenda/sync', async (request) =>
    request.env(async (raw) => {
      const env = raw as unknown as Env;
      mine(env);
      const accounts = await env
        .model('calendar.sync.account')
        .search({ where: { user: env.userId } as never, order: ['id asc'] });
      return {
        ready: key !== null,
        providers: [...providers.values()].map((p) => ({
          code: p.code,
          label: p.label,
          configured: p.configured(),
        })),
        accounts: [...accounts].map((a) => ({
          id: a.id,
          provider: a.provider,
          label: providers.get(a.provider)?.label ?? a.provider,
          email: a.email,
          lastSyncAt: a.lastSyncAt === null ? null : new Date(a.lastSyncAt as never).toISOString(),
          lastResult: a.lastResult,
          lastError: a.lastError,
        })),
      };
    }),
  );

  app.post('/api/v1/agenda/sync/connect', async (request) => {
    const code = String((request.body as { provider?: unknown } | null)?.provider ?? '');
    const provider = providers.get(code);
    const sealing = deps().key;
    if (provider === undefined || !provider.configured())
      throw new HttpProblem(
        409,
        'not-configured',
        'Not set up',
        `The ${provider?.label ?? code} calendar is not set up on this server.`,
        'An administrator registers the app with the provider and sets its client id and secret in the environment.',
      );
    const state = randomBytes(24).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    await request.env(
      async (raw) => {
        const env = raw as unknown as Env;
        mine(env);
        const user = env.userId as number;
        await env.asSuperuser({ reason: 'a calendar connection starts' }, async (su) => {
          // What was started and never finished is cleared on the way.
          const stale = await su.model('calendar.sync.state').search({
            where: { or: [{ user }, { expiresAt: { lt: new Date() } }] } as never,
          });
          if (stale.length > 0) await stale.unlink();
          await su.model('calendar.sync.state').create([
            {
              user,
              provider: provider.code,
              stateHash: sha256(state),
              verifierSealed: seal(verifier, sealing),
              expiresAt: new Date(Date.now() + STATE_MINUTES * 60_000),
            } as never,
          ]);
        });
      },
      { write: true },
    );
    return {
      url: provider.authorizeUrl({
        state,
        redirectUri,
        challenge: createHash('sha256').update(verifier).digest('base64url'),
      }),
    };
  });

  // The test provider's own "say yes" page (only where the test provider is installed): which calendar to open.
  if (providers.has('fake'))
    app.get('/api/v1/agenda/sync/fake', { config: { auth: false } }, async (request, reply) => {
      const query = request.query as {
        state?: unknown;
        redirect_uri?: unknown;
        calendar?: unknown;
      };
      const state = typeof query.state === 'string' ? query.state : '';
      const calendar = typeof query.calendar === 'string' ? query.calendar.trim() : '';
      // Only back to this server's own callback, whatever the address says.
      if (calendar !== '')
        return reply.redirect(
          `${redirectUri}?${new URLSearchParams({ code: calendar, state }).toString()}`,
        );
      const escaped = state.replace(/[^A-Za-z0-9_-]/g, '');
      return reply
        .type('text/html; charset=utf-8')
        .header(
          'content-security-policy',
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
        )
        .send(
          `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Test calendar</title>
<style>body{font:16px system-ui;max-width:24rem;margin:4rem auto;padding:0 1rem}input,button{font:inherit;padding:.4rem}</style></head>
<body><h1>Test calendar</h1><p>This calendar moves nothing real: it is for trying the sync.</p>
<form method="get"><input type="hidden" name="state" value="${escaped}">
<label for="c">Calendar to open</label> <input id="c" name="calendar" value="my-calendar" required pattern="[A-Za-z0-9.@_-]{1,80}">
<button type="submit">Allow</button></form></body></html>`,
        );
    });

  // Back from the provider. Who it is for is what the state says — kept by the server when they asked —, never
  // what the address says; a state works once, for a quarter of an hour.
  app.get('/api/v1/agenda/sync/callback', { config: { auth: false } }, async (request, reply) => {
    const query = request.query as { code?: unknown; state?: unknown; error?: unknown };
    const state = typeof query.state === 'string' ? query.state : '';
    const code = typeof query.code === 'string' ? query.code : '';
    if (key === null) return reply.redirect(landing('unavailable'));
    const started = await system('a calendar connection returns', async (env) => {
      const [found] = await env
        .model('calendar.sync.state')
        .search({ where: { stateHash: sha256(state) } as never, limit: 1 })
        .then((rows) => rows.load({ user: true }));
      if (found === undefined) return null;
      const out = {
        user: found.user.id as number,
        provider: found.provider,
        verifier: open(found.verifierSealed, key),
        fresh: new Date(found.expiresAt as never).getTime() > Date.now(),
      };
      await env
        .model('calendar.sync.state')
        .browse([found.id as never])
        .unlink();
      return out;
    });
    const provider = started === null ? undefined : providers.get(started.provider);
    if (
      started === null ||
      !started.fresh ||
      started.verifier === null ||
      provider === undefined ||
      code === '' ||
      typeof query.error === 'string'
    )
      return reply.redirect(landing('refused'));
    try {
      const tokens = await provider.exchange({ code, redirectUri, verifier: started.verifier });
      const account = await system('a calendar connected', async (env) => {
        const email = tokens.email ?? '';
        const values = {
          accessSealed: seal(tokens.access, key),
          ...(tokens.refresh === null ? {} : { refreshSealed: seal(tokens.refresh, key) }),
          expiresAt: new Date(tokens.expiresAt),
          lastError: null,
        };
        const [had] = await env.model('calendar.sync.account').search({
          where: { user: started.user, provider: provider.code, email } as never,
          limit: 1,
        });
        if (had !== undefined) {
          await env
            .model('calendar.sync.account')
            .browse([had.id as never])
            .write(values as never);
          return had.id as number;
        }
        const made = await env
          .model('calendar.sync.account')
          .create([{ user: started.user, provider: provider.code, email, ...values } as never]);
        await audit(env as never, {
          kind: 'calendar.sync.connected',
          summary: `A ${provider.label} calendar (${email}) was connected to Agenda.`,
          details: { user: started.user, provider: provider.code },
          ip: request.ip,
        });
        return made.ids[0] as number;
      });
      // The first sync, so that they land on a calendar that is already theirs; a failure shows on the page.
      await syncAccount({ system, providers, key }, account).catch(() => undefined);
      return reply.redirect(landing('connected'));
    } catch (error) {
      app.log.warn({ err: error }, 'a calendar was not connected');
      return reply.redirect(landing('refused'));
    }
  });

  app.post('/api/v1/agenda/sync/:id/run', async (request) => {
    const id = idOf(request.params);
    const using = deps();
    await request.env((raw) => own(raw as unknown as Env, id));
    try {
      return await syncAccount(using, id);
    } catch (error) {
      throw new HttpProblem(
        error instanceof ProviderError && error.status === 401 ? 409 : 502,
        'sync-failed',
        'The calendar did not sync',
        error instanceof Error ? error.message : String(error),
      );
    }
  });

  app.delete('/api/v1/agenda/sync/:id', async (request, reply) => {
    const id = idOf(request.params);
    await request.env(
      async (raw) => {
        const env = raw as unknown as Env;
        await own(env, id);
        // The events stay where they are, here and there: only the tie between them goes.
        await env.asSuperuser({ reason: 'a calendar disconnected' }, async (su) => {
          const [a] = await su
            .model('calendar.sync.account')
            .browse([id as never])
            .load(['provider', 'email']);
          // Read before it goes: a deleted record has nothing to read.
          const what = `${a?.provider ?? ''} calendar (${a?.email ?? ''})`;
          await su
            .model('calendar.sync.account')
            .browse([id as never])
            .unlink();
          await audit(su as never, {
            kind: 'calendar.sync.disconnected',
            summary: `A ${what} was disconnected from Agenda.`,
            details: { user: env.userId },
            ip: request.ip,
          });
        });
      },
      { write: true },
    );
    return reply.code(204).send();
  });

  if (!(options.workers ?? process.env['KOSH_SCHEDULES'] !== 'off') || key === null) return;
  // Every few minutes, each connected calendar; one that fails says so on its own row and is tried again.
  let running = false;
  const round = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const ids = await system('calendars to sync', async (env) =>
        (await env.model('calendar.sync.account').search({ where: {}, limit: 5000 })).ids.map(
          Number,
        ),
      );
      for (const id of ids)
        await syncAccount({ system, providers, key }, id).catch(() => undefined);
    } catch (error) {
      app.log.warn({ err: error }, 'calendars were not synced');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void round(), EVERY_MS);
  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));
}

/** Calendar sync with explicit options (tests: the fake provider, a key, no timer). */
export function calendarSyncModule(
  options: CalendarSyncOptions = {},
): ReturnType<typeof defineModule> {
  return defineModule({
    shutro: calendarSyncShutro,
    kosh: '^0.1.0',
    depends: [calendarApp],
    bridge: [calendarApp],
    // Bangla for the labels it serves (RFC 0023 §3.1; `pnpm i18n:extract`).
    i18n: { bn: () => import('./i18n/bn.js') },
    accessLevels: {
      user: { label: 'Calendar sync', groups: ['calendar_sync.user'] },
    },
    // What was the same at the last sync, and a consent under way, are the server's alone.
    privateModels: ['calendar.sync.link', 'calendar.sync.state'],
    routes: (context: ModuleContext) => registerSyncRoutes(context, options),
    standard: {
      waive: [
        {
          rule: 'I1',
          model: 'calendar.sync.account',
          reason:
            'A calendar is connected by its person’s own consent at the provider; there is nothing to import.',
        },
      ],
    },
    actions: {
      'agenda.action_sync': { type: 'client', page: 'agenda.Sync', label: 'My other calendars' },
    },
    menus: [
      {
        id: 'agenda.sync',
        parent: 'agenda.root',
        label: 'My other calendars',
        action: 'agenda.action_sync',
        sequence: 8,
      },
    ],
    views: {
      'calendar.sync.account.list': list(SyncAccount, {
        columns: ['provider', 'email', 'lastSyncAt', 'lastResult', 'lastError'],
        decorations: { danger: { lastError: { isNull: false } } },
      }),
      'calendar.sync.account.form': form(SyncAccount, (k) => ({
        header: { buttons: [] },
        sheet: [
          k.group('main', ['provider', 'email', 'lastSyncAt', 'lastResult', 'lastError'], {
            description:
              'Your own events in Agenda appear in this calendar, and what you add there appears here as private events. Connect and disconnect under Agenda › My other calendars.',
          }),
        ],
      })),
    },
    search: {
      'calendar.sync.account': search(SyncAccount, {
        fields: ['email'],
        filters: { failing: { label: 'With a problem', domain: { lastError: { isNull: false } } } },
        groupBy: ['provider'],
      }),
    },
  });
}

export const calendarSync: ReturnType<typeof defineModule> = calendarSyncModule();
