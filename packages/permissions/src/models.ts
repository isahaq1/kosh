/**
 * The approval models (RFC 0003 §5.3, RFC 0025): policies and their ordered levels are data (administrators edit them
 * through the generated API, without code); requests are private and change only through the approvals API, which
 * checks the approver, the order of levels and separation of duties. A level is decided by a role's holders, named
 * people, the requester's manager or a person on the record — by any one of them, all, or a number —; each
 * decision is a vote; a request may be sent back for changes, which starts a new round when resubmitted.
 */
import { baseShutro } from '@kosh/server';
import { type Env, orm } from '@kosh/server/orm';

const { defineGroup, defineModel, defineModule, definePermission, f } = orm;

type Row = Record<string, unknown>;
interface Rows {
  readonly ids: readonly number[];
  readonly length: number;
  load(
    keys: readonly string[] | Readonly<Record<string, true>>,
  ): Promise<{ read(keys: readonly string[]): Row[] }>;
}
const modelOf = (env: Env, name: string) =>
  env.model(name as never) as unknown as {
    search(q: unknown): Promise<Rows>;
    browse(ids: readonly number[]): Rows;
  };

async function readAll(records: unknown, keys: string[]): Promise<Row[]> {
  const set = records as Rows;
  // A many-to-many is loaded by the object spec (defaults plus the relation) and read as ids.
  const spec = keys.includes('approverUsers')
    ? Object.fromEntries(
        keys
          .filter((k) => k === 'approverUsers' || k === 'extraUsers')
          .map((k) => [k, true as const]),
      )
    : keys;
  return set.length === 0 ? [] : (await set.load(spec)).read(keys);
}

/** The installed model a policy names, or `undefined`. */
function installed(env: Env, name: unknown): boolean {
  if (typeof name !== 'string') return false;
  try {
    env.model(name as never);
    return true;
  } catch {
    return false;
  }
}

const ApprovalPolicy = defineModel('approval.policy', {
  archivable: true,
  access: { 'base.user': ['read'], 'approvals.manager': ['read', 'write', 'create', 'unlink'] },
  order: ['targetModel asc', 'sequence asc'],
  fields: {
    name: f.char({ required: true }),
    targetModel: f.char({ required: true, index: true, label: 'Model' }),
    sequence: f.integer({ default: 10 }),
    /** Empty: every company. */
    company: f.many2one('res.company', { ondelete: 'cascade' }),
    /** A transition of the record run when every level approved (as the system, attributed in the audit log). */
    onApproved: f.char(),
    /** A transition run when a level rejects. */
    onRejected: f.char(),
    /** A transition run when an approver sends the record back for changes (usually back to draft). */
    onSentBack: f.char({ label: 'On sent back' }),
    /** A transition run when the requester withdraws the request. */
    onWithdrawn: f.char({ label: 'On withdrawn' }),
    /** A rejection or a sending back must say why. */
    reasonRequired: f.boolean({ default: true, label: 'Reason required' }),
    /**
     * The records the policy is for, as a Shutro domain on the model (RFC 0025 step 4: a request category's policy
     * covers that category's requests); empty: every record.
     */
    condition: f.json({ label: 'For records where' }),
    /**
     * When a level finds nobody to decide — no person, and no role to stand in (RFC 0027 §2.4): refuse the submission
     * and say why, let administrators decide, or skip the level (recorded as skipped).
     */
    whenNobody: f.selection(
      { refuse: 'Refuse the submission', admins: 'Administrators decide', skip: 'Skip the level' },
      { required: true, default: 'refuse', label: 'When nobody is found' },
    ),
    levels: f.one2many('approval.level', 'policy'),
  },
  constraints: {
    validCondition: {
      depends: ['condition', 'targetModel'],
      check: async (records: never) => {
        const { env, ids } = records as { env: Env; ids: readonly number[] };
        return env.asSuperuser({ reason: 'validate approval policy condition' }, async (su) => {
          const failing: number[] = [];
          for (const row of await readAll(modelOf(su, 'approval.policy').browse(ids), [
            'condition',
            'targetModel',
          ])) {
            const condition = row['condition'];
            if (condition === null || condition === undefined) continue;
            const target = row['targetModel'];
            const ok =
              typeof condition === 'object' &&
              !Array.isArray(condition) &&
              installed(su, target) &&
              (await modelOf(su, String(target))
                .search({ where: condition, limit: 1 })
                .then(() => true)
                .catch(() => false));
            if (!ok) failing.push(row['id'] as number);
          }
          return failing;
        });
      },
      message: 'The policy’s condition is not a valid domain on its model.',
    },
    installedModel: {
      depends: ['targetModel'],
      check: async (records: never) => {
        const { env, ids } = records as { env: Env; ids: readonly number[] };
        // Integrity checks read as the system: they may run at commit, outside the scope that made the change.
        return env.asSuperuser({ reason: 'validate approval policy' }, async (su) => {
          const rows = await readAll(modelOf(su, 'approval.policy').browse(ids), ['targetModel']);
          return rows.filter((r) => !installed(su, r['targetModel'])).map((r) => r['id'] as number);
        });
      },
      message: 'The policy names a model that is not installed.',
    },
  },
});

