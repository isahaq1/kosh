/**
 * Chats that become tickets and deals on real PostgreSQL (RFC 0034 §2.6), with Live chat, Helpdesk and Pipeline
 * installed together: a channel's rules — in order, by how the conversation ended, a word the visitor wrote, the
 * page they wrote from — make a ticket or a deal of it, once, with what was said; a conversation no rule meets
 * stays a conversation; an operator makes one by hand; a rule cannot name what no app makes; who may is checked.
 */

import { livechatWorkers, sweepSessions } from '@kosh/livechat';
import { livechatCrm } from '@kosh/livechat_crm';
import { type TestInstallation, testInstallation } from '@kosh/server/testing';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { livechatHelpdesk } from '../src/index.js';

let erp: TestInstallation;
let drain: () => Promise<void>;
const ids: Record<string, number> = {};
let key = '';

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
const call = async (
  as: string,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  url: string,
  body?: unknown,
) => {
  const res = await erp.call(method as 'GET', url, as, body);
  return { status: res.status, json: res.json as Json };
};
const make = async (model: string, values: Record<string, unknown>) => {
  const made = await call('maria', 'POST', `/api/v1/models/${model}`, values);
  expect(made.status, `${model}: ${JSON.stringify(made.json)}`).toBe(201);
  return made.json.id as number;
};
const visit = async (method: 'GET' | 'POST', url: string, secret?: string, body?: unknown) => {
  const res = await erp.host.server.app.inject({
    method,
    url,
    headers: secret === undefined ? {} : { 'x-chat-secret': secret },
    ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
  });
  return { status: res.statusCode, json: (res.body.startsWith('{') ? res.json() : null) as Json };
};
const chat = (): string => `/api/v1/public/livechat/${key}`;
/** A conversation started by a visitor and ended by them. */
const talk = async (body: Record<string, unknown>) => {
  const started = await visit('POST', `${chat()}/sessions`, undefined, body);
  expect(started.status, JSON.stringify(started.json)).toBe(201);
  expect(
    (await visit('POST', `${chat()}/sessions/current/close`, started.json.secret, {})).status,
  ).toBe(200);
  await drain();
  return started.json.session.id as number;
};
const became = async (session: number) =>
  (
    await call(
      'maria',
      'GET',
      `/api/v1/models/livechat.session/${session}?fields=resModel,resId,resName,rule,state`,
    )
  ).json as Json;

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  erp = await testInstallation({
    // Live chat comes with its bridges; `KOSH_SCHEDULES=off` keeps its worker and its round for the test to run.
    modules: [livechatHelpdesk, livechatCrm],
    users: {
      maria: ['livechat.manager', 'helpdesk.manager', 'crm.manager', 'contacts.manager'],
      dina: ['livechat.user'],
      // Answers another channel; and somebody of Helpdesk with no role of Live chat.
      sumi: ['livechat.user'],
      rahim: ['helpdesk.user'],
    },
    company: { name: 'Padma Traders', currency: 'BDT' },
  });
  const workers = livechatWorkers({ shutro: erp.host.server.shutro });
  drain = async () => {
    for (const w of workers) await w.drain();
  };
  const users = await erp.host.server.driver.query<{ id: number; login: string }>({
    text: 'SELECT id, login FROM res_users',
    params: [],
  });
  for (const u of users) ids[u.login] = Number(u.id);
  ids['team'] = await make('helpdesk.team', {
    name: 'Support',
    members: { set: [ids['rahim']] },
  });
  ids['channel'] = await make('livechat.channel', {
    name: 'Chat with us',
    operators: { set: [ids['dina']] },
    assignment: 'turn',
  });
  await make('livechat.channel', { name: 'Other', operators: { set: [ids['sumi']] } });
  key = (await call('maria', 'GET', `/api/v1/models/livechat.channel/${ids['channel']}?fields=key`))
    .json.key;
  ids['meghna'] = await make('res.partner', {
    name: 'Meghna Mills',
    email: 'buyer@meghna.example',
  });
  // In order: a price asked from the pricing page is a deal; a problem is a ticket; a missed one is a ticket.
  ids['dealRule'] = await make('livechat.rule', {
    name: 'Prices are for Sales',
    channel: ids['channel'],
    sequence: 10,
    keywords: 'price, quotation, কত দাম',
    target: 'crm.deal',
  });
  ids['problemRule'] = await make('livechat.rule', {
    name: 'Problems are tickets',
    channel: ids['channel'],
    sequence: 20,
    on: 'closed',
    keywords: 'broken\nrefund',
    target: 'helpdesk.ticket',
  });
  ids['missedRule'] = await make('livechat.rule', {
    name: 'Nobody answered',
    channel: ids['channel'],
    sequence: 30,
    on: 'missed',
    target: 'helpdesk.ticket',
  });
  expect((await call('dina', 'PUT', '/api/v1/livechat/presence', { available: true })).status).toBe(
    200,
  );
}, 300_000);

