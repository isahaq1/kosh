/**
 * The chatter (RFC 0006 §5.1) on PostgreSQL: messages and notes with mentions and safe bodies, the change log from
 * Shutro's trail (labels, display names, field security), pagination, attachments on S3-compatible storage (here a
 * directory), followers, activities, outbox events — and at every route, a record the caller cannot see is a 404.
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Authenticator, createServer, type KoshServer } from '@isahaq/kosh-server';
import { orm } from '@isahaq/kosh-server/orm';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Chatter, MessageItem } from '../src/index.js';
import { installActivityTypes } from '../src/index.js';
import { crm } from './fixtures/crm.js';

const USERS: Record<string, { user: number; groups: string[] }> = {
  manager: { user: 1, groups: ['crm.manager', 'messaging.user'] },
  alice: { user: 2, groups: ['crm.user', 'messaging.user'] },
  bob: { user: 3, groups: ['crm.user', 'messaging.user'] },
  carol: { user: 4, groups: ['crm.user'] }, // no Messaging access level
};
const authenticate: Authenticator = async (request) => {
  const u = USERS[String(request.headers['x-test-user'])];
  return u === undefined
    ? null
    : { user: u.user, company: 1, companies: [1], groups: u.groups, lang: 'en_US', tz: 'UTC' };
};

let pg: StartedPostgreSqlContainer;
let server: KoshServer;
let files: string;
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
const call = (method: Method, url: string, as: string, body?: unknown) =>
  server.app.inject({
    method,
    url,
    headers: { 'x-test-user': as },
    ...(body === undefined ? {} : { payload: body as object }),
  });
const upload = (as: string, url: string, name: string, type: string, data: string | Buffer) =>
  server.app.inject({
    method: 'POST',
    url,
    headers: {
      ...(as === '' ? {} : { 'x-test-user': as }),
      'content-type': type,
      'x-filename': encodeURIComponent(name),
    },
    payload: data,
  });
const chatter = async (as: string, deal: number, query = ''): Promise<Chatter> => {
  const res = await call('GET', `/api/v1/chatter/crm.deal/${deal}${query}`, as);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as Chatter;
};
const deal = async (as: string, values: Record<string, unknown>): Promise<number> => {
  const res = await call('POST', '/api/v1/models/crm.deal', as, values);
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { id: number }).id;
};
const events = (topic: string) =>
  server.driver.query<{ payload: Record<string, unknown>; uid: string }>({
    text: 'SELECT payload, uid FROM shutro_outbox WHERE topic = $1 ORDER BY id',
    params: [topic],
  });

beforeAll(async () => {
  files = await mkdtemp(join(tmpdir(), 'kosh-chatter-'));
  process.env['KOSH_STORAGE_DIR'] = files;
  process.env['KOSH_ATTACHMENT_MAX_BYTES'] = String(64 * 1024);
  pg = await new PostgreSqlContainer('postgres:18').start();
  server = await createServer({
    databaseUrl: pg.getConnectionUri(),
    modules: [crm],
    authenticate,
    logger: { level: 'error' },
    rateLimit: { max: 0, timeWindow: '1 minute' },
  });
  for (const statement of orm.createTableStatements(server.registry.registry))
    await server.driver.query(statement);
  for (const text of [
    "INSERT INTO res_users (login, name) VALUES ('manager', 'Mina Manager'), ('alice', 'Alice Akter'), ('bob', 'Bob Barua'), ('carol', 'Carol Chowdhury')",
    "INSERT INTO res_currency (name, decimal_places) VALUES ('BDT', 2)",
    "INSERT INTO res_company (name, currency_id) VALUES ('Dhaka Ltd', 1)",
    "INSERT INTO res_partner (name) VALUES ('Acme'), ('Globex')",
  ])
    await server.driver.query({ text, params: [] });
  await server.shutro.bootstrap({ reason: 'install activity types' }, (env) =>
    installActivityTypes(env),
  );
}, 240_000);

afterAll(async () => {
  await server?.close();
  await pg?.stop();
  delete process.env['KOSH_STORAGE_DIR'];
  delete process.env['KOSH_ATTACHMENT_MAX_BYTES'];
  await rm(files, { recursive: true, force: true });
});

describe('change log', () => {
  test('creation, tracked changes with labels and names; restricted fields only for those who may read them', async () => {
    const id = await deal('alice', { name: 'Deal A', partner: 1, amount: '100.00' });
    expect(
      (
        await call('PATCH', `/api/v1/models/crm.deal/${id}`, 'alice', {
          partner: 2,
          amount: '150.50',
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await call('PATCH', `/api/v1/models/crm.deal/${id}`, 'manager', { margin: '12.00' }))
        .statusCode,
    ).toBe(200);
    expect(
      (await call('POST', `/api/v1/models/crm.deal/${id}/transitions/win`, 'alice')).statusCode,
    ).toBe(200);

    const seen = await chatter('alice', id);
    const changes = seen.items.filter((i) => i.type === 'change');
    expect(changes.map((c) => c.action)).toEqual(['write', 'write', 'create']);
    expect(changes[0]).toMatchObject({
      author: { id: 2, name: 'Alice Akter' },
      changes: [
        {
          field: 'state',
          label: 'State',
          old: 'new',
          new: 'won',
          oldLabel: 'New',
          newLabel: 'Won',
        },
      ],
    });
    expect(changes[1]?.changes).toEqual([
      expect.objectContaining({
        field: 'partner',
        old: 1,
        new: 2,
        oldLabel: 'Acme',
        newLabel: 'Globex',
      }),
      expect.objectContaining({ field: 'amount', old: '100', new: '150.5' }), // exact decimals, normalized
    ]);
    // The manager's margin change is invisible to Alice (field security), visible to the manager.
    expect(JSON.stringify(seen)).not.toContain('margin');
    const managerView = await chatter('manager', id);
    const margin = managerView.items.find(
      (i) => i.type === 'change' && i.changes.some((c) => c.field === 'margin'),
    );
    expect(margin).toMatchObject({ author: { name: 'Mina Manager' } });
  });
});

describe('messages', () => {
  test('notes and messages: safe HTML, real names for mentions, the author follows, an outbox event', async () => {
    const id = await deal('alice', { name: 'Deal B' });
    const res = await call('POST', `/api/v1/chatter/crm.deal/${id}/messages`, 'alice', {
      kind: 'comment',
      text: 'Hi @[Boss](user:1), see **this**: https://example.com/x?a=1&b=2\n<script>alert(1)</script>\n\n- one\n- `two`',
    });
    expect(res.statusCode, res.body).toBe(201);
    const message = res.json() as MessageItem;
    expect(message.body).toBe(
      '<p>Hi <span class="mention" data-user="1">@Mina Manager</span>, see <strong>this</strong>: <a href="https://example.com/x?a=1&amp;b=2" target="_blank" rel="noopener noreferrer nofollow">https://example.com/x?a=1&amp;b=2</a><br>&lt;script&gt;alert(1)&lt;/script&gt;</p><ul><li>one</li><li><code>two</code></li></ul>',
    );
    expect(message).toMatchObject({
      kind: 'comment',
      author: { id: 2, name: 'Alice Akter' },
      mentions: [{ id: 1, name: 'Mina Manager' }],
      mine: true,
    });
    const view = await chatter('alice', id);
    expect(view.following).toBe(true);
    expect(view.followers).toEqual([{ id: 2, name: 'Alice Akter' }]);
    expect(view.items[0]).toMatchObject({ type: 'message', id: message.id });
    const [event] = (await events('mail.message.posted')).slice(-1);
    expect(event?.payload).toMatchObject({
      model: 'crm.deal',
      id,
      message: message.id,
      kind: 'comment',
      author: 2,
      mentions: [1],
    });
    expect(String(event?.payload['preview'])).toContain('Hi @Mina Manager, see this');
    // Mentioning an unknown user leaves the text as typed, escaped.
    const ghost = await call('POST', `/api/v1/chatter/crm.deal/${id}/messages`, 'alice', {
      text: 'cc @[<b>Ghost</b>](user:999)',
    });
    expect((ghost.json() as MessageItem).body).toBe('<p>cc @&lt;b&gt;Ghost&lt;/b&gt;</p>');
  });

  test('only the author edits or deletes; others see no source text', async () => {
    const id = await deal('alice', { name: 'Deal C' });
    const posted = (
      await call('POST', `/api/v1/chatter/crm.deal/${id}/messages`, 'alice', { text: 'draft' })
    ).json() as MessageItem;
    expect(posted.kind).toBe('note');
    const managerView = await chatter('manager', id);
    expect(managerView.items[0]).toMatchObject({ id: posted.id, text: null, mine: false });
    expect(
      (await call('PATCH', `/api/v1/chatter/messages/${posted.id}`, 'manager', { text: 'hacked' }))
        .statusCode,
    ).toBe(403);
    const edited = await call('PATCH', `/api/v1/chatter/messages/${posted.id}`, 'alice', {
      text: 'final',
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toMatchObject({ body: '<p>final</p>', text: 'final' });
    expect((edited.json() as MessageItem).editedAt).not.toBeNull();
    expect(
      (await call('DELETE', `/api/v1/chatter/messages/${posted.id}`, 'manager')).statusCode,
    ).toBe(403);
    expect(
      (await call('DELETE', `/api/v1/chatter/messages/${posted.id}`, 'alice')).statusCode,
    ).toBe(204);
    expect((await chatter('alice', id)).items.some((i) => i.type === 'message')).toBe(false);
  });

  test('invalid input is refused', async () => {
    const id = await deal('alice', { name: 'Deal D' });
    const post = (body: unknown) =>
      call('POST', `/api/v1/chatter/crm.deal/${id}/messages`, 'alice', body);
    expect((await post({ text: '' })).statusCode).toBe(400);
    expect((await post({ text: 'x'.repeat(20_001) })).statusCode).toBe(400);
    expect((await post({ text: 'x', kind: 'system' })).statusCode).toBe(400);
    expect((await post({ text: 'x', attachments: ['1'] })).statusCode).toBe(400);
  });

  test('pages: every item once, newest first', async () => {
    const id = await deal('alice', { name: 'Deal E', amount: '1' });
    for (let i = 1; i <= 4; i++) {
      await call('POST', `/api/v1/chatter/crm.deal/${id}/messages`, 'alice', { text: `m${i}` });
      await call('PATCH', `/api/v1/models/crm.deal/${id}`, 'alice', { amount: `${i + 1}` });
    }
    const seen: string[] = [];
    let query = '?limit=3';
    for (let page = 0; page < 10; page++) {
      const view = await chatter('alice', id, query);
      for (const item of view.items)
        seen.push(item.type === 'message' ? `m:${item.id}` : `c:${item.id}`);
      if (view.next === null) break;
      const next = new URLSearchParams({ limit: '3' });
      for (const [k, v] of Object.entries(view.next)) next.set(k, String(v));
      query = `?${next}`;
    }
    expect(seen).toHaveLength(9); // 4 messages, 4 changes, the creation
    expect(new Set(seen).size).toBe(9);
    expect(seen.at(-1)?.startsWith('c:')).toBe(true); // the creation is the oldest
  });
});

describe('access', () => {
  test("a record outside the caller's rules is refused on every chatter route, as by the REST API; no Messaging access is a 403", async () => {
    const id = await deal('alice', { name: 'Private deal' });
    const posted = (
      await call('POST', `/api/v1/chatter/crm.deal/${id}/messages`, 'alice', { text: 'secret' })
    ).json() as MessageItem;
    const file = (
      await upload('alice', `/api/v1/attachments/crm.deal/${id}`, 'a.txt', 'text/plain', 'secret')
    ).json() as { id: number };
    for (const [method, url, body] of [
      ['GET', `/api/v1/chatter/crm.deal/${id}`],
      ['POST', `/api/v1/chatter/crm.deal/${id}/messages`, { text: 'x' }],
      ['POST', `/api/v1/chatter/crm.deal/${id}/followers`, { follow: true }],
      ['POST', `/api/v1/chatter/crm.deal/${id}/activities`, { type: 1, deadline: '2026-11-01' }],
      ['PATCH', `/api/v1/chatter/messages/${posted.id}`, { text: 'x' }],
      ['GET', `/api/v1/attachments/crm.deal/${id}`],
      ['GET', `/api/v1/attachments/${file.id}/download`],
    ] as [Method, string, unknown?][]) {
      const res = await call(method, url, 'bob', body);
      expect(res.statusCode, `${method} ${url}: ${res.body}`).toBe(403);
      expect(res.body).not.toContain('secret');
    }
    const refused = await upload(
      'bob',
      `/api/v1/attachments/crm.deal/${id}`,
      'b.txt',
      'text/plain',
      'x',
    );
    expect(refused.statusCode).toBe(403);
    expect((await call('GET', '/api/v1/chatter/crm.deal/99999', 'alice')).statusCode).toBe(404);
    expect((await call('GET', `/api/v1/chatter/crm.deal/${id}`, 'carol')).statusCode).toBe(403);
    expect((await call('GET', '/api/v1/chatter/res.nothing/1', 'alice')).statusCode).toBe(404);
    // The chatter's models are private: the generated API does not serve them, not even to the manager.
    for (const model of ['mail.message', 'mail.follower', 'mail.activity', 'storage.attachment'])
      expect((await call('GET', `/api/v1/models/${model}`, 'manager')).statusCode).toBe(404);
  });
});

describe('attachments', () => {
  test('upload, list, download as an attachment; attach to a message; deleting the message removes them', async () => {
    const id = await deal('alice', { name: 'Deal F' });
    const json = await upload(
      'alice',
      `/api/v1/attachments/crm.deal/${id}`,
      'দর-প্রস্তাব "v2".json',
      'application/json',
      '{"a":1}',
    );
    expect(json.statusCode, json.body).toBe(201);
    const info = json.json() as { id: number; name: string; mime: string; size: number };
    expect(info).toMatchObject({ name: 'দর-প্রস্তাব "v2".json', mime: 'application/json', size: 7 });
    const got = await call('GET', `/api/v1/attachments/${info.id}/download`, 'alice');
    expect(got.statusCode).toBe(200);
    expect(got.body).toBe('{"a":1}'); // bytes, never parsed
    expect(got.headers['content-type']).toBe('application/octet-stream');
    expect(got.headers['x-content-type-options']).toBe('nosniff');
    expect(String(got.headers['content-disposition'])).toContain('attachment;');
    expect(String(got.headers['content-disposition'])).toContain(
      `filename*=UTF-8''${encodeURIComponent('দর-প্রস্তাব "v2".json')}`,
    );
    const png = (
      await upload(
        'alice',
        `/api/v1/attachments/crm.deal/${id}`,
        'p.png',
        'image/png',
        Buffer.from([137, 80, 78, 71]),
      )
    ).json() as { id: number };
    const inline = await call('GET', `/api/v1/attachments/${png.id}/download?inline=true`, 'alice');
    expect(inline.headers['content-type']).toBe('image/png');
    expect(String(inline.headers['content-disposition'])).toMatch(/^inline;/);
    const html = (
      await upload(
        'alice',
        `/api/v1/attachments/crm.deal/${id}`,
        'x.html',
        'text/html',
        '<script>1</script>',
      )
    ).json() as { id: number };
    const forced = await call(
      'GET',
      `/api/v1/attachments/${html.id}/download?inline=true`,
      'alice',
    );
    expect(forced.headers['content-type']).toBe('application/octet-stream'); // never rendered by the browser

    const listed = await call('GET', `/api/v1/attachments/crm.deal/${id}`, 'alice');
    expect((listed.json() as { attachments: unknown[] }).attachments).toHaveLength(3);
    // Someone else's upload cannot be attached by the manager.
    expect(
      (
        await call('POST', `/api/v1/chatter/crm.deal/${id}/messages`, 'manager', {
          text: 'mine now',
          attachments: [info.id],
        })
      ).statusCode,
    ).toBe(400);
    const message = (
      await call('POST', `/api/v1/chatter/crm.deal/${id}/messages`, 'alice', {
        text: 'files',
        attachments: [info.id, png.id],
      })
    ).json() as MessageItem;
    expect(message.attachments.map((a) => a.id)).toEqual([info.id, png.id]);
    expect(
      (
        await call('POST', `/api/v1/chatter/crm.deal/${id}/messages`, 'alice', {
          text: 'again',
          attachments: [png.id],
        })
      ).statusCode,
    ).toBe(400); // already on another message
    const before = (await readdir(files, { recursive: true })).length;
    expect(
      (await call('DELETE', `/api/v1/chatter/messages/${message.id}`, 'alice')).statusCode,
    ).toBe(204);
    expect((await call('GET', `/api/v1/attachments/${info.id}/download`, 'alice')).statusCode).toBe(
      404,
    );
    expect((await readdir(files, { recursive: true })).length).toBeLessThan(before);
  });

  test('limits: empty, too large, unauthenticated, no Messaging access; only the uploader deletes', async () => {
    const id = await deal('alice', { name: 'Deal G' });
    const url = `/api/v1/attachments/crm.deal/${id}`;
    expect((await upload('alice', url, 'e.txt', 'text/plain', '')).statusCode).toBe(400);
    expect(
      (await upload('alice', url, 'big.bin', 'application/octet-stream', Buffer.alloc(65 * 1024)))
        .statusCode,
    ).toBe(413);
    expect((await upload('', url, 'x.txt', 'text/plain', 'x')).statusCode).toBe(401);
    const carolDeal = await deal('carol', { name: 'Carol deal' });
    expect(
      (
        await upload(
          'carol',
          `/api/v1/attachments/crm.deal/${carolDeal}`,
          'c.txt',
          'text/plain',
          'x',
        )
      ).statusCode,
    ).toBe(403);
    const file = (await upload('alice', url, '../../etc/passwd', 'text/plain', 'x')).json() as {
      id: number;
      name: string;
    };
    expect(file.name).toBe('.._.._etc_passwd');
    expect((await call('DELETE', `/api/v1/attachments/${file.id}`, 'manager')).statusCode).toBe(
      403,
    );
    expect((await call('DELETE', `/api/v1/attachments/${file.id}`, 'alice')).statusCode).toBe(204);
  });
});

describe('followers', () => {
  test('anyone who can read follows themselves; adding others needs write access', async () => {
    const id = await deal('alice', { name: 'Deal H' });
    const follow = (as: string, body: unknown) =>
      call('POST', `/api/v1/chatter/crm.deal/${id}/followers`, as, body);
    expect((await follow('manager', { follow: true })).json()).toEqual({
      followers: [{ id: 1, name: 'Mina Manager' }],
    });
    expect((await follow('alice', { follow: true, user: 3 })).statusCode).toBe(200); // her deal: she writes it
    expect((await chatter('alice', id)).followers.map((f) => f.id)).toEqual([3, 1]);
    expect((await chatter('alice', id)).canManageFollowers).toBe(true);
    expect((await follow('manager', { follow: false })).statusCode).toBe(200);
    expect((await follow('alice', { follow: true, user: 999 })).statusCode).toBe(400);
    expect((await follow('alice', { follow: 'yes' })).statusCode).toBe(400);
  });
});

describe('activities', () => {
  test('schedule for someone, their inbox, complete with feedback (logged), cancel; only those involved', async () => {
    const id = await deal('alice', { name: 'Deal I' });
    const types = (await call('GET', '/api/v1/activities/types', 'alice')).json() as {
      types: { id: number; name: string }[];
    };
    expect(types.types.map((t) => t.name)).toEqual([
      'To-do',
      'Call',
      'Meeting',
      'Email',
      'Upload document',
    ]);
    const call_ = types.types[1] as { id: number };
    const planned = await call('POST', `/api/v1/chatter/crm.deal/${id}/activities`, 'alice', {
      type: call_.id,
      summary: 'Discuss price',
      deadline: '2026-11-02',
      assignee: 1,
    });
    expect(planned.statusCode, planned.body).toBe(201);
    const activity = planned.json() as { id: number };
    expect(planned.json()).toMatchObject({
      type: { name: 'Call', icon: 'phone' },
      assignee: { id: 1, name: 'Mina Manager' },
      deadline: '2026-11-02',
      mine: true,
    });
    const [assigned] = (await events('mail.activity.assigned')).slice(-1);
    expect(assigned?.payload).toMatchObject({ model: 'crm.deal', id, assignee: 1, by: 2 });

    const inbox = (await call('GET', '/api/v1/activities/mine', 'manager')).json() as {
      activities: { id: number; record: string; model: string }[];
    };
    expect(inbox.activities).toContainEqual(
      expect.objectContaining({ id: activity.id, record: 'Deal I', model: 'crm.deal' }),
    );
    expect((await chatter('alice', id)).activities.map((a) => a.id)).toEqual([activity.id]);
    expect(
      (await call('POST', `/api/v1/activities/${activity.id}/done`, 'bob', {})).statusCode,
    ).toBe(403);

    const done = await call('POST', `/api/v1/activities/${activity.id}/done`, 'manager', {
      feedback: 'Agreed on 5% off.',
    });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json()).toMatchObject({
      kind: 'activity',
      author: { name: 'Mina Manager' },
      body: '<p><strong>Call done</strong>: Discuss price</p><p>Agreed on 5% off.</p>',
    });
    expect(
      (await call('POST', `/api/v1/activities/${activity.id}/done`, 'manager', {})).statusCode,
    ).toBe(409);
    expect((await chatter('alice', id)).activities).toEqual([]);

    const todo = (
      await call('POST', `/api/v1/chatter/crm.deal/${id}/activities`, 'alice', {
        type: (types.types[0] as { id: number }).id,
        deadline: '2026-11-05',
      })
    ).json() as { id: number; assignee: { id: number } };
    expect(todo.assignee.id).toBe(2); // the caller by default
    expect(
      (await call('PATCH', `/api/v1/activities/${todo.id}`, 'manager', { deadline: '2026-11-09' }))
        .statusCode,
    ).toBe(403);
    expect(
      (await call('PATCH', `/api/v1/activities/${todo.id}`, 'alice', { deadline: '2026-11-09' }))
        .statusCode,
    ).toBe(204);
    expect(
      (
        await call('POST', `/api/v1/chatter/crm.deal/${id}/activities`, 'alice', {
          type: 1,
          deadline: 'soon',
        })
      ).statusCode,
    ).toBe(400);
    expect((await call('DELETE', `/api/v1/activities/${todo.id}`, 'alice')).statusCode).toBe(204);
    expect((await chatter('alice', id)).activities).toEqual([]);
  });
});