const ApprovalLevel = defineModel('approval.level', {
  access: { 'base.user': ['read'], 'approvals.manager': ['read', 'write', 'create', 'unlink'] },
  order: ['policy asc', 'sequence asc'],
  fields: {
    policy: f.many2one('approval.policy', { required: true, ondelete: 'cascade' }),
    sequence: f.integer({ default: 10 }),
    name: f.char({ required: true }),
    /** A Shutro domain on the record; empty: the level always applies. Compiled when saved. */
    condition: f.json(),
    /**
     * Who decides: a role's holders (in the record's company), named people, the requester's manager (Workforce),
     * or the person in a field of the record.
     */
    approverKind: f.selection(
      {
        role: 'A role',
        users: 'Named people',
        manager: 'The requester’s manager',
        department_head: 'The head of the requester’s department',
        department_approvers: 'The approvers of the requester’s department',
        field: 'A person on the record',
        record: 'The record decides',
      },
      { required: true, default: 'role', label: 'Approved by' },
    ),
    /** People added to whoever the kind finds (RFC 0027 §2.1). */
    extraUsers: f.many2many('res.users', {
      relation: 'approval_level_extra_user_rel',
      label: 'Also',
    }),
    /** The role (or, for a manager or a field, the role used when there is nobody). */
    approverRole: f.char({ label: 'Role' }),
    approverUsers: f.many2many('res.users', {
      relation: 'approval_level_user_rel',
      label: 'People',
    }),
    /**
     * A many-to-one field of the record to a user (`user`, `project.user`); for "the record decides", the key passed
     * to the model's `approvalUsers(key)` (optional).
     */
    approverField: f.char({ label: 'Field' }),
    /** How many decide: any one, all of them, or a number. */
    quorum: f.selection(
      { any: 'Any one', all: 'All of them', count: 'A number of them' },
      { required: true, default: 'any', label: 'Decided by' },
    ),
    quorumCount: f.integer({ label: 'How many' }),
    /** Hours to decide (empty: no deadline); a reminder at half, then escalation (RFC 0025 §3.3). */
    deadlineHours: f.integer({ label: 'Hours to decide' }),
    /** Who may decide once the deadline passed (besides the approvers). */
    escalateRole: f.char({ label: 'Escalate to (role)' }),
  },
  constraints: {
    // Who decides is complete: a role for roles (and as the fallback of a manager or a field), people for people, a
    // field for a field, a number for a quorum by number.
    approvers: {
      depends: [
        'approverKind',
        'approverRole',
        'approverUsers',
        'approverField',
        'quorum',
        'quorumCount',
      ],
      check: async (records: never) => {
        const { env, ids } = records as { env: Env; ids: readonly number[] };
        return env.asSuperuser({ reason: 'validate approval level' }, async (su) => {
          const rows = await readAll(modelOf(su, 'approval.level').browse(ids), [
            'approverKind',
            'approverRole',
            'approverUsers',
            'approverField',
            'quorum',
            'quorumCount',
          ]);
          return rows
            .filter((r) => {
              const role = typeof r['approverRole'] === 'string' && r['approverRole'] !== '';
              const users = Array.isArray(r['approverUsers']) ? r['approverUsers'].length : 0;
              const kind = r['approverKind'];
              return (
                (kind === 'role' && !role) ||
                (kind === 'users' && users === 0) ||
                (kind === 'field' &&
                  !(typeof r['approverField'] === 'string' && r['approverField'] !== '')) ||
                (r['quorum'] === 'count' && !(Number(r['quorumCount']) >= 1))
              );
            })
            .map((r) => r['id'] as number);
        });
      },
      message:
        'A level names its approvers: a role, people, or a field; a quorum by number needs the number.',
    },
    // A broken condition is refused when saved, not when a user submits a record.
    validCondition: {
      depends: ['condition', 'policy'],
      check: async (records: never) => {
        const { env, ids } = records as { env: Env; ids: readonly number[] };
        const failing: number[] = [];
        await env.asSuperuser({ reason: 'validate approval condition' }, async (su) => {
          const rows = await readAll(modelOf(su, 'approval.level').browse(ids), [
            'condition',
            'policy',
          ]);
          for (const row of rows) {
            const condition = row['condition'];
            if (condition === null || condition === undefined) continue;
            const [policy] = await readAll(
              modelOf(su, 'approval.policy').browse([row['policy'] as number]),
              ['targetModel'],
            );
            const target = policy?.['targetModel'];
            const ok =
              typeof condition === 'object' &&
              !Array.isArray(condition) &&
              installed(su, target) &&
              (await modelOf(su, String(target))
                .search({ where: condition, limit: 1 })
                .then(() => true)
                .catch(() => false));
            if (!ok) failing.push(row['id'] as number);
          }
        });
        return failing;
      },
      message: 'The condition is not a valid domain on the policy model.',
    },
  },
});

