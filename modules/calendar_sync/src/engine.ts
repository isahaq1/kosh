/**
 * Two-way calendar sync (RFC 0034 §2.4), without a database or a provider: given a person's events here, their
 * events in the other calendar, and what was the same at the last sync, what to do now — push, pull, delete on
 * one side or the other. The rules are few and fixed, so that a sync run twice does nothing the second time and
 * no event is made twice.
 */

/** What of an event travels between the two calendars. */
export interface EventFields {
  readonly title: string;
  /** ISO instants; for an all-day event, midnight UTC of the first day and of the day after the last. */
  readonly start: string;
  readonly stop: string;
  readonly allDay: boolean;
  readonly location: string | null;
  /** Plain text. */
  readonly description: string | null;
}

const text = (value: string | null | undefined): string | null => {
  const clean = (value ?? '').replace(/\r\n?/g, '\n').trim();
  return clean === '' ? null : clean;
};
const instant = (value: string): string => {
  const at = Date.parse(value);
  return Number.isNaN(at) ? value : new Date(Math.floor(at / 1000) * 1000).toISOString();
};

/** The fields as they are compared: spaces trimmed, empty as nothing, times to the second. */
export function normalise(fields: EventFields): EventFields {
  return {
    title: (text(fields.title) ?? '').replace(/\s+/g, ' ').slice(0, 250),
    start: instant(fields.start),
    stop: instant(fields.stop),
    allDay: fields.allDay === true,
    location: text(fields.location)?.slice(0, 250) ?? null,
    description: text(fields.description)?.slice(0, 8000) ?? null,
  };
}

/** What two versions of an event are compared by: equal stamps, equal events. */
export function stampOf(fields: EventFields): string {
  const n = normalise(fields);
  return JSON.stringify([n.title, n.start, n.stop, n.allDay, n.location, n.description]);
}

export interface LocalEvent {
  readonly id: number;
  readonly fields: EventFields;
}
export interface RemoteEvent {
  readonly id: string;
  /** Changes whenever the event changes at the provider. */
  readonly etag: string;
  readonly fields: EventFields;
}
/** What was the same on both sides at the last sync. */
export interface Link {
  readonly id: number;
  /** The event here; `null` once it was deleted here. */
  readonly event: number | null;
  readonly remoteId: string;
  readonly etag: string;
  readonly stamp: string;
}

export type Op =
  /** An event of here the other calendar does not have yet. */
  | { readonly op: 'push-new'; readonly event: LocalEvent; readonly replaces: number | null }
  | { readonly op: 'push-update'; readonly event: LocalEvent; readonly link: Link }
  /** An event of the other calendar that is not here yet. */
  | { readonly op: 'pull-new'; readonly remote: RemoteEvent }
  | { readonly op: 'pull-update'; readonly remote: RemoteEvent; readonly link: Link }
  /** Deleted here: deleted there. */
  | { readonly op: 'delete-remote'; readonly link: Link }
  /** Deleted there: deleted here. */
  | { readonly op: 'delete-local'; readonly link: Link }
  /** The same on both sides after all: only what is remembered changes. */
  | {
      readonly op: 'remember';
      readonly link: Link;
      readonly etag: string;
      readonly stamp: string;
    }
  /** Gone on both sides. */
  | { readonly op: 'forget'; readonly link: Link };

/**
 * What a sync does. `locals` are the person's events here that take part (in the window, not cancelled);
 * `remotes` their events at the provider — **every** linked one that still exists there must be among them, in the
 * window or not: an event that is not given was deleted there. `outside` are the ids of linked events here that
 * still exist but do not take part (out of the window): they are left alone.
 *
 * - Changed on one side since the last sync: it goes to the other.
 * - Changed on both: the same after all — remembered; else the other calendar's version wins, and is pulled.
 * - Deleted on one side: deleted on the other — unless the other side changed since: then it is kept, and made
 *   again where it was deleted.
 */
export function plan(
  locals: readonly LocalEvent[],
  remotes: readonly RemoteEvent[],
  links: readonly Link[],
  outside: ReadonlySet<number> = new Set(),
): Op[] {
  const ops: Op[] = [];
  const byId = new Map(locals.map((l) => [l.id, l]));
  const byRemote = new Map(remotes.map((r) => [r.id, r]));
  const linkedLocal = new Set<number>();
  const linkedRemote = new Set<string>();
  for (const link of links) {
    linkedRemote.add(link.remoteId);
    if (link.event !== null) linkedLocal.add(link.event);
    const remote = byRemote.get(link.remoteId);
    // Out of the window here, still there: nothing to say about it now.
    if (link.event !== null && outside.has(link.event)) continue;
    const local = link.event === null ? undefined : byId.get(link.event);
    if (local === undefined && remote === undefined) {
      ops.push({ op: 'forget', link });
      continue;
    }
    if (local === undefined) {
      const there = remote as RemoteEvent;
      // Deleted (or cancelled) here. Changed there meanwhile: it is kept, and comes back here.
      if (there.etag !== link.etag && stampOf(there.fields) !== link.stamp)
        ops.push({ op: 'pull-update', remote: there, link });
      else ops.push({ op: 'delete-remote', link });
      continue;
    }
    const stamp = stampOf(local.fields);
    if (remote === undefined) {
      // Deleted there. Changed here meanwhile: it is kept, and made there again.
      if (stamp !== link.stamp) ops.push({ op: 'push-new', event: local, replaces: link.id });
      else ops.push({ op: 'delete-local', link });
      continue;
    }
    const localChanged = stamp !== link.stamp;
    const remoteChanged = remote.etag !== link.etag;
    if (!localChanged && !remoteChanged) continue;
    const remoteStamp = stampOf(remote.fields);
    if (remoteStamp === stamp) {
      ops.push({ op: 'remember', link, etag: remote.etag, stamp });
      continue;
    }
    // The provider's tag may change without anything we carry changing: then only here changed.
    if (localChanged && (!remoteChanged || remoteStamp === link.stamp))
      ops.push({ op: 'push-update', event: local, link });
    else ops.push({ op: 'pull-update', remote, link });
  }
  for (const local of locals)
    if (!linkedLocal.has(local.id)) ops.push({ op: 'push-new', event: local, replaces: null });
  for (const remote of remotes)
    if (!linkedRemote.has(remote.id)) ops.push({ op: 'pull-new', remote });
  return ops;
}

/** The window a sync looks at: from a month ago to a year ahead, in ISO instants. */
export function windowOf(now: number): { from: string; to: string } {
  const day = 86_400_000;
  return {
    from: new Date(now - 30 * day).toISOString(),
    to: new Date(now + 365 * day).toISOString(),
  };
}
