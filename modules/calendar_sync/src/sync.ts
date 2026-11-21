/**
 * One sync of a connected calendar (RFC 0034 §2.4): the person's own events here, in a window from a month ago to
 * a year ahead, and their events at the provider are compared with what was the same last time (`engine.ts`), and
 * each difference is carried over. The provider is never called with a transaction open; each event carried is
 * remembered at once in a transaction of its own, so a sync cut short never makes an event twice.
 *
 * What comes from the other calendar becomes a **private** event here — a person's own calendar is not the
 * company's to read. Attendees, rooms and reminders are not carried.
 */
import { htmlToText } from '@kosh/server';
import type { Env } from './.kosh/bindings.js';
import {
  type EventFields,
  type Link,
  type LocalEvent,
  plan,
  type RemoteEvent,
  stampOf,
  windowOf,
} from './engine.js';
import type { CalendarProvider } from './providers.js';
import { open, seal } from './secrets.js';

export interface SyncDeps {
  /** Runs `fn` as the system in a transaction of its own. */
  readonly system: <T>(reason: string, fn: (env: Env) => Promise<T>) => Promise<T>;
  readonly providers: ReadonlyMap<string, CalendarProvider>;
  /** The server's key for secrets at rest. */
  readonly key: string;
  readonly now?: () => number;
}

export interface SyncResult {
  readonly pushed: number;
  readonly pulled: number;
  readonly deletedHere: number;
  readonly deletedThere: number;
}

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Plain text as the event's rich text: a paragraph per line, nothing in it is markup. */
const htmlOf = (text: string | null): string | null =>
  text === null
    ? null
    : text
        .split('\n')
        .map((line) => `<p>${escapeHtml(line)}</p>`)
        .join('');

const iso = (value: unknown): string => new Date(value as string | Date).toISOString();

interface Stored {
  readonly id: unknown;
  readonly name: string;
  readonly start: unknown;
  readonly stop: unknown;
  readonly allDay: boolean | null;
  readonly location: string | null;
  readonly description: string | null;
}
const fieldsOf = (e: Stored): EventFields => ({
  title: e.name,
  start: iso(e.start),
  stop: iso(e.stop),
  allDay: e.allDay === true,
  location: e.location ?? null,
  description: e.description === null || e.description === '' ? null : htmlToText(e.description),
});

/** The values of an event here, from what the other calendar has. */
const valuesOf = (f: EventFields): Record<string, unknown> => ({
  name: f.title.trim() === '' ? '(no title)' : f.title,
  start: new Date(f.start),
  stop: new Date(f.stop),
  allDay: f.allDay,
  location: f.location,
  description: htmlOf(f.description),
});

/** An access token that works: the one kept, or a new one from the refresh token. */
async function accessOf(
  deps: SyncDeps,
  provider: CalendarProvider,
  account: number,
): Promise<string> {
  const now = (deps.now ?? Date.now)();
  const kept = await deps.system('a calendar’s tokens read', async (env) => {
    const [a] = await env
      .model('calendar.sync.account')
      .browse([account as never])
      .load(['accessSealed', 'refreshSealed', 'expiresAt']);
    return a === undefined
      ? null
      : {
          access: open(a.accessSealed, deps.key),
          refresh: open(a.refreshSealed, deps.key),
          expiresAt: a.expiresAt === null ? 0 : new Date(a.expiresAt as never).getTime(),
        };
  });
  if (kept === null) throw new Error('This calendar is no longer connected.');
  if (kept.access !== null && kept.expiresAt > now + 30_000) return kept.access;
  if (kept.refresh === null)
    throw new Error('The calendar has to be connected again: its permission has ended.');
  const fresh = await provider.refresh(kept.refresh);
  await deps.system('a calendar’s tokens renewed', async (env) => {
    await env
      .model('calendar.sync.account')
      .browse([account as never])
      .write({
        accessSealed: seal(fresh.access, deps.key),
        ...(fresh.refresh === null ? {} : { refreshSealed: seal(fresh.refresh, deps.key) }),
        expiresAt: new Date(fresh.expiresAt),
      } as never);
  });
  return fresh.access;
}

