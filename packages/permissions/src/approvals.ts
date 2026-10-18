/**
 * Multi-level approvals (RFC 0003 §5.3). A module wires them into its state machine:
 *
 * ```ts
 * transitions: {
 *   submit:  { from: ['draft'], to: 'submitted', after: (orders) => requestApprovals(orders) },
 *   approve: { from: ['submitted'], to: 'approved', guard: (orders) => approvalGuard(orders),
 *              message: 'Waiting for approvals.' },
 * }
 * ```
 *
 * `requestApprovals` creates one request per policy level whose condition (a Shutro domain) matches the record.
 * Levels are decided in order (a level waits for the lower ones), by holders of the level's role in the record's
 * company; the requester never approves their own record (separation of duties, administrators included). The
 * last approval runs the policy's `onApproved` transition, a rejection its `onRejected` one, as the system
 * (attributed to the approver in the audit log). Every step is audited and emitted as an event for notifications.
 */
import type { KoshModule } from '@kosh/modules-sdk';
import { audit, HttpProblem } from '@kosh/server';
import type { Env } from '@kosh/server/orm';

type Row = Record<string, unknown>;
interface Rows {
  readonly ids: readonly number[];
  readonly length: number;
  load(keys: readonly string[]): Promise<{ read(keys: readonly string[]): Row[] }>;
  write(values: unknown): Promise<void>;
}
interface Ref {
  search(q: unknown): Promise<Rows>;
  browse(ids: readonly number[]): Rows;
  create(rows: readonly unknown[]): Promise<Rows>;
}
const ref = (env: Env, name: string): Ref => env.model(name as never) as unknown as Ref;

async function find(env: Env, model: string, where: unknown, keys: string[], order?: string[]) {
  const set = await ref(env, model).search({ where, ...(order === undefined ? {} : { order }) });
  return set.length === 0 ? [] : (await set.load(keys)).read(keys);
}

const REQUEST_KEYS = [
  'policy',
  'levelName',
  'sequence',
  'targetModel',
  'targetId',
  'company',
  'approverRole',
  'state',
  'requestedBy',
  'decidedBy',
  'decidedAt',
  'comment',
];

/** An approval request as the API returns it. */
export interface ApprovalRequestInfo {
  readonly id: number;
  readonly policy: number | null;
  readonly levelName: string;
  readonly sequence: number;
  readonly targetModel: string;
  readonly targetId: number;
  readonly company: number | null;
  readonly approverRole: string;
  readonly state: 'pending' | 'approved' | 'rejected' | 'cancelled';
  readonly requestedBy: number | null;
  readonly decidedBy: number | null;
  readonly decidedAt: string | null;
  readonly comment: string | null;
}

function info(row: Row): ApprovalRequestInfo {
  const at = row['decidedAt'];
  return {
    id: row['id'] as number,
    policy: (row['policy'] as number | null) ?? null,
    levelName: String(row['levelName']),
    sequence: row['sequence'] as number,
    targetModel: String(row['targetModel']),
    targetId: row['targetId'] as number,
    company: (row['company'] as number | null) ?? null,
    approverRole: String(row['approverRole']),
    state: row['state'] as ApprovalRequestInfo['state'],
    requestedBy: (row['requestedBy'] as number | null) ?? null,
    decidedBy: (row['decidedBy'] as number | null) ?? null,
    decidedAt: at instanceof Date ? at.toISOString() : null,
    comment: (row['comment'] as string | null) ?? null,
  };
}

/** The requests of a record's current round (cancelled ones are history). */
async function currentRequests(su: Env, model: string, id: number): Promise<ApprovalRequestInfo[]> {
  return (
    await find(
      su,
      'approval.request',
      { targetModel: model, targetId: id, state: { ne: 'cancelled' } },
      REQUEST_KEYS,
      ['sequence asc', 'id asc'],
    )
  ).map(info);
}

/** The record's company, when the model has one. */
async function companyOf(su: Env, model: string, id: number): Promise<number | null> {
  try {
    const [row] = (await ref(su, model).browse([id]).load(['company'])).read(['company']);
    return typeof row?.['company'] === 'number' ? (row['company'] as number) : null;
  } catch {
    return null; // the model is not company-scoped
  }
}

/**
 * Creates the approval requests of `records` (a recordset: `env`, `modelName`, `ids`) from the matching policies
 * and levels; earlier pending requests of the records are cancelled (a resubmission starts a new round). Returns
 * the number of requests created.
 */
