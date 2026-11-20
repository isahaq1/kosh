/**
 * What Surveys does by itself, on real PostgreSQL (RFC 0034 §2.6): an invitation with an address is emailed once,
 * and only when its survey is open; a rule waits for another app's event — a contact made, a ticket solved — and
 * invites the people concerned, once each, also the rows of a record; a rating answered is written on the ticket
 * it was asked about; a rule that does not hold together is refused.
 */
import { helpdesk } from '@kosh/helpdesk';
import { createMemoryMailer } from '@kosh/mail';
import { type TestInstallation, testInstallation } from '@kosh/server/testing';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { surveyModule, surveyWorkers } from '../src/index.js';

const S = '/api/v1/models/survey.survey';
const I = '/api/v1/models/survey.invitation';
const G = '/api/v1/models/survey.trigger';
const BASE = 'https://erp.padma.example';
const mailer = createMemoryMailer();
let erp: TestInstallation;
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
const filter = (where: Record<string, unknown>) => encodeURIComponent(JSON.stringify(where));
/** The invitations of a survey, oldest first. */
const invitations = async (survey: number) =>
  (
    await call(
      'GET',
      `${I}?filter=${filter({ survey })}&fields=name,email,resModel,resId,status,sentAt,token,lang&order=id+asc`,
      'mona',
    )
  ).json.items as Json[];
/** A survey with one rating, opened. */
const openSurvey = async (name: string) => {
  const id = await make('survey.survey', 'mona', {
    name,
    description: 'One question.',
    questions: { create: [{ sequence: 10, title: 'How was it?', kind: 'rating', scaleMax: 5 }] },
  });
  expect((await call('POST', `${S}/${id}/transitions/publish`, 'mona')).status).toBe(200);
  return id;
};

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  erp = await testInstallation({
    modules: [surveyModule({ mailer, baseUrl: `${BASE}/`, workers: false }), helpdesk],
    users: {
      mona: ['survey.manager', 'helpdesk.manager', 'contacts.manager'],
      rafi: ['survey.user'],
      ali: ['helpdesk.user'],
    },
    company: { name: 'Padma Traders', currency: 'BDT' },
  });
  const workers = surveyWorkers(
    { shutro: erp.host.server.shutro, registry: erp.host.server.registry },
    { mailer, baseUrl: `${BASE}/` },
  );
  drain = async () => {
    // Twice: what a worker makes (an invitation) is another worker's work.
    for (let round = 0; round < 2; round += 1) for (const w of workers) await w.drain();
  };
}, 300_000);

afterAll(async () => {
  await erp?.close();
});

test('an invitation with an address is emailed once, and only when its survey is open', async () => {
  const id = await make('survey.survey', 'mona', {
    name: 'After your visit',
    description: 'Two minutes of your time.',
    questions: { create: [{ sequence: 10, title: 'How was it?', kind: 'rating', scaleMax: 5 }] },
  });
  const first = await make('survey.invitation', 'rafi', {
    survey: id,
    name: 'Karim',
    email: 'karim@example.com',
  });
  await make('survey.invitation', 'rafi', { survey: id, name: 'No address' });
  await drain();
  // A draft sends nothing.
  expect(mailer.sent).toHaveLength(0);
  expect((await call('POST', `${S}/${id}/transitions/publish`, 'mona')).status).toBe(200);
  await drain();
  expect(mailer.sent).toHaveLength(1);
  const [mail] = mailer.sent;
  const invited = (await call('GET', `${I}/${first}?fields=token,sentAt`, 'rafi')).json as Json;
  expect(mail?.to).toBe('karim@example.com');
  expect(mail?.subject).toBe('After your visit');
  expect(mail?.text).toContain('Karim, we would like to hear from you');
  expect(mail?.text).toContain('Two minutes of your time.');
  // The link is whole: the server's public address and the person's own key.
  expect(mail?.html).toContain(`${BASE}/api/v1/public/surveys/${invited.token}/page`);
  expect(invited.sentAt).not.toBeNull();
  // Made while it is open: emailed at once, in the person's language; never twice.
  await make('survey.invitation', 'rafi', {
    survey: id,
    name: 'Nadia',
    email: 'nadia@example.com',
    lang: 'bn',
  });
  await drain();
  await drain();
  expect(mailer.sent).toHaveLength(2);
  expect(mailer.sent[1]?.text).toContain('আমরা আপনার মতামত জানতে চাই');
  expect(mailer.sent[1]?.html).toContain('/page?lang=bn');
  // When it went is the server's to say.
  expect((await call('PATCH', `${I}/${first}`, 'mona', { sentAt: null })).status).toBe(403);
});

