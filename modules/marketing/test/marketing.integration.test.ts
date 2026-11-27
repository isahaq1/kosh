/**
 * Campaigns on real PostgreSQL (RFC 0038, step 3): who a campaign writes to — subscribed addresses of its lists
 * and the tagged contacts the sender may see, each once, the never-email list left out —; sending in the
 * background with the two subjects alternating; opens and clicks counted once per person, the redirect only to
 * the campaign's own links; unsubscribing by the page's button or a mail client's one click, honoured by the
 * next campaign; a campaign scheduled and started at its time; what the mail server refuses; who may send.
 */
import { createMemoryMailer, type Mailer, type OutboundMail } from '@kosh/mail';
import { type TestInstallation, testInstallation } from '@kosh/server/testing';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { bounceWorker, campaignWorker, configureCampaigns, marketing } from '../src/index.js';

const BASE = 'https://erp.test';
const C = '/api/v1/models/marketing.campaign';
const memory = createMemoryMailer();
/** A mail server that refuses one address. */
const mailer: Mailer = {
  name: 'test',
  from: memory.from,
  async send(mail: OutboundMail) {
    if (mail.to === 'refused@example.com') throw new Error('550 mailbox unavailable');
    return memory.send(mail);
  },
};
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
const step = (id: number, name: string, as: string) =>
  call('POST', `${C}/${id}/transitions/${name}`, as);
const sql = <T extends Record<string, unknown>>(text: string, params: unknown[] = []) =>
  erp.host.server.driver.query<T>({ text, params });
/** A request nobody is signed in for: a recipient following a link of their message. */
const visit = (method: 'GET' | 'POST', url: string, form?: string) =>
  erp.host.server.app.inject({
    method,
    url: url.replace(BASE, ''),
    ...(form === undefined
      ? {}
      : { headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: form }),
  });
const campaign = async (id: number) =>
  (
    await call(
      'GET',
      `${C}/${id}?fields=state,recipients,skipped,sent,failed,opened,clicked,unsubscribed,sentA,sentB,openedA,openedB,openRate`,
      'mia',
    )
  ).json as Json;
const deliveries = (id: number) =>
  sql<{ email: string; state: string; variant: string; error: string | null }>(
    `SELECT email, state, variant, error FROM marketing_delivery WHERE campaign_id = $1 ORDER BY id`,
    [id],
  );
const mailTo = (to: string): OutboundMail => {
  const mail = [...memory.sent].reverse().find((m) => m.to === to);
  if (mail === undefined) throw new Error(`no mail to ${to}`);
  return mail;
};
const linkIn = (mail: OutboundMail, kind: 'c' | 'o' | 'u'): string => {
  const found = new RegExp(`${BASE}/api/v1/public/campaigns/${kind}/[^"\\s]+`).exec(mail.html);
  if (found === null) throw new Error(`no ${kind} link`);
  return found[0];
};
const BODY =
  '<p>Dear {{name|customer}},</p><p><a href="https://shop.test/offers">See the offers</a> or <a href="https://shop.test/contact">write to us</a>.</p>';

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  configureCampaigns({ mailer, baseUrl: `${BASE}/`, workers: false });
  erp = await testInstallation({
    modules: [marketing],
    users: {
      mia: ['marketing.manager', 'contacts.manager'],
      uma: ['marketing.user'],
      bob: ['base.user'],
    },
    company: { name: 'Padma Traders', currency: 'BDT' },
  });
  const worker = campaignWorker({ shutro: erp.host.server.shutro }, { mailer, baseUrl: BASE });
  const bounces = bounceWorker({ shutro: erp.host.server.shutro });
  drain = async () => {
    for (let round = 0; round < 20; round += 1)
      if ((await worker.drain()) + (await bounces.drain()) === 0) break;
  };
}, 300_000);

afterAll(async () => {
  await erp?.close();
});

