/**
 * The email channel on real PostgreSQL and a real SMTP server (Mailpit in a container): a notification whose
 * recipient wants email gets one delivery and one job; the job sends the email in the recipient's language with a
 * link that opens the record, and marks the delivery sent; a recipient without an address or with email switched
 * off gets none; a provider failure is recorded and retried.
 */
import { createMemoryMailer, createSmtpMailer, type Mailer, replyAddress } from '@kosh/mail';
import { defineModule as defineKoshModule } from '@kosh/modules-sdk';
import { base, baseShutro, createServer, installBase, type KoshServer } from '@kosh/server';
import { type Env, orm } from '@kosh/server/orm';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { deliveryWorker, inboxWorkers, notify, renderEmail } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const { defineGroup, defineModel, defineModule, f } = orm;

const Book = defineModel('library.book', {
  recName: 'title',
  access: { 'library.user': ['read', 'write', 'create'] },
  fields: { title: f.char({ required: true }) },
});
const library = defineKoshModule({
  shutro: defineModule({
    name: 'library',
    version: '1.0.0',
    depends: [baseShutro],
    groups: [defineGroup({ code: 'library.user', label: 'Library', implies: ['base.user'] })],
    models: [Book],
  }),
  kosh: '^0.1.0',
  depends: [base],
  accessLevels: { user: { label: 'User', groups: ['library.user'] } },
});

let postgres: StartedPostgreSqlContainer;
let mailpit: StartedTestContainer;
let server: KoshServer;
let mailer: Mailer;
const users: Record<string, number> = {};
let company: number;
let book: number;

async function emitAndRun(
  mailerUsed: Mailer | undefined,
  payload: unknown,
  replyTo?: (target: { model: string; id: number; uid: number }) => string,
) {
  const context = {
    shutro: server.shutro,
    driver: server.driver,
    registry: server.registry,
    auth: server.auth,
    ...(mailerUsed === undefined ? {} : { mailer: mailerUsed }),
    baseUrl: 'https://erp.example.com/',
    ...(replyTo === undefined ? {} : { replyAddress: replyTo }),
  };
  const inbox = inboxWorkers(context);
  const delivery = deliveryWorker(context);
  for (const w of inbox) await w.drain(); // cursors
  await server.shutro.run({ user: users['rahim'] as number, company }, (env: Env) =>
    env.emit('mail.message.posted', payload),
  );
  for (const w of inbox) await w.drain();
  const sent = await delivery.drain();
  return { sent, delivery };
}

const mention = (who: number, preview: string) => ({
  model: 'library.book',
  id: book,
  message: 1,
  kind: 'comment',
  author: users['rahim'],
  mentions: [who],
  preview,
});

async function mailpitMessages(): Promise<{ Subject: string; To: { Address: string }[] }[]> {
  const res = await fetch(
    `http://${mailpit.getHost()}:${mailpit.getMappedPort(8025)}/api/v1/messages`,
  );
  return ((await res.json()) as { messages: { Subject: string; To: { Address: string }[] }[] })
    .messages;
}

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  [postgres, mailpit] = await Promise.all([
    new PostgreSqlContainer('postgres:18').start(),
    new GenericContainer('axllent/mailpit:latest')
      .withExposedPorts(1025, 8025)
      .withWaitStrategy(Wait.forListeningPorts())
      .start(),
  ]);
  mailer = createSmtpMailer({
    url: `smtp://${mailpit.getHost()}:${mailpit.getMappedPort(1025)}`,
    from: 'Kosh <kosh@example.com>',
  });
  server = await createServer({
    databaseUrl: postgres.getConnectionUri(),
    modules: [library, notify],
    auth: { secureCookies: false, cacheMs: 0, loginLimit: 0 },
    rateLimit: { max: 0, timeWindow: '1 minute' },
    logger: false,
  });
  for (const statement of orm.createTableStatements(server.registry.registry))
    await server.driver.query(statement);
  const auth = server.auth;
  if (auth === undefined) throw new Error('base is installed');
  company = (
    await installBase(server.shutro, auth, {
      company: { name: 'Padma Traders', currency: 'BDT' },
      admin: { login: 'admin', name: 'Administrator', password: PASSWORD },
    })
  ).company;
  for (const [login, name] of [
    ['rahim', 'Rahim Uddin'],
    ['dina', 'Dina Rahman'],
    ['karim', 'Karim Mia'],
  ] as const)
    users[login] = await auth.createUser({
      login,
      name,
      password: PASSWORD,
      company,
      companies: [company],
      groups: ['library.user'],
    });
  book = await server.shutro.bootstrap({ reason: 'test', company }, async (env) => {
    const u = env.model('res.users' as never) as unknown as {
      browse(ids: number[]): { write(v: unknown): Promise<void> };
    };
    await u.browse([users['dina'] as number]).write({ email: 'dina@example.com', lang: 'bn_BD' });
    // karim has no email address
    const created = await (
      env.model('library.book' as never) as unknown as {
        create(r: unknown[]): Promise<{ ids: number[] }>;
      }
    ).create([{ title: 'Padma Nadir Majhi' }]);
    return created.ids[0] as number;
  });
}, 180_000);