test('a rule does not hold together: an unknown event, a field that is not there, Surveys’ own events', async () => {
  const survey = await openSurvey('Rules');
  const bad = async (values: Record<string, unknown>) =>
    (await call('POST', G, 'mona', { name: 'Broken', survey, ...values })).status;
  expect(await bad({ topic: 'nothing.happened' })).toBeGreaterThanOrEqual(400);
  expect(await bad({ topic: 'res.partner.created', emailField: 'fax' })).toBeGreaterThanOrEqual(
    400,
  );
  expect(await bad({ topic: 'res.partner.created', each: 'email' })).toBeGreaterThanOrEqual(400);
  expect(
    await bad({ topic: 'helpdesk.ticket.solved', answerField: 'subject' }),
  ).toBeGreaterThanOrEqual(400);
  // An invitation about an invitation would never end.
  expect(await bad({ topic: 'survey.invitation.created' })).toBeGreaterThanOrEqual(400);
  expect(await bad({ topic: 'survey.survey.opened' })).toBeGreaterThanOrEqual(400);
  // Rules are a manager's; the events on offer are listed.
  expect(
    (await call('POST', G, 'rafi', { name: 'Mine', survey, topic: 'res.partner.created' })).status,
  ).toBe(403);
  const offered = await call('GET', '/api/v1/surveys/events', 'rafi');
  expect(offered.status).toBe(200);
  expect(offered.json.events.map((e: Json) => e.topic)).toContain('helpdesk.ticket.solved');
  expect(offered.json.events.some((e: Json) => e.topic.startsWith('survey.'))).toBe(false);
  expect((await call('GET', '/api/v1/surveys/events', 'ali')).status).toBe(403);
});

test('a rule on a record made: new contacts are asked once; companies and people without an address are not', async () => {
  const survey = await openSurvey('Welcome');
  ids['welcome'] = survey;
  await make('survey.trigger', 'mona', {
    name: 'Welcome new people',
    survey,
    topic: 'res.partner.created',
    whenField: 'isCompany',
    whenValue: 'false',
  });
  const before = mailer.sent.length;
  const person = await make('res.partner', 'mona', { name: 'Selim', email: 'selim@example.com' });
  await make('res.partner', 'mona', { name: 'Nameless address' });
  await make('res.partner', 'mona', {
    name: 'Meghna Textiles',
    isCompany: true,
    email: 'office@meghna.example',
  });
  await drain();
  await drain();
  const made = await invitations(survey);
  expect(made.map((i) => [i.name, i.email, i.resModel, i.resId, i.status])).toEqual([
    ['Selim', 'selim@example.com', 'res.partner', person, 'pending'],
  ]);
  expect(made[0].sentAt).not.toBeNull();
  expect(mailer.sent.slice(before).map((m) => m.to)).toEqual(['selim@example.com']);
  // A closed survey asks nobody.
  expect((await call('POST', `${S}/${survey}/transitions/close`, 'mona')).status).toBe(200);
  await make('res.partner', 'mona', { name: 'Too late', email: 'late@example.com' });
  await drain();
  expect(await invitations(survey)).toHaveLength(1);
});

