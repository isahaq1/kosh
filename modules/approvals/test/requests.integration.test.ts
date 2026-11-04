/**
 * Generic requests (RFC 0025 step 4) on real PostgreSQL: the shipped categories; a category's policy made on demand,
 * scoped to its requests by its condition, its levels edited; a request refused until it has what its category
 * requires (a file too), submitted, readable by who decides it and nobody else, approved from the inbox; the policy
 * preview; a policy condition that is not a domain refused.
 */
import { orm } from '@kosh/server/orm';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { startApp, type TestApp } from '../../../packages/permissions/test/support/app.js';
import { approvalsModule } from '../src/index.js';

let t: TestApp;
// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
const ASK = '/api/v1/models/approval.ask';
const CAT = '/api/v1/models/approval.category';

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  t = await startApp({ modules: [approvalsModule({ mailer: undefined })] });
  // The shipped categories (data records; the installer loads them).
  await orm.loadData(t.server.shutro, { modules: ['approvals'], company: t.companies.dhaka });
}, 240_000);
afterAll(async () => t?.stop());

const expectStatus = (r: { status: number; body: string }, status: number) =>
  expect(r.status, r.body).toBe(status);

test('the shipped categories; a category with its own policy, scoped to its requests', async () => {
  const shipped = await t.call({ url: `${CAT}?fields=code,askAmount,askAttachment`, as: 'bob' });
  expectStatus(shipped, 200);
  const codes = (shipped.json().items as Json[]).map((c) => c.code).sort();
  expect(codes).toEqual(['GEN', 'PAY', 'PR', 'TRIP']);
  expectStatus(
    await t.call({ method: 'POST', url: CAT, as: 'bob', body: { name: 'Training' } }),
    403,
  );
  const made = await t.call({
    method: 'POST',
    url: CAT,
    as: 'admin',
    body: { name: 'Training', code: 'TRN', askAmount: 'required', askPeriod: 'optional' },
  });
  expectStatus(made, 201);
  // An outcome no app offers is refused.
  expectStatus(
    await t.call({
      method: 'PATCH',
      url: `${CAT}/${made.json().id}`,
      as: 'admin',
      body: { outcome: 'teleport' },
    }),
    422,
  );
  // Its policy, on demand (Approvals managers), once; then decided by Dina by name.
  expectStatus(
    await t.call({
      method: 'POST',
      url: `/api/v1/approvals/categories/${made.json().id}/policy`,
      as: 'bob',
    }),
    403,
  );
  const policy = await t.call({
    method: 'POST',
    url: `/api/v1/approvals/categories/${made.json().id}/policy`,
    as: 'admin',
  });
  expectStatus(policy, 200);
  const again = await t.call({
    method: 'POST',
    url: `/api/v1/approvals/categories/${made.json().id}/policy`,
    as: 'admin',
  });
  expect(again.json().policy).toBe(policy.json().policy);
  const p = await t.call({
    url: `/api/v1/models/approval.policy/${policy.json().policy}?fields=condition,targetModel,levels`,
    as: 'admin',
  });
  expect(p.json()).toMatchObject({
    targetModel: 'approval.ask',
    condition: { category: made.json().id },
  });
  const [level] = p.json().levels as number[];
  expectStatus(
    await t.call({
      method: 'PATCH',
      url: `/api/v1/models/approval.level/${level}`,
      as: 'admin',
      body: { approverKind: 'users', approverUsers: { set: [t.users['dina']] } },
    }),
    200,
  );
  // A condition that is not a domain on the model is refused.
  expectStatus(
    await t.call({
      method: 'PATCH',
      url: `/api/v1/models/approval.policy/${policy.json().policy}`,
      as: 'admin',
      body: { condition: { noSuchField: 1 } },
    }),
    422,
  );

  // Rahim asks: refused without the amount the category requires, then submitted.
  const ask = await t.call({
    method: 'POST',
    url: ASK,
    as: 'rahim',
    body: { category: made.json().id, title: 'Excel course' },
  });
  expectStatus(ask, 201);
  expect(ask.json().name).toMatch(/^REQ-\d{5}$/);
  const id = ask.json().id as number;
  const run = (transition: string, as: string) =>
    t.call({ method: 'POST', url: `${ASK}/${id}/transitions/${transition}`, as });
  expectStatus(await run('submit', 'rahim'), 409);
  expectStatus(
    await t.call({ method: 'PATCH', url: `${ASK}/${id}`, as: 'rahim', body: { amount: '12000' } }),
    200,
  );
  expectStatus(await run('submit', 'rahim'), 200);
  // Only its category's policy asked: one request, Dina's.
  const requests = (
    await t.call({ url: `/api/v1/approvals/approval.ask/${id}`, as: 'rahim' })
  ).json().requests as Json[];
  expect(requests).toHaveLength(1);
  // Dina reads it (she decides it), Bob does not; Rahim no longer changes it.
  expectStatus(await t.call({ url: `${ASK}/${id}?fields=title,amount`, as: 'dina' }), 200);
  expect((await t.call({ url: `${ASK}/${id}`, as: 'bob' })).status).toBeGreaterThanOrEqual(403);
  expect(
    (await t.call({ method: 'PATCH', url: `${ASK}/${id}`, as: 'rahim', body: { amount: '1' } }))
      .status,
  ).toBeGreaterThanOrEqual(403);
  const inbox = (await t.call({ url: '/api/v1/approvals/inbox', as: 'dina' })).json()
    .requests as Json[];
  const mine = inbox.find((r) => r.targetModel === 'approval.ask' && r.targetId === id);
  expectStatus(
    await t.call({
      method: 'POST',
      url: `/api/v1/approvals/requests/${mine.id}/approve`,
      as: 'dina',
    }),
    200,
  );
  const done = (await t.call({ url: `${ASK}/${id}?fields=state,approvedAt`, as: 'rahim' })).json();
  expect(done.state).toBe('approved');
  expect(done.approvedAt).not.toBeNull();

  // The preview: of the policy's records (this category's), its one level asks about all of them.
  expectStatus(
    await t.call({
      url: `/api/v1/approvals/policies/${policy.json().policy}/preview`,
      as: 'rahim',
    }),
    403,
  );
  const preview = await t.call({
    url: `/api/v1/approvals/policies/${policy.json().policy}/preview`,
    as: 'admin',
  });
  expectStatus(preview, 200);
  expect(preview.json()).toMatchObject({ records: 1, levels: [{ matched: [id] }] });
});

test('a payment needs its file: refused without one; lines add up', async () => {
  const cats = (await t.call({ url: `${CAT}?fields=code`, as: 'rahim' })).json().items as Json[];
  const pay = cats.find((c) => c.code === 'PAY').id as number;
  const partner = await t.call({
    method: 'POST',
    url: '/api/v1/models/res.partner',
    as: 'admin',
    body: { name: 'Meghna Press' },
  });
  const ask = await t.call({
    method: 'POST',
    url: ASK,
    as: 'rahim',
    body: {
      category: pay,
      title: 'Brochures',
      amount: '5000',
      partner: partner.json().id,
      lines: {
        create: [
          { name: 'Brochure', quantity: '500', priceUnit: '8' },
          { name: 'Design', quantity: '1', priceUnit: '1000' },
        ],
      },
    },
  });
  expectStatus(ask, 201);
  expect(
    Number(
      (await t.call({ url: `${ASK}/${ask.json().id}?fields=linesTotal`, as: 'rahim' })).json()
        .linesTotal,
    ),
  ).toBe(5000);
  expectStatus(
    await t.call({
      method: 'POST',
      url: `${ASK}/${ask.json().id}/transitions/submit`,
      as: 'rahim',
    }),
    409,
  );
});