afterAll(async () => {
  await server?.close();
  await Promise.all([postgres?.stop(), mailpit?.stop()]);
});

test('renders in the recipient language with a link that opens the record', () => {
  const mail = renderEmail(
    { baseUrl: 'https://erp.example.com' },
    { name: 'Dina', lang: 'bn_BD' },
    {
      kind: 'mention',
      params: { actor: 'Rahim Uddin', record: 'Padma Nadir Majhi', preview: 'Look' },
      model: 'library.book',
      resId: 7,
    },
  );
  expect(mail.subject).toBe('Rahim Uddin আপনাকে Padma Nadir Majhi-এ উল্লেখ করেছেন');
  expect(mail.html).toContain('https://erp.example.com/open/library.book/7');
  expect(mail.html).toContain('lang="bn"');
  expect(mail.text).toContain('“Look”');
});

test('a mention becomes an email through SMTP, and the delivery is marked sent', async () => {
  const { sent } = await emitAndRun(
    mailer,
    mention(users['dina'] as number, 'Have a look at this one'),
  );
  expect(sent).toBe(1);
  const messages = await mailpitMessages();
  expect(messages).toHaveLength(1);
  expect(messages[0]?.To[0]?.Address).toBe('dina@example.com');
  expect(messages[0]?.Subject).toContain('Rahim Uddin');
  const deliveries = await server.driver.query<{ state: string; provider_id: string | null }>({
    text: 'SELECT state, provider_id FROM notify_delivery ORDER BY id',
    params: [],
  });
  expect(deliveries).toEqual([{ state: 'sent', provider_id: expect.any(String) }]);
});

test('no address, or email switched off: no delivery', async () => {
  await emitAndRun(mailer, mention(users['karim'] as number, 'no address'));
  await server.shutro.bootstrap({ reason: 'test', company }, async (env) => {
    await (
      env.model('notify.preference' as never) as unknown as {
        create(r: unknown[]): Promise<unknown>;
      }
    ).create([{ user: users['dina'], kind: 'mention', channel: 'email', enabled: false }]);
  });
  await emitAndRun(mailer, mention(users['dina'] as number, 'switched off'));
  const [count] = await server.driver.query<{ n: string }>({
    text: 'SELECT count(*)::text AS n FROM notify_delivery',
    params: [],
  });
  expect(count?.n).toBe('1'); // still only the first one
  expect(await mailpitMessages()).toHaveLength(1);
  // the in-app notifications exist regardless
  const [inapp] = await server.driver.query<{ n: string }>({
    text: 'SELECT count(*)::text AS n FROM notify_notification',
    params: [],
  });
  expect(inapp?.n).toBe('3');
});

test('a provider failure is recorded and retried later', async () => {
  await server.shutro.bootstrap({ reason: 'test', company }, async (env) => {
    const prefs = env.model('notify.preference' as never) as unknown as {
      search(q: unknown): Promise<{ unlink(): Promise<void> }>;
    };
    await (await prefs.search({ where: { user: users['dina'] } })).unlink();
  });
  const broken: Mailer = {
    name: 'broken',
    from: 'x',
    send: async () => {
      throw new Error('SMTP down');
    },
  };
  const { sent } = await emitAndRun(broken, mention(users['dina'] as number, 'retry me'));
  expect(sent).toBe(1); // handled (unsuccessfully)
  const [failed] = await server.driver.query<{ state: string; attempts: number; error: string }>({
    text: 'SELECT state, attempts, error FROM notify_delivery ORDER BY id DESC LIMIT 1',
    params: [],
  });
  expect(failed).toMatchObject({ state: 'failed', attempts: 1, error: 'SMTP down' });
  const [job] = await server.driver.query<{ state: string; attempts: number }>({
    text: "SELECT state, attempts FROM shutro_job WHERE name = 'notify.deliver' ORDER BY id DESC LIMIT 1",
    params: [],
  });
  expect(job?.state).not.toBe('done'); // Shutro keeps it for a retry (backoff)
  // A memory mailer shows what the retry would send.
  const memory = createMemoryMailer();
  const mail = renderEmail(
    { baseUrl: 'http://x' },
    { name: 'D', lang: 'en_US' },
    {
      kind: 'approval.decided',
      params: { actor: 'Maria', record: 'PO 1', state: 'rejected' },
      model: 'purchase.order',
      resId: 1,
    },
  );
  await memory.send({ to: 'a@b', subject: mail.subject, text: mail.text, html: mail.html });
  expect(memory.sent[0]?.subject).toBe('Maria rejected PO 1');
});

test('with replies by email configured, a record email carries the signed reply address (RFC 0006 §7.1)', async () => {
  const memory = createMemoryMailer();
  const config = { secret: 'top secret', domain: 'mail.padma.test', alias: 'reply' };
  const { sent } = await emitAndRun(
    memory,
    mention(users['dina'] as number, 'Reply to this one'),
    (t) => replyAddress(config, t),
  );
  expect(sent).toBe(1);
  expect(memory.sent[0]?.replyTo).toBe(
    replyAddress(config, { model: 'library.book', id: book, uid: users['dina'] as number }),
  );
});