test('for each of a record’s rows: the people of a company made with them', async () => {
  const survey = await openSurvey('For the people of a new customer');
  await make('survey.trigger', 'mona', {
    name: 'People of a new company',
    survey,
    topic: 'res.partner.created',
    each: 'contacts',
    whenField: 'isCompany',
    whenValue: 'false',
  });
  const before = mailer.sent.length;
  await make('res.partner', 'mona', {
    name: 'Jamuna Traders',
    isCompany: true,
    contacts: {
      create: [
        { name: 'Rina', email: 'rina@jamuna.example' },
        { name: 'Tarek', email: 'tarek@jamuna.example' },
        { name: 'No address' },
      ],
    },
  });
  await drain();
  await drain();
  const made = await invitations(survey);
  expect(made.map((i) => [i.name, i.resModel]).sort()).toEqual([
    ['Rina', 'res.partner'],
    ['Tarek', 'res.partner'],
  ]);
  expect(
    mailer.sent
      .slice(before)
      .map((m) => m.to)
      .sort(),
  ).toEqual(['rina@jamuna.example', 'tarek@jamuna.example']);
});

test('a ticket solved: its customer is asked, and the rating they give is on the ticket', async () => {
  const survey = await openSurvey('How did we help?');
  const [question] = (
    await call(
      'GET',
      `/api/v1/models/survey.question?filter=${filter({ survey })}&fields=title`,
      'mona',
    )
  ).json.items as Json[];
  await make('survey.trigger', 'mona', {
    name: 'After a ticket',
    survey,
    topic: 'helpdesk.ticket.solved',
    nameField: 'subject',
    emailField: 'email',
    partnerField: 'partner',
    answerQuestion: question.id,
    answerField: 'rating',
  });
  const users = Object.fromEntries(
    (
      await erp.host.server.driver.query<{ id: number; login: string }>({
        text: 'SELECT id, login FROM res_users',
        params: [],
      })
    ).map((u) => [u.login, Number(u.id)]),
  );
  // Helpdesk's own one-question rating is switched off: the survey asks instead.
  const team = await make('helpdesk.team', 'mona', {
    name: 'Support',
    members: { set: [users['ali']] },
    assignment: 'manual',
    rating: false,
  });
  const ticket = await make('helpdesk.ticket', 'mona', {
    subject: 'The invoice shows the wrong address',
    team,
    email: 'buyer@customer.example',
  });
  const before = mailer.sent.length;
  await drain();
  // Not before it is solved.
  expect(await invitations(survey)).toHaveLength(0);
  expect(
    (await call('POST', `/api/v1/models/helpdesk.ticket/${ticket}/transitions/solve`, 'mona'))
      .status,
  ).toBe(200);
  await drain();
  await drain();
  const [invited] = await invitations(survey);
  expect([invited.email, invited.resModel, invited.resId]).toEqual([
    'buyer@customer.example',
    'helpdesk.ticket',
    ticket,
  ]);
  expect(mailer.sent.slice(before).map((m) => m.to)).toEqual(['buyer@customer.example']);
  // The customer answers by their link, without a sign-in.
  const answered = await erp.host.server.app.inject({
    method: 'POST',
    url: `/api/v1/public/surveys/${invited.token}`,
    payload: { answers: { [question.id]: 4 } },
  });
  expect(answered.statusCode, answered.body).toBe(201);
  const t = (await call('GET', `/api/v1/models/helpdesk.ticket/${ticket}?fields=rating`, 'mona'))
    .json as Json;
  expect(t.rating).toBe(4);
  // The response says what it is about.
  const [response] = (
    await call(
      'GET',
      `/api/v1/models/survey.response?filter=${filter({ survey })}&fields=resModel,resId,email`,
      'mona',
    )
  ).json.items as Json[];
  expect(response).toMatchObject({
    resModel: 'helpdesk.ticket',
    resId: ticket,
    email: 'buyer@customer.example',
  });
});
