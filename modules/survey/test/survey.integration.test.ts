/**
 * Surveys on real PostgreSQL (RFC 0034 §2.6): a survey opens only when it holds together; a visitor without a
 * sign-in gets its page and its questions — never the points —, and sends answers the server reviews: required
 * ones, the ones that wait for another, each of its kind; a response keeps its score and whether it passed, the
 * survey its NPS and CSAT; an invitation is good once; an anonymous survey keeps nothing that names anyone; open
 * surveys do not change; who may do what.
 */
import { type TestInstallation, testInstallation } from '@kosh/server/testing';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { survey } from '../src/index.js';

const S = '/api/v1/models/survey.survey';
const Q = '/api/v1/models/survey.question';
const I = '/api/v1/models/survey.invitation';
const R = '/api/v1/models/survey.response';
let erp: TestInstallation;
const ids: Record<string, number> = {};
const keys: Record<string, string> = {};

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
/** A visitor: no sign-in, no cookie, no token. */
const visit = async (
  method: 'GET' | 'POST',
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
) => {
  const res = await erp.host.server.app.inject({
    method,
    url,
    headers,
    ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
  });
  const type = String(res.headers['content-type'] ?? '');
  return {
    status: res.statusCode,
    headers: res.headers,
    text: res.body,
    json: (type.includes('json') ? res.json() : null) as Json,
  };
};
const pub = (key: string) => `/api/v1/public/surveys/${key}`;
const answer = (key: string, answers: Record<number, unknown>, who: Record<string, unknown> = {}) =>
  visit('POST', pub(key), { answers, ...who });

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  erp = await testInstallation({
    modules: [survey],
    users: {
      mona: ['survey.manager'],
      rafi: ['survey.user'],
      bob: ['base.user'],
    },
    company: { name: 'Padma Traders', currency: 'BDT' },
  });
}, 300_000);

afterAll(async () => {
  await erp?.close();
});

test('a survey is written by a manager and opens only when it holds together', async () => {
  expect((await call('POST', S, 'rafi', { name: 'Not mine to write' })).status).toBe(403);
  const id = await make('survey.survey', 'mona', {
    name: 'How was your delivery?',
    description: 'Four questions.',
    thanks: 'Thank you — we read every answer.',
    passPercent: 50,
  });
  // Nothing to ask yet.
  expect((await call('POST', `${S}/${id}/transitions/publish`, 'mona')).status).toBe(409);
  ids['recommend'] = await make('survey.question', 'mona', {
    survey: id,
    sequence: 10,
    title: 'Would you recommend us?',
    kind: 'nps',
    required: true,
  });
  ids['why'] = await make('survey.question', 'mona', {
    survey: id,
    sequence: 20,
    title: 'What went wrong?',
    kind: 'long_text',
    required: true,
    showWhenQuestion: ids['recommend'],
    showWhenOp: 'lt',
    showWhenValue: '7',
  });
  ids['speed'] = await make('survey.question', 'mona', {
    survey: id,
    sequence: 30,
    title: 'How fast was it?',
    kind: 'choice',
    choices: {
      create: [
        { sequence: 10, label: 'Fast', score: '10' },
        { sequence: 20, label: 'Slow', score: '0' },
      ],
    },
  });
  ids['stars'] = await make('survey.question', 'mona', {
    survey: id,
    sequence: 40,
    title: 'Rate the courier',
    kind: 'rating',
    scaleMax: 5,
    weight: '2',
  });
  // Asked of those who chose a label that does not exist: it cannot open.
  ids['courier'] = await make('survey.question', 'mona', {
    survey: id,
    sequence: 50,
    title: 'Which courier was it?',
    kind: 'text',
    showWhenQuestion: ids['speed'],
    showWhenOp: 'eq',
    showWhenValue: 'Sluggish',
  });
  expect((await call('POST', `${S}/${id}/transitions/publish`, 'mona')).status).toBe(409);
  expect(
    (await call('PATCH', `${Q}/${ids['courier']}`, 'mona', { showWhenValue: 'slow' })).status,
  ).toBe(200);
  const s = (await call('GET', `${S}/${id}?fields=token,link,state`, 'mona')).json as Json;
  expect(s.link).toBe(`/api/v1/public/surveys/${s.token}/page`);
  // A draft takes no answers.
  expect((await visit('GET', pub(s.token))).status).toBe(410);
  expect((await call('POST', `${S}/${id}/transitions/publish`, 'rafi')).status).toBe(403);
  expect((await call('POST', `${S}/${id}/transitions/publish`, 'mona')).status).toBe(200);
  ids['feedback'] = id;
  keys['feedback'] = s.token;
  // The key is the server's.
  expect((await call('PATCH', `${S}/${id}`, 'mona', { token: 'a'.repeat(24) })).status).toBe(403);
});

