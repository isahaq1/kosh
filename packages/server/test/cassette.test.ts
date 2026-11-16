/**
 * The certification cassette (RFC 0034 §2.2): a live run records every exchange with the secrets taken out (raw and
 * URL-encoded, and JSON fields named like tokens), a replay serves it back and fails on a request that changed, and
 * no recording at all says how to make one.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { cassette, redact } from '../src/cassette.js';

const dir = mkdtempSync(join(tmpdir(), 'kosh-cassette-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const provider = (async (_input: string | URL | Request, init: RequestInit = {}) =>
  new Response(
    JSON.stringify({ id_token: 'eyJsecret', echoed: String(init.body ?? ''), status: 'OK' }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )) as typeof fetch;

test('secrets go, raw, URL-encoded and in token fields; the rest stays', () => {
  expect(redact('store_passwd=p%40ss&x=1', ['p@ss'])).toBe('store_passwd=<redacted>&x=1');
  expect(redact('{"refresh_token":"abc","amount":"10.00"}', [])).toBe(
    '{"refresh_token":"<redacted>","amount":"10.00"}',
  );
});

test('a live run is recorded without secrets and replayed; a changed request fails the replay', async () => {
  const file = join(dir, 'shop.json');
  const live = cassette(file, { adapter: 'shop', secrets: ['p@ss'], live: true, fetch: provider });
  const reference = live.vars('reference', () => 'REF-1');
  const answer = await live.fetch('https://sandbox.example.com/pay?key=p@ss', {
    method: 'POST',
    body: new URLSearchParams({ password: 'p@ss', reference }),
  });
  expect((await answer.json()) as unknown).toMatchObject({ status: 'OK' });
  live.save();
  const text = readFileSync(file, 'utf8');
  expect(text).not.toContain('p@ss');
  expect(text).not.toContain('p%40ss');
  expect(text).not.toContain('eyJsecret');

  const replay = cassette(file, { adapter: 'shop', secrets: ['other'], live: false });
  expect(replay.vars('reference', () => 'REF-NEW')).toBe('REF-1');
  // Replayed credentials differ from the recorded ones: they are redacted the same way when named as secrets.
  const again = cassette(file, { adapter: 'shop', secrets: ['p@ss'], live: false });
  const served = await again.fetch('https://sandbox.example.com/pay?key=p@ss', {
    method: 'POST',
    body: new URLSearchParams({ password: 'p@ss', reference: 'REF-1' }),
  });
  expect(((await served.json()) as { status: string }).status).toBe('OK');

  const changed = cassette(file, { adapter: 'shop', secrets: ['p@ss'], live: false });
  await expect(
    changed.fetch('https://sandbox.example.com/pay?key=p@ss', {
      method: 'POST',
      body: new URLSearchParams({ password: 'p@ss', reference: 'REF-1', extra: 'x' }),
    }),
  ).rejects.toThrow(
    /request 1 differs from the recording in its requestBody[\s\S]*KOSH_CERTIFY=live/,
  );
});

test('no recording yet: replay says how to make one', () => {
  expect(() => cassette(join(dir, 'none.json'), { adapter: 'none', secrets: [] })).toThrow(
    /KOSH_CERTIFY=live/,
  );
});
