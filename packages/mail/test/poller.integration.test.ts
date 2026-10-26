/**
 * The IMAP poller (RFC 0006 §7.1) against a real mail server (GreenMail in a container): messages delivered to
 * the mailbox by SMTP are read once, handed to the handler (a reply posts on the record) and marked seen; a
 * second round finds nothing; the lock keeps one node polling at a time.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chatterContext, messaging } from '@kosh/messaging';
import { defineModule as defineKoshModule } from '@kosh/modules-sdk';
import { base, baseShutro, createServer, installBase, type KoshServer } from '@kosh/server';
import { orm } from '@kosh/server/orm';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import nodemailer from 'nodemailer';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { type InboundContext, mailModule, pollOnce, replyAddress } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const { defineGroup, defineModel, defineModule, f } = orm;
const config = { secret: 'inbound secret', domain: 'mail.padma.test', alias: 'reply' };

const Deal = defineModel('crm.deal', {
  recName: 'name',
  access: { 'crm.user': ['read', 'write', 'create'] },
  fields: { name: f.char({ required: true }) },
});
const crm = defineKoshModule({
  shutro: defineModule({
    name: 'crm',
    version: '0.1.0',
    depends: [baseShutro],
    groups: [defineGroup({ code: 'crm.user', label: 'CRM', implies: ['base.user'] })],
    models: [Deal],
  }),
  kosh: '^0.1.0',
  depends: [base],
  accessLevels: { user: { label: 'User', groups: ['crm.user'] } },
});

let postgres: StartedPostgreSqlContainer;
let greenmail: StartedTestContainer;
let server: KoshServer;
let files: string;
let company: number;
let rahim: number;
let deal: number;
let inbound: InboundContext;
let imap: {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  mailbox: string;
};

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  files = await mkdtemp(join(tmpdir(), 'kosh-poller-'));
  process.env['KOSH_STORAGE_DIR'] = files;
  [postgres, greenmail] = await Promise.all([
    new PostgreSqlContainer('postgres:18').start(),
    new GenericContainer('greenmail/standalone:2.1.2')
      .withEnvironment({
        GREENMAIL_OPTS:
          '-Dgreenmail.setup.test.smtp -Dgreenmail.setup.test.imap -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.auth.disabled',
      })
      .withExposedPorts(3025, 3143)
      .withWaitStrategy(Wait.forListeningPorts())
      .start(),
  ]);
  server = await createServer({
    databaseUrl: postgres.getConnectionUri(),
    modules: [
      crm,
      messaging,
      mailModule({ inbound: config, webhookSecret: 'hook', workers: false }),
    ],
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
  rahim = await auth.createUser({
    login: 'rahim',
    name: 'Rahim Uddin',
    password: PASSWORD,
    company,
    companies: [company],
    groups: ['crm.user', 'messaging.user'],
  });
  await server.shutro.bootstrap({ reason: 'test', company }, async (env) => {
    type Model = { browse(ids: number[]): { write(v: unknown): Promise<void> } };
    const model = (name: string) => env.model(name as never) as unknown as Model;
    await model('res.users').browse([rahim]).write({ email: 'rahim@padma.test' });
  });
  deal = await server.shutro.run(
    { user: rahim, company, companies: [company], groups: ['crm.user'] },
    async (env) => {
      const created = await (
        env.model('crm.deal' as never) as unknown as {
          create(r: unknown[]): Promise<{ ids: number[] }>;
        }
      ).create([{ name: 'Deal A' }]);
      return created.ids[0] as number;
    },
  );
  inbound = {
    shutro: server.shutro,
    driver: server.driver,
    registry: server.registry,
    auth: server.auth,
    config,
    chatter: chatterContext({ registry: server.registry } as never),
  };
  imap = {
    host: greenmail.getHost(),
    port: greenmail.getMappedPort(3143),
    secure: false,
    user: 'reply@mail.padma.test',
    pass: 'reply',
    mailbox: 'INBOX',
  };
}, 300_000);

afterAll(async () => {
  await server?.close();
  await Promise.all([postgres?.stop(), greenmail?.stop()]);
  delete process.env['KOSH_STORAGE_DIR'];
  await rm(files, { recursive: true, force: true });
});

test('unseen messages in the mailbox are received once and marked seen; the next round finds nothing', async () => {
  // Rahim's reply, delivered to the inbound mailbox by SMTP (as a provider would).
  const to = replyAddress(config, { model: 'crm.deal', id: deal, uid: rahim });
  const transport = nodemailer.createTransport({
    host: greenmail.getHost(),
    port: greenmail.getMappedPort(3025),
    secure: false,
    tls: { rejectUnauthorized: false },
  });
  await transport.sendMail({
    from: 'Rahim Uddin <rahim@padma.test>',
    to,
    subject: 'Re: a notification',
    text: 'Seen from the mailbox.\n\nOn Monday, Kosh wrote:\n> ...',
    messageId: '<poll-1@padma.test>',
    envelope: { from: 'rahim@padma.test', to: 'reply@mail.padma.test' },
  });
  const first = await pollOnce(inbound, imap);
  expect(first).not.toBeNull();
  expect(first).toHaveLength(1);
  expect(first?.[0]).toMatchObject({
    state: 'posted',
    model: 'crm.deal',
    resId: deal,
    duplicate: false,
  });
  const second = await pollOnce(inbound, imap);
  expect(second).toEqual([]); // marked seen
  const page = await server.shutro.run(
    { user: rahim, company, companies: [company], groups: ['crm.user', 'messaging.user'] },
    async (env) => {
      const found = await (
        env.model('mail.message' as never) as unknown as {
          search(q: unknown): Promise<{
            load(k: string[]): Promise<{ read(k: string[]): Record<string, unknown>[] }>;
          }>;
        }
      ).search({ where: { resModel: 'crm.deal', resId: deal } });
      return (await found.load(['body', 'author'])).read(['body', 'author']);
    },
  );
  expect(page).toMatchObject([{ body: '<p>Seen from the mailbox.</p>', author: rahim }]);
}, 120_000);

test('the lock: a round that finds the lock taken does nothing', async () => {
  await server.driver.transaction({}, async (conn) => {
    await conn.query({
      text: "SELECT pg_advisory_xact_lock(hashtext('mail.inbound.imap'))",
      params: [],
    });
    expect(await pollOnce(inbound, imap)).toBeNull();
  });
}, 60_000);