test('lists are a manager’s; an address is an address, once per list', async () => {
  expect(
    (await call('POST', '/api/v1/models/marketing.list', 'uma', { name: 'Mine' })).status,
  ).toBe(403);
  expect((await call('GET', '/api/v1/models/marketing.list', 'bob')).status).toBe(403);
  ids['news'] = await make('marketing.list', 'mia', { name: 'Newsletter' });
  for (const [email, name, more] of [
    ['nadia@example.com', 'Nadia Karim', {}],
    ['Tanvir@Example.com', 'Tanvir Ahmed', { language: 'bn' }],
    ['sadia@example.com', 'Sadia Islam', {}],
    ['refused@example.com', 'Rafi Khan', {}],
    ['legal@example.org', 'Legal', {}],
    ['imran@example.com', 'Imran Hossain', { state: 'unsubscribed' }],
  ] as const)
    await make('marketing.subscriber', 'uma', { list: ids['news'], email, name, ...more });
  const twice = await call('POST', '/api/v1/models/marketing.subscriber', 'uma', {
    list: ids['news'],
    email: ' NADIA@example.com',
  });
  expect(twice.status).toBeGreaterThanOrEqual(400);
  const wrong = await call('POST', '/api/v1/models/marketing.subscriber', 'uma', {
    list: ids['news'],
    email: 'not an address',
  });
  expect(wrong.status).toBe(422);
  // Nobody writes to this one, whatever list it is on.
  await make('marketing.suppression', 'mia', { email: 'Legal@example.org', reason: 'complaint' });
  expect(
    (await call('POST', '/api/v1/models/marketing.suppression', 'uma', { email: 'x@example.com' }))
      .status,
  ).toBe(403);
});

test('a campaign is written by a user and sent by a manager; not before it is ready', async () => {
  ids['vip'] = await make('res.partner.tag', 'mia', { name: 'VIP' });
  // A tagged contact who is also on the list is written to once; one without an address is not.
  await make('res.partner', 'mia', {
    name: 'Nadia Karim',
    email: 'nadia@example.com',
    tags: { set: [ids['vip']] },
  });
  await make('res.partner', 'mia', {
    name: 'Karim Traders',
    email: 'karim@example.com',
    tags: { set: [ids['vip']] },
  });
  await make('res.partner', 'mia', { name: 'No address', tags: { set: [ids['vip']] } });
  ids['winter'] = await make('marketing.campaign', 'uma', {
    name: 'Winter offer',
    subject: '{{first_name|Hello}}, winter prices are here',
    subjectB: '15% off until Friday',
    preheader: 'Three days only',
    body: BODY,
  });
  // Nobody to send to yet.
  expect((await step(ids['winter'] as number, 'send', 'mia')).status).toBe(409);
  expect(
    (
      await call('PATCH', `${C}/${ids['winter']}`, 'uma', {
        lists: { set: [ids['news']] },
        tags: { set: [ids['vip']] },
      })
    ).status,
  ).toBe(200);
  expect((await step(ids['winter'] as number, 'send', 'uma')).status).toBe(403);
  const sent = await step(ids['winter'] as number, 'send', 'mia');
  expect(sent.status, JSON.stringify(sent.json)).toBe(200);
});

test('who it writes to: each address once, the never-email list left out, subjects alternating', async () => {
  const id = ids['winter'] as number;
  const rows = await deliveries(id);
  expect(rows.map((r) => [r.email.toLowerCase(), r.state, r.variant])).toEqual([
    ['nadia@example.com', 'queued', 'a'],
    ['tanvir@example.com', 'queued', 'b'],
    ['sadia@example.com', 'queued', 'a'],
    ['refused@example.com', 'queued', 'b'],
    ['legal@example.org', 'skipped', 'a'],
    ['karim@example.com', 'queued', 'a'],
  ]);
  expect(await campaign(id)).toMatchObject({
    state: 'sending',
    recipients: 5,
    skipped: 1,
    sent: 0,
  });
  // Nothing went out in the request: the worker sends.
  expect(memory.sent).toHaveLength(0);
  // What is on its way is not rewritten.
  expect((await call('PATCH', `${C}/${id}`, 'uma', { subject: 'Changed' })).status).toBe(422);
});

