/**
 * Screens offline (RFC 0010 Phase B): the query cache is kept on the device, so what the user opened recently
 * (apps, menus, views, lists, records) shows again without the network, and refreshes when it is back. Only
 * reads of business screens are kept, never notifications or searches; the cache is dropped when another user
 * signs in on the same browser, and on sign-out.
 */
import { onlineManager, type QueryClient } from '@tanstack/react-query';
import type {
  PersistedClient,
  Persister,
  PersistQueryClientOptions,
} from '@tanstack/react-query-persist-client';
import { useSyncExternalStore } from 'react';
import { kvAvailable, kvDelete, kvGet, kvSet } from './db.js';

const KEY = 'queries';
const UID_KEY = 'kosh.offline.uid';
/** A day: the cache's age limit, and the client's `gcTime` must cover it. */
export const OFFLINE_MAX_AGE_MS: number = 24 * 60 * 60 * 1000;
const KEPT = new Set([
  'me',
  'apps',
  'menus',
  'routes',
  'action',
  'view',
  'search',
  'meta',
  'list',
  'record',
  'names',
  'lines',
  'totals',
  'groups',
  'kanban-stats',
  'chat',
]);

/** The user whose cache is being written (none: nothing is written, e.g. the login page or after sign-out). */
let currentUid: number | null = null;

function lastUid(): string | null {
  try {
    return localStorage.getItem(UID_KEY);
  } catch {
    return null;
  }
}

/**
 * The persister on IndexedDB, or none without it. What is written carries its user; it is restored only for the
 * user last signed in on this browser, so no one sees another's screens, even briefly.
 */
export function createOfflinePersister(): Persister | undefined {
  if (!kvAvailable()) return undefined;
  return {
    persistClient: (client: PersistedClient) =>
      currentUid === null ? Promise.resolve() : kvSet(KEY, { uid: currentUid, client }),
    restoreClient: async () => {
      const stored = await kvGet<{ uid: number; client: PersistedClient }>(KEY);
      return stored !== undefined && String(stored.uid) === lastUid() ? stored.client : undefined;
    },
    removeClient: () => kvDelete(KEY),
  };
}

/** What `PersistQueryClientProvider` needs. */
export function offlinePersistOptions(
  persister: Persister,
): Omit<PersistQueryClientOptions, 'queryClient'> {
  return {
    persister,
    maxAge: OFFLINE_MAX_AGE_MS,
    buster: 'kosh-1',
    dehydrateOptions: {
      shouldDehydrateQuery: (query) =>
        query.state.status === 'success' && KEPT.has(String(query.queryKey[0])),
    },
  };
}

/**
 * Called when the signed-in user is known: their screens are what the device keeps from now on. Another user than
 * last time (a sign-in after an expired session) starts from fresh answers: every screen is reset and refetched,
 * nothing of the previous user is shown.
 */
export async function claimOfflineCache(queryClient: QueryClient, uid: number): Promise<void> {
  const previous = lastUid();
  try {
    localStorage.setItem(UID_KEY, String(uid));
  } catch {
    // storage unavailable
  }
  currentUid = uid;
  if (previous !== null && previous !== String(uid))
    await queryClient.resetQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
}

/** Forgets the cache (sign-out). */
export async function dropOfflineCache(persister: Persister | undefined): Promise<void> {
  currentUid = null;
  try {
    localStorage.removeItem(UID_KEY);
  } catch {
    // storage unavailable
  }
  await persister?.removeClient();
}

/** Whether the browser believes it is online (TanStack Query's manager, from the `online`/`offline` events). */
export function useOnline(): boolean {
  return useSyncExternalStore(
    (notify) => onlineManager.subscribe(notify),
    () => onlineManager.isOnline(),
    () => true,
  );
}
