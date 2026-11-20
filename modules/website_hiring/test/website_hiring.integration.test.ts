/**
 * The careers page on real PostgreSQL (RFC 0034 §2.6): the site lists the openings that are published, open and
 * not past their closing date; a visitor without a sign-in applies — an applicant from the website in the first
 * stage, with their letter and CV attached —, once per address and opening; a robot is thanked and dropped; a
 * candidate is emailed once at each stage that has an email, and again when they come back to it.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryMailer } from '@kosh/mail';
import { type TestInstallation, testInstallation } from '@kosh/server/testing';
import { FileStorage, useStorage } from '@kosh/storage';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { careersWorkers, websiteHiringModule } from '../src/index.js';

const A = '/api/v1/models/hiring.applicant';
const CAREERS = '/api/v1/public/sites/padma/careers';
const mailer = createMemoryMailer();
let erp: TestInstallation;
let dir: string;
let drain: () => Promise<void>;
const ids: Record<string, number> = {};

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
const call = async (
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  as: string,
  body?: unknown,
) => {
  const res = await erp.call(method, url, as, body);
  return { status: res.status, json: res.json as Json };
};
const make = async (model: string, as: string, values: Record<string, unknown>) => {
  const made = await call('POST', `/api/v1/models/${model}`, as, values);
  expect(made.status, `${model}: ${JSON.stringify(made.json)}`).toBe(201);
  return made.json.id as number;
};
/** A visitor: no sign-in. */
const visit = async (method: 'GET' | 'POST', url: string, body?: unknown) => {
  const res = await erp.host.server.app.inject({
    method,
    url,
    ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
  });
  return { status: res.statusCode, json: (res.body === '' ? null : res.json()) as Json };
};
const day = (offset: number): string =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const filter = (where: Record<string, unknown>) => encodeURIComponent(JSON.stringify(where));
const applicantsOf = async (opening: number) =>
  (
    await call(
      'GET',
      `${A}?filter=${filter({ opening })}&fields=name,email,phone,source,stage,cover&order=id+asc`,
      'mona',
    )
  ).json.items as Json[];

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  dir = await mkdtemp(join(tmpdir(), 'kosh-careers-'));
  erp = await testInstallation({
    modules: [websiteHiringModule({ mailer, workers: false })],
    users: {
      mona: ['hiring.manager', 'website.manager', 'hr.manager'],
      bob: ['base.user'],
    },
    company: { name: 'Padma Traders', currency: 'BDT' },
  });
  useStorage(erp.host.server.app, new FileStorage(dir));
  const [worker] = careersWorkers({ shutro: erp.host.server.shutro }, mailer);
  drain = async () => {
    await worker?.drain();
  };
  await make('website.site', 'mona', { name: 'Padma Traders', key: 'padma' });
  ids['sales'] = await make('hiring.opening', 'mona', {
    name: 'Sales officer',
    description: 'Visits shops in Dhaka and takes their orders.',
    published: true,
    location: 'Dhaka',
    employment: 'Full time',
    closingDate: day(30),
  });
  ids['hidden'] = await make('hiring.opening', 'mona', { name: 'Not announced' });
  ids['past'] = await make('hiring.opening', 'mona', {
    name: 'Applications are over',
    published: true,
    closingDate: day(-1),
  });
  ids['filled'] = await make('hiring.opening', 'mona', { name: 'Filled', published: true });
  expect(
    (await call('POST', `/api/v1/models/hiring.opening/${ids['filled']}/transitions/close`, 'mona'))
      .status,
  ).toBe(200);
  const stages = (
    await call('GET', '/api/v1/models/hiring.stage?fields=name&order=sequence+asc', 'mona')
  ).json.items as Json[];
  for (const s of stages) ids[`stage:${s.name}`] = s.id;
}, 300_000);

afterAll(async () => {
  await erp?.close();
  await rm(dir, { recursive: true, force: true });
});

test('the site lists the openings that are published, open and not past their closing date', async () => {
  const list = await visit('GET', CAREERS);
  expect(list.status).toBe(200);
  expect(list.json.site).toBe('Padma Traders');
  expect(list.json.openings).toEqual([
    {
      id: ids['sales'],
      name: 'Sales officer',
      department: null,
      location: 'Dhaka',
      employment: 'Full time',
      closingDate: day(30),
      description: 'Visits shops in Dhaka and takes their orders.',
    },
  ]);
  expect((await visit('GET', `${CAREERS}/${ids['sales']}`)).json.name).toBe('Sales officer');
  for (const key of ['hidden', 'past', 'filled'])
    expect((await visit('GET', `${CAREERS}/${ids[key]}`)).status, key).toBe(404);
  expect((await visit('GET', '/api/v1/public/sites/nowhere/careers')).status).toBe(404);
  // What is not for candidates stays inside: the manager, the headcount.
  expect(JSON.stringify(list.json)).not.toMatch(/manager|headcount|hired/i);
});

