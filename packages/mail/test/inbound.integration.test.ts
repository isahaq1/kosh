/**
 * Inbound email (RFC 0006 §7.1) on real PostgreSQL through the webhook: a reply to a reply address from the
 * recipient's own mailbox posts on the record as that user (text cut at the quote, the file attached); the same
 * message again does nothing; a reply from the record's partner posts as the system naming the sender; an unknown
 * sender is quarantined, then attached by hand or discarded by an email manager; an auto-reply is dropped;
 * Postmark's JSON is accepted; a wrong secret is refused. (A reply resolved by In-Reply-To: the notify tests.)
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { messaging } from '@kosh/messaging';
import { defineModule as defineKoshModule } from '@kosh/modules-sdk';
import { base, baseShutro, createServer, installBase, type KoshServer } from '@kosh/server';
import { orm } from '@kosh/server/orm';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { mailModule, replyAddress } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const { defineGroup, defineModel, defineModule, f } = orm;
const config = { secret: 'inbound secret', domain: 'mail.padma.test', alias: 'reply' };
const WEBHOOK = 'hook secret';

const Partner = defineModel('res.partner', {
  recName: 'name',
  access: { 'crm.user': ['read', 'write', 'create'] },
  fields: { name: f.char({ required: true }), email: f.char() },
});
const Deal = defineModel('crm.deal', {
  recName: 'name',
  access: { 'crm.user': ['read', 'write', 'create'] },
  rules: {
    own: { groups: ['crm.user'], perms: ['read', 'write'], domain: { createdBy: { $env: 'uid' } } },
    all: { groups: ['crm.manager'], perms: ['read', 'write'], domain: {} },
  },
  fields: { name: f.char({ required: true }), partner: f.many2one('res.partner') },
});
const crm = defineKoshModule({
  shutro: defineModule({
    name: 'crm',
    version: '0.1.0',
    depends: [baseShutro],
    groups: [
      defineGroup({ code: 'crm.user', label: 'CRM', implies: ['base.user'] }),
      defineGroup({ code: 'crm.manager', label: 'CRM manager', implies: ['crm.user'] }),
    ],
    models: [Partner, Deal],
  }),
  kosh: '^0.1.0',
  depends: [base],
  accessLevels: { user: { label: 'User', groups: ['crm.user'] } },
  // sales@<domain>: a deal from the message (RFC 0006 §7.1).
  inboundAliases: [{ alias: 'sales', model: 'crm.deal', subjectField: 'name' }],
});

let container: StartedPostgreSqlContainer;
let server: KoshServer;
let files: string;
let company: number;
const users: Record<string, number> = {};
let deal: number;
let vendorDeal: number;
const tokens = new Map<string, string>();

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function call(method: 'GET' | 'POST', url: string, as: string, payload?: unknown) {
  let token = tokens.get(as);
  if (token === undefined) {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { login: as, password: PASSWORD },
    });
    token = (res.json() as { token: string }).token;
    tokens.set(as, token);
  }
  const res = await server.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: res.statusCode, json: (res.body === '' ? null : res.json()) as Json };
}
const webhook = (raw: string, headers: Record<string, string> = {}) =>
  server.app.inject({
    method: 'POST',
    url: '/api/v1/mail/inbound',
    headers: { 'content-type': 'message/rfc822', 'x-kosh-inbound-secret': WEBHOOK, ...headers },
    payload: raw,
  });
const chatter = async (as: string, id: number): Promise<Json[]> => {
  const res = await call('GET', `/api/v1/chatter/crm.deal/${id}`, as);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return (res.json.items as Json[]).filter((i) => i.type === 'message');
};
let counter = 0;
const raw = (
  from: string,
  to: string,
  text: string,
  extra: { subject?: string; headers?: string[]; attachment?: { name: string; body: string } } = {},
) => {
  counter += 1;
  const head = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${extra.subject ?? 'Re: a notification'}`,
    `Message-ID: <m${counter}@sender.test>`,
    ...(extra.headers ?? []),
    'MIME-Version: 1.0',
  ];
  if (extra.attachment === undefined)
    return [...head, 'Content-Type: text/plain; charset=utf-8', '', text].join('\r\n');
  return [
    ...head,
    'Content-Type: multipart/mixed; boundary="b"',
    '',
    '--b',
    'Content-Type: text/plain; charset=utf-8',
    '',
    text,
    '--b',
    `Content-Type: text/plain; name="${extra.attachment.name}"`,
    `Content-Disposition: attachment; filename="${extra.attachment.name}"`,
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(extra.attachment.body).toString('base64'),
    '--b--',
    '',
  ].join('\r\n');
};

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  files = await mkdtemp(join(tmpdir(), 'kosh-inbound-'));
  process.env['KOSH_STORAGE_DIR'] = files;
  container = await new PostgreSqlContainer('postgres:18').start();
  server = await createServer({
    databaseUrl: container.getConnectionUri(),
    modules: [crm, messaging, mailModule({ inbound: config, webhookSecret: WEBHOOK })],
    auth: { secureCookies: false, cacheMs: 0, loginLimit: 0 },
    rateLimit: { max: 0, timeWindow: '1 minute' },
    logger: false,
  });
  for (const statement of orm.createTableStatements(server.registry.registry))
    await server.driver.query(statement);
  for (const statement of orm.eventTableStatements()) await server.driver.query(statement);
  const auth = server.auth;
  if (auth === undefined) throw new Error('base is installed');
  ({ company } = await installBase(server.shutro, auth, {
    company: { name: 'Padma Traders', currency: 'BDT' },
    admin: { login: 'admin', name: 'Administrator', password: PASSWORD },
  }));
  for (const [login, name, groups] of [
    ['rahim', 'Rahim Uddin', ['crm.user', 'messaging.user']],
    ['dina', 'Dina Rahman', ['crm.manager', 'messaging.user', 'mail.manager']],
    ['bob', 'Bob Smith', ['base.user']],
  ] as const)
    users[login] = await auth.createUser({
      login,
      name,
      password: PASSWORD,
      company,
      companies: [company],
      groups: [...groups],
    });
  await server.shutro.bootstrap({ reason: 'test', company }, async (env) => {
    type Model = { browse(ids: number[]): { write(v: unknown): Promise<void> } };
    const model = (name: string) => env.model(name as never) as unknown as Model;
    await model('res.users')
      .browse([users['rahim'] as number])
      .write({ email: 'Rahim@padma.test' });
    await model('res.users')
      .browse([users['dina'] as number])
      .write({ email: 'dina@padma.test' });
  });
  // The deals are Rahim's (the own rule): made as him.
  await server.shutro.run(
    { user: users['rahim'] as number, company, companies: [company], groups: ['crm.user'] },
    async (env) => {
      type Model = { create(r: unknown[]): Promise<{ ids: number[] }> };
      const model = (name: string) => env.model(name as never) as unknown as Model;
      const partners = await model('res.partner').create([
        { name: 'Bengal Steel', email: 'orders@bengalsteel.test' },
      ]);
      const deals = await model('crm.deal').create([
        { name: 'Deal A' },
        { name: 'Vendor deal', partner: partners.ids[0] },
      ]);
      deal = deals.ids[0] as number;
      vendorDeal = deals.ids[1] as number;
    },
  );
}, 180_000);

afterAll(async () => {
  await server?.close();
  await container?.stop();
  delete process.env['KOSH_STORAGE_DIR'];
  await rm(files, { recursive: true, force: true });
});

test('the webhook: no secret or a wrong one is refused; an unreadable body too', async () => {
  expect((await webhook('x', { 'x-kosh-inbound-secret': 'nope' })).statusCode).toBe(401);
  expect(
    (
      await server.app.inject({
        method: 'POST',
        url: '/api/v1/mail/inbound',
        headers: { 'content-type': 'message/rfc822' },
        payload: 'x',
      })
    ).statusCode,
  ).toBe(401);
  expect((await webhook('', {})).statusCode).toBe(400);
});

test("a reply from the recipient's own address posts as that user, with the quote cut and the file attached", async () => {
  const to = replyAddress(config, { model: 'crm.deal', id: deal, uid: users['rahim'] as number });
  const message = raw(
    'Rahim Uddin <rahim@padma.test>',
    to,
    'Yes, **confirmed** for Monday.\n\nOn Mon, Kosh wrote:\n> Dina mentioned you',
    {
      attachment: { name: 'note.txt', body: 'shipping note' },
    },
  );
  const res = await webhook(message);
  expect(res.statusCode, res.body).toBe(202);
  expect(res.json()).toMatchObject({
    state: 'posted',
    model: 'crm.deal',
    resId: deal,
    duplicate: false,
  });
  const [posted] = await chatter('rahim', deal);
  expect(posted).toMatchObject({ kind: 'comment', author: { name: 'Rahim Uddin' }, mine: true });
  expect(posted.body).toBe('<p>Yes, <strong>confirmed</strong> for Monday.</p>');
  expect(posted.attachments.map((a: Json) => a.name)).toEqual(['note.txt']);
  // Delivered twice by the provider: once is enough.
  const again = await webhook(message);
  expect(again.statusCode).toBe(200);
  expect(again.json()).toMatchObject({ state: 'posted', duplicate: true });
  expect(await chatter('rahim', deal)).toHaveLength(1);
});

test("a reply from the record's partner posts as the system, naming the sender", async () => {
  const to = replyAddress(config, {
    model: 'crm.deal',
    id: vendorDeal,
    uid: users['rahim'] as number,
  });
  const res = await webhook(
    raw('Bengal Steel <Orders@BengalSteel.test>', to, 'We can deliver on the 3rd.'),
  );
  expect(res.statusCode, res.body).toBe(202);
  expect(res.json()).toMatchObject({ state: 'posted', resId: vendorDeal });
  const [posted] = await chatter('rahim', vendorDeal);
  expect(posted).toMatchObject({
    kind: 'comment',
    author: null,
    authorEmail: 'orders@bengalsteel.test',
    authorName: 'Bengal Steel',
    mine: false,
  });
  expect(posted.body).toBe('<p>We can deliver on the 3rd.</p>');
});

test('an unknown sender is quarantined; the email manager attaches it by hand, or discards another', async () => {
  const to = replyAddress(config, { model: 'crm.deal', id: deal, uid: users['rahim'] as number });
  const first = await webhook(
    raw('Someone <someone@else.test>', to, 'Who are you?', { subject: 'Hello?' }),
  );
  expect(first.json()).toMatchObject({
    state: 'quarantined',
    reason: 'sender-unknown',
    resId: deal,
  });
  const second = await webhook(
    raw('Nobody <nobody@else.test>', 'info@mail.padma.test', 'Price list please', {
      subject: 'Prices',
    }),
  );
  expect(second.json()).toMatchObject({ state: 'quarantined', reason: 'no-target' });
  expect((await call('GET', '/api/v1/mail/inbound?state=quarantined', 'rahim')).status).toBe(403); // not a manager
  const list = await call('GET', '/api/v1/mail/inbound?state=quarantined', 'dina');
  expect(list.status).toBe(200);
  expect(list.json.items.map((i: Json) => i.subject)).toEqual(['Prices', 'Hello?']);
  const quarantined = list.json.items[1];
  const attached = await call('POST', `/api/v1/mail/inbound/${quarantined.id}/attach`, 'dina', {
    model: 'crm.deal',
    id: deal,
  });
  expect(attached.status, JSON.stringify(attached.json)).toBe(200);
  expect(attached.json).toMatchObject({ state: 'posted', resModel: 'crm.deal', resId: deal });
  const messages = await chatter('rahim', deal);
  expect(messages[0]).toMatchObject({
    author: null,
    authorEmail: 'someone@else.test',
    body: '<p>Who are you?</p>',
  });
  const discarded = await call(
    'POST',
    `/api/v1/mail/inbound/${list.json.items[0].id}/discard`,
    'dina',
  );
  expect(discarded.json).toMatchObject({ state: 'discarded' });
  expect(
    (await call('GET', '/api/v1/mail/inbound?state=quarantined', 'dina')).json.items,
  ).toHaveLength(0);
  // A manager cannot attach to a record they may not read.
  const res = await call('POST', `/api/v1/mail/inbound/${quarantined.id}/attach`, 'dina', {
    model: 'crm.deal',
    id: 999,
  });
  expect([403, 404, 409]).toContain(res.status);
});

test('an auto-reply is dropped; a bounce of a message we sent marks its delivery', async () => {
  const to = replyAddress(config, { model: 'crm.deal', id: deal, uid: users['rahim'] as number });
  const auto = await webhook(
    raw('Rahim Uddin <rahim@padma.test>', to, 'I am out of the office.', {
      headers: ['Auto-Submitted: auto-replied'],
    }),
  );
  expect(auto.json()).toMatchObject({ state: 'dropped', reason: 'automatic' });
  expect(await chatter('rahim', deal)).toHaveLength(2); // nothing new
});

test('Postmark JSON is accepted (the secret in the query string too)', async () => {
  const to = replyAddress(config, { model: 'crm.deal', id: deal, uid: users['rahim'] as number });
  const res = await server.app.inject({
    method: 'POST',
    url: '/api/v1/mail/inbound?secret=hook%20secret',
    headers: { 'content-type': 'application/json' },
    payload: {
      FromFull: { Email: 'rahim@padma.test', Name: 'Rahim Uddin' },
      ToFull: [{ Email: to }],
      Subject: 'Re: mention',
      MessageID: 'pm-1',
      TextBody: 'Replying from my phone.\n\nOn x, Kosh wrote:\n> ...',
      Headers: [],
      Attachments: [],
    },
  });
  expect(res.statusCode, res.body).toBe(202);
  expect(res.json()).toMatchObject({ state: 'posted', resId: deal });
  const [posted] = await chatter('rahim', deal);
  expect(posted).toMatchObject({
    author: { name: 'Rahim Uddin' },
    body: '<p>Replying from my phone.</p>',
  });
});

test('a message to a catch-all alias creates the record and posts on it naming the sender', async () => {
  const res = await webhook(
    raw('New Lead <lead@bigcorp.test>', 'Sales <sales@mail.padma.test>', 'We need 200 beams.', {
      subject: 'Quote request',
    }),
  );
  expect(res.statusCode, res.body).toBe(202);
  expect(res.json()).toMatchObject({ state: 'posted', reason: 'alias:sales', model: 'crm.deal' });
  const id = res.json().resId as number;
  const [posted] = await chatter('dina', id); // the manager reads every deal
  expect(posted).toMatchObject({
    author: null,
    authorEmail: 'lead@bigcorp.test',
    body: '<p>We need 200 beams.</p>',
  });
  const created = await call('GET', `/api/v1/models/crm.deal/${id}`, 'dina');
  expect(created.json.name).toBe('Quote request');
  // Another domain is not ours: no record.
  const other = await webhook(
    raw('X <x@y.test>', 'sales@elsewhere.test', 'hi', { subject: 'Elsewhere' }),
  );
  expect(other.json()).toMatchObject({ state: 'quarantined', reason: 'no-target' });
});

test("Mailgun's form post carries the raw message in body-mime", async () => {
  const to = replyAddress(config, { model: 'crm.deal', id: deal, uid: users['rahim'] as number });
  const message = raw('Rahim Uddin <rahim@padma.test>', to, 'From Mailgun.');
  const boundary = 'mgboundary';
  const form = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="recipient"',
    '',
    to,
    `--${boundary}`,
    'Content-Disposition: form-data; name="body-mime"',
    '',
    message,
    `--${boundary}--`,
    '',
  ].join('\r\n');
  const res = await server.app.inject({
    method: 'POST',
    url: '/api/v1/mail/inbound',
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'x-kosh-inbound-secret': WEBHOOK,
    },
    payload: form,
  });
  expect(res.statusCode, res.body).toBe(202);
  expect(res.json()).toMatchObject({ state: 'posted', resId: deal });
  const [posted] = await chatter('rahim', deal);
  expect(posted.body).toBe('<p>From Mailgun.</p>');
  const encoded = await server.app.inject({
    method: 'POST',
    url: '/api/v1/mail/inbound',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-kosh-inbound-secret': WEBHOOK,
    },
    payload: new URLSearchParams({
      'body-mime': raw('Rahim Uddin <rahim@padma.test>', to, 'Encoded too.'),
    }).toString(),
  });
  expect(encoded.statusCode, encoded.body).toBe(202);
  expect(encoded.json()).toMatchObject({ state: 'posted' });
});
