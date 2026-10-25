/**
 * A small key-value store on IndexedDB, for what the app keeps on the device: the query cache (recently opened
 * screens, readable offline) and the queue of changes saved offline. Everything is per browser profile; the
 * callers scope their keys by user. Without IndexedDB (some private windows), every operation is a no-op.
 */
const DB = 'kosh';
const STORE = 'kv';

export function kvAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

let opening: Promise<IDBDatabase> | undefined;

function open(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB is not available.'));
    request.onblocked = () => reject(new Error('IndexedDB is blocked.'));
  });
  return opening;
}

function run<T>(
  mode: IDBTransactionMode,
  op: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  if (!kvAvailable()) return Promise.resolve(undefined as T);
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const request = op(db.transaction(STORE, mode).objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB failed.'));
      }),
  );
}

export const kvGet = <T>(key: string): Promise<T | undefined> =>
  run<T | undefined>('readonly', (s) => s.get(key) as IDBRequest<T | undefined>).catch(
    () => undefined,
  );
export const kvSet = (key: string, value: unknown): Promise<void> =>
  run('readwrite', (s) => s.put(value, key))
    .then(() => undefined)
    .catch(() => undefined);
export const kvDelete = (key: string): Promise<void> =>
  run('readwrite', (s) => s.delete(key))
    .then(() => undefined)
    .catch(() => undefined);