test('a visitor without a sign-in gets the page and the questions, never the points', async () => {
  const data = await visit('GET', pub(keys['feedback'] as string));
  expect(data.status).toBe(200);
  expect(data.json.name).toBe('How was your delivery?');
  expect(data.json.askWho).toBe(true);
  expect(data.json.questions.map((q: Json) => [q.title, q.kind, q.required])).toEqual([
    ['Would you recommend us?', 'nps', true],
    ['What went wrong?', 'long_text', true],
    ['How fast was it?', 'choice', false],
    ['Rate the courier', 'rating', false],
    ['Which courier was it?', 'text', false],
  ]);
  const speed = data.json.questions[2];
  expect(speed.choices.map((c: Json) => c.label)).toEqual(['Fast', 'Slow']);
  ids['fast'] = speed.choices[0].id;
  ids['slow'] = speed.choices[1].id;
  // The condition on a choice arrives as its id; nothing says what an answer scores.
  expect(data.json.questions[4].showWhen).toEqual({
    question: ids['speed'],
    op: 'eq',
    value: String(ids['slow']),
  });
  expect(data.text).not.toMatch(/score|weight|points|passPercent/i);

  const page = await visit('GET', `${pub(keys['feedback'] as string)}/page`);
  expect(page.status).toBe(200);
  expect(String(page.headers['content-type'])).toContain('text/html');
  const csp = String(page.headers['content-security-policy']);
  const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
  expect(nonce).toBeTruthy();
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(page.text).toContain('<h1>How was your delivery?</h1>');
  expect(page.text).toContain(`<script nonce="${nonce}">`);
  expect(page.text).toContain('>Send</button>');
  // In Bangla when asked for, by the address or by the browser.
  expect((await visit('GET', `${pub(keys['feedback'] as string)}/page?lang=bn`)).text).toContain(
    '>পাঠান</button>',
  );
  expect(
    (
      await visit('GET', `${pub(keys['feedback'] as string)}/page`, undefined, {
        'accept-language': 'bn-BD,bn;q=0.9,en;q=0.5',
      })
    ).text,
  ).toContain('<html lang="bn">');
  // A key that opens nothing.
  expect((await visit('GET', pub('x'.repeat(24)))).status).toBe(404);
  expect((await visit('GET', `${pub('x'.repeat(24))}/page`)).status).toBe(404);
});

