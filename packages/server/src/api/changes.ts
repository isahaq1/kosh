/**
 * Record change announcements (RFC 0006 §5, RFC 0010 Phase B): after a transaction commits, the server tells every
 * node of the database which records changed (`NOTIFY kosh_changes`), and the realtime gateway (`@kosh/realtime`)
 * fans that out to the browsers subscribed to the model or the record. The payload names the model, the ids, the
 * operation and the user, never the data: clients refetch through the API, which checks access again.
 */
import type { Driver, Env } from '../orm.js';

/** The PostgreSQL channel of record changes. */
export const CHANGES_CHANNEL = 'kosh_changes';
/** Ids per announcement; above it, `ids` is empty and means "many records of this model". */
export const MAX_IDS = 200;

/** What an announcement carries. */
export interface RecordChange {
  readonly model: string;
  /** Empty: many records (an import, a bulk change). */
  readonly ids: readonly number[];
  readonly op: 'create' | 'update' | 'delete';
  /** The user who made the change (0 for the system). */
  readonly by: number;
  /** Milliseconds since the epoch, when it committed. */
  readonly at: number;
}

/**
 * Announces `change` once `env`'s outermost transaction commits (nothing is sent when it rolls back). Module routes
 * that write records outside the generated API call this too, so their changes reach open screens.
 */
export function announceChange(
  env: Env,
  driver: Driver,
  change: Pick<RecordChange, 'model' | 'ids' | 'op'>,
): void {
  const ids = change.ids.length > MAX_IDS ? [] : [...change.ids];
  env.afterCommit(async () => {
    const payload: RecordChange = { ...change, ids, by: env.uid, at: Date.now() };
    await driver.query({
      text: 'SELECT pg_notify($1, $2)',
      params: [CHANGES_CHANNEL, JSON.stringify(payload)],
    });
  });
}

/** Parses a notification's payload; `null` for anything that is not an announcement. */
export function parseChange(payload: string): RecordChange | null {
  try {
    const value = JSON.parse(payload) as Partial<RecordChange>;
    if (
      typeof value.model !== 'string' ||
      !Array.isArray(value.ids) ||
      !['create', 'update', 'delete'].includes(String(value.op)) ||
      typeof value.by !== 'number' ||
      typeof value.at !== 'number'
    )
      return null;
    return {
      model: value.model,
      ids: value.ids.filter((id): id is number => typeof id === 'number'),
      op: value.op as RecordChange['op'],
      by: value.by,
      at: value.at,
    };
  } catch {
    return null;
  }
}