const ApprovalRequest = defineModel('approval.request', {
  order: ['targetModel asc', 'targetId asc', 'sequence asc', 'id asc'],
  fields: {
    policy: f.many2one('approval.policy', { ondelete: 'set null' }),
    level: f.many2one('approval.level', { ondelete: 'set null' }),
    levelName: f.char({ required: true }),
    sequence: f.integer({ required: true }),
    targetModel: f.char({ required: true, index: true }),
    targetId: f.integer({ required: true, index: true }),
    company: f.many2one('res.company', { ondelete: 'cascade' }),
    /** The role whose holders decide (empty when named people do). */
    approverRole: f.char(),
    /** The people who decide, when the level names them (empty: the role's holders). */
    approvers: f.many2many('res.users', {
      relation: 'approval_request_user_rel',
      label: 'Approvers',
    }),
    /** How many approvals it needs. */
    required: f.integer({ required: true, default: 1, label: 'Approvals needed' }),
    /** The submission it belongs to (a resubmission after sending back is the next round). */
    round: f.integer({ required: true, default: 1 }),
    votes: f.one2many('approval.vote', 'request'),
    /** When it should be decided by (the level's deadline). */
    dueAt: f.datetime({ label: 'Due' }),
    remindedAt: f.datetime({ label: 'Reminded at' }),
    /** The role that may also decide since the deadline passed. */
    escalatedTo: f.char({ label: 'Escalated to' }),
    escalatedAt: f.datetime({ label: 'Escalated at' }),
    /** When the level's turn came (every lower level approved); the deadline counts from it (RFC 0027 §2.5). */
    startedAt: f.datetime({ label: 'Started' }),
    /** How its approvers were found, written when it was made. */
    explanation: f.text({ label: 'How the approvers were found' }),
    state: f.selection(
      {
        pending: 'Pending',
        approved: 'Approved',
        rejected: 'Rejected',
        sent_back: 'Sent back',
        cancelled: 'Cancelled',
      },
      { required: true, default: 'pending' },
    ),
    requestedBy: f.many2one('res.users', { ondelete: 'set null' }),
    decidedBy: f.many2one('res.users', { ondelete: 'set null' }),
    decidedAt: f.datetime(),
    comment: f.text(),
  },
});

/**
 * The matrix log (RFC 0027 §2.5): every step of a request — made, its turn, votes, decisions, cancelled, skipped,
 * reminded, escalated — with who and a note. Private like requests: read through the record's approvals.
 */
const ApprovalEvent = defineModel('approval.event', {
  order: ['at asc', 'id asc'],
  fields: {
    request: f.many2one('approval.request', { required: true, ondelete: 'cascade', index: true }),
    at: f.datetime({ required: true }),
    user: f.many2one('res.users', { ondelete: 'set null' }),
    kind: f.selection(
      {
        created: 'Created',
        started: 'Its turn',
        voted: 'Voted',
        approved: 'Approved',
        rejected: 'Rejected',
        sent_back: 'Sent back',
        cancelled: 'Cancelled',
        skipped: 'Skipped',
        reminded: 'Reminded',
        escalated: 'Escalated',
      },
      { required: true },
    ),
    note: f.text(),
  },
});

