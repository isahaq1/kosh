/**
 * Document numbering on real PostgreSQL (RFC 0020 §3.3), through Shutro's `sequenceAdmin` (request #31): an
 * Administrator reads every sequence of the installed apps with the document it numbers and the next number as a
 * document would carry it; previews a change without making it; changes the format and moves the next number
 * forward — the next document carries it —; a number already issued, a format that is none and an unknown sequence
 * are refused in words; the change is in the audit log; nobody but an Administrator reads or changes numbering.
 */
import { defineModule as defineKoshModule, type KoshModule } from '@kosh/modules-sdk';
import { base, baseShutro } from '@kosh/server';
import { orm } from '@kosh/server/orm';
import { type TestInstallation, testInstallation } from '@kosh/server/testing';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { settings } from '../src/index.js';

const N = '/api/v1/settings/numbering';
let erp: TestInstallation;
const year = new Date().toISOString().slice(0, 4);

const Doc = orm.defineModel('demo.doc', {
  label: 'Delivery note',
  companyScoped: { required: true },
  access: { 'demo.user': ['read', 'write', 'create'] },
  fields: {
    name: orm.f.char({ required: true, sequence: 'demo.doc', label: 'Number' }),
    note: orm.f.char(),
  },
});
const demo: KoshModule = defineKoshModule({
  shutro: orm.defineModule({
    name: 'demo',
    version: '0.1.0',
    depends: [baseShutro],
    groups: [orm.defineGroup({ code: 'demo.user', label: 'Demo user', implies: ['base.user'] })],
    sequences: [
      orm.defineSequence({ code: 'demo.doc', prefix: 'DN/{year}/', padding: 4, reset: 'yearly' }),
    ],
    models: [Doc],
  }),
  kosh: '^0.1.0',
  depends: [base],
  app: { code: 'demo', label: 'Deliveries', icon: 'box', sequence: 5, category: 'Test' },
  accessLevels: { user: { label: 'User', groups: ['demo.user'] } },
  // A test app: the module standard's screens are not what is tested here.
  standard: { waive: [] },
});

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
const call = async (method: 'GET' | 'POST' | 'PUT', url: string, as: string, body?: unknown) => {
  const res = await erp.call(method as 'GET', url, as, body);
  return { status: res.status, json: res.json as Json };
};
const note = async (): Promise<string> => {
  const made = await call('POST', '/api/v1/models/demo.doc', 'dana', { note: 'x' });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  return (await call('GET', `/api/v1/models/demo.doc/${made.json.id}?fields=name`, 'dana')).json
    .name as string;
};
const mine = async (): Promise<Json> => {
  const all = await call('GET', N, 'admin');
  expect(all.status, JSON.stringify(all.json)).toBe(200);
  return (all.json.apps as Json[])
    .find((a) => a.app === 'demo')
    ?.sequences.find((s: Json) => s.code === 'demo.doc');
};

beforeAll(async () => {
  erp = await testInstallation({
    modules: [settings, demo],
    users: { dana: ['demo.user'] },
    company: { name: 'Padma Traders', currency: 'BDT' },
  });
}, 300_000);

afterAll(async () => {
  await erp?.close();
});

test('an Administrator reads each app’s sequences: the document, the format, the next number as it will print', async () => {
  const all = await call('GET', N, 'admin');
  const app = (all.json.apps as Json[]).find((a) => a.app === 'demo');
  expect(app).toMatchObject({ label: 'Deliveries', icon: 'box' });
  expect(app.sequences).toEqual([
    {
      code: 'demo.doc',
      label: 'Delivery note',
      gapless: false,
      declared: { prefix: 'DN/{year}/', suffix: '', padding: 4, reset: 'yearly' },
      format: { prefix: 'DN/{year}/', suffix: '', padding: 4, reset: 'yearly' },
      changed: false,
      period: year,
      next: 1,
      preview: `DN/${year}/0001`,
    },
  ]);
  expect(await note()).toBe(`DN/${year}/0001`);
  expect((await mine()).preview).toBe(`DN/${year}/0002`);
});

test('a preview changes nothing; a change is what the next document carries', async () => {
  const previewed = await call('POST', `${N}/demo.doc/preview`, 'admin', {
    format: { prefix: 'CH-{yy}-', padding: 3 },
    next: 40,
  });
  expect(previewed.status, JSON.stringify(previewed.json)).toBe(200);
  expect(previewed.json).toMatchObject({ next: 40, preview: `CH-${year.slice(2)}-040` });
  expect(await mine()).toMatchObject({ changed: false, next: 2 });
  const changed = await call('PUT', `${N}/demo.doc`, 'admin', {
    format: { prefix: 'CH-{yy}-', padding: 3 },
    next: 40,
  });
  expect(changed.status, JSON.stringify(changed.json)).toBe(200);
  expect(changed.json).toMatchObject({
    changed: true,
    format: { prefix: 'CH-{yy}-', suffix: '', padding: 3, reset: 'yearly' },
    next: 40,
    preview: `CH-${year.slice(2)}-040`,
  });
  expect(await note()).toBe(`CH-${year.slice(2)}-040`);
  // In the audit log, in words.
  const [entry] = await erp.host.server.driver.query<{ summary: string }>({
    text: `SELECT summary FROM audit_event WHERE kind = 'settings.numbering' ORDER BY id DESC LIMIT 1`,
    params: [],
  });
  expect(entry?.summary).toBe(
    `Deliveries › Numbering › Delivery note: the next is CH-${year.slice(2)}-040 (was DN/${year}/0002).`,
  );
  // Back to the app's own format: the counter stays where it is.
  const back = await call('PUT', `${N}/demo.doc`, 'admin', { format: null });
  expect(back.json).toMatchObject({ changed: false, next: 41, preview: `DN/${year}/0041` });
});

test('refused in words: a number already issued, a format that is none, a sequence that is none', async () => {
  const lower = await call('PUT', `${N}/demo.doc`, 'admin', { format: null, next: 5 });
  expect(lower.status).toBe(422);
  expect(JSON.stringify(lower.json)).toContain('already issued numbers up to 40');
  for (const format of [
    { prefix: '{week}/' },
    { padding: 99 },
    { reset: 'weekly' },
    { prefix: 7 },
  ]) {
    const bad = await call('PUT', `${N}/demo.doc`, 'admin', { format });
    expect(bad.status, JSON.stringify(format)).toBe(422);
    expect(
      (await call('POST', `${N}/demo.doc/preview`, 'admin', { format })).status,
      JSON.stringify(format),
    ).toBe(422);
  }
  expect((await call('PUT', `${N}/demo.doc`, 'admin', {})).status).toBe(400);
  expect((await call('PUT', `${N}/no.such`, 'admin', { format: null })).status).toBe(404);
  // Nothing of it was kept.
  expect(await mine()).toMatchObject({ changed: false, next: 41 });
});

test('numbering is an Administrator’s: nobody else reads or changes it', async () => {
  expect((await call('GET', N, 'dana')).status).toBe(403);
  expect(
    (await call('POST', `${N}/demo.doc/preview`, 'dana', { format: { padding: 2 } })).status,
  ).toBe(403);
  expect(
    (await call('PUT', `${N}/demo.doc`, 'dana', { format: { padding: 2 }, next: 9000 })).status,
  ).toBe(403);
  expect(await mine()).toMatchObject({ changed: false, next: 41 });
});