test('a visitor applies: an applicant from the website, with their letter and CV; once per address', async () => {
  const apply = (opening: string, body: Record<string, unknown>) =>
    visit('POST', `${CAREERS}/${ids[opening]}/apply`, body);
  // What an application needs.
  expect((await apply('sales', { email: 'rina@example.com' })).status).toBe(422);
  expect((await apply('sales', { name: 'Rina', email: 'not an address' })).status).toBe(422);
  expect(
    (
      await apply('sales', {
        name: 'Rina',
        email: 'rina@example.com',
        cv: { name: 'cv.exe', mediaType: 'application/x-msdownload', data: 'TVo=' },
      })
    ).status,
  ).toBe(422);
  expect(await applicantsOf(ids['sales'] as number)).toEqual([]);

  const sent = await apply('sales', {
    name: '  Rina Akter ',
    email: 'rina@example.com',
    phone: '01711000000',
    cover: 'I sold for three years in Mirpur.',
    cv: {
      name: 'Rina Akter CV',
      mediaType: 'application/pdf',
      data: Buffer.from('%PDF-1.4 a small CV').toString('base64'),
    },
  });
  expect(sent.status, JSON.stringify(sent.json)).toBe(201);
  expect(sent.json.message).toBe('Thank you — your application is in.');
  const [rina] = await applicantsOf(ids['sales'] as number);
  expect([rina.name, rina.email, rina.phone, rina.source, rina.cover]).toEqual([
    'Rina Akter',
    'rina@example.com',
    '01711000000',
    'website',
    'I sold for three years in Mirpur.',
  ]);
  expect(rina.stage?.id ?? rina.stage).toBe(ids['stage:New']);
  ids['rina'] = rina.id;
  // The CV is on the applicant, as a PDF.
  const files = await erp.host.server.driver.query<{ name: string; mime: string; size: string }>({
    text: `SELECT name, mime, size::text AS size FROM storage_attachment
            WHERE res_model = 'hiring.applicant' AND res_id = $1`,
    params: [rina.id],
  });
  expect(files.map((f) => [f.name, f.mime, Number(f.size)])).toEqual([
    ['Rina Akter CV.pdf', 'application/pdf', 19],
  ]);

  // The same address again, whatever its case: not another applicant.
  expect((await apply('sales', { name: 'Rina', email: 'RINA@example.com' })).status).toBe(409);
  // A robot fills the field no person sees: thanked, and dropped.
  expect(
    (await apply('sales', { name: 'Bot', email: 'bot@example.com', website: 'http://spam' }))
      .status,
  ).toBe(201);
  // Openings that are not shown take nothing.
  for (const key of ['hidden', 'past', 'filled'])
    expect((await apply(key, { name: 'Late', email: 'late@example.com' })).status, key).toBe(410);
  expect(await applicantsOf(ids['sales'] as number)).toHaveLength(1);
});

test('a candidate is emailed once at each stage that has an email', async () => {
  // No stage has an email yet: the application above sent nothing.
  await drain();
  expect(mailer.sent).toHaveLength(0);
  for (const [stage, subject, body] of [
    [
      'New',
      'We received your application',
      'Dear {{name}},\n\nThank you for applying as {{opening}} at {{company}}.',
    ],
    ['Interview', '{{opening}}: an interview', '{{name}}, we would like to meet you.'],
  ] as const)
    expect(
      (
        await call('PATCH', `/api/v1/models/hiring.stage/${ids[`stage:${stage}`]}`, 'mona', {
          mailSubject: subject,
          mailBody: body,
        })
      ).status,
    ).toBe(200);
  // A new application: received.
  expect(
    (
      await visit('POST', `${CAREERS}/${ids['sales']}/apply`, {
        name: 'Tarek',
        email: 'tarek@example.com',
      })
    ).status,
  ).toBe(201);
  await drain();
  await drain();
  expect(mailer.sent.map((m) => [m.to, m.subject])).toEqual([
    ['tarek@example.com', 'We received your application'],
  ]);
  expect(mailer.sent[0]?.text).toContain('Dear Tarek,');
  expect(mailer.sent[0]?.text).toContain(
    'Thank you for applying as Sales officer at Padma Traders.',
  );
  const [, tarek] = await applicantsOf(ids['sales'] as number);
  const move = async (stage: string) => {
    expect(
      (await call('PATCH', `${A}/${tarek.id}`, 'mona', { stage: ids[`stage:${stage}`] })).status,
    ).toBe(200);
    await drain();
  };
  // Another field changed: nothing. To the interview: emailed. To the offer, which has no email: nothing.
  expect((await call('PATCH', `${A}/${tarek.id}`, 'mona', { phone: '018' })).status).toBe(200);
  await drain();
  await move('Interview');
  await move('Offer');
  // Back to the interview after another stage: asked again.
  await move('Interview');
  expect(mailer.sent.slice(1).map((m) => [m.to, m.subject])).toEqual([
    ['tarek@example.com', 'Sales officer: an interview'],
    ['tarek@example.com', 'Sales officer: an interview'],
  ]);
  // What was emailed is the server's to say.
  expect((await call('PATCH', `${A}/${tarek.id}`, 'mona', { mailedStage: null })).status).toBe(403);
  // Someone without Hiring reads no applicant.
  expect((await call('GET', A, 'bob')).status).toBe(403);
});