/** Syncs one connected calendar. Says what it did; a failure is kept on the account and thrown. */
export async function syncAccount(deps: SyncDeps, account: number): Promise<SyncResult> {
  const now = (deps.now ?? Date.now)();
  const window = windowOf(now);
  const result = { pushed: 0, pulled: 0, deletedHere: 0, deletedThere: 0 };
  try {
    const who = await deps.system('a calendar sync starts', async (env) => {
      const [a] = await env
        .model('calendar.sync.account')
        .browse([account as never])
        .load({ user: true });
      return a === undefined ? null : { user: a.user.id as number, provider: a.provider };
    });
    if (who === null) throw new Error('This calendar is no longer connected.');
    const provider = deps.providers.get(who.provider);
    if (provider === undefined || !provider.configured())
      throw new Error(`The ${who.provider} calendar is not set up on this server.`);
    const access = await accessOf(deps, provider, account);

    // Here: the person's own events that take place, in the window; and what was linked.
    const here = await deps.system('a calendar sync reads', async (env) => {
      const events = await env.model('calendar.event').search({
        where: {
          organizer: who.user,
          state: 'confirmed',
          stop: { gt: new Date(window.from) },
          start: { lt: new Date(window.to) },
        } as never,
        limit: 5000,
      });
      const locals: LocalEvent[] = [...events].map((e) => ({
        id: e.id as number,
        fields: fieldsOf(e as unknown as Stored),
      }));
      const found = await env
        .model('calendar.sync.link')
        .search({ where: { account } as never, limit: 20000 })
        .then((rows) => rows.load({ event: true }));
      const inWindow = new Set(locals.map((l) => l.id));
      const outside = new Set<number>();
      const links: Link[] = [...found].map((l) => {
        const event = l.event;
        // Still there and taking place, but out of the window: left alone. Cancelled counts as deleted here.
        const alive = event !== null && event.state === 'confirmed';
        if (alive && !inWindow.has(event.id as number)) outside.add(event.id as number);
        return {
          id: l.id as number,
          event: alive ? (event.id as number) : null,
          remoteId: l.remoteId,
          etag: l.etag,
          stamp: l.stamp,
        };
      });
      return { locals, links, outside };
    });

    // There: the window, and every linked event that is not in it but still exists.
    const remotes = new Map<string, RemoteEvent>(
      (await provider.list(access, window)).map((r) => [r.id, r]),
    );
    for (const link of here.links) {
      if (remotes.has(link.remoteId)) continue;
      const one = await provider.get(access, link.remoteId);
      if (one !== null) remotes.set(one.id, one);
    }

    const remember = (values: Record<string, unknown>, link: number | null) =>
      deps.system('a synced event remembered', async (env) => {
        if (link === null)
          await env.model('calendar.sync.link').create([{ account, ...values } as never]);
        else
          await env
            .model('calendar.sync.link')
            .browse([link as never])
            .write(values as never);
      });
    const forget = (link: number) =>
      deps.system('a synced event forgotten', async (env) => {
        await env
          .model('calendar.sync.link')
          .browse([link as never])
          .unlink();
      });
    /** Writes an event here from the other calendar, and remembers it as it is kept here. */
    const pull = (remote: RemoteEvent, link: Link | null) =>
      deps.system('an event from the other calendar', async (env) => {
        const events = env.model('calendar.event');
        let id = link?.event ?? null;
        if (id !== null && (await events.search({ where: { id } as never, limit: 1 })).length === 0)
          id = null;
        if (id === null) {
          const made = await events.create([
            {
              ...valuesOf(remote.fields),
              organizer: who.user,
              // A person's own calendar is theirs: others see only that they are busy.
              privacy: 'private',
            } as never,
          ]);
          id = made.ids[0] as number;
        } else {
          const one = events.browse([id as never]);
          const [was] = await one.load(['state']);
          await one.write(valuesOf(remote.fields) as never);
          if (was?.state === 'cancelled') await one.restore();
        }
        await env.flush();
        const [kept] = await events.browse([id as never]).load({});
        const values = {
          event: id,
          remoteId: remote.id,
          etag: remote.etag,
          stamp: stampOf(fieldsOf(kept as unknown as Stored)),
        };
        if (link === null)
          await env.model('calendar.sync.link').create([{ account, ...values } as never]);
        else
          await env
            .model('calendar.sync.link')
            .browse([link.id as never])
            .write(values as never);
      });

    for (const op of plan(here.locals, [...remotes.values()], here.links, here.outside)) {
      switch (op.op) {
        case 'push-new': {
          const made = await provider.create(access, op.event.fields);
          await remember(
            {
              event: op.event.id,
              remoteId: made.id,
              etag: made.etag,
              stamp: stampOf(op.event.fields),
            },
            op.replaces,
          );
          result.pushed += 1;
          break;
        }
        case 'push-update': {
          const changed = await provider.update(access, op.link.remoteId, op.event.fields);
          await remember({ etag: changed.etag, stamp: stampOf(op.event.fields) }, op.link.id);
          result.pushed += 1;
          break;
        }
        case 'pull-new':
          await pull(op.remote, null);
          result.pulled += 1;
          break;
        case 'pull-update':
          await pull(op.remote, op.link);
          result.pulled += 1;
          break;
        case 'delete-remote':
          await provider.remove(access, op.link.remoteId);
          await forget(op.link.id);
          result.deletedThere += 1;
          break;
        case 'delete-local': {
          const link = op.link;
          await deps.system('an event deleted in the other calendar', async (env) => {
            if (link.event !== null)
              await env
                .model('calendar.event')
                .browse([link.event as never])
                .unlink();
            await env
              .model('calendar.sync.link')
              .browse([link.id as never])
              .unlink();
          });
          result.deletedHere += 1;
          break;
        }
        case 'remember':
          await remember({ etag: op.etag, stamp: op.stamp }, op.link.id);
          break;
        case 'forget':
          await forget(op.link.id);
          break;
      }
    }
    await deps.system('a calendar sync ends', async (env) => {
      await env
        .model('calendar.sync.account')
        .browse([account as never])
        .write({
          lastSyncAt: new Date(now),
          lastError: null,
          lastResult: `${result.pulled} in, ${result.pushed} out, ${result.deletedHere + result.deletedThere} deleted`,
        } as never);
    });
    return result;
  } catch (error) {
    const said = (error instanceof Error ? error.message : String(error)).slice(0, 300);
    await deps
      .system('a calendar sync failed', async (env) => {
        const accounts = await env
          .model('calendar.sync.account')
          .search({ where: { id: account } as never, limit: 1 });
        if (accounts.length > 0) await accounts.write({ lastError: said } as never);
      })
      .catch(() => undefined);
    throw error;
  }
}
