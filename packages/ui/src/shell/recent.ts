/**
 * Recently opened records, per user and browser (RFC 0010 §3.1): the command palette and the home page list them
 * first. A convenience only: kept in `localStorage`, empty when storage is unavailable.
 */

/** One recently opened record. */
export interface RecentRecord {
  readonly app: string;
  readonly action: string;
  readonly model: string;
  readonly id: number;
  readonly title: string;
  readonly at: number;
}

const MAX = 12;
const key = (uid: number) => `kosh.recent.${uid}`;

/** The user's recent records, newest first. */
export function recentRecords(uid: number): RecentRecord[] {
  try {
    const raw = localStorage.getItem(key(uid));
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as RecentRecord[]).slice(0, MAX) : [];
  } catch {
    return [];
  }
}

/** Remembers that the user opened a record (moved to the front when already there). */
export function rememberRecord(uid: number, record: Omit<RecentRecord, 'at'>): void {
  try {
    const rest = recentRecords(uid).filter(
      (r) => !(r.model === record.model && r.id === record.id),
    );
    localStorage.setItem(
      key(uid),
      JSON.stringify([{ ...record, at: Date.now() }, ...rest].slice(0, MAX)),
    );
  } catch {
    // storage unavailable: nothing to remember
  }
}
