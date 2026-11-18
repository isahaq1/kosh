/**
 * Password reset by email (RFC 0034 §2.4) on real PostgreSQL: asking never says whether an account exists; a known
 * account gets a link that works once, within the hour, and the latest link is the only one; the new password signs
 * in and the old one does not; every device is signed out; an account asks at most three times an hour; each step
 * is in the audit log.
 */
import type { Mailer } from '@kosh/mail';
import { base, createServer, installBase, type KoshServer } from '@kosh/server';
import { orm } from '@kosh/server/orm';
import { type TestDatabase, testDatabase } from '@kosh/server/testing';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { settingsModule } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const NEW_PASSWORD = 'a brand new long password';
const LOGIN = 'rumi@padma.test';
const sent: { to: string; subject: string; html?: string; text?: string }[] = [];
const mailer = {
  async send(message: { to: string; subject: string }) {
    sent.push(message);
  },
} as unknown as Mailer;

let container: TestDatabase;
let server: KoshServer;

const post = async (url: string, payload: unknown, token?: string) => {
  const res = await server.app.inject({
    method: 'POST',
    url,
    payload: payload as Record<string, unknown>,
    ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
  });
  return {
    status: res.statusCode,
    json: res.body === '' ? null : (res.json() as Record<string, unknown>),
  };
};
const signIn = (password: string) => post('/api/v1/auth/login', { login: LOGIN, password });
const forgot = (login: string) => post('/api/v1/auth/password/forgot', { login });
/** The reset link of the latest email. */
const linkOf = (): string => {
  const found = /https:\/\/erp\.example\.test\/reset\?token=([\w-]{40,})/.exec(
    JSON.stringify(sent.at(-1)),
  );
  if (found === null) throw new Error(`no reset link in ${JSON.stringify(sent.at(-1))}`);
  return found[1] as string;
};

beforeAll(async () => {
  container = await testDatabase();
  server = await createServer({
    databaseUrl: container.getConnectionUri(),
    modules: [base, settingsModule({ baseUrl: 'https://erp.example.test', mailer })],
    auth: { secureCookies: false, cacheMs: 0, loginLimit: 0 },
    rateLimit: { max: 0, timeWindow: '1 minute' },
    logger: false,
  });
  for (const statement of orm.createTableStatements(server.registry.registry))
    await server.driver.query(statement);
  const auth = server.auth;
  if (auth === undefined) throw new Error('base is installed');
  const { company } = await installBase(server.shutro, auth, {
    company: { name: 'Padma Traders', currency: 'BDT' },
    admin: { login: 'admin', name: 'Administrator', password: PASSWORD },
  });
  await auth.createUser({
    login: LOGIN,
    name: 'Rumi',
    password: PASSWORD,
    company,
    companies: [company],
    groups: ['base.user'],
  });
}, 180_000);

afterAll(async () => {
  await server?.close();
  await container?.stop();
});

test('asking for an account that does not exist answers the same, and sends nothing', async () => {
  const unknown = await forgot('nobody@padma.test');
  expect(unknown).toEqual({ status: 200, json: { ok: true } });
  expect((await forgot('')).json).toEqual({ ok: true });
  expect(sent).toHaveLength(0);
});

test('a known account gets a link; the latest one is the only one that works', {
  retry: 0,
}, async () => {
  expect(await forgot(LOGIN)).toEqual({ status: 200, json: { ok: true } });
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ to: LOGIN, subject: 'Reset your Shutro ERP password' });
  const first = linkOf();
  // Asked again (in another case of letters): the first link stops working.
  await forgot('Rumi@Padma.test');
  expect(sent).toHaveLength(2);
  const second = linkOf();
  expect(second).not.toBe(first);
  const replaced = await post('/api/v1/auth/password/reset', {
    token: first,
    password: NEW_PASSWORD,
  });
  expect(replaced.status).toBe(410);
  expect(replaced.json?.['type']).toContain('reset-invalid');
  // The old password still signs in: nothing changed by asking.
  expect((await signIn(PASSWORD)).status).toBe(200);
});

test('the link sets the new password once, and signs every device out', { retry: 0 }, async () => {
  const before = await signIn(PASSWORD);
  const session = String(before.json?.['token']);
  const me = () =>
    server.app.inject({
      method: 'GET',
      url: '/api/v1/auth/profile',
      headers: { authorization: `Bearer ${session}` },
    });
  expect((await me()).statusCode).toBe(200);

  const token = linkOf();
  const short = await post('/api/v1/auth/password/reset', { token, password: 'too short' });
  expect(short.status).toBeGreaterThanOrEqual(400);
  expect(short.status).toBeLessThan(500);
  const done = await post('/api/v1/auth/password/reset', { token, password: NEW_PASSWORD });
  expect(done, JSON.stringify(done.json)).toEqual({ status: 200, json: { login: LOGIN } });

  expect((await signIn(PASSWORD)).status).toBe(401);
  expect((await signIn(NEW_PASSWORD)).status).toBe(200);
  // The device signed in before the reset is signed out.
  expect((await me()).statusCode).toBe(401);
  // Once: the same link does nothing more.
  const again = await post('/api/v1/auth/password/reset', {
    token,
    password: 'another long password',
  });
  expect(again.status).toBe(410);
  expect((await signIn(NEW_PASSWORD)).status).toBe(200);
  // The person is told their password changed.
  expect(sent.at(-1)).toMatchObject({ to: LOGIN, subject: 'Your Shutro ERP password was changed' });
});

test('an account asks three times an hour; a link older than the hour does not work', {
  retry: 0,
}, async () => {
  const before = sent.length; // two links were asked for above
  await forgot(LOGIN);
  expect(sent.length).toBe(before + 1);
  const third = linkOf();
  await forgot(LOGIN);
  await forgot(LOGIN);
  expect(sent.length).toBe(before + 1); // the fourth and fifth are not sent
  await server.driver.query({
    text: "UPDATE settings_invitation SET expires_at = now() - interval '1 minute' WHERE purpose = 'reset' AND used_at IS NULL",
    params: [],
  });
  const late = await post('/api/v1/auth/password/reset', {
    token: third,
    password: 'yet another long password',
  });
  expect(late.status).toBe(410);
  expect((await signIn(NEW_PASSWORD)).status).toBe(200);
});

test('each step is in the audit log', async () => {
  const kinds = (
    await server.driver.query<{ kind: string }>({
      text: "SELECT kind FROM audit_event WHERE kind LIKE 'auth.%reset%' ORDER BY id",
      params: [],
    })
  ).map((r) => r.kind);
  expect(kinds.filter((k) => k === 'auth.reset_requested')).toHaveLength(3);
  expect(kinds.filter((k) => k === 'auth.password_reset')).toHaveLength(1);
});
