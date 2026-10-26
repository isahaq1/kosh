/** Cron expressions (RFC 0011 §5.1): fields, lists, ranges, steps, aliases; the next slot; due or not. */
import { expect, test } from 'vitest';
import { isDue, nextRun, parseCron, signWebhook, webhookProblem } from '../src/index.js';

const at = (iso: string) => new Date(iso);

test('parsing: steps, ranges, lists, aliases; bad expressions refused', () => {
  const c = parseCron('*/15 9-17 * * 1-5');
  expect([...c.minutes]).toEqual([0, 15, 30, 45]);
  expect([...c.hours]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
  expect([...c.weekdays]).toEqual([1, 2, 3, 4, 5]);
  expect([...parseCron('@daily').hours]).toEqual([0]);
  expect([...parseCron('0 0 * * 7').weekdays]).toEqual([0]); // 7 is Sunday too
  expect(() => parseCron('* * *')).toThrow('five fields');
  expect(() => parseCron('61 * * * *')).toThrow('Bad range');
  expect(() => parseCron('*/0 * * * *')).toThrow('Bad step');
});

test('the next slot, strictly after; across days and months', () => {
  expect(nextRun(parseCron('0 2 * * *'), at('2026-10-26T01:30:00Z'))?.toISOString()).toBe(
    '2026-10-26T02:00:00.000Z',
  );
  expect(nextRun(parseCron('0 2 * * *'), at('2026-10-26T02:00:00Z'))?.toISOString()).toBe(
    '2026-10-27T02:00:00.000Z',
  );
  expect(nextRun(parseCron('30 8 * * 1'), at('2026-10-26T09:00:00Z'))?.toISOString()).toBe(
    '2026-11-02T08:30:00.000Z',
  ); // Mondays
  expect(nextRun(parseCron('0 0 1 * *'), at('2026-10-26T00:00:00Z'))?.toISOString()).toBe(
    '2026-11-01T00:00:00.000Z',
  );
  expect(nextRun(parseCron('0 0 31 2 *'), at('2026-01-01T00:00:00Z'))).toBeNull(); // never
});

test('due: the slot after the last run (or the creation) has passed', () => {
  const daily = parseCron('0 2 * * *');
  const created = at('2026-10-25T10:00:00Z');
  expect(isDue(daily, null, created, at('2026-10-26T01:00:00Z'))).toBeNull();
  expect(isDue(daily, null, created, at('2026-10-26T02:05:00Z'))?.toISOString()).toBe(
    '2026-10-26T02:00:00.000Z',
  );
  expect(isDue(daily, at('2026-10-26T02:00:00Z'), created, at('2026-10-26T23:00:00Z'))).toBeNull();
});

test('webhooks: https and the allow-list; the signature', () => {
  expect(webhookProblem('https://hooks.example.com/x', ['hooks.example.com'])).toBeNull();
  expect(webhookProblem('https://a.example.com/x', ['*.example.com'])).toBeNull();
  expect(webhookProblem('https://evil.test/x', ['hooks.example.com'])).toContain('allow-list');
  expect(webhookProblem('http://hooks.example.com/x', ['hooks.example.com'])).toContain('https');
  expect(webhookProblem('http://127.0.0.1:8080/x', ['127.0.0.1'])).toBeNull();
  expect(webhookProblem('not a url', [])).toContain('Not a URL');
  expect(signWebhook('s', '{}')).toMatch(/^sha256=[0-9a-f]{64}$/);
});