afterAll(async () => {
  await erp?.close();
});

test('what a conversation may become is what the installed apps make; a rule names one of them', async () => {
  const targets = await call('dina', 'GET', '/api/v1/livechat/targets');
  expect(targets.status).toBe(200);
  expect([...targets.json.targets].sort()).toEqual(['crm.deal', 'helpdesk.ticket']);
  const wrong = await call('maria', 'POST', '/api/v1/models/livechat.rule', {
    name: 'Into users',
    channel: ids['channel'],
    target: 'res.users',
  });
  expect(wrong.status).toBeGreaterThanOrEqual(400);
  expect(JSON.stringify(wrong.json)).toContain('No installed app makes that');
  // Rules are a manager's.
  const operator = await call('dina', 'POST', '/api/v1/models/livechat.rule', {
    name: 'Mine',
    channel: ids['channel'],
    target: 'crm.deal',
  });
  expect(operator.status).toBe(403);
});

test('a word the visitor wrote: a deal, with the visitor, the known contact and what was said — once', async () => {
  const session = await talk({
    name: 'Rina Akter',
    email: 'Buyer@Meghna.example',
    message: 'What is the PRICE of 200 cartons?\nWe need them by Eid.',
    page: '/pricing',
  });
  const kept = await became(session);
  expect(kept).toMatchObject({ resModel: 'crm.deal', state: 'closed' });
  expect(kept.rule?.id ?? kept.rule).toBe(ids['dealRule']);
  const deal = await call(
    'maria',
    'GET',
    `/api/v1/models/crm.deal/${kept.resId}?fields=name,description,contactName,email,partner,source,salesperson`,
  );
  expect(deal.status, JSON.stringify(deal.json)).toBe(200);
  expect(deal.json).toMatchObject({
    name: 'What is the PRICE of 200 cartons? We need them by Eid.',
    contactName: 'Rina Akter',
    email: 'buyer@meghna.example',
    source: 'website',
    salesperson: null,
  });
  expect(deal.json.partner?.id ?? deal.json.partner).toBe(ids['meghna']);
  // What was said, a line per message, with who said it and the note of how it ended.
  const lines = String(deal.json.description).split('\n');
  expect(lines[0]).toMatch(/^\[\d\d:\d\d\] Rina Akter: What is the PRICE of 200 cartons\?$/);
  expect(lines[1]).toBe('We need them by Eid.');
  expect(lines.some((l) => /— dina joined\.$/.test(l))).toBe(true);
  expect(lines.at(-1)).toMatch(/— The visitor left\.$/);
  expect(kept.resName).toBe(deal.json.name);
  // The event read again, and an operator asking for a ticket of it: it is what it became, nothing new.
  const deals = async () =>
    (await call('maria', 'GET', '/api/v1/models/crm.deal?fields=name')).json.items.length as number;
  const before = await deals();
  await erp.host.server.shutro.bootstrap({ reason: 'test: the event again' }, async (env) => {
    const { routeSession } = await import('@kosh/livechat');
    expect(await routeSession(env as never, session)).toMatchObject({
      model: 'crm.deal',
      id: kept.resId,
      made: false,
    });
  });
  const again = await call('dina', 'POST', `/api/v1/livechat/sessions/${session}/route`, {
    target: 'helpdesk.ticket',
  });
  expect(again.json).toMatchObject({ model: 'crm.deal', id: kept.resId, made: false });
  expect(await deals()).toBe(before);
});

test('rules in order: a problem is a ticket; a word inside another word is not that word; no rule, no record', async () => {
  // "refund" as a whole word, whatever its case: the second rule.
  const problem = await talk({
    name: 'Karim',
    message: 'My kettle arrived <b>broken</b>, I want a REFUND.',
  });
  const kept = await became(problem);
  expect(kept.resModel).toBe('helpdesk.ticket');
  expect(kept.rule?.id ?? kept.rule).toBe(ids['problemRule']);
  const ticket = await call(
    'maria',
    'GET',
    `/api/v1/models/helpdesk.ticket/${kept.resId}?fields=name,subject,description,team,email,partner`,
  );
  expect(ticket.status, JSON.stringify(ticket.json)).toBe(200);
  expect(ticket.json.subject).toBe('My kettle arrived <b>broken</b>, I want a REFUND.');
  expect(ticket.json.team?.id ?? ticket.json.team).toBe(ids['team']);
  expect(kept.resName).toBe(ticket.json.name);
  // What the visitor typed is text on the ticket: its markup is not markup.
  expect(ticket.json.description).toContain('&lt;b&gt;broken&lt;/b&gt;');
  expect(ticket.json.description).not.toContain('<b>broken</b>');
  // Both rules' words: the first in order wins.
  const both = await became(await talk({ message: 'A quotation, and my last one came broken.' }));
  expect(both.resModel).toBe('crm.deal');
  // "priceless" is not "price", "refunded" is not "refund": no rule, and it stays a conversation.
  const none = await became(
    await talk({ message: 'Your service is priceless. I was refunded already.' }),
  );
  expect(none).toMatchObject({ resModel: null, resId: null, state: 'closed' });
  // Bangla words are words too.
  const bangla = await became(await talk({ message: 'এই কেটলির কত দাম?' }));
  expect(bangla.resModel).toBe('crm.deal');
});

