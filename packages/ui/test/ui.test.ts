import { describe, expect, test } from 'vitest';
import {
  ApiError,
  createDefaultRegistry,
  createFormatter,
  createKoshApi,
  directionOf,
  RegistryError,
} from '../src/index.js';

describe('registry', () => {
  test('defaults are registered; replacing needs { replace: true }', () => {
    const registry = createDefaultRegistry();
    expect(registry.view('list')).toBeDefined();
    expect(registry.form()).toBeDefined();
    const Custom = () => null;
    expect(() => registry.registerWidget('badge', Custom)).toThrow(RegistryError);
    registry.registerWidget('badge', Custom, { replace: true });
    expect(
      registry.widget(
        { kind: 'field', id: 'x', field: 'x', widget: 'badge' },
        { key: 'x', kind: 'char', label: 'X', required: false, readonly: false },
      ),
    ).toBe(Custom);
    // Unknown widget names fall back to the field kind, then to plain text.
    const char = registry.widget(
      { kind: 'field', id: 'y', field: 'y', widget: 'nope' },
      { key: 'y', kind: 'weird', label: 'Y', required: false, readonly: false },
    );
    expect(char).toBe(
      registry.widget(
        { kind: 'field', id: 'y', field: 'y' },
        { key: 'y', kind: 'char', label: 'Y', required: false, readonly: false },
      ),
    );
    // Clones are independent.
    const copy = registry.clone();
    copy.registerComponent('approvals.Panel', Custom);
    expect(registry.component('approvals.Panel')).toBeUndefined();
  });
});

describe('formatting', () => {
  test('exact decimals grouped per locale, never through floats', () => {
    const en = createFormatter('en_US', 'UTC');
    expect(en.decimal('750000.00')).toBe('750,000');
    expect(en.decimal('12345678901234567890.25')).toBe('12,345,678,901,234,567,890.25');
    expect(en.decimal('-0.10', 2)).toBe('-0.10');
    // South Asian grouping, and Bengali digits on request.
    expect(createFormatter('bn_BD', 'Asia/Dhaka').decimal('750000.5')).toBe('7,50,000.5');
    expect(createFormatter('bn_BD', 'Asia/Dhaka', { nativeDigits: true }).decimal('750000.5')).toBe(
      '৭,৫০,০০০.৫',
    );
  });
  test('dates are calendar dates; datetimes in the user time zone', () => {
    const f = createFormatter('en_US', 'Asia/Dhaka');
    expect(f.date('2026-10-18')).toBe('Oct 18, 2026');
    expect(f.datetime('2026-10-18T20:30:00Z')).toBe('Oct 19, 2026, 2:30 AM');
  });
  test('text direction', () => {
    expect(directionOf('ar')).toBe('rtl');
    expect(directionOf('bn-BD')).toBe('ltr');
    expect(directionOf('ur_PK')).toBe('rtl');
  });
});

describe('api client', () => {
  test('sends the CSRF token after sign-in, the company and language; problems become ApiError', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const store = new Map<string, string>();
    const api = createKoshApi({
      storage: {
        getItem: (k) => store.get(k) ?? null,
        setItem: (k, v) => void store.set(k, v),
        removeItem: (k) => void store.delete(k),
      },
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        if (url.endsWith('/auth/login'))
          return new Response(
            JSON.stringify({ token: 't', csrfToken: 'csrf-1', twoFactorRequired: false }),
            { status: 200 },
          );
        if (url.includes('/models/res.partner/9'))
          return new Response(
            JSON.stringify({
              type: 'https://kosh.dev/problems/stale-record',
              title: 'Changed',
              status: 412,
              detail: 'Changed since read.',
            }),
            { status: 412 },
          );
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { etag: '"1"' },
        });
      }) as typeof fetch,
    });
    await api.login('rahim', 'pw');
    api.setCompany(2);
    api.setLanguage('bn_BD');
    await api.list('res.partner', { filter: { name: 'x' }, fields: ['name'] });
    const error = await api.update('res.partner', 9, { name: 'y' }, '"5"').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).kind).toBe('stale-record');
    const patch = calls.find((c) => c.init.method === 'PATCH');
    expect(patch?.init.headers).toMatchObject({
      'x-csrf-token': 'csrf-1',
      'x-company': '2',
      'accept-language': 'bn-BD',
      'if-match': '"5"',
    });
    const list = calls.find((c) => c.url.includes('/models/res.partner?'));
    expect(decodeURIComponent(list?.url ?? '')).toContain('filter={"name":"x"}');
    expect(list?.init.headers).not.toHaveProperty('x-csrf-token'); // GET
    expect(store.get('kosh.csrf')).toBe('csrf-1'); // survives reloads (sessionStorage)
  });
});