export async function requestApprovals(records: unknown): Promise<number> {
  const { env, modelName, ids } = records as {
    env: Env;
    modelName: string;
    ids: readonly number[];
  };
  const requester = env.uid;
  return env.asSuperuser({ reason: `request approvals of ${modelName}` }, async (su) => {
    let created = 0;
    for (const id of ids) {
      const stale = await ref(su, 'approval.request').search({
        where: { targetModel: modelName, targetId: id, state: 'pending' },
      });
      if (stale.length > 0) await stale.write({ state: 'cancelled' });
      const company = (await companyOf(su, modelName, id)) ?? env.companyId;
      const policies = await find(
        su,
        'approval.policy',
        { targetModel: modelName, or: [{ company: null }, { company }] },
        ['name'],
        ['sequence asc', 'id asc'],
      );
      const rows: Row[] = [];
      for (const policy of policies) {
        const levels = await find(
          su,
          'approval.level',
          { policy: policy['id'] },
          ['sequence', 'name', 'condition', 'approverRole'],
          ['sequence asc', 'id asc'],
        );
        for (const level of levels) {
          const condition = level['condition'] as Row | null;
          const applies =
            condition === null ||
            Object.keys(condition).length === 0 ||
            (await ref(su, modelName).search({ where: { and: [{ id }, condition] }, limit: 1 }))
              .length > 0;
          if (!applies) continue;
          rows.push({
            policy: policy['id'],
            level: level['id'],
            levelName: level['name'],
            sequence: level['sequence'],
            targetModel: modelName,
            targetId: id,
            company,
            approverRole: level['approverRole'],
            requestedBy: requester,
          });
        }
      }
      if (rows.length === 0) continue;
      await ref(su, 'approval.request').create(rows);
      created += rows.length;
      await audit(su, {
        kind: 'approval.requested',
        summary: `${rows.length} approval(s) requested for ${modelName} ${id}.`,
        actor: requester,
        company,
        targetModel: modelName,
        targetId: id,
        details: { levels: rows.map((r) => r['levelName']) },
      });
      await su.emit('approval.requested', {
        model: modelName,
        id,
        roles: [...new Set(rows.map((r) => r['approverRole']))],
      });
    }
    return created;
  });
}

/** `none` (no level applied), `pending`, `approved` or `rejected`, for the record's current round. */
export async function approvalState(
  env: Env,
  model: string,
  id: number,
): Promise<'none' | 'pending' | 'approved' | 'rejected'> {
  const requests = await env.asSuperuser({ reason: 'approval state' }, (su) =>
    currentRequests(su, model, id),
  );
  if (requests.length === 0) return 'none';
  if (requests.some((r) => r.state === 'rejected')) return 'rejected';
  return requests.every((r) => r.state === 'approved') ? 'approved' : 'pending';
}

/** Transition guard: the records whose approvals are pending or rejected (records no level applied to may go). */
export async function approvalGuard(records: unknown): Promise<number[]> {
  const { env, modelName, ids } = records as {
    env: Env;
    modelName: string;
    ids: readonly number[];
  };
  const blocked: number[] = [];
  for (const id of ids) {
    const state = await approvalState(env, modelName, id);
    if (state === 'pending' || state === 'rejected') blocked.push(id);
  }
  return blocked;
}

function refuse(status: number, type: string, title: string, detail: string, hint?: string): never {
  throw new HttpProblem(status, type, title, detail, hint);
}

/** True when `env`'s user may decide `request` now (its turn, its role, its company, not the requester). */
function mayDecide(
  env: Env,
  request: ApprovalRequestInfo,
  round: readonly ApprovalRequestInfo[],
): string | null {
  if (request.state !== 'pending') return 'decided';
  if (round.some((r) => r.sequence < request.sequence && r.state !== 'approved'))
    return 'not-your-turn';
  if (request.requestedBy === env.uid) return 'separation-of-duties';
  if (request.company !== null && request.company !== env.companyId) return 'other-company';
  if (!env.administrator && !env.groups.has(request.approverRole)) return 'not-approver';
  return null;
}

/**
 * Approves or rejects a request as `env`'s user. @throws {HttpProblem} 404 unknown, 409 decided / not its turn,
 * 403 not an approver, the requester, or another company
 */
