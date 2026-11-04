/**
 * RFC 0025 step 3 on real PostgreSQL, over the permissions package's purchase fixture: the approvers of a request
 * whose turn it is get an email with a link of their own — the delegate of an approver who is away too —; the delegate
 * decides for them (the vote says for whom); a request left past its deadline is reminded and escalated to its level's
 * role, whose holders may then decide; an email link opens a confirmation page, decides as its person once (a
 * reason needed to reject), and is then spent.
 */
import { createMemoryMailer } from '@kosh/mail';
import { sweepDeadlines } from '@kosh/permissions';
import type { Env } from '@kosh/server/orm';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { startApp, type TestApp } from '../../../packages/permissions/test/support/app.js';
import { approvalMailWorkers, approvalsModule } from '../src/index.js';

const mailer = createMemoryMailer();
let t: TestApp;
const PO = '/api/v1/models/purchase.order';
const LINK = /https:\/\/erp\.test(\/api\/v1\/public\/approvals\/[A-Za-z0-9_-]+)/;

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  t = await startApp({ modules: [approvalsModule({ mailer, apiUrl: 'https://erp.test' })] });
  // Emails for the people in this test.
  await t.server.shutro.bootstrap({ reason: 'test: emails' }, async (env) => {
    for (const login of ['dina', 'farid', 'maria']) {
      const users = env.model('res.users' as never) as unknown as {
        browse(ids: number[]): { write(v: unknown): Promise<void> };
      };
      await users.browse([t.users[login] as number]).write({ email: `${login}@padma.example` });
    }
  });
  const policy = await t.call({
    method: 'POST',
    url: '/api/v1/models/approval.policy',
    as: 'admin',
    body: {
      name: 'Timed',
      targetModel: 'purchase.order',
      onApproved: 'approve',
      onRejected: 'reject',
      levels: {
        create: [
          {
            name: 'Approver',
            condition: { amountTotal: '7101' },
            approverRole: 'purchase.approver',
            deadlineHours: 2,
            escalateRole: 'purchase.user',
          },
        ],
      },
    },
  });
  expect(policy.status, policy.body).toBe(201);
}, 240_000);
afterAll(async () => t?.stop());

const drain = async () => {
  for (const w of approvalMailWorkers({ shutro: t.server.shutro })) await w.drain();
};
async function submitted(): Promise<{ order: number; request: number }> {
  const made = await t.call({
    method: 'POST',
    url: PO,
    as: 'rahim',
    body: { name: 'PO 7101', amountTotal: '7101' },
  });
  const order = made.json().id as number;
  await t.call({ method: 'POST', url: `${PO}/${order}/transitions/submit`, as: 'rahim' });
  const [request] = (
    await t.call({ url: `/api/v1/approvals/purchase.order/${order}`, as: 'rahim' })
  ).json().requests as { id: number }[];
  return { order, request: request?.id ?? 0 };
}
const linkFor = (email: string): string =>
  LINK.exec(mailer.sent.filter((m) => m.to === email).at(-1)?.text ?? '')?.[1] ?? '';
const stateOf = async (id: number) =>
  (await t.call({ url: `${PO}/${id}?fields=state`, as: 'dina' })).json().state as string;

test('away: the delegate gets the email and decides for the approver', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const later = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  expect(
    (
      await t.call({
        method: 'POST',
        url: '/api/v1/models/approval.delegation',
        as: 'dina',
        body: { delegate: t.users['dina'], dateFrom: today, dateTo: later },
      })
    ).status,
  ).toBe(422); // not to oneself
  const away = await t.call({
    method: 'POST',
    url: '/api/v1/models/approval.delegation',
    as: 'dina',
    body: { delegate: t.users['farid'], dateFrom: today, dateTo: later, note: 'On leave' },
  });
  expect(away.status, away.body).toBe(201);

  const { order, request } = await submitted();
  await drain();
  expect(linkFor('dina@padma.example')).not.toBe('');
  expect(linkFor('farid@padma.example')).not.toBe(''); // the delegate too
  const inbox = (await t.call({ url: '/api/v1/approvals/inbox', as: 'farid' })).json().requests as {
    id: number;
  }[];
  expect(inbox.map((r) => r.id)).toContain(request);
  const decided = await t.call({
    method: 'POST',
    url: `/api/v1/approvals/requests/${request}/approve`,
    as: 'farid',
    body: { comment: 'For Dina, on leave' },
  });
  expect(decided.status, decided.body).toBe(200);
  expect(await stateOf(order)).toBe('approved');
  // Dina may not decide it again for herself.
  expect(
    (
      await t.call({
        method: 'POST',
        url: `/api/v1/approvals/requests/${request}/approve`,
        as: 'dina',
      })
    ).status,
  ).toBe(409);
  // Back from leave: the delegation removed, later requests are Dina's alone.
  const [d] = (
    await t.call({ url: '/api/v1/models/approval.delegation?fields=id', as: 'dina' })
  ).json().items;
  expect(
    (
      await t.call({
        method: 'DELETE',
        url: `/api/v1/models/approval.delegation/${d.id}`,
        as: 'dina',
      })
    ).status,
  ).toBe(200);
});

test('late: reminded at half the deadline, escalated once past it, its role may then decide', async () => {
  const { order, request } = await submitted();
  await drain();
  const farid = async () =>
    (
      (await t.call({ url: '/api/v1/approvals/inbox', as: 'farid' })).json().requests as {
        id: number;
      }[]
    ).map((r) => r.id);
  expect(await farid()).not.toContain(request);
  const sweep = (hours: number) =>
    t.server.shutro.bootstrap({ reason: 'test: deadlines', company: t.companies.dhaka }, (env) =>
      (env as Env).asSuperuser({ reason: 'test' }, (su) =>
        sweepDeadlines(su, new Date(Date.now() + hours * 3_600_000)),
      ),
    );
  expect((await sweep(1.1)).map((d) => [d.kind, d.request.id])).toContainEqual([
    'reminded',
    request,
  ]);
  expect((await sweep(1.5)).filter((d) => d.request.id === request)).toEqual([]); // reminded once
  expect((await sweep(2.5)).map((d) => [d.kind, d.request.id])).toContainEqual([
    'escalated',
    request,
  ]);
  expect(await farid()).toContain(request);
  expect(
    (
      await t.call({
        method: 'POST',
        url: `/api/v1/approvals/requests/${request}/approve`,
        as: 'farid',
      })
    ).status,
  ).toBe(200);
  expect(await stateOf(order)).toBe('approved');
});

test('from the email: a confirmation page, a decision as its person once, then spent', async () => {
  const { order } = await submitted();
  await drain();
  const link = linkFor('dina@padma.example');
  expect(link).not.toBe('');
  const page = await t.server.app.inject({ method: 'GET', url: link });
  expect(page.statusCode).toBe(200);
  expect(page.body).toContain('PO 7101');
  expect(page.headers['content-security-policy']).toContain("script-src 'nonce-");
  // Opening the page decided nothing.
  expect(await stateOf(order)).toBe('submitted');
  const post = (payload: Record<string, unknown>) =>
    t.server.app.inject({ method: 'POST', url: link, payload });
  expect((await post({ decision: 'reject' })).statusCode).toBe(422);
  expect((await post({ decision: 'maybe' })).statusCode).toBe(400);
  const approved = await post({ decision: 'approve', comment: 'Fine' });
  expect(approved.statusCode, approved.body).toBe(200);
  expect(await stateOf(order)).toBe('approved');
  expect((await post({ decision: 'approve' })).statusCode).toBe(404);
  expect((await t.server.app.inject({ method: 'GET', url: link })).statusCode).toBe(404);
});