test('answers are reviewed by the server: required, waiting for another, each of its kind', async () => {
  const key = keys['feedback'] as string;
  // Nothing: the first question is required.
  const none = await answer(key, {});
  expect(none.status).toBe(422);
  expect(none.json.errors).toEqual([
    { question: ids['recommend'], title: 'Would you recommend us?', problem: 'needs an answer' },
  ]);
  // A detractor owes the reason; a rating of 9 on five stars is no rating.
  const bad = await answer(key, { [ids['recommend'] as number]: 3, [ids['stars'] as number]: 9 });
  expect(bad.status).toBe(422);
  expect(bad.json.errors.map((e: Json) => [e.title, e.problem])).toEqual([
    ['What went wrong?', 'needs an answer'],
    ['Rate the courier', 'is a whole number from 1 to 5'],
  ]);
  expect((await visit('POST', pub(key), { answers: [] })).status).toBe(400);
  expect((await call('GET', `${R}?fields=name`, 'rafi')).json.items).toEqual([]);

  // A promoter: fast, five stars — 10 + 10 of 20.
  const happy = await answer(
    key,
    {
      [ids['recommend'] as number]: 10,
      [ids['why'] as number]: 'sent for a question that was not asked',
      [ids['speed'] as number]: ids['fast'],
      [ids['stars'] as number]: 5,
    },
    { name: '  Karim  ', email: 'karim@example.com' },
  );
  expect(happy.status, happy.text).toBe(201);
  expect(happy.json.thanks).toBe('Thank you — we read every answer.');
  // A detractor: slow, two stars, and the courier's name — 0 + 4 of 20.
  expect(
    (
      await answer(key, {
        [ids['recommend'] as number]: 3,
        [ids['why'] as number]: 'Two days late.',
        [ids['speed'] as number]: ids['slow'],
        [ids['stars'] as number]: 2,
        [ids['courier'] as number]: 'Pathao',
      })
    ).status,
  ).toBe(201);
  const responses = (
    await call('GET', `${R}?fields=name,email,score,maxScore,percent,outcome&order=id+asc`, 'rafi')
  ).json.items as Json[];
  expect(
    responses.map((r) => [
      r.name,
      r.email,
      Number(r.score),
      Number(r.maxScore),
      Number(r.percent),
      r.outcome,
    ]),
  ).toEqual([
    ['Karim', 'karim@example.com', 20, 20, 100, 'passed'],
    [null, null, 4, 20, 20, 'failed'],
  ]);
  // What was sent for the question that was not asked is not kept.
  const kept = (
    await call(
      'GET',
      `/api/v1/models/survey.answer?fields=question,display,score&order=id+asc&limit=50`,
      'rafi',
    )
  ).json.items as Json[];
  expect(kept.map((a) => [a.question?.id ?? a.question, a.display, Number(a.score)])).toEqual([
    [ids['recommend'], '10', 0],
    [ids['speed'], 'Fast', 10],
    [ids['stars'], '5', 10],
    [ids['recommend'], '3', 0],
    [ids['why'], 'Two days late.', 0],
    [ids['speed'], 'Slow', 0],
    [ids['stars'], '2', 4],
    [ids['courier'], 'Pathao', 0],
  ]);
});

test('the survey keeps its figures; each question’s answers are counted', async () => {
  const s = (
    await call(
      'GET',
      `${S}/${ids['feedback']}?fields=responseCount,averagePercent,npsScore,csatScore`,
      'rafi',
    )
  ).json as Json;
  // One promoter, one detractor; one rating of five in the top two fifths.
  expect([s.responseCount, Number(s.averagePercent), s.npsScore, s.csatScore]).toEqual([
    2, 60, 0, 50,
  ]);
  const results = await call('GET', `/api/v1/surveys/${ids['feedback']}/results`, 'rafi');
  expect(results.status).toBe(200);
  const by = (title: string) => (results.json.questions as Json[]).find((q) => q.title === title);
  expect(by('Would you recommend us?')).toMatchObject({ answers: 2, average: 6.5, nps: 0 });
  expect(by('Rate the courier')).toMatchObject({ answers: 2, average: 3.5, csat: 50 });
  expect(by('How fast was it?').choices).toEqual([
    { label: 'Fast', count: 1, percent: 50 },
    { label: 'Slow', count: 1, percent: 50 },
  ]);
  expect(by('What went wrong?')).toMatchObject({ answers: 1, average: null });
  // Not for someone without the app; the figures are the server's; nobody writes a response.
  expect((await call('GET', `/api/v1/surveys/${ids['feedback']}/results`, 'bob')).status).toBe(403);
  expect((await call('GET', `/api/v1/surveys/999999/results`, 'rafi')).status).toBe(404);
  expect((await call('PATCH', `${S}/${ids['feedback']}`, 'mona', { npsScore: 100 })).status).toBe(
    403,
  );
  expect(
    (
      await call('POST', R, 'mona', {
        survey: ids['feedback'],
        submittedAt: '2027-01-01T00:00:00Z',
      })
    ).status,
  ).toBe(403);
});

