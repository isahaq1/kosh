/**
 * Live chat on real PostgreSQL (RFC 0034 §2.6), through its public API and the operators' API: a visitor without
 * an account starts a conversation that goes to the operator who is there, both write, the visitor ends and rates
 * it; a conversation is its visitor's by their secret alone; when nobody is there an email is asked for and the
 * conversation is missed in time; conversations wait when everybody is at their limit and are taken by hand;
 * operators see their channels' conversations only, and people without a role of Live chat nothing.
 */
import { type TestInstallation, testInstallation } from '@kosh/server/testing';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { livechatModule, sweepSessions } from '../src/index.js';

let erp: TestInstallation;
const ids: Record<string, number> = {};
const keys: Record<string, string> = {};

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
const call = async (
  as: string,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  body?: unknown,
) => {
  const res = await erp.call(method as 'GET', url, as, body);
  return { status: res.status, json: res.json as Json };
};
/** A visitor's call: no sign-in; their secret if they have one. */
const visit = async (method: 'GET' | 'POST', url: string, secret?: string, body?: unknown) => {
  const res = await erp.host.server.app.inject({
    method,
    url,
    headers: secret === undefined ? {} : { 'x-chat-secret': secret },
    ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
  });
  const text = res.body;
  return {
    status: res.statusCode,
    headers: res.headers,
    text,
    json: (text.startsWith('{') ? JSON.parse(text) : null) as Json,
  };
};
const chat = (channel: string): string => `/api/v1/public/livechat/${keys[channel]}`;
const here = async (who: string, available: boolean) => {
  expect((await call(who, 'PUT', '/api/v1/livechat/presence', { available })).status).toBe(200);
};
const start = async (channel: string, body: Record<string, unknown>) => {
  const made = await visit('POST', `${chat(channel)}/sessions`, undefined, body);
  expect(made.status, made.text).toBe(201);
  return made.json as { secret: string; online: boolean; session: Json };
};
const sweep = (at: number) =>
  erp.host.server.shutro.bootstrap({ reason: 'test: time passes' }, (env) =>
    sweepSessions(env as never, at),
  );

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  erp = await testInstallation({
    modules: [livechatModule({ workers: false })],
    users: {
      maria: ['livechat.manager'],
      dina: ['livechat.user'],
      rahim: ['livechat.user'],
      // An operator of another channel, and somebody with no role of Live chat.
      sumi: ['livechat.user'],
      karim: ['contacts.user'],
    },
    company: { name: 'Padma Traders', currency: 'BDT' },
  });
  const users = await erp.host.server.driver.query<{ id: number; login: string }>({
    text: 'SELECT id, login FROM res_users',
    params: [],
  });
  for (const u of users) ids[u.login] = Number(u.id);
  const channel = async (name: string, values: Record<string, unknown>) => {
    const made = await call('maria', 'POST', '/api/v1/models/livechat.channel', {
      name,
      ...values,
    });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    ids[name] = made.json.id;
    keys[name] = (
      await call('maria', 'GET', `/api/v1/models/livechat.channel/${made.json.id}?fields=key,link`)
    ).json.key;
  };
  await channel('Sales', {
    operators: { set: [ids['dina'], ids['rahim']] },
    assignment: 'turn',
    limit: 1,
  });
  await channel('Support', { operators: { set: [ids['sumi']] }, assignment: 'manual' });
}, 300_000);

afterAll(async () => {
  await erp?.close();
});

