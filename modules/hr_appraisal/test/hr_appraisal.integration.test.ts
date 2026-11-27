/**
 * Appraisals and skills on real PostgreSQL (RFC 0038, step 5): a cycle opens an appraisal for everyone who has a
 * manager; an appraisal is seen by the person, their reviewer and HR, and by nobody else; the person writes
 * their own words and scores, the reviewer theirs — neither the other's —; the score is the goals', weighted;
 * a completed appraisal stands until HR reopens it; skills are kept by the manager and HR, of the skill's kind.
 */
import { type TestInstallation, testInstallation } from '@kosh/server/testing';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { hrAppraisal } from '../src/index.js';

const A = '/api/v1/models/hr.appraisal';
const G = '/api/v1/models/hr.appraisal.goal';
const S = '/api/v1/models/hr.employee.skill';
let erp: TestInstallation;
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
const step = (id: number, name: string, as: string) =>
  call('POST', `${A}/${id}/transitions/${name}`, as);
const listOf = async (url: string, as: string, filter: unknown = {}) =>
  (
    await call(
      'GET',
      `${url}?filter=${encodeURIComponent(JSON.stringify(filter))}&order=id+asc&limit=100`,
      as,
    )
  ).json.items as Json[];
const idOf = (v: unknown): number => (v as { id?: number })?.id ?? (v as number);

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  erp = await testInstallation({
    modules: [hrAppraisal],
    users: {
      hana: ['hr_appraisal.manager'],
      mara: ['hr_appraisal.user'],
      eli: ['hr_appraisal.user'],
      noor: ['hr_appraisal.user'],
      bob: ['base.user'],
    },
    company: { name: 'Padma Mills', currency: 'BDT' },
  });
  const users: Record<string, number> = {};
  for (const u of await erp.host.server.driver.query<{ id: number; login: string }>({
    text: 'SELECT id, login FROM res_users',
    params: [],
  }))
    users[u.login] = Number(u.id);
  ids['mara'] = await make('hr.employee', 'hana', { name: 'Mara Sen', user: users['mara'] });
  ids['eli'] = await make('hr.employee', 'hana', {
    name: 'Eli Roy',
    user: users['eli'],
    manager: ids['mara'],
  });
  ids['noor'] = await make('hr.employee', 'hana', {
    name: 'Noor Alam',
    user: users['noor'],
    manager: ids['mara'],
  });
}, 300_000);

afterAll(async () => {
  await erp?.close();
});

test('skills: kinds with their own levels; kept by the manager and HR, read by the person', async () => {
  expect(
    (await call('POST', '/api/v1/models/hr.skill.type', 'mara', { name: 'Mine' })).status,
  ).toBe(403);
  const languages = await make('hr.skill.type', 'hana', {
    name: 'Languages',
    levels: {
      create: [
        { name: 'Basic', progress: 25 },
        { name: 'Fluent', progress: 100 },
      ],
    },
    skills: { create: [{ name: 'English' }] },
  });
  const tools = await make('hr.skill.type', 'hana', {
    name: 'Tools',
    levels: { create: [{ name: 'Independent', progress: 70 }] },
    skills: { create: [{ name: 'Spreadsheets' }] },
  });
  const [english] = await listOf('/api/v1/models/hr.skill', 'hana', { type: languages });
  const [fluent] = await listOf('/api/v1/models/hr.skill.level', 'hana', {
    type: languages,
    name: 'Fluent',
  });
  const [independent] = await listOf('/api/v1/models/hr.skill.level', 'hana', { type: tools });
  // A level of another kind is not this skill's.
  const wrong = await call('POST', S, 'mara', {
    employee: ids['eli'],
    skill: english.id,
    level: independent.id,
  });
  expect(wrong.status).toBe(422);
  const given = await call('POST', S, 'mara', {
    employee: ids['eli'],
    skill: english.id,
    level: fluent.id,
  });
  expect(given.status, JSON.stringify(given.json)).toBe(201);
  expect(given.json.progress).toBe(100);
  // The person reads their skills and does not give themselves any; a colleague sees none of them.
  expect(await listOf(S, 'eli')).toHaveLength(1);
  expect(
    (await call('POST', S, 'eli', { employee: ids['eli'], skill: english.id, level: fluent.id }))
      .status,
  ).toBeGreaterThanOrEqual(400);
  expect(await listOf(S, 'noor')).toHaveLength(0);
});

