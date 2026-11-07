/**
 * The approval engine of RFC 0025 on real PostgreSQL: a level decided by named people, all of whom must approve (each
 * vote kept, a second vote refused, others refused); sending back for changes with a reason, the next submission a
 * new round with the earlier kept; the requester withdrawing; a manager level without Workforce falling back to its
 * role; a level that does not name its approvers refused.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startApp, type TestApp } from './support/app.js';

let t: TestApp;
const PO = '/api/v1/models/purchase.order';

beforeAll(async () => {
  t = await startApp();
  const policy = async (
    name: string,
    amount: string,
    level: Record<string, unknown>,
    extra = {},
  ) => {
    const res = await t.call({
      method: 'POST',
      url: '/api/v1/models/approval.policy',
      as: 'admin',
      body: {
        name,
        targetModel: 'purchase.order',
        onApproved: 'approve',
        onRejected: 'reject',
        ...extra,
        levels: { create: [{ name, condition: { amountTotal: amount }, ...level }] },
      },
    });
    expect(res.status, res.body).toBe(201);
  };
  await policy('Board', '7001', {
    approverKind: 'users',
    approverUsers: { set: [t.users['dina'], t.users['maria']] },
    quorum: 'all',
  });
  await policy(
    'Review',
    '7002',
    { approverRole: 'purchase.approver' },
    { onSentBack: 'reject', onWithdrawn: 'cancel' },
  );
  await policy('Line manager', '7003', {
    approverKind: 'manager',
    approverRole: 'purchase.approver',
  });
}, 240_000);
afterAll(async () => t?.stop());

type Request = {
  id: number;
  levelName: string;
  state: string;
  round: number;
  approvers: number[];
  required: number;
  approvals: number;
};

async function order(amount: string, as = 'rahim'): Promise<number> {
  const res = await t.call({
    method: 'POST',
    url: PO,
    as,
    body: { name: `PO ${amount}`, amountTotal: amount },
  });
  expect(res.status, res.body).toBe(201);
  return res.json().id as number;
}
const submit = (id: number, as = 'rahim') =>
  t.call({ method: 'POST', url: `${PO}/${id}/transitions/submit`, as });
const requests = async (id: number, as = 'rahim'): Promise<Request[]> =>
  (
    (await t.call({ url: `/api/v1/approvals/purchase.order/${id}`, as })).json() as {
      requests: Request[];
    }
  ).requests;
const decide = (
  request: number,
  decision: 'approve' | 'reject' | 'send-back',
  as: string,
  comment?: string,
) =>
  t.call({
    method: 'POST',
    url: `/api/v1/approvals/requests/${request}/${decision}`,
    as,
    body: comment === undefined ? {} : { comment },
  });
const stateOf = async (id: number) =>
  (await t.call({ url: `${PO}/${id}?fields=state`, as: 'dina' })).json().state as string;

describe('named people, all of them', () => {
  test('each vote kept; the request approved by the last; others and second votes refused', async () => {
    const id = await order('7001');
    await submit(id);
    const [board] = await requests(id);
    expect(board).toMatchObject({
      levelName: 'Board',
      state: 'pending',
      required: 2,
      approvals: 0,
    });
    expect([...(board?.approvers ?? [])].sort()).toEqual(
      [t.users['dina'], t.users['maria']].sort(),
    );
    // Not named: refused, whatever their role.
    expect((await decide(board?.id ?? 0, 'approve', 'farid')).status).toBe(403);
    expect((await decide(board?.id ?? 0, 'approve', 'dina')).status).toBe(200);
    const [half] = await requests(id);
    expect(half).toMatchObject({ state: 'pending', approvals: 1 });
    expect(await stateOf(id)).toBe('submitted');
    expect((await decide(board?.id ?? 0, 'approve', 'dina')).status).toBe(409);
    // In maria's inbox, no longer in dina's.
    const inbox = async (as: string) =>
      (
        (await t.call({ url: '/api/v1/approvals/inbox', as })).json() as { requests: Request[] }
      ).requests.map((r) => r.id);
    expect(await inbox('maria')).toContain(board?.id);
    expect(await inbox('dina')).not.toContain(board?.id);
    expect((await decide(board?.id ?? 0, 'approve', 'maria')).status).toBe(200);
    expect((await requests(id))[0]).toMatchObject({ state: 'approved', approvals: 2 });
    expect(await stateOf(id)).toBe('approved');
  });
});

describe('sent back for changes', () => {
  test('a reason required; the record back; the next submission a new round, the first kept', async () => {
    const id = await order('7002');
    await submit(id);
    const [first] = await requests(id);
    expect((await decide(first?.id ?? 0, 'send-back', 'dina')).status).toBe(422);
    const back = await decide(first?.id ?? 0, 'send-back', 'dina', 'Add the vendor’s quotation.');
    expect(back.status, back.body).toBe(200);
    expect(await stateOf(id)).toBe('rejected');
    expect((await submit(id)).status).toBe(200);
    const all = await requests(id);
    expect(all.map((r) => [r.round, r.state])).toEqual([
      [1, 'sent_back'],
      [2, 'pending'],
    ]);
    // A rejection says why, too.
    expect((await decide(all[1]?.id ?? 0, 'reject', 'dina')).status).toBe(422);
  });

  test('the requester withdraws (others may not); the policy’s transition runs', async () => {
    const id = await order('7002');
    await submit(id);
    const [pending] = await requests(id);
    const withdraw = (as: string) =>
      t.call({ method: 'POST', url: `/api/v1/approvals/purchase.order/${id}/withdraw`, as });
    expect((await withdraw('dina')).status).toBe(403);
    const done = await withdraw('rahim');
    expect(done.status, done.body).toBe(200);
    expect(done.json()).toEqual({ withdrawn: 1 });
    expect((await requests(id))[0]?.state).toBe('cancelled');
    expect(await stateOf(id)).toBe('cancelled');
    expect((await decide(pending?.id ?? 0, 'approve', 'dina')).status).toBe(409);
  });
});

describe('a manager level without Workforce', () => {
  test('falls back to its role', async () => {
    const id = await order('7003');
    await submit(id);
    const [level] = await requests(id);
    expect(level).toMatchObject({ levelName: 'Line manager', approvers: [] });
    expect((await decide(level?.id ?? 0, 'approve', 'dina')).status).toBe(200);
    expect(await stateOf(id)).toBe('approved');
  });
});

describe('levels name their approvers', () => {
  test('people without anyone, a field without its name, a role without its role, a number without the number: refused', async () => {
    const [policy] = (
      await t.call({ url: '/api/v1/models/approval.policy?fields=id&limit=1', as: 'admin' })
    ).json().items;
    for (const level of [
      { approverKind: 'users' },
      { approverKind: 'field', approverRole: 'purchase.approver' },
      { approverRole: 'purchase.approver', quorum: 'count' },
      { approverKind: 'role' },
    ]) {
      const res = await t.call({
        method: 'POST',
        url: '/api/v1/models/approval.level',
        as: 'admin',
        body: { policy: policy.id, name: 'Incomplete', ...level },
      });
      expect(res.status, JSON.stringify(level)).toBe(422);
    }
  });
});

describe('the Approvals app’s lists', () => {
  type Card = {
    id: number;
    state: string;
    levelName: string;
    record: { model: string; id: number; name: string; label: string };
    requester: { name: string } | null;
    steps: { levelName: string; state: string }[];
    comment: string | null;
  };
  const cards = async (list: string, as: string): Promise<Card[]> =>
    (
      (await t.call({ url: `/api/v1/approvals/cards?list=${list}`, as })).json() as {
        cards: Card[];
      }
    ).cards;

  test('the inbox as cards; approving many at once; my requests; what I decided; the header', async () => {
    const a = await order('7002');
    const b = await order('7002');
    await submit(a);
    await submit(b);
    const inbox = await cards('inbox', 'dina');
    const mine = inbox.filter((c) => [a, b].includes(c.record.id));
    expect(mine).toHaveLength(2);
    expect(mine[0]).toMatchObject({
      levelName: 'Review',
      state: 'pending',
      record: { model: 'purchase.order', name: 'PO 7002', label: 'Purchase order' },
      requester: { name: 'rahim' },
    });
    expect(mine[0]?.steps.map((s) => s.levelName)).toEqual(['Review']);

    const bulk = await t.call({
      method: 'POST',
      url: '/api/v1/approvals/bulk',
      as: 'dina',
      body: { requests: [...mine.map((c) => c.id), 999999] },
    });
    expect(bulk.json()).toMatchObject({ approved: 2, failed: [{ id: 999999 }] });
    expect(await stateOf(a)).toBe('approved');
    expect(await stateOf(b)).toBe('approved');

    const asked = await cards('mine', 'rahim');
    expect(asked.find((c) => c.record.id === a)?.state).toBe('approved');
    const decided = await cards('history', 'dina');
    expect(decided.filter((c) => [a, b].includes(c.record.id)).map((c) => c.state)).toEqual([
      'approved',
      'approved',
    ]);
    const stats = (await t.call({ url: '/api/v1/approvals/stats', as: 'dina' })).json();
    expect(stats.decidedThisMonth).toBeGreaterThanOrEqual(2);
    expect(typeof stats.waiting).toBe('number');
    expect((await t.call({ url: '/api/v1/approvals/cards?list=nope', as: 'dina' })).status).toBe(
      400,
    );
  });
});

describe('when it was decided', () => {
  test('a decided request says when', async () => {
    const id = await order('7003');
    await submit(id);
    const [level] = await requests(id);
    await decide(level?.id ?? 0, 'approve', 'dina');
    const [after] = (await requests(id)) as unknown as { decidedAt: string | null }[];
    expect(after?.decidedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
