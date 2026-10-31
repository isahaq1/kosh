/**
 * Changes saved offline (RFC 0010 Phase B): when a save cannot reach the server, the form keeps it here, on the
 * device and per user, and the queue sends it when the network is back, in order, as the very request the form
 * would have made (a create, or an update with the record's version). The server stays the authority: a version
 * that moved meanwhile is a **conflict** the user resolves (open the record, overwrite, or discard), and a refusal
 * (a rule, a right, a validation) is shown with its reason for a retry or a discard. Nothing is sent as someone
 * else: the queue of a user only syncs while they are signed in.
 */
import { ApiError, type KoshApi, NetworkError } from '../api.js';
import { kvGet, kvSet } from './db.js';

export type ChangeStatus = 'pending' | 'conflict' | 'refused';

export interface QueuedChange {
  readonly id: string;
  readonly at: number;
  /** A record created or updated through the generated API, or a module's route replayed as sent (`request`). */
  readonly kind: 'create' | 'update' | 'request';
  readonly model: string;
  /** `request` only: the method and path, with `values` as the body. */
  readonly method?: 'POST' | 'PATCH' | 'PUT' | undefined;
  readonly path?: string | undefined;
  /** The list's label, for people (e.g. "Contacts"). */
  readonly modelLabel: string;
  readonly recordId: number | null;
  readonly title: string;
  readonly values: Readonly<Record<string, unknown>>;
  /** The version the update was made on (its ETag): the server refuses when it moved. */
  readonly etag: string | null;
  /** Where the record opens (the form it was saved from). */
  readonly app?: string | undefined;
  readonly action?: string | undefined;
  readonly status: ChangeStatus;
  readonly error: string | null;
}

export type NewChange = Omit<QueuedChange, 'id' | 'at' | 'status' | 'error'>;

export interface SyncResult {
  readonly synced: number;
  /** Conflicts and refusals left for the user. */
  readonly attention: number;
  /** The network went before the queue was empty. */
  readonly offline: boolean;
}

const key = (uid: number) => `queue.${uid}`;

export class OfflineQueue {
  private uid: number | null = null;
  private items: readonly QueuedChange[] = [];
  private readonly listeners = new Set<() => void>();
  private loading: Promise<void> = Promise.resolve();
  private syncing: Promise<SyncResult> | null = null;

  constructor(private readonly api: KoshApi) {}

  /** The signed-in user: their queue is loaded (and another user's is left alone). */
  setUser(uid: number | null): Promise<void> {
    if (uid === this.uid) return this.loading;
    this.uid = uid;
    this.items = [];
    this.emit();
    this.loading =
      uid === null
        ? Promise.resolve()
        : kvGet<QueuedChange[]>(key(uid)).then((stored) => {
            if (this.uid !== uid) return;
            this.items = Array.isArray(stored) ? stored : [];
            this.emit();
          });
    return this.loading;
  }

  /** The changes, oldest first (a stable array for `useSyncExternalStore`). */
  snapshot(): readonly QueuedChange[] {
    return this.items;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Keeps a change the server could not be reached for. */
  async add(change: NewChange): Promise<QueuedChange> {
    await this.loading;
    const queued: QueuedChange = {
      ...change,
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      at: Date.now(),
      status: 'pending',
      error: null,
    };
    // One pending update per record: a later save of the same record replaces the earlier one (same version).
    const rest =
      change.kind === 'update'
        ? this.items.filter(
            (i) =>
              !(
                i.kind === 'update' &&
                i.model === change.model &&
                i.recordId === change.recordId &&
                i.status === 'pending'
              ),
          )
        : this.items;
    const merged =
      change.kind === 'update'
        ? this.items.find(
            (i) =>
              i.kind === 'update' &&
              i.model === change.model &&
              i.recordId === change.recordId &&
              i.status === 'pending',
          )
        : undefined;
    await this.replace([
      ...rest,
      merged === undefined
        ? queued
        : { ...queued, values: { ...merged.values, ...queued.values }, etag: merged.etag },
    ]);
    return queued;
  }

  async discard(id: string): Promise<void> {
    await this.replace(this.items.filter((i) => i.id !== id));
  }

  /** Sends one change again; `overwrite` drops the version check of an update (the user's choice on a conflict). */
  async retry(id: string, overwrite = false): Promise<ChangeStatus | 'synced' | 'offline'> {
    const item = this.items.find((i) => i.id === id);
    if (item === undefined) return 'synced';
    const outcome = await this.send(overwrite ? { ...item, etag: null } : item);
    if (outcome === 'synced') await this.discard(id);
    else if (outcome !== 'offline')
      await this.replace(
        this.items.map((i) =>
          i.id === id ? { ...i, status: outcome.status, error: outcome.error } : i,
        ),
      );
    return outcome === 'synced' || outcome === 'offline' ? outcome : outcome.status;
  }

  /** Sends every pending change in order; stops at the first network failure. One run at a time. */
  sync(): Promise<SyncResult> {
    this.syncing ??= this.run().finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  private async run(): Promise<SyncResult> {
    await this.loading;
    let synced = 0;
    let offline = false;
    for (const item of this.items.filter((i) => i.status === 'pending')) {
      if (!this.items.includes(item)) continue; // discarded meanwhile
      const outcome = await this.send(item);
      if (outcome === 'offline') {
        offline = true;
        break;
      }
      if (outcome === 'synced') {
        synced += 1;
        await this.replace(this.items.filter((i) => i.id !== item.id));
      } else
        await this.replace(
          this.items.map((i) =>
            i.id === item.id ? { ...i, status: outcome.status, error: outcome.error } : i,
          ),
        );
    }
    return {
      synced,
      attention: this.items.filter((i) => i.status !== 'pending').length,
      offline,
    };
  }

  private async send(
    item: QueuedChange,
  ): Promise<'synced' | 'offline' | { status: ChangeStatus; error: string }> {
    try {
      if (item.kind === 'create') await this.api.create(item.model, { ...item.values });
      else if (item.kind === 'request')
        await this.api.call(item.method ?? 'POST', item.path ?? '', { ...item.values });
      else
        await this.api.update(item.model, item.recordId as number, { ...item.values }, item.etag);
      return 'synced';
    } catch (error) {
      if (error instanceof NetworkError) return 'offline';
      if (error instanceof ApiError)
        return {
          status: error.kind === 'stale-record' ? 'conflict' : 'refused',
          error: error.message,
        };
      return { status: 'refused', error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async replace(items: readonly QueuedChange[]): Promise<void> {
    this.items = items;
    this.emit();
    if (this.uid !== null) await kvSet(key(this.uid), items);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