test('a cycle opens an appraisal for everyone who has a manager, reviewed by that manager', async () => {
  ids['cycle'] = await make('hr.appraisal.cycle', 'hana', {
    name: 'Annual review 2026',
    dateFrom: '2026-01-01',
    dateTo: '2026-12-31',
    dateDue: '2027-01-31',
  });
  expect(
    (
      await call(
        'POST',
        `/api/v1/models/hr.appraisal.cycle/${ids['cycle']}/transitions/launch`,
        'mara',
      )
    ).status,
  ).toBe(403);
  const opened = await call(
    'POST',
    `/api/v1/models/hr.appraisal.cycle/${ids['cycle']}/transitions/launch`,
    'hana',
  );
  expect(opened.status, JSON.stringify(opened.json)).toBe(200);
  const all = await listOf(A, 'hana', { cycle: ids['cycle'] });
  // Mara has no manager: none for her.
  expect(all.map((a) => [idOf(a.employee), idOf(a.reviewer), a.state])).toEqual([
    [ids['eli'], ids['mara'], 'draft'],
    [ids['noor'], ids['mara'], 'draft'],
  ]);
  expect(all[0].name).toBe('Eli Roy — Annual review 2026');
  ids['elis'] = all[0].id;
  ids['noors'] = all[1].id;
});

test('private: the person, their reviewer and HR — nobody else', async () => {
  expect((await listOf(A, 'eli')).map((a) => a.id)).toEqual([ids['elis']]);
  expect((await listOf(A, 'noor')).map((a) => a.id)).toEqual([ids['noors']]);
  expect((await listOf(A, 'mara')).map((a) => a.id)).toEqual([ids['elis'], ids['noors']]);
  expect((await call('GET', `${A}/${ids['elis']}`, 'noor')).status).toBeGreaterThanOrEqual(403);
  expect((await call('GET', A, 'bob')).status).toBe(403);
});

