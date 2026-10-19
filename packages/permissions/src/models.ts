/**
 * The approval models (RFC 0003 §5.3): policies and their ordered levels are data (administrators edit them through
 * the generated API, without code); requests are private and change only through the approvals API, which checks
 * the approver, the order of levels and separation of duties.
 */
import { baseShutro } from '@isahaq/kosh-server';
import { type Env, orm } from '@isahaq/kosh-server/orm';

const { defineGroup, defineModel, defineModule, definePermission, f } = orm;

type Row = Record<string, unknown>;
interface Rows {
  readonly ids: readonly number[];
  readonly length: number;
  load(keys: readonly string[]): Promise<{ read(keys: readonly string[]): Row[] }>;
}
const modelOf = (env: Env, name: string) =>
  env.model(name as never) as unknown as {
    search(q: unknown): Promise<Rows>;
    browse(ids: readonly number[]): Rows;
  };

async function readAll(records: unknown, keys: string[]): Promise<Row[]> {
  const set = records as Rows;
  return set.length === 0 ? [] : (await set.load(keys)).read(keys);
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
  access: { 'base.user': ['read'] },
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
    levels: f.one2many('approval.level', 'policy'),
  },
  constraints: {
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
  access: { 'base.user': ['read'] },
  order: ['policy asc', 'sequence asc'],
  fields: {
    policy: f.many2one('approval.policy', { required: true, ondelete: 'cascade' }),
    sequence: f.integer({ default: 10 }),
    name: f.char({ required: true }),
    /** A Shutro domain on the record; empty: the level always applies. Compiled when saved. */
    condition: f.json(),
    /** The group or role whose holders decide (in the record's company). */
    approverRole: f.char({ required: true }),
  },
  constraints: {
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
    approverRole: f.char({ required: true }),
    state: f.selection(
      { pending: 'Pending', approved: 'Approved', rejected: 'Rejected', cancelled: 'Cancelled' },
      { required: true, default: 'pending' },
    ),
    requestedBy: f.many2one('res.users', { ondelete: 'set null' }),
    decidedBy: f.many2one('res.users', { ondelete: 'set null' }),
    decidedAt: f.datetime(),
    comment: f.text(),
  },
});

/** The Shutro module of `@isahaq/kosh-permissions`. */
export const permissionsShutro: ReturnType<typeof orm.defineModule> = defineModule({
  name: 'permissions',
  version: '0.1.0',
  depends: [baseShutro],
  groups: [
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
  models: [ApprovalPolicy, ApprovalLevel, ApprovalRequest],
});