test('the channel as a visitor sees it; its window is a page of its own, framed by nobody unless named', async () => {
  const info = await visit('GET', chat('Sales'));
  expect(info.status).toBe(200);
  expect(info.json).toEqual({
    name: 'Sales',
    welcome: 'Hello! How can we help?',
    offline: 'Nobody is here right now. Leave your email and we will write back.',
    online: false,
  });
  const page = await visit('GET', `${chat('Sales')}/widget?lang=bn`);
  expect(page.status).toBe(200);
  expect(String(page.headers['content-type'])).toContain('text/html');
  expect(String(page.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
  expect(page.text).toContain('<html lang="bn">');
  expect(page.text).toContain('চ্যাট শুরু করুন');
  // The sites the channel names may frame it; what is not an address of a site is left out.
  expect(
    (
      await call('maria', 'PATCH', `/api/v1/models/livechat.channel/${ids['Sales']}`, {
        origins: "https://shop.example.com/\njavascript:alert(1)\n* 'unsafe-inline'",
      })
    ).status,
  ).toBe(200);
  const framed = await visit('GET', `${chat('Sales')}/widget`);
  expect(String(framed.headers['content-security-policy'])).toContain(
    'frame-ancestors https://shop.example.com;',
  );
  // A key that opens nothing.
  expect((await visit('GET', '/api/v1/public/livechat/nope')).status).toBe(404);
  expect((await visit('GET', '/api/v1/public/livechat/nope/widget')).status).toBe(404);
  // The key is the server's: nobody chooses it.
  const forged = await call('maria', 'PATCH', `/api/v1/models/livechat.channel/${ids['Sales']}`, {
    key: 'mine',
  });
  expect(forged.status).toBeGreaterThanOrEqual(400);
});

test('a conversation goes to the operator who is there; both write; the visitor ends and rates it', async () => {
  await here('dina', true);
  expect((await visit('GET', chat('Sales'))).json.online).toBe(true);
  const started = await start('Sales', {
    name: 'Rina <b>Akter</b>',
    message: '  Do you deliver\r\nto Gazipur?  ',
    page: '/delivery',
  });
  expect(started.online).toBe(true);
  expect(started.session.state).toBe('active');
  // A visitor reads the operator's first name, and what the server noted.
  expect(started.session.operator).toBe('dina');
  expect(started.session.messages.map((m: Json) => [m.kind, m.body])).toEqual([
    ['visitor', 'Do you deliver\nto Gazipur?'],
    ['system', 'dina joined.'],
  ]);
  const id = started.session.id as number;
  // In Dina's inbox, hers.
  const inbox = await call('dina', 'GET', '/api/v1/livechat/inbox');
  expect(inbox.status).toBe(200);
  expect(inbox.json).toMatchObject({ available: true, channels: 1 });
  expect(inbox.json.sessions).toMatchObject([
    { id, visitor: 'Rina <b>Akter</b>', mine: true, state: 'active', page: '/delivery' },
  ]);
  // She answers; an empty answer is nothing.
  expect(
    (await call('dina', 'POST', `/api/v1/livechat/sessions/${id}/messages`, { body: '  ' })).status,
  ).toBe(422);
  const answered = await call('dina', 'POST', `/api/v1/livechat/sessions/${id}/messages`, {
    body: 'Yes — within two working days.',
  });
  expect(answered.status, JSON.stringify(answered.json)).toBe(201);
  // The visitor reads what came after the last message they have, and writes back.
  const last = started.session.messages.at(-1).id as number;
  const news = await visit(
    'GET',
    `${chat('Sales')}/sessions/current?after=${last}`,
    started.secret,
  );
  expect(news.json.messages.map((m: Json) => [m.kind, m.author, m.body])).toEqual([
    ['operator', 'dina', 'Yes — within two working days.'],
  ]);
  expect(
    (
      await visit('POST', `${chat('Sales')}/sessions/current/messages`, started.secret, {
        body: 'Thank you!',
      })
    ).status,
  ).toBe(201);
  // The visitor ends it with a rating; a second rating is refused, and nothing more is said in it.
  const ended = await visit('POST', `${chat('Sales')}/sessions/current/close`, started.secret, {
    rating: 5,
  });
  expect(ended.status, ended.text).toBe(200);
  expect(ended.json.state).toBe('closed');
  expect(
    (await visit('POST', `${chat('Sales')}/sessions/current/close`, started.secret, { rating: 1 }))
      .status,
  ).toBe(409);
  expect(
    (
      await visit('POST', `${chat('Sales')}/sessions/current/messages`, started.secret, {
        body: 'Hello?',
      })
    ).status,
  ).toBe(409);
  expect(
    (await call('dina', 'POST', `/api/v1/livechat/sessions/${id}/messages`, { body: 'Bye' }))
      .status,
  ).toBe(409);
  // Kept: who, how long, what they thought.
  const kept = await call(
    'maria',
    'GET',
    `/api/v1/models/livechat.session/${id}?fields=state,operator,visitorName,rating,waitSeconds,messageCount,someoneThere`,
  );
  expect(kept.json).toMatchObject({
    state: 'closed',
    visitorName: 'Rina <b>Akter</b>',
    rating: 5,
    messageCount: 3,
    someoneThere: true,
  });
  expect(kept.json.waitSeconds).toBeGreaterThanOrEqual(0);
  expect(kept.json.operator?.id ?? kept.json.operator).toBe(ids['dina']);
  // The visitor's secret is never served, not even to a manager.
  const secret = await call(
    'maria',
    'GET',
    `/api/v1/models/livechat.session/${id}?fields=secretHash`,
  );
  expect(JSON.stringify(secret.json)).not.toMatch(/[0-9a-f]{64}/);
});

test('a conversation is its visitor’s by their secret alone', async () => {
  const mine = await start('Sales', { name: 'Salma', message: 'Is the blue one in stock?' });
  // No secret, a wrong one, the right one on another channel: the same answer, and nothing read.
  for (const [channel, secret] of [
    ['Sales', undefined],
    ['Sales', 'x'.repeat(32)],
    ['Support', mine.secret],
  ] as const) {
    const read = await visit('GET', `${chat(channel)}/sessions/current`, secret);
    expect(read.status).toBe(404);
    expect(read.text).not.toContain('blue one');
    expect(
      (await visit('POST', `${chat(channel)}/sessions/current/messages`, secret, { body: 'Hi' }))
        .status,
    ).toBe(404);
    expect(
      (await visit('POST', `${chat(channel)}/sessions/current/close`, secret, {})).status,
    ).toBe(404);
  }
  // Nothing a visitor sends is a field of the conversation: the operator is the server's choice.
  const forged = await start('Support', {
    message: 'Hello',
    email: 'someone@example.com',
    operator: ids['dina'],
    state: 'active',
  });
  expect(forged.session).toMatchObject({ state: 'waiting', operator: null });
  await visit('POST', `${chat('Support')}/sessions/current/close`, forged.secret, {});
  // What is not a person fills the field people do not see: told all is well, and nothing is kept.
  const before = (await call('maria', 'GET', '/api/v1/models/livechat.session?fields=name')).json
    .items.length;
  const robot = await visit('POST', `${chat('Sales')}/sessions`, undefined, {
    message: 'Buy now',
    website: 'http://spam.example',
  });
  expect(robot.status).toBe(201);
  expect(
    (await call('maria', 'GET', '/api/v1/models/livechat.session?fields=name')).json.items,
  ).toHaveLength(before);
  expect((await visit('GET', `${chat('Sales')}/sessions/current`, robot.json.secret)).status).toBe(
    404,
  );
  // A message is needed, and an email looks like one.
  expect(
    (await visit('POST', `${chat('Sales')}/sessions`, undefined, { message: ' ' })).status,
  ).toBe(422);
  expect(
    (await visit('POST', `${chat('Sales')}/sessions`, undefined, { message: 'Hi', email: 'nope' }))
      .status,
  ).toBe(422);
  await visit('POST', `${chat('Sales')}/sessions/current/close`, mine.secret, {});
});

test('everybody at their limit: it waits, and an operator of the channel takes it by hand', async () => {
  await here('dina', true);
  await here('rahim', false);
  // Dina's one conversation at once.
  const first = await start('Sales', { name: 'One', message: 'First' });
  expect(first.session).toMatchObject({ state: 'active', operator: 'dina' });
  const second = await start('Sales', { name: 'Two', message: 'Second' });
  expect(second.session).toMatchObject({ state: 'waiting', operator: null });
  const id = second.session.id as number;
  // It waits in the inbox of both operators of the channel.
  for (const who of ['dina', 'rahim'])
    expect(
      (await call(who, 'GET', '/api/v1/livechat/inbox')).json.sessions.map((s: Json) => [
        s.id,
        s.mine,
      ]),
    ).toContainEqual([id, false]);
  // Until it is taken, nobody answers in it.
  expect(
    (await call('rahim', 'POST', `/api/v1/livechat/sessions/${id}/messages`, { body: 'Hi' }))
      .status,
  ).toBe(403);
  const taken = await call('rahim', 'POST', `/api/v1/livechat/sessions/${id}/take`);
  expect(taken.status, JSON.stringify(taken.json)).toBe(200);
  expect(taken.json).toMatchObject({ state: 'active', operator: 'rahim' });
  // Taken once; and it is Rahim's to answer and to end, not Dina's.
  expect((await call('dina', 'POST', `/api/v1/livechat/sessions/${id}/take`)).status).toBe(409);
  expect(
    (await call('dina', 'POST', `/api/v1/livechat/sessions/${id}/messages`, { body: 'Mine' }))
      .status,
  ).toBe(403);
  expect((await call('dina', 'POST', `/api/v1/livechat/sessions/${id}/close`)).status).toBe(403);
  expect((await call('rahim', 'POST', `/api/v1/livechat/sessions/${id}/close`)).json.state).toBe(
    'closed',
  );
  // In turn: Rahim is there now, and was given one after Dina — the next goes to her once she is free.
  await here('rahim', true);
  await visit('POST', `${chat('Sales')}/sessions/current/close`, first.secret, {});
  const third = await start('Sales', { name: 'Three', message: 'Third' });
  expect(third.session.operator).toBe('dina');
  const fourth = await start('Sales', { name: 'Four', message: 'Fourth' });
  expect(fourth.session.operator).toBe('rahim');
  for (const s of [third, fourth])
    await visit('POST', `${chat('Sales')}/sessions/current/close`, s.secret, {});
});

test('nobody there: an email is asked for; time misses what waits and closes what went quiet', async () => {
  await here('dina', false);
  await here('rahim', false);
  expect((await visit('GET', chat('Sales'))).json.online).toBe(false);
  const anonymous = await visit('POST', `${chat('Sales')}/sessions`, undefined, {
    message: 'A quotation for 200 cartons, please.',
  });
  expect(anonymous.status).toBe(422);
  expect(anonymous.text).toContain('leave your email');
  const left = await start('Sales', {
    name: 'Karim Hossain',
    email: 'Karim@Example.com',
    message: 'A quotation for 200 cartons, please.',
  });
  expect(left.online).toBe(false);
  expect(left.session.state).toBe('waiting');
  const id = left.session.id as number;
  // One that is being answered, for the other half of what time does.
  await here('dina', true);
  const talking = await start('Sales', { name: 'Quiet', message: 'Hello' });
  expect(talking.session.state).toBe('active');
  const min = 60_000;
  // Nine minutes: nothing yet.
  expect(await sweep(Date.now() + 9 * min)).toEqual({ missed: 0, closed: 0 });
  // Eleven: the one that waits is missed; the other is still being answered.
  expect(await sweep(Date.now() + 11 * min)).toEqual({ missed: 1, closed: 0 });
  expect(await sweep(Date.now() + 11 * min)).toEqual({ missed: 0, closed: 0 });
  const missed = await visit('GET', `${chat('Sales')}/sessions/current`, left.secret);
  expect(missed.json.state).toBe('missed');
  const kept = await call(
    'maria',
    'GET',
    `/api/v1/models/livechat.session/${id}?fields=state,visitorEmail,someoneThere`,
  );
  expect(kept.json).toMatchObject({
    state: 'missed',
    visitorEmail: 'karim@example.com',
    someoneThere: false,
  });
  // Half an hour of silence: the other is closed, and says so.
  expect(await sweep(Date.now() + 31 * min)).toEqual({ missed: 0, closed: 1 });
  const closed = await visit('GET', `${chat('Sales')}/sessions/current`, talking.secret);
  expect(closed.json.state).toBe('closed');
  expect(closed.json.messages.at(-1).body).toBe('Closed: nobody wrote for a while.');
  // An operator whose inbox has not been open for a while is not there, whatever they said.
  await erp.host.server.driver.query({
    text: "UPDATE livechat_presence SET seen_at = now() - interval '5 minutes'",
    params: [],
  });
  expect((await visit('GET', chat('Sales'))).json.online).toBe(false);
  // Their inbox opens again: they are back.
  await call('dina', 'GET', '/api/v1/livechat/inbox');
  expect((await visit('GET', chat('Sales'))).json.online).toBe(true);
});

test('operators see their channels only; without a role of Live chat, nothing; the server writes the record', async () => {
  const theirs = await start('Sales', { name: 'Private', message: 'For Sales only' });
  const id = theirs.session.id as number;
  // Sumi answers Support: Sales' conversations are not hers — not in her inbox, the list or by id.
  const inbox = await call('sumi', 'GET', '/api/v1/livechat/inbox');
  expect(inbox.json.sessions.map((s: Json) => s.channel)).not.toContain('Sales');
  expect((await call('sumi', 'GET', `/api/v1/livechat/sessions/${id}`)).status).toBe(404);
  expect((await call('sumi', 'POST', `/api/v1/livechat/sessions/${id}/take`)).status).toBe(404);
  expect(
    (await call('sumi', 'POST', `/api/v1/livechat/sessions/${id}/messages`, { body: 'Hi' })).status,
  ).toBe(404);
  expect((await call('sumi', 'POST', `/api/v1/livechat/sessions/${id}/close`)).status).toBe(404);
  const listed = await call('sumi', 'GET', '/api/v1/models/livechat.session?fields=name,channel');
  expect(JSON.stringify(listed.json)).not.toContain(`"id":${id},`);
  const said = await call('sumi', 'GET', '/api/v1/models/livechat.message?fields=body');
  expect(JSON.stringify(said.json)).not.toContain('For Sales only');
  // Karim has no role of Live chat.
  for (const [method, url] of [
    ['GET', '/api/v1/livechat/inbox'],
    ['PUT', '/api/v1/livechat/presence'],
    ['GET', `/api/v1/livechat/sessions/${id}`],
    ['POST', `/api/v1/livechat/sessions/${id}/take`],
    ['GET', '/api/v1/models/livechat.session?fields=name'],
    ['GET', '/api/v1/models/livechat.message?fields=body'],
  ] as const)
    expect(
      (await call('karim', method, url, method === 'PUT' ? { available: true } : undefined)).status,
      `${method} ${url}`,
    ).toBe(403);
  // What happened is the server's to write: not an operator's, by the models' API.
  for (const values of [{ state: 'closed' }, { rating: 5 }, { operator: ids['dina'] }])
    expect(
      (await call('dina', 'PATCH', `/api/v1/models/livechat.session/${id}`, values)).status,
    ).toBeGreaterThanOrEqual(400);
  expect(
    (
      await call('dina', 'POST', '/api/v1/models/livechat.message', {
        session: id,
        kind: 'visitor',
        body: 'Words put in their mouth',
        at: new Date().toISOString(),
      })
    ).status,
  ).toBeGreaterThanOrEqual(400);
  // A manager reads every channel's conversations; an operator's presence is not theirs to set for another.
  expect((await call('maria', 'GET', `/api/v1/livechat/sessions/${id}`)).status).toBe(200);
  const presence = await call(
    'maria',
    'GET',
    '/api/v1/models/livechat.presence?fields=user,available',
  );
  const row = (presence.json.items as Json[])[0];
  expect(
    (
      await call('dina', 'PATCH', `/api/v1/models/livechat.presence/${row.id}`, {
        available: false,
      })
    ).status,
  ).toBeGreaterThanOrEqual(400);
});