test('each side writes its own words: goals and scores, the self review, the review and the rating', async () => {
  const id = ids['elis'] as number;
  const goals = await call('PATCH', `${A}/${id}`, 'mara', {
    goals: {
      create: [
        { name: 'Close the books by the 5th', weight: '2' },
        { name: 'Train a backup', weight: '1' },
      ],
    },
  });
  expect(goals.status, JSON.stringify(goals.json)).toBe(200);
  const [books, backup] = await listOf(G, 'mara', { appraisal: id });
  // Before the self review is asked for, the person only reads.
  expect((await call('PATCH', `${A}/${id}`, 'eli', { selfReview: 'Early' })).status).toBe(403);
  expect((await step(id, 'begin', 'eli')).status).toBeGreaterThanOrEqual(400);
  expect((await step(id, 'begin', 'mara')).status).toBe(200);

  // The person: their own words and their own scores — not the reviewer's.
  expect(
    (await call('PATCH', `${A}/${id}`, 'eli', { selfReview: 'Closed on the 4th every month.' }))
      .status,
  ).toBe(200);
  expect((await call('PATCH', `${G}/${books.id}`, 'eli', { selfScore: '90' })).status).toBe(200);
  expect((await call('PATCH', `${A}/${id}`, 'eli', { rating: 'outstanding' })).status).toBe(422);
  expect((await call('PATCH', `${A}/${id}`, 'eli', { managerReview: 'Great.' })).status).toBe(422);
  const scored = await call('PATCH', `${G}/${books.id}`, 'eli', { score: '100' });
  expect(scored.status, JSON.stringify(scored.json)).toBe(422);
  expect((await call('PATCH', `${G}/${books.id}`, 'eli', { weight: '9' })).status).toBe(422);
  // The reviewer does not write the person's words, nor submit for them.
  expect((await call('PATCH', `${A}/${id}`, 'mara', { selfReview: 'For Eli.' })).status).toBe(422);
  expect((await step(id, 'submit', 'mara')).status).toBe(409);
  expect((await step(id, 'submit', 'eli')).status).toBe(200);
  // Submitted: the person reads again, and does not complete their own appraisal.
  expect((await call('PATCH', `${A}/${id}`, 'eli', { selfReview: 'More.' })).status).toBe(403);
  expect((await step(id, 'complete', 'eli')).status).toBeGreaterThanOrEqual(400);

  // The reviewer: scores, the review, the rating.
  expect((await call('PATCH', `${G}/${books.id}`, 'mara', { score: '80' })).status).toBe(200);
  expect((await call('PATCH', `${G}/${backup.id}`, 'mara', { score: '50' })).status).toBe(200);
  expect(
    (await call('PATCH', `${G}/${backup.id}`, 'mara', { score: '120' })).status,
  ).toBeGreaterThanOrEqual(400);
  expect(
    (
      await call('PATCH', `${A}/${id}`, 'mara', {
        managerReview: 'Reliable; a backup is half trained.',
      })
    ).status,
  ).toBe(200);
  // No rating, no completion.
  expect((await step(id, 'complete', 'mara')).status).toBe(409);
  expect((await call('PATCH', `${A}/${id}`, 'mara', { rating: 'exceeds' })).status).toBe(200);
  expect((await step(id, 'complete', 'mara')).status).toBe(200);
  const done = (await call('GET', `${A}/${id}?fields=state,score,rating,doneOn`, 'eli'))
    .json as Json;
  // (80 × 2 + 50 × 1) / 3
  expect(Number(done.score)).toBe(70);
  expect(done).toMatchObject({ state: 'done', rating: 'exceeds' });
  expect(done.doneOn).not.toBeNull();
});

test('a completed appraisal stands until HR reopens it', async () => {
  const id = ids['elis'] as number;
  expect(
    (await call('PATCH', `${A}/${id}`, 'mara', { managerReview: 'Changed my mind.' })).status,
  ).toBe(422);
  const [books] = await listOf(G, 'mara', { appraisal: id });
  expect((await call('PATCH', `${G}/${books.id}`, 'mara', { score: '10' })).status).toBe(422);
  expect((await step(id, 'reopen', 'mara')).status).toBe(403);
  expect((await step(id, 'reopen', 'hana')).status).toBe(200);
  expect((await call('PATCH', `${A}/${id}`, 'mara', { managerReview: 'Reliable.' })).status).toBe(
    200,
  );
});

test('nobody reviews themselves; HR reviews where there is no reviewer', async () => {
  const own = await call('POST', A, 'hana', {
    name: 'Mara reviews Mara',
    employee: ids['mara'],
    reviewer: ids['mara'],
  });
  expect(own.status).toBe(422);
  const id = await make('hr.appraisal', 'hana', { name: 'Mara — by HR', employee: ids['mara'] });
  expect((await step(id, 'begin', 'hana')).status).toBe(200);
  expect((await call('PATCH', `${A}/${id}`, 'mara', { selfReview: 'A good year.' })).status).toBe(
    200,
  );
  expect((await step(id, 'submit', 'mara')).status).toBe(200);
  // Mara is a reviewer of others, not of herself.
  expect(
    (await call('PATCH', `${A}/${id}`, 'mara', { rating: 'outstanding' })).status,
  ).toBeGreaterThanOrEqual(400);
  expect(
    (await call('PATCH', `${A}/${id}`, 'hana', { managerReview: 'Leads well.', rating: 'meets' }))
      .status,
  ).toBe(200);
  expect((await step(id, 'complete', 'mara')).status).toBeGreaterThanOrEqual(400);
  expect((await step(id, 'complete', 'hana')).status).toBe(200);
});