/** One approver's decision on a request (a level decided by several keeps each). */
const ApprovalVote = defineModel('approval.vote', {
  order: ['request asc', 'at asc', 'id asc'],
  fields: {
    request: f.many2one('approval.request', { required: true, ondelete: 'cascade' }),
    user: f.many2one('res.users', { required: true, ondelete: 'restrict' }),
    decision: f.selection(
      { approve: 'Approved', reject: 'Rejected', send_back: 'Sent back' },
      { required: true },
    ),
    comment: f.text(),
    at: f.datetime({ required: true }),
    /** Decided for this approver, who delegated to `user` while away. */
    onBehalfOf: f.many2one('res.users', { ondelete: 'set null', label: 'For' }),
    /** Decided from an email link: the address it came from. */
    ip: f.char({ label: 'From address' }),
  },
  sqlConstraints: {
    once: { unique: ['request', 'user'], message: 'Each approver decides a request once.' },
  },
});

const me = { $env: 'uid' } as const;

/**
 * "While I am away, my approvals go to …" (RFC 0025 §3.3): from one date to another, `delegate` decides what `user`
 * may, in their own name and for them. Each person keeps their own; Approvals managers see all.
 */
const ApprovalDelegation = defineModel('approval.delegation', {
  order: ['dateFrom desc', 'id desc'],
  access: {
    'base.user': ['read', 'write', 'create', 'unlink'],
    'approvals.manager': ['read', 'write', 'create', 'unlink'],
  },
  rules: {
    mine: {
      groups: ['base.user'],
      perms: ['read', 'write', 'create', 'unlink'],
      domain: { or: [{ user: me }, { delegate: me }] },
    },
    all: {
      groups: ['approvals.manager'],
      perms: ['read', 'write', 'create', 'unlink'],
      domain: {},
    },
  },
  fields: {
    user: f.many2one('res.users', {
      required: true,
      ondelete: 'cascade',
      default: (env: Env) => env.uid as never,
      label: 'Away',
    }),
    delegate: f.many2one('res.users', {
      required: true,
      ondelete: 'cascade',
      label: 'Decides instead',
    }),
    dateFrom: f.date({ required: true, label: 'From' }),
    dateTo: f.date({ required: true, label: 'Until' }),
    note: f.char(),
  },
  sqlConstraints: {
    period: {
      check: orm.sql`date_to >= date_from`,
      message: 'A delegation ends on or after it starts.',
    },
    other: { check: orm.sql`delegate_id <> user_id`, message: 'Delegate to someone else.' },
  },
});

/** A one-time link that decides a request from an email (only its digest kept). */
const ApprovalLink = defineModel('approval.link', {
  order: ['id desc'],
  fields: {
    request: f.many2one('approval.request', { required: true, ondelete: 'cascade' }),
    user: f.many2one('res.users', { required: true, ondelete: 'cascade' }),
    tokenHash: f.char({ required: true, index: 'unique' }),
    expiresAt: f.datetime({ required: true }),
    usedAt: f.datetime(),
  },
});

/** The Shutro module of `@kosh/permissions`. */
export const permissionsShutro: ReturnType<typeof orm.defineModule> = defineModule({
  name: 'permissions',
  version: '0.3.0',
  depends: [baseShutro],
  groups: [
    // Who edits approval policies on screen (RFC 0025; administrators always may).
    defineGroup({ code: 'approvals.manager', label: 'Approvals manager', implies: ['base.user'] }),
    defineGroup({
      code: 'permissions.auditor',
      label: 'Security auditor',
      implies: ['base.user'],
    }),
  ],
  permissions: [
    definePermission({
      code: 'permissions.view_audit',
      label: 'Read the security audit log and effective permissions',
      groups: ['permissions.auditor'],
    }),
  ],
  models: [
    ApprovalPolicy,
    ApprovalLevel,
    ApprovalRequest,
    ApprovalEvent,
    ApprovalVote,
    ApprovalDelegation,
    ApprovalLink,
  ],
});