test('missed: the visitor’s message and email become a ticket for somebody to answer', async () => {
  expect(
    (await call('dina', 'PUT', '/api/v1/livechat/presence', { available: false })).status,
  ).toBe(200);
  const started = await visit('POST', `${chat()}/sessions`, undefined, {
    name: 'Salma',
    email: 'salma@example.com',
    message: 'Is the blue kettle back in stock?',
  });
  expect(started.status).toBe(201);
  const session = started.json.session.id as number;
  // Still waiting: nothing is made of a conversation that has not ended, by the rules or by hand.
  await drain();
  expect((await became(session)).resModel).toBeNull();
  expect(
    (
      await call('dina', 'POST', `/api/v1/livechat/sessions/${session}/route`, {
        target: 'helpdesk.ticket',
      })
    ).status,
  ).toBe(409);
  await erp.host.server.shutro.bootstrap({ reason: 'test: time passes' }, (env) =>
    sweepSessions(env as never, Date.now() + 11 * 60_000),
  );
  await drain();
  const kept = await became(session);
  expect(kept).toMatchObject({ resModel: 'helpdesk.ticket', state: 'missed' });
  expect(kept.rule?.id ?? kept.rule).toBe(ids['missedRule']);
  const ticket = await call(
    'maria',
    'GET',
    `/api/v1/models/helpdesk.ticket/${kept.resId}?fields=subject,email,partner`,
  );
  expect(ticket.json).toMatchObject({
    subject: 'Is the blue kettle back in stock?',
    email: 'salma@example.com',
    partner: null,
  });
  expect((await call('dina', 'PUT', '/api/v1/livechat/presence', { available: true })).status).toBe(
    200,
  );
});

test('by hand: an operator of the channel makes a ticket of an ended conversation; others may not', async () => {
  const session = await talk({ name: 'Nadia', message: 'Just saying hello.' });
  expect((await became(session)).resModel).toBeNull();
  // Not a model an app makes of a conversation.
  expect(
    (
      await call('dina', 'POST', `/api/v1/livechat/sessions/${session}/route`, {
        target: 'res.users',
      })
    ).status,
  ).toBe(422);
  // An operator of another channel does not see it; Helpdesk without a role of Live chat is not let in.
  expect(
    (
      await call('sumi', 'POST', `/api/v1/livechat/sessions/${session}/route`, {
        target: 'helpdesk.ticket',
      })
    ).status,
  ).toBe(404);
  for (const [method, url] of [
    ['POST', `/api/v1/livechat/sessions/${session}/route`],
    ['GET', '/api/v1/livechat/targets'],
  ] as const)
    expect(
      (
        await call(
          'rahim',
          method,
          url,
          method === 'POST' ? { target: 'helpdesk.ticket' } : undefined,
        )
      ).status,
    ).toBe(403);
  const made = await call('dina', 'POST', `/api/v1/livechat/sessions/${session}/route`, {
    target: 'helpdesk.ticket',
  });
  expect(made.status, JSON.stringify(made.json)).toBe(200);
  expect(made.json).toMatchObject({ model: 'helpdesk.ticket', made: true });
  const kept = await became(session);
  expect(kept).toMatchObject({ resModel: 'helpdesk.ticket', resId: made.json.id, rule: null });
  // What a conversation became is the server's to write.
  const forged = await call('dina', 'PATCH', `/api/v1/models/livechat.session/${session}`, {
    resModel: 'crm.deal',
    resId: 1,
  });
  expect(forged.status).toBeGreaterThanOrEqual(400);
  // The ticket's agent, who has no role of Live chat, reads the ticket — not the conversation behind it.
  expect(
    (await call('rahim', 'GET', `/api/v1/models/helpdesk.ticket/${made.json.id}?fields=subject`))
      .json.subject,
  ).toBe('Just saying hello.');
  expect(
    (await call('rahim', 'GET', `/api/v1/models/livechat.session/${session}?fields=name`)).status,
  ).toBe(403);
});