export async function decide(
  env: Env,
  requestId: number,
  decision: 'approve' | 'reject',
  comment?: string,
): Promise<ApprovalRequestInfo> {
  const actor = env.uid;
  return env.asSuperuser({ reason: `${decision} approval ${requestId}` }, async (su) => {
    const [row] = await find(su, 'approval.request', { id: requestId }, REQUEST_KEYS);
    if (row === undefined)
      refuse(404, 'missing-record', 'Not found', `No approval request ${requestId}.`);
    const request = info(row);
    const round = await currentRequests(su, request.targetModel, request.targetId);
    const reason = mayDecide(env, request, round);
    if (reason === 'decided' || request.state === 'cancelled')
      refuse(409, 'approval-decided', 'Already decided', `This request is ${request.state}.`);
    if (reason === 'not-your-turn')
      refuse(
        409,
        'approval-not-your-turn',
        'Earlier levels first',
        'A lower approval level is still open.',
        'Wait for the earlier approvers.',
      );
    if (reason === 'separation-of-duties')
      refuse(
        403,
        'separation-of-duties',
        'Separation of duties',
        'The requester cannot approve their own record.',
        'Another approver decides.',
      );
    if (reason === 'other-company')
      refuse(
        403,
        'company-not-allowed',
        'Other company',
        `This request belongs to company ${request.company}.`,
        'Switch to that company (X-Company).',
      );
    if (reason === 'not-approver')
      refuse(
        403,
        'access',
        'Not an approver',
        `Approving needs the role ${request.approverRole} in this company.`,
      );

    const state = decision === 'approve' ? 'approved' : 'rejected';
    await ref(su, 'approval.request')
      .browse([request.id])
      .write({
        state,
        decidedBy: actor,
        decidedAt: new Date(),
        comment: comment ?? null,
      });
    const target = { model: request.targetModel, id: request.targetId };
    if (state === 'rejected') {
      const open = round
        .filter((r) => r.id !== request.id && r.state === 'pending')
        .map((r) => r.id);
      if (open.length > 0)
        await ref(su, 'approval.request').browse(open).write({ state: 'cancelled' });
    }
    const done =
      state === 'rejected' || round.every((r) => r.id === request.id || r.state === 'approved');
    await audit(su, {
      kind: `approval.${state}`,
      summary: `${request.levelName} ${state} for ${target.model} ${target.id}.`,
      actor,
      company: request.company,
      targetModel: target.model,
      targetId: target.id,
      details: { request: request.id, comment: comment ?? null },
    });
    await su.emit('approval.decided', { ...target, request: request.id, state, final: done });
    if (done && request.policy !== null) {
      const [policy] = await find(su, 'approval.policy', { id: request.policy }, [
        'onApproved',
        'onRejected',
      ]);
      const transition = policy?.[state === 'approved' ? 'onApproved' : 'onRejected'];
      if (typeof transition === 'string' && transition !== '') {
        const record = ref(su, target.model).browse([target.id]) as unknown as Record<
          string,
          () => Promise<void>
        >;
        const run = record[transition];
        if (typeof run !== 'function')
          refuse(
            409,
            'invalid-transition',
            'Invalid transition',
            `${target.model} has no transition '${transition}'.`,
          );
        await run.call(record);
      }
    }
    const [after] = await find(su, 'approval.request', { id: request.id }, REQUEST_KEYS);
    return info(after as Row);
  });
}

/** The pending requests `env`'s user may decide now, in the current company. */
export async function inbox(env: Env): Promise<ApprovalRequestInfo[]> {
  return env.asSuperuser({ reason: 'approval inbox' }, async (su) => {
    const pending = (
      await find(su, 'approval.request', { state: 'pending' }, REQUEST_KEYS, ['id asc'])
    ).map(info);
    const out: ApprovalRequestInfo[] = [];
    for (const request of pending) {
      if (!env.administrator && !env.groups.has(request.approverRole)) continue;
      const round = await currentRequests(su, request.targetModel, request.targetId);
      if (mayDecide(env, request, round) === null) out.push(request);
    }
    return out;
  });
}

/** The requests of a record, when `env` may read the record (record rules apply: 404 otherwise). */
export async function requestsOf(
  env: Env,
  model: string,
  id: number,
): Promise<ApprovalRequestInfo[]> {
  await ref(env, model).browse([id]).load(['id']); // as the caller: ACL and rules decide
  return env.asSuperuser({ reason: 'approval history' }, async (su) =>
    (
      await find(su, 'approval.request', { targetModel: model, targetId: id }, REQUEST_KEYS, [
        'id asc',
      ])
    ).map(info),
  );
}

/** Installs the default policies the modules declare (`approvals` in manifests) that do not exist yet, by name. */
export async function installApprovalPolicies(
  env: Env,
  modules: readonly KoshModule[],
): Promise<number> {
  let created = 0;
  for (const module of modules)
    for (const spec of module.approvals ?? []) {
      const existing = await ref(env, 'approval.policy').search({
        where: { name: spec.name, targetModel: spec.model, active: { in: [true, false] } },
      });
      if (existing.length > 0) continue;
      const policy = await ref(env, 'approval.policy').create([
        {
          name: spec.name,
          targetModel: spec.model,
          ...(spec.onApproved === undefined ? {} : { onApproved: spec.onApproved }),
          ...(spec.onRejected === undefined ? {} : { onRejected: spec.onRejected }),
        },
      ]);
      await ref(env, 'approval.level').create(
        spec.levels.map((level, i) => ({
          policy: policy.ids[0],
          sequence: (i + 1) * 10,
          name: level.name,
          condition: level.condition ?? null,
          approverRole: level.approverRole,
        })),
      );
      created += 1;
    }
  return created;
}