test('invited people only, anonymous: a link each, good once, and nothing that names them', async () => {
  const id = await make('survey.survey', 'mona', {
    name: 'How is work?',
    audience: 'invited',
    anonymous: true,
    questions: { create: [{ sequence: 10, title: 'One word', kind: 'text', required: true }] },
  });
  expect((await call('POST', `${S}/${id}/transitions/publish`, 'mona')).status).toBe(200);
  const s = (await call('GET', `${S}/${id}?fields=token`, 'mona')).json as Json;
  // Its own link opens nothing.
  expect((await visit('GET', pub(s.token))).status).toBe(404);
  // Someone with the app invites; the key is the server's.
  expect(
    (await call('POST', I, 'rafi', { survey: id, name: 'Forged', token: 'b'.repeat(24) })).status,
  ).toBe(403);
  expect((await call('POST', I, 'bob', { survey: id, name: 'Not mine' })).status).toBe(403);
  const invitation = await make('survey.invitation', 'rafi', {
    survey: id,
    name: 'Nadia',
    email: 'nadia@example.com',
  });
  const made = (await call('GET', `${I}/${invitation}?fields=token,link,status`, 'rafi'))
    .json as Json;
  expect(made.status).toBe('pending');
  expect(made.link).toBe(`/api/v1/public/surveys/${made.token}/page`);
  const question = ((await visit('GET', pub(made.token))).json.questions as Json[])[0].id as number;
  const shown = await visit('GET', pub(made.token));
  expect([shown.json.anonymous, shown.json.askWho]).toEqual([true, false]);
  expect((await visit('GET', `${pub(made.token)}/page`)).text).toContain(
    'Your answers are anonymous',
  );
  // Answered once.
  const sent = await answer(made.token, { [question]: 'Busy' }, { name: 'Nadia' });
  expect(sent.status, sent.text).toBe(201);
  expect((await answer(made.token, { [question]: 'Again' })).status).toBe(410);
  expect((await visit('GET', `${pub(made.token)}/page`)).status).toBe(410);
  const after = (await call('GET', `${I}/${invitation}?fields=status,answeredAt`, 'rafi'))
    .json as Json;
  expect(after.status).toBe('answered');
  expect(after.answeredAt).not.toBeNull();
  // The response names nobody, and is not tied to the invitation.
  const [response] = (
    await call(
      'GET',
      `${R}?filter=${encodeURIComponent(JSON.stringify({ survey: id }))}&fields=name,email,invitation,partner,outcome`,
      'rafi',
    )
  ).json.items as Json[];
  expect(response).toMatchObject({
    name: null,
    email: null,
    invitation: null,
    partner: null,
    outcome: null, // no pass mark: neither passed nor failed
  });
  // An invitation is not marked by hand.
  expect((await call('PATCH', `${I}/${invitation}`, 'rafi', { status: 'pending' })).status).toBe(
    403,
  );
});

test('an open survey does not change; with responses it is not redrafted; closed, it takes no answers', async () => {
  const id = ids['feedback'] as number;
  expect(
    (await call('PATCH', `${Q}/${ids['stars']}`, 'mona', { kind: 'number' })).status,
  ).toBeGreaterThanOrEqual(400);
  expect(
    (await call('POST', Q, 'mona', { survey: id, sequence: 60, title: 'One more', kind: 'text' }))
      .status,
  ).toBeGreaterThanOrEqual(400);
  expect((await call('POST', `${S}/${id}/transitions/redraft`, 'mona')).status).toBe(409);
  expect((await call('POST', `${S}/${id}/transitions/close`, 'mona')).status).toBe(200);
  const key = keys['feedback'] as string;
  expect((await answer(key, { [ids['recommend'] as number]: 10 })).status).toBe(410);
  expect((await visit('GET', `${pub(key)}/page`)).text).toContain('not taking answers');
  expect((await call('POST', `${S}/${id}/transitions/reopen`, 'mona')).status).toBe(200);
  expect((await answer(key, { [ids['recommend'] as number]: 9 })).status).toBe(201);
  const s = (await call('GET', `${S}/${id}?fields=responseCount,npsScore`, 'rafi')).json as Json;
  // Two promoters and a detractor.
  expect([s.responseCount, s.npsScore]).toEqual([3, 33]);
});
