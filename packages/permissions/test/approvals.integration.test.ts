/**
 * Multi-level approvals on purchase orders (RFC 0003 §5.3, §6): a 750 000 BDT order needs the department head,
 * then the finance director; a 100 000 one only the department head; a 30 000 one none. Levels are decided in
 * order, by holders of the role in the order's company, never by the requester; the last approval approves the
 * order, a rejection rejects it; policies are data administrators edit; everything is audited.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startApp, type TestApp } from './support/app.js';

let t: TestApp;
const PO = '/api/v1/models/purchase.order';

beforeAll(async () => {
  t = await startApp();
  // The finance director is a runtime role, assigned to farid in Dhaka (as an administrator would).
  await t.call({
    method: 'PUT',
    url: '/api/v1/admin/roles/company.finance_director',
    as: 'admin',
    body: { label: 'Finance director', accessLevels: ['purchase.approver'] },
  });
  await t.call({
    method: 'PUT',
    url: `/api/v1/admin/users/${t.users['farid']}/roles`,
    as: 'admin',
    body: { assignments: [{ role: 'company.finance_director', company: t.companies.dhaka }] },
  });
}, 240_000);
afterAll(async () => t?.stop());

type Request = { id: number; levelName: string; state: string; sequence: number };

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
const decide = (request: number, decision: 'approve' | 'reject', as: string, comment?: string) =>
  t.call({
    method: 'POST',
    url: `/api/v1/approvals/requests/${request}/${decision}`,
    as,
    body: comment === undefined ? {} : { comment },
  });
const stateOf = async (id: number) =>
  (await t.call({ url: `${PO}/${id}?fields=state`, as: 'dina' })).json().state as string;

describe('policies from the manifest', () => {
  test('installed as data: one policy with two levels', async () => {
    const policies = (
      await t.call({
        url: '/api/v1/models/approval.policy?fields=name,targetModel,onApproved',
        as: 'admin',
      })
    ).json();
    expect(policies.items).toEqual([
      expect.objectContaining({
        name: 'Purchase approvals',
        targetModel: 'purchase.order',
        onApproved: 'approve',
      }),
    ]);
    const levels = (
      await t.call({
        url: '/api/v1/models/approval.level?fields=name,approverRole&order=sequence',
        as: 'admin',
      })
    ).json();
    expect(levels.items.map((l: { name: string }) => l.name)).toEqual([
      'Department head',
      'Finance director',
    ]);
  });

  test('a broken condition is refused when saved', async () => {
    const res = await t.call({
      method: 'POST',
      url: '/api/v1/models/approval.level',
      as: 'admin',
      body: {
        policy: 1,
        name: 'Broken',
        condition: { noSuchField: 1 },
        approverRole: 'purchase.approver',
      },
    });
    expect(res.status).toBe(422);
  });
});

describe('a 750 000 order', () => {
  test('two levels in order; separation of duties; the last approval approves the order', async () => {
    const id = await order('750000');
    expect((await submit(id)).json().state).toBe('submitted');
    const [head, director] = await requests(id);
    expect([head?.levelName, director?.levelName]).toEqual(['Department head', 'Finance director']);
    expect([head?.state, director?.state]).toEqual(['pending', 'pending']);

    // The order cannot be approved by hand while approvals are open.
    const early = await t.call({
      method: 'POST',
      url: `${PO}/${id}/transitions/approve`,
      as: 'dina',
    });
    expect(early.status).toBe(409);

    // The finance director waits for the department head.
    const tooEarly = await decide(director?.id as number, 'approve', 'farid');
    expect(tooEarly.status).toBe(409);
    expect(tooEarly.json()).toMatchObject({
      type: 'https://kosh.dev/problems/approval-not-your-turn',
    });
    // Requesters never approve their own order; plain users are not approvers.
    expect((await decide(head?.id as number, 'approve', 'rahim')).status).toBe(403);
    expect((await decide(head?.id as number, 'approve', 'bob')).status).toBe(403);

    // Inboxes show what each approver may decide now.
    const inbox = async (login: string) =>
      (
        (await t.call({ url: '/api/v1/approvals/inbox', as: login })).json() as {
          requests: Request[];
        }
      ).requests.map((r) => r.id);
    expect(await inbox('dina')).toEqual([head?.id]);
    expect(await inbox('farid')).not.toContain(director?.id);

    expect((await decide(head?.id as number, 'approve', 'dina', 'Within budget')).status).toBe(200);
    expect(await inbox('farid')).toContain(director?.id);
    expect(await stateOf(id)).toBe('submitted');
    const last = await decide(director?.id as number, 'approve', 'farid');
    expect(last.json()).toMatchObject({ state: 'approved', decidedBy: t.users['farid'] });
    expect(await stateOf(id)).toBe('approved');
    expect((await decide(director?.id as number, 'approve', 'farid')).status).toBe(409); // decided once

    // Each step is audited with its actor.
    const events = await t.server.driver.query<{ kind: string; actor_id: number }>({
      text: "SELECT kind, actor_id FROM audit_event WHERE kind LIKE 'approval.%' AND target_id = $1 ORDER BY id",
      params: [id],
    });
    expect(events).toEqual([
      { kind: 'approval.requested', actor_id: t.users['rahim'] },
      { kind: 'approval.approved', actor_id: t.users['dina'] },
      { kind: 'approval.approved', actor_id: t.users['farid'] },
    ]);
  });
});

describe('smaller orders and rejections', () => {
  test('100 000: only the department head; 30 000: no approval, approved directly', async () => {
    const mid = await order('100000');
    await submit(mid);
    expect((await requests(mid)).map((r) => r.levelName)).toEqual(['Department head']);
    const small = await order('30000');
    await submit(small);
    expect(await requests(small)).toEqual([]);
    const approve = await t.call({
      method: 'POST',
      url: `${PO}/${small}/transitions/approve`,
      as: 'dina',
    });
    expect(approve.json().state).toBe('approved');
  });

  test('a rejection rejects the order and cancels the open levels; resubmitting starts a new round', async () => {
    const id = await order('600000');
    await submit(id);
    const [head, director] = await requests(id);
    expect(
      (await decide(head?.id as number, 'reject', 'dina', 'Too expensive')).json(),
    ).toMatchObject({ state: 'rejected', comment: 'Too expensive' });
    expect(await stateOf(id)).toBe('rejected');
    expect((await requests(id)).find((r) => r.id === director?.id)?.state).toBe('cancelled');
    await submit(id);
    const round = (await requests(id)).filter((r) => r.state === 'pending');
    expect(round.map((r) => r.levelName)).toEqual(['Department head', 'Finance director']);
  });

  test('approvers decide in the order company only; per-company roles hold', async () => {
    // In Chattogram, rahim is a department head: he decides orders there that others requested.
    const id = await order('70000', 'maria');
    await t.call({
      method: 'PATCH',
      url: `${PO}/${id}`,
      as: 'maria',
      body: { company: t.companies.chattogram },
    });
    expect((await submit(id, 'maria')).status).toBe(200);
    const [head] = await requests(id, 'maria');
    const inDhaka = await decide(head?.id as number, 'approve', 'dina');
    expect(inDhaka.status).toBe(403); // dina is an approver in Dhaka only
    const asRahim = await t.call({
      method: 'POST',
      url: `/api/v1/approvals/requests/${head?.id}/approve`,
      as: 'rahim',
      company: t.companies.chattogram,
      body: {},
    });
    expect(asRahim.status, asRahim.body).toBe(200);
  });

  test('requests are private: not served by the generated API, and the history needs read access to the record', async () => {
    expect((await t.call({ url: '/api/v1/models/approval.request', as: 'admin' })).status).toBe(
      404,
    );
    const id = await order('90000', 'dina');
    await submit(id, 'dina');
    expect([403, 404]).toContain(
      (await t.call({ url: `/api/v1/approvals/purchase.order/${id}`, as: 'rahim' })).status,
    ); // not his order
  });

  test("administrators may decide others' requests (bypass), but not their own (separation of duties)", async () => {
    const theirs = await order('80000', 'farid');
    await submit(theirs, 'farid');
    const [request] = await requests(theirs, 'farid');
    expect((await decide(request?.id as number, 'approve', 'admin')).status).toBe(200);
    const own = await order('80000', 'admin');
    await submit(own, 'admin');
    const [mine] = await requests(own, 'admin');
    expect((await decide(mine?.id as number, 'approve', 'admin')).status).toBe(403);
  });
});
