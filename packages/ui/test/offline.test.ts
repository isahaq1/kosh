/**
 * The queue of changes saved offline: in order, as the requests the form would have made; a moved version is a
 * conflict, a refusal keeps its reason, the network going stops the run, and one pending update per record.
 */
import { describe, expect, test } from 'vitest';
import { ApiError, type KoshApi, NetworkError, OfflineQueue } from '../src/index.js';

function fakeApi(
  answer: (call: { method: string; model: string; etag: string | null }) => unknown,
) {
  const calls: {
    method: string;
    model: string;
    id?: number;
    values: unknown;
    etag: string | null;
  }[] = [];
  const api = {
    async create(model: string, values: Record<string, unknown>) {
      calls.push({ method: 'create', model, values, etag: null });
      const a = answer({ method: 'create', model, etag: null });
      if (a instanceof Error) throw a;
      return { record: { id: 1, ...values }, etag: '"1"' };
    },
    async update(model: string, id: number, values: Record<string, unknown>, etag?: string | null) {
      calls.push({ method: 'update', model, id, values, etag: etag ?? null });
      const a = answer({ method: 'update', model, etag: etag ?? null });
      if (a instanceof Error) throw a;
      return { record: { id, ...values }, etag: '"2"' };
    },
  } as unknown as KoshApi;
  return { api, calls };
}

const stale = () =>
  new ApiError({
    type: 'https://kosh.dev/problems/stale-record',
    title: 'Stale',
    status: 412,
    detail: 'The record changed.',
  });
const forbidden = () =>
  new ApiError({
    type: 'https://kosh.dev/problems/access',
    title: 'Forbidden',
    status: 403,
    detail: 'You may not write this.',
  });

describe('OfflineQueue', () => {
  test('sends in order; a conflict and a refusal stay for the user with their reason', async () => {
    const { api, calls } = fakeApi(({ etag }) => (etag === '"old"' ? stale() : undefined));
    const queue = new OfflineQueue(api);
    await queue.setUser(7);
    await queue.add({
      kind: 'update',
      model: 'res.partner',
      modelLabel: 'Contacts',
      recordId: 3,
      title: 'Bengal Steel',
      values: { city: 'Khulna' },
      etag: '"old"',
    });
    await queue.add({
      kind: 'create',
      model: 'res.partner',
      modelLabel: 'Contacts',
      recordId: null,
      title: 'New',
      values: { name: 'Padma' },
      etag: null,
    });
    const result = await queue.sync();
    expect(result).toEqual({ synced: 1, attention: 1, offline: false });
    expect(calls.map((c) => c.method)).toEqual(['update', 'create']);
    expect(calls[0]?.etag).toBe('"old"');
    const [left] = queue.snapshot();
    expect(left?.status).toBe('conflict');
    expect(left?.error).toContain('The record changed.');

    // Overwrite: the same update without the version check.
    expect(await queue.retry(left?.id as string, true)).toBe('synced');
    expect(calls[2]).toMatchObject({ method: 'update', id: 3, etag: null });
    expect(queue.snapshot()).toEqual([]);
  });

  test('the network going stops the run; later saves of one record merge into one pending update', async () => {
    let online = false;
    const { api, calls } = fakeApi(() =>
      online ? undefined : new NetworkError(new TypeError('x')),
    );
    const queue = new OfflineQueue(api);
    await queue.setUser(7);
    const base = {
      kind: 'update' as const,
      model: 'res.partner',
      modelLabel: 'Contacts',
      recordId: 3,
      title: 'B',
    };
    await queue.add({ ...base, values: { city: 'Khulna' }, etag: '"1"' });
    await queue.add({ ...base, values: { phone: '017' }, etag: '"1"' });
    expect(queue.snapshot()).toHaveLength(1);
    expect(queue.snapshot()[0]?.values).toEqual({ city: 'Khulna', phone: '017' });
    expect(await queue.sync()).toEqual({ synced: 0, attention: 0, offline: true });
    expect(queue.snapshot()[0]?.status).toBe('pending');
    online = true;
    expect(await queue.sync()).toEqual({ synced: 1, attention: 0, offline: false });
    expect(calls).toHaveLength(2);
  });

  test('a refusal can be retried or discarded; another user sees an empty queue', async () => {
    let allowed = false;
    const { api } = fakeApi(() => (allowed ? undefined : forbidden()));
    const queue = new OfflineQueue(api);
    await queue.setUser(7);
    await queue.add({
      kind: 'create',
      model: 'res.partner',
      modelLabel: 'Contacts',
      recordId: null,
      title: 'New',
      values: { name: 'Padma' },
      etag: null,
    });
    expect(await queue.sync()).toEqual({ synced: 0, attention: 1, offline: false });
    expect(queue.snapshot()[0]).toMatchObject({
      status: 'refused',
      error: 'You may not write this.',
    });
    await queue.setUser(8);
    expect(queue.snapshot()).toEqual([]);
    await queue.setUser(7);
    allowed = true;
    expect(await queue.retry(queue.snapshot()[0]?.id as string)).toBe('synced');
    expect(queue.snapshot()).toEqual([]);
  });
});