test('sent in the background: personal, with its links through the server and its way out', async () => {
  const id = ids['winter'] as number;
  await drain();
  expect(memory.sent.map((m) => m.to.toLowerCase()).sort()).toEqual([
    'karim@example.com',
    'nadia@example.com',
    'sadia@example.com',
    'tanvir@example.com',
  ]);
  const nadia = mailTo('nadia@example.com');
  expect(nadia.subject).toBe('Nadia, winter prices are here');
  expect(nadia.html).toContain('Dear Nadia Karim,');
  expect(nadia.html).not.toContain('shop.test');
  expect(nadia.headers?.['List-Unsubscribe']).toBe(`<${linkIn(nadia, 'u')}>`);
  expect(nadia.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  const tanvir = mailTo('Tanvir@Example.com');
  expect(tanvir.subject).toBe('15% off until Friday');
  expect(tanvir.html).toContain('তালিকা থেকে বাদ দিন');
  // Each message has a secret of its own.
  expect(linkIn(tanvir, 'u')).not.toBe(linkIn(nadia, 'u'));
  // The one the mail server refused is on record, and not in what was sent.
  const refused = (await deliveries(id)).find((r) => r.email === 'refused@example.com');
  expect(refused).toMatchObject({ state: 'failed', error: '550 mailbox unavailable' });
  expect(await campaign(id)).toMatchObject({
    state: 'sent',
    recipients: 5,
    sent: 4,
    failed: 1,
    sentA: 3,
    sentB: 1,
  });
});

test('an open is counted once per person; the picture is served whoever asks', async () => {
  const id = ids['winter'] as number;
  const pixel = linkIn(mailTo('nadia@example.com'), 'o');
  const first = await visit('GET', pixel);
  expect(first.statusCode).toBe(200);
  expect(first.headers['content-type']).toContain('image/gif');
  await visit('GET', pixel);
  expect(await campaign(id)).toMatchObject({ opened: 1, openedA: 1, openedB: 0 });
  const [d] = await sql<{ opens: number }>(
    `SELECT opens FROM marketing_delivery WHERE campaign_id = $1 AND email = 'nadia@example.com'`,
    [id],
  );
  expect(Number(d?.opens)).toBe(2);
  expect((await visit('GET', `${BASE}/api/v1/public/campaigns/o/nobody.gif`)).statusCode).toBe(200);
  expect((await campaign(id)).opened).toBe(1);
  expect(Number((await campaign(id)).openRate)).toBe(25);
});

test('a click is counted and leads to the campaign’s own link, nowhere else', async () => {
  const id = ids['winter'] as number;
  const link = linkIn(mailTo('Tanvir@Example.com'), 'c');
  expect(link.endsWith('/0')).toBe(true);
  const go = await visit('GET', link);
  expect(go.statusCode).toBe(302);
  expect(go.headers['location']).toBe('https://shop.test/offers');
  const second = await visit('GET', link.replace(/\/0$/, '/1'));
  expect(second.headers['location']).toBe('https://shop.test/contact');
  // Who clicked has opened, and counts once.
  expect(await campaign(id)).toMatchObject({ clicked: 1, opened: 2, openedB: 1 });
  expect((await visit('GET', link.replace(/\/0$/, '/7'))).statusCode).toBe(404);
  expect(
    (await visit('GET', `${BASE}/api/v1/public/campaigns/c/nobody/0?to=https://evil.test`))
      .statusCode,
  ).toBe(404);
  const clicks = await sql<{ position: number; clicks: number }>(
    `SELECT position, clicks FROM marketing_link WHERE campaign_id = $1 ORDER BY position`,
    [id],
  );
  expect(clicks.map((l) => Number(l.clicks))).toEqual([1, 1]);
});

test('unsubscribing: the page asks, the button does it, and the next campaign leaves them out', async () => {
  const id = ids['winter'] as number;
  const out = linkIn(mailTo('sadia@example.com'), 'u');
  // Opening the page changes nothing: mail scanners follow links.
  const page = await visit('GET', out);
  expect(page.statusCode).toBe(200);
  expect(page.body).toContain('<form method="post"');
  expect(page.body).toContain('sa…@example.com');
  expect((await campaign(id)).unsubscribed).toBe(0);
  const done = await visit('POST', out, '');
  expect(done.statusCode).toBe(200);
  expect(done.body).not.toContain('<form');
  // A mail client's one click, on another message; twice counts once.
  const karim = linkIn(mailTo('karim@example.com'), 'u');
  expect((await visit('POST', karim, 'List-Unsubscribe=One-Click')).statusCode).toBe(200);
  expect((await visit('POST', karim, 'List-Unsubscribe=One-Click')).statusCode).toBe(200);
  expect((await campaign(id)).unsubscribed).toBe(2);
  expect((await visit('GET', `${BASE}/api/v1/public/campaigns/u/nobody`)).statusCode).toBe(404);
  const [sadia] = await sql<{ state: string }>(
    `SELECT state FROM marketing_subscriber WHERE key = 'sadia@example.com'`,
  );
  expect(sadia?.state).toBe('unsubscribed');
  const never = await sql<{ key: string; reason: string }>(
    `SELECT key, reason FROM marketing_suppression ORDER BY key`,
  );
  expect(never.map((n) => [n.key, n.reason])).toEqual([
    ['karim@example.com', 'unsubscribed'],
    ['legal@example.org', 'complaint'],
    ['sadia@example.com', 'unsubscribed'],
  ]);

  // The next campaign, to the same list and tag: neither of them, by the server.
  memory.sent.length = 0;
  ids['spring'] = await make('marketing.campaign', 'uma', {
    name: 'Spring news',
    subject: 'Spring news',
    body: '<p>News.</p>',
    lists: { set: [ids['news']] },
    tags: { set: [ids['vip']] },
  });
  expect((await step(ids['spring'] as number, 'send', 'mia')).status).toBe(200);
  await drain();
  expect(memory.sent.map((m) => m.to.toLowerCase()).sort()).toEqual([
    'nadia@example.com',
    'tanvir@example.com',
  ]);
  const rows = await deliveries(ids['spring'] as number);
  expect(rows.find((r) => r.email === 'karim@example.com')?.state).toBe('skipped');
  // Without a second subject everybody gets the one there is.
  expect(new Set(rows.map((r) => r.variant))).toEqual(new Set(['a']));
});

test('a scheduled campaign starts at its time, by itself', async () => {
  memory.sent.length = 0;
  const id = await make('marketing.campaign', 'uma', {
    name: 'Scheduled',
    subject: 'On time',
    body: '<p>Now.</p>',
    lists: { set: [ids['news']] },
  });
  // No time, no schedule.
  expect((await step(id, 'schedule', 'mia')).status).toBe(409);
  const at = new Date(Date.now() - 60_000).toISOString();
  expect((await call('PATCH', `${C}/${id}`, 'uma', { scheduledAt: at })).status).toBe(200);
  expect((await step(id, 'schedule', 'uma')).status).toBe(403);
  const scheduled = await step(id, 'schedule', 'mia');
  expect(scheduled.status, JSON.stringify(scheduled.json)).toBe(200);
  expect((await campaign(id)).state).toBe('scheduled');
  await drain();
  expect((await campaign(id)).state).toBe('sent');
  expect(memory.sent.map((m) => m.to.toLowerCase()).sort()).toEqual([
    'nadia@example.com',
    'tanvir@example.com',
  ]);
});

test('cancelled while sending: what has not gone out does not', async () => {
  memory.sent.length = 0;
  const id = await make('marketing.campaign', 'uma', {
    name: 'Stopped',
    subject: 'Never mind',
    body: '<p>Oops.</p>',
    lists: { set: [ids['news']] },
  });
  expect((await step(id, 'send', 'mia')).status).toBe(200);
  expect((await step(id, 'cancel', 'mia')).status).toBe(200);
  await drain();
  expect(memory.sent).toHaveLength(0);
  expect(await campaign(id)).toMatchObject({ state: 'cancel', recipients: 0, sent: 0 });
});

test('a test send is the message as one person gets it, and counts for nothing', async () => {
  memory.sent.length = 0;
  const id = ids['spring'] as number;
  expect(
    (await call('POST', `/api/v1/campaigns/${id}/test`, 'bob', { to: 'me@example.com' })).status,
  ).toBeGreaterThanOrEqual(403);
  const sent = await call('POST', `/api/v1/campaigns/${id}/test`, 'uma', { to: 'Me@Example.com' });
  expect(sent.status, JSON.stringify(sent.json)).toBe(200);
  expect(memory.sent).toHaveLength(1);
  expect(memory.sent[0]?.subject).toBe('[Test] Spring news');
  expect(memory.sent[0]?.html).not.toContain('/api/v1/public/campaigns/');
  expect((await call('POST', `/api/v1/campaigns/${id}/test`, 'uma', { to: 'nobody' })).status).toBe(
    400,
  );
});

test('a message that comes back is bounced; an address that never takes mail leaves the lists', async () => {
  memory.sent.length = 0;
  for (const email of ['full@example.com', 'gone@example.com'])
    await make('marketing.subscriber', 'uma', { list: ids['news'], email });
  const id = await make('marketing.campaign', 'uma', {
    name: 'Bounces',
    subject: 'Hello',
    body: '<p>Hello.</p>',
    lists: { set: [ids['news']] },
  });
  expect((await step(id, 'send', 'mia')).status).toBe(200);
  await drain();
  const named = await sql<{ email: string; provider_id: string }>(
    `SELECT email, provider_id FROM marketing_delivery WHERE campaign_id = $1 AND state = 'sent'`,
    [id],
  );
  const idOf = (email: string) => named.find((n) => n.email === email)?.provider_id as string;
  expect(idOf('gone@example.com')).toBeTruthy();
  // What inbound email announces for a delivery report: the ids of the messages it answers.
  const announce = (messageIds: string[], permanent: boolean) =>
    erp.host.server.shutro.bootstrap({ reason: 'test bounce' }, (su) =>
      su.emit('mail.bounced', { messageIds, permanent, subject: 'Undelivered Mail Returned' }),
    );
  await announce([idOf('full@example.com')], false);
  await announce([idOf('gone@example.com'), '<not-ours@elsewhere>'], true);
  await drain();
  const rows = await deliveries(id);
  expect(rows.find((r) => r.email === 'full@example.com')?.state).toBe('bounced');
  expect(rows.find((r) => r.email === 'gone@example.com')?.state).toBe('bounced');
  // Both went out: they count as sent, and as bounced.
  const seen = (await call('GET', `${C}/${id}?fields=sent,bounced`, 'mia')).json as Json;
  expect(seen).toMatchObject({ sent: 4, bounced: 2 });
  // A full mailbox may take the next one; an address that does not exist is never written to again.
  const subscribers = await sql<{ key: string; state: string }>(
    `SELECT key, state FROM marketing_subscriber WHERE key IN ('full@example.com', 'gone@example.com') ORDER BY key`,
  );
  expect(subscribers.map((s) => s.state)).toEqual(['subscribed', 'bounced']);
  const never = await sql<{ reason: string }>(
    `SELECT reason FROM marketing_suppression WHERE key = 'gone@example.com'`,
  );
  expect(never.map((n) => n.reason)).toEqual(['bounced']);
  // The same report again changes nothing.
  await announce([idOf('gone@example.com')], true);
  await drain();
  expect(((await call('GET', `${C}/${id}?fields=bounced`, 'mia')).json as Json).bounced).toBe(2);
});
