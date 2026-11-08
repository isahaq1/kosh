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
 * Levels are decided in order (a level waits for the lower ones; levels with the same sequence side by side), by
 * the level's approvers in the record's company — a role's holders, named people, the requester's manager
 * (Workforce; the level's role when there is none) or the person in a field of the record —, by any one of them,
 * all of them or a number (RFC 0025): each decision is a vote. The requester never approves their own record
 * (separation of duties, administrators included). The last approval runs the policy's `onApproved` transition, a
 * rejection its `onRejected` one, sending back for changes its `onSentBack` one (a reason required unless the policy
 * says otherwise), a withdrawal by the requester its `onWithdrawn` one — as the system, attributed in the audit log.
 * A resubmission is the next round; earlier rounds stay as history. Every step is audited and emitted as an event.
 */
import type { KoshModule } from '@kosh/modules-sdk';
import { audit, HttpProblem } from '@kosh/server';
import type { Env } from '@kosh/server/orm';

type Row = Record<string, unknown>;
interface Rows {
  readonly ids: readonly number[];
  readonly length: number;
  load(
    keys: readonly string[] | Readonly<Record<string, true>>,
  ): Promise<{ read(keys: readonly string[]): Row[] }>;
  write(values: unknown): Promise<void>;
}
interface Ref {
  search(q: unknown): Promise<Rows>;
  browse(ids: readonly number[]): Rows;
  create(rows: readonly unknown[]): Promise<Rows>;
}
const ref = (env: Env, name: string): Ref => env.model(name as never) as unknown as Ref;

/** Many-to-many fields read here: loaded by the object spec (defaults plus the relation), read as ids. */
const MANY = new Set([
  'approvers',
  'backups',
  'approverUsers',
  'extraUsers',
  'backupUsers',
  'companies',
]);
const specOf = (keys: readonly string[]): readonly string[] | Readonly<Record<string, true>> =>
  keys.some((k) => MANY.has(k))
    ? Object.fromEntries(keys.filter((k) => MANY.has(k)).map((k) => [k, true as const]))
    : keys;

async function find(env: Env, model: string, where: unknown, keys: string[], order?: string[]) {
  const set = await ref(env, model).search({ where, ...(order === undefined ? {} : { order }) });
  return set.length === 0 ? [] : (await set.load(specOf(keys))).read(keys);
}

const REQUEST_KEYS = [
  'dueAt',
  'backups',
  'startedAt',
  'explanation',
  'escalatedTo',
  'approvers',
  'required',
  'round',
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
  /** The people who decide (empty: the role's holders). */
  readonly approvers: readonly number[];
  /** Backups who may decide it too. */
  readonly backups: readonly number[];
  /** How many approvals it needs, and how many it has. */
  readonly required: number;
  readonly approvals: number;
  readonly round: number;
  /** When it should be decided by, and the role it was escalated to once late. */
  readonly dueAt: string | null;
  readonly escalatedTo: string | null;
  /** When its turn came (null: earlier levels still decide), and how its approvers were found. */
  readonly startedAt: string | null;
  readonly explanation: string | null;
  readonly state: 'pending' | 'approved' | 'rejected' | 'sent_back' | 'cancelled';
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
    approverRole: String(row['approverRole'] ?? ''),
    approvers: Array.isArray(row['approvers']) ? (row['approvers'] as number[]) : [],
    backups: Array.isArray(row['backups']) ? (row['backups'] as number[]) : [],
    required: Number(row['required'] ?? 1),
    approvals: Number(row['approvals'] ?? 0),
    round: Number(row['round'] ?? 1),
    dueAt:
      row['dueAt'] instanceof Date
        ? row['dueAt'].toISOString()
        : typeof row['dueAt'] === 'string'
          ? row['dueAt']
          : null,
    escalatedTo:
      typeof row['escalatedTo'] === 'string' && row['escalatedTo'] !== ''
        ? row['escalatedTo']
        : null,
    startedAt:
      row['startedAt'] instanceof Date
        ? row['startedAt'].toISOString()
        : typeof row['startedAt'] === 'string'
          ? row['startedAt']
          : null,
    explanation: (row['explanation'] as string | null) ?? null,
    state: row['state'] as ApprovalRequestInfo['state'],
    requestedBy: (row['requestedBy'] as number | null) ?? null,
    decidedBy: (row['decidedBy'] as number | null) ?? null,
    decidedAt: at instanceof Date ? at.toISOString() : typeof at === 'string' ? at : null,
    comment: (row['comment'] as string | null) ?? null,
  };
}

/** Requests as the API returns them, each with its count of approvals. */
async function loadRequests(
  su: Env,
  where: unknown,
  order: string[],
): Promise<ApprovalRequestInfo[]> {
  const rows = await find(su, 'approval.request', where, REQUEST_KEYS, order);
  if (rows.length === 0) return [];
  const votes = await find(
    su,
    'approval.vote',
    { request: { in: rows.map((r) => r['id']) }, decision: 'approve' },
    ['request'],
  );
  const count = new Map<number, number>();
  for (const v of votes)
    count.set(v['request'] as number, (count.get(v['request'] as number) ?? 0) + 1);
  return rows.map((r) => info({ ...r, approvals: count.get(r['id'] as number) ?? 0 }));
}

/** The requests of a record's current round (cancelled ones, and earlier rounds, are history). */
async function currentRequests(su: Env, model: string, id: number): Promise<ApprovalRequestInfo[]> {
  const all = await loadRequests(su, { targetModel: model, targetId: id }, [
    'round desc',
    'sequence asc',
    'id asc',
  ]);
  const round = all[0]?.round ?? 0;
  return all
    .filter((r) => r.round === round && r.state !== 'cancelled')
    .sort((a, b) => a.sequence - b.sequence || a.id - b.id);
}

/** The holders of a role in a company (or in every company). */
async function holders(su: Env, role: string, company: number | null): Promise<number[]> {
  const rows = await find(
    su,
    'auth.user_group',
    { group: role, ...(company === null ? {} : { or: [{ company }, { company: null }] }) },
    ['user'],
  );
  return [...new Set(rows.map((r) => r['user'] as number))];
}

/** The user of the requester's manager in Workforce, when it is installed and they have one. */
async function managerOf(su: Env, requester: number): Promise<number | null> {
  try {
    const [me] = await find(su, 'hr.employee', { user: requester }, ['manager'], ['id asc']);
    const manager = me?.['manager'];
    if (typeof manager !== 'number') return null;
    const [boss] = await find(su, 'hr.employee', { id: manager }, ['user']);
    return typeof boss?.['user'] === 'number' ? (boss['user'] as number) : null;
  } catch {
    return null; // Workforce is not installed
  }
}

/** The user in a field of the record (a many-to-one to users), or null. */
async function userIn(su: Env, model: string, id: number, field: string): Promise<number | null> {
  try {
    const [row] = (await ref(su, model).browse([id]).load([field])).read([field]);
    const value = row?.[field];
    return typeof value === 'number' ? value : null;
  } catch {
    return null;
  }
}

/**
 * The user in a field of the requester's employee: the field's employee's user (`unitHead`, `coach`), or the user
 * itself (`expenseApprover`); null when there is none or Workforce is not installed.
 */
async function employeePerson(su: Env, requester: number, field: string): Promise<number | null> {
  let me: Row | undefined;
  try {
    [me] = await find(su, 'hr.employee', { user: requester }, [field], ['id asc']);
  } catch {
    return null;
  }
  const value = me?.[field];
  if (me === undefined || typeof value !== 'number') return null;
  try {
    // A field to an employee: that employee's user.
    const [row] = (await ref(su, 'hr.employee')
      .browse([me['id'] as number])
      .load({ [field]: { user: true } } as never)) as unknown as Record<
      string,
      { user: { id: number } | null } | null
    >[];
    return row?.[field]?.user?.id ?? null;
  } catch {
    // A field to a user: the user.
    return value;
  }
}

/** The requester's employee in Workforce, with its department (null when Workforce is not installed or none). */
async function employeeOf(
  su: Env,
  requester: number,
): Promise<{ name: string; department: number | null } | null> {
  try {
    const [me] = await find(
      su,
      'hr.employee',
      { user: requester },
      ['name', 'department'],
      ['id asc'],
    );
    if (me === undefined) return null;
    return {
      name: String(me['name']),
      department: typeof me['department'] === 'number' ? (me['department'] as number) : null,
    };
  } catch {
    return null;
  }
}

/** The head of a department and its approvers, with its name. */
async function departmentOf(
  su: Env,
  id: number,
): Promise<{ name: string; head: number | null; approvers: number[] }> {
  const set = await ref(su, 'hr.department').search({ where: { id } });
  const [row] =
    set.length === 0
      ? []
      : (await set.load({ approvalUsers: true } as never)).read(['name', 'head', 'approvalUsers']);
  const headEmployee = typeof row?.['head'] === 'number' ? (row['head'] as number) : null;
  const [head] =
    headEmployee === null ? [] : await find(su, 'hr.employee', { id: headEmployee }, ['user']);
  return {
    name: String(row?.['name'] ?? id),
    head: typeof head?.['user'] === 'number' ? (head['user'] as number) : null,
    approvers: Array.isArray(row?.['approvalUsers']) ? (row['approvalUsers'] as number[]) : [],
  };
}

/** The people the record names for a level (its model's `approvalUsers(key)`), or null when it names none. */
async function recordApprovers(
  su: Env,
  model: string,
  id: number,
  key: string,
): Promise<number[] | null> {
  const record = ref(su, model).browse([id]) as unknown as {
    approvalUsers?: (key: string) => Promise<Map<number, readonly number[]>>;
  };
  if (typeof record.approvalUsers !== 'function') return null;
  return [...((await record.approvalUsers(key)).get(id) ?? [])];
}

/** People's names, for explanations. */
async function namesOf(su: Env, ids: readonly number[]): Promise<string> {
  if (ids.length === 0) return 'nobody';
  const rows = await find(su, 'res.users', { id: { in: [...ids] } }, ['name']);
  const by = new Map(rows.map((r) => [r['id'] as number, String(r['name'])]));
  return ids.map((u) => by.get(u) ?? `#${u}`).join(', ');
}

/**
 * Who decides a level, how many approvals it needs and how they were found (RFC 0027 §2.1): named people, the
 * requester's manager, their department's head or approvers, a field's person, the people the record names — plus
 * the level's extra people —; a role's holders for a role, and when all or a number of them must approve. Never the
 * requester. `nobody` when no one can decide (the policy's `whenNobody` decides what then).
 */
async function approversOf(
  su: Env,
  level: Row,
  target: { model: string; id: number; company: number | null },
  requester: number,
): Promise<{
  role: string;
  approvers: number[];
  required: number;
  explanation: string[];
  nobody: boolean;
}> {
  const role = typeof level['approverRole'] === 'string' ? (level['approverRole'] as string) : '';
  const notes: string[] = [];
  let people: number[] = [];
  const kind = String(level['approverKind'] ?? 'role');
  const who = await namesOf(su, [requester]);
  if (kind === 'users') {
    people = (level['approverUsers'] as number[] | undefined) ?? [];
    notes.push(`Named people: ${await namesOf(su, people)}.`);
  } else if (kind === 'manager') {
    const manager = await managerOf(su, requester);
    if (manager !== null) people = [manager];
    notes.push(
      manager === null
        ? `${who} has no manager with a user in Workforce.`
        : `${who}’s manager: ${await namesOf(su, people)}.`,
    );
  } else if (kind === 'department_head' || kind === 'department_approvers') {
    const employee = await employeeOf(su, requester);
    if (employee === null) notes.push(`${who} is not an employee in Workforce.`);
    else if (employee.department === null) notes.push(`${employee.name} has no department.`);
    else {
      const department = await departmentOf(su, employee.department);
      if (kind === 'department_head') {
        if (department.head !== null) people = [department.head];
        notes.push(
          department.head === null
            ? `${department.name} has no head with a user.`
            : `${department.name}’s head: ${await namesOf(su, people)}.`,
        );
      } else {
        people = department.approvers;
        notes.push(`${department.name}’s approvers: ${await namesOf(su, people)}.`);
      }
    }
  } else if (kind === 'employee') {
    // A person on the requester's employee record (RFC 0032 §3.2): their unit head, coach, expense approver…
    const field = String(level['approverField'] ?? '');
    const person = await employeePerson(su, requester, field);
    if (person !== null) people = [person];
    notes.push(
      person === null
        ? `${who} has no ${field} with a user in Workforce.`
        : `${who}’s ${field}: ${await namesOf(su, people)}.`,
    );
  } else if (kind === 'field') {
    const field = String(level['approverField'] ?? '');
    const person = await userIn(su, target.model, target.id, field);
    if (person !== null) people = [person];
    notes.push(`The record’s ${field}: ${await namesOf(su, people)}.`);
  } else if (kind === 'record') {
    const named = await recordApprovers(
      su,
      target.model,
      target.id,
      String(level['approverField'] ?? ''),
    );
    people = named ?? [];
    notes.push(
      named === null
        ? `${target.model} names no approvers.`
        : `Named by the record: ${await namesOf(su, people)}.`,
    );
  }
  // A role decides a role level, and stands in when nobody else was found.
  const roleHolders =
    role === '' ? [] : (await holders(su, role, target.company)).filter((u) => u !== requester);
  const extra = (level['extraUsers'] as number[] | undefined) ?? [];
  if (extra.length > 0) {
    // A role with extra people: its holders by name, beside them.
    if (kind === 'role') {
      people = roleHolders;
      notes.push(`Role ${role}: ${await namesOf(su, roleHolders)}.`);
    }
    people = [...new Set([...people, ...extra])];
    notes.push(`Also: ${await namesOf(su, extra)}.`);
  }
  if (people.includes(requester)) notes.push(`${who} asked, so does not decide.`);
  people = people.filter((u) => u !== requester);
  const quorum = level['quorum'] ?? 'any';
  const byRole = people.length === 0 && role !== '';
  if (byRole) {
    notes.push(
      kind === 'role'
        ? `Role ${role}: ${roleHolders.length} ${roleHolders.length === 1 ? 'person' : 'people'} in the company.`
        : `Instead, role ${role}: ${roleHolders.length} ${roleHolders.length === 1 ? 'person' : 'people'} in the company.`,
    );
    if (roleHolders.length === 0) notes.push('Nobody holds it yet: administrators decide.');
    if (quorum !== 'any') people = roleHolders;
  }
  const count = Math.max(1, Number(level['quorumCount'] ?? 1));
  const required =
    quorum === 'all'
      ? Math.max(1, people.length)
      : quorum === 'count'
        ? Math.min(count, Math.max(1, people.length))
        : 1;
  return {
    role: byRole ? role : '',
    approvers: people,
    required,
    explanation: notes,
    // A role always has someone: administrators decide a role nobody holds yet.
    nobody: people.length === 0 && !byRole,
  };
}

/** A company's segment (RFC 0027 §2.3), or null. */
async function segmentOf(su: Env, company: number | null): Promise<number | null> {
  if (company === null) return null;
  const segments = await find(su, 'res.segment', { active: true }, ['companies']);
  const mine = segments.find((s) =>
    ((s['companies'] as number[] | undefined) ?? []).includes(company),
  );
  return mine === undefined ? null : (mine['id'] as number);
}

/** Whether a policy covers a company: its company, its companies and its segment's together; none: every company. */
function covers(policy: Row, company: number | null, segment: number | null): boolean {
  const one = typeof policy['company'] === 'number' ? (policy['company'] as number) : null;
  const many = Array.isArray(policy['companies']) ? (policy['companies'] as number[]) : [];
  const group = typeof policy['segment'] === 'number' ? (policy['segment'] as number) : null;
  if (one === null && many.length === 0 && group === null) return true;
  if (company === null) return false;
  return one === company || many.includes(company) || (group !== null && group === segment);
}

/** The active policies of a model that cover a company, in order. */
async function policiesFor(
  su: Env,
  model: string,
  company: number | null,
  keys: string[],
): Promise<Row[]> {
  const segment = await segmentOf(su, company);
  const rows = await find(
    su,
    'approval.policy',
    { targetModel: model },
    [...keys, 'company', 'companies', 'segment'],
    ['sequence asc', 'id asc'],
  );
  return rows.filter((p) => covers(p, company, segment));
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
/** Whether record `id` of `model` meets `condition` (a Shutro domain; empty: always). */
async function matches(
  su: Env,
  model: string,
  id: number,
  condition: Row | null,
): Promise<boolean> {
  if (condition === null || Object.keys(condition).length === 0) return true;
  return (
    (await ref(su, model).search({ where: { and: [{ id }, condition] }, limit: 1 })).length > 0
  );
}

/**
 * Which of the last `limit` records of the policy's model each of its levels would have asked about (RFC 0025 step
 * 4: the editor's preview), as the system; the policy's own condition first.
 */
export async function previewPolicy(
  su: Env,
  policyId: number,
  limit = 50,
): Promise<{
  records: number;
  levels: { id: number; name: string; matched: number[] }[];
  covers: { all: boolean; companies: string[] };
}> {
  const [policy] = await find(su, 'approval.policy', { id: policyId }, [
    'targetModel',
    'condition',
    'company',
    'companies',
    'segment',
  ]);
  if (policy === undefined)
    throw new HttpProblem(404, 'missing-record', 'Not found', 'No such policy.');
  const model = String(policy['targetModel']);
  const recent = await ref(su, model).search({
    where: (policy['condition'] as Row | null) ?? {},
    order: ['id desc'],
    limit,
  });
  const ids = recent.ids as unknown as number[];
  const levels = await find(
    su,
    'approval.level',
    { policy: policyId },
    ['name', 'condition'],
    ['sequence asc', 'id asc'],
  );
  const out: { id: number; name: string; matched: number[] }[] = [];
  for (const level of levels) {
    const condition = level['condition'] as Row | null;
    const matched =
      ids.length === 0
        ? []
        : condition === null || Object.keys(condition).length === 0
          ? ids
          : ((await ref(su, model).search({ where: { and: [{ id: { in: ids } }, condition] } }))
              .ids as unknown as number[]);
    out.push({ id: level['id'] as number, name: String(level['name']), matched });
  }
  // The companies it covers: its company, its companies and its segment's, or every company.
  const ids2 = new Set<number>(
    Array.isArray(policy['companies']) ? (policy['companies'] as number[]) : [],
  );
  if (typeof policy['company'] === 'number') ids2.add(policy['company'] as number);
  if (typeof policy['segment'] === 'number')
    for (const s of await find(su, 'res.segment', { id: policy['segment'] }, ['companies']))
      for (const c of (s['companies'] as number[] | undefined) ?? []) ids2.add(c);
  const all =
    ids2.size === 0 &&
    typeof policy['segment'] !== 'number' &&
    typeof policy['company'] !== 'number';
  const names =
    ids2.size === 0
      ? []
      : (await find(su, 'res.company', { id: { in: [...ids2] } }, ['name'], ['name asc'])).map(
          (c) => String(c['name']),
        );
  return { records: ids.length, levels: out, covers: { all, companies: names } };
}

/** Writes steps to the matrix log (RFC 0027 §2.5). */
async function logEvents(
  su: Env,
  events: readonly {
    request: number;
    kind: string;
    user?: number | null;
    note?: string | null;
    at?: Date;
  }[],
): Promise<void> {
  if (events.length === 0) return;
  const at = new Date();
  await ref(su, 'approval.event').create(
    events.map((e) => ({
      request: e.request,
      kind: e.kind,
      user: e.user ?? null,
      note: e.note === undefined || e.note === '' ? null : e.note,
      at: e.at ?? at,
    })),
  );
}

/**
 * Starts the levels whose turn it is and that have not started: `startedAt` now, the deadline counted from it
 * (RFC 0027 §2.5), logged.
 */
async function startTurn(su: Env, model: string, id: number, now: Date): Promise<void> {
  const turn = (await turnOf(su, model, id)).filter((r) => r.startedAt === null);
  if (turn.length === 0) return;
  const rows = await find(su, 'approval.request', { id: { in: turn.map((r) => r.id) } }, ['level']);
  const levelIds = rows.map((r) => r['level']).filter((l): l is number => typeof l === 'number');
  const levels =
    levelIds.length === 0
      ? []
      : await find(su, 'approval.level', { id: { in: levelIds } }, ['deadlineHours']);
  const hours = new Map(levels.map((l) => [l['id'] as number, Number(l['deadlineHours'] ?? 0)]));
  for (const row of rows) {
    const h = typeof row['level'] === 'number' ? (hours.get(row['level'] as number) ?? 0) : 0;
    await ref(su, 'approval.request')
      .browse([row['id'] as number])
      .write({
        startedAt: now,
        ...(h > 0 ? { dueAt: new Date(now.getTime() + h * 3_600_000) } : {}),
      });
  }
  await logEvents(
    su,
    turn.map((r) => ({ request: r.id, kind: 'started', at: now })),
  );
  await skipDuplicates(su, model, id, turn, now);
}

/**
 * Skip approvers who already approved (RFC 0027 §2.2): for the levels just started, under a policy that asks for it,
 * the approval of someone who approved an earlier level of this round counts here too — a vote marked `auto` —;
 * a level that reaches its quorum this way is approved and the next turn starts (the record approved when it was
 * the last).
 */
async function skipDuplicates(
  su: Env,
  model: string,
  id: number,
  started: readonly ApprovalRequestInfo[],
  now: Date,
): Promise<void> {
  const policyIds = [
    ...new Set(started.map((r) => r.policy).filter((p): p is number => p !== null)),
  ];
  if (policyIds.length === 0) return;
  const skipping = new Set(
    (
      await find(su, 'approval.policy', { id: { in: policyIds }, skipDuplicates: true }, ['id'])
    ).map((p) => p['id'] as number),
  );
  if (skipping.size === 0) return;
  const round = await currentRequests(su, model, id);
  const earlier = round.filter((r) => r.state === 'approved');
  if (earlier.length === 0) return;
  const votes = await find(
    su,
    'approval.vote',
    { request: { in: earlier.map((r) => r.id) }, decision: 'approve' },
    ['request', 'user'],
  );
  let approvedAny = false;
  for (const request of started) {
    if (request.policy === null || !skipping.has(request.policy)) continue;
    const already = new Set(
      (await find(su, 'approval.vote', { request: request.id }, ['user'])).map(
        (v) => v['user'] as number,
      ),
    );
    const allowed = new Set([
      ...request.approvers,
      ...request.backups,
      ...(request.approvers.length === 0 && request.approverRole !== ''
        ? await holders(su, request.approverRole, request.company)
        : []),
    ]);
    let approvals = request.approvals;
    let last: number | null = null;
    for (const v of votes) {
      const user = v['user'] as number;
      if (approvals >= request.required) break;
      if (user === request.requestedBy || already.has(user) || !allowed.has(user)) continue;
      const level = earlier.find((r) => r.id === v['request'])?.levelName ?? '';
      await ref(su, 'approval.vote').create([
        {
          request: request.id,
          user,
          decision: 'approve',
          comment: `Approved already at ${level}.`,
          at: now,
          auto: true,
        },
      ]);
      await logEvents(su, [
        { request: request.id, kind: 'auto', user, note: `Approved already at ${level}.`, at: now },
      ]);
      already.add(user);
      approvals += 1;
      last = user;
    }
    if (approvals >= request.required && last !== null) {
      await ref(su, 'approval.request')
        .browse([request.id])
        .write({ state: 'approved', decidedBy: last, decidedAt: now });
      approvedAny = true;
    }
  }
  if (!approvedAny) return;
  const after = await currentRequests(su, model, id);
  if (after.every((r) => r.state === 'approved')) {
    await su.emit('approval.decided', { model, id, state: 'approved', final: true });
    for (const pid of new Set(after.map((r) => r.policy).filter((p) => p !== null))) {
      const [policy] = await find(su, 'approval.policy', { id: pid }, ['onApproved']);
      await runTransition(su, { model, id }, policy?.['onApproved']);
    }
    return;
  }
  await su.emit('approval.decided', { model, id, state: 'approved', final: false });
  await startTurn(su, model, id, now);
}

/** The matrix log of a record's requests, when `env` may read the record. */
export async function eventsOf(
  env: Env,
  model: string,
  id: number,
): Promise<
  {
    id: number;
    request: number;
    at: string;
    user: number | null;
    kind: string;
    note: string | null;
  }[]
> {
  await ref(env, model).browse([id]).load(['id']); // as the caller: ACL and rules decide
  return env.asSuperuser({ reason: 'approval log' }, async (su) => {
    const requests = await find(su, 'approval.request', { targetModel: model, targetId: id }, [
      'id',
    ]);
    if (requests.length === 0) return [];
    const rows = await find(
      su,
      'approval.event',
      { request: { in: requests.map((r) => r['id']) } },
      ['request', 'at', 'user', 'kind', 'note'],
      ['at asc', 'id asc'],
    );
    return rows.map((r) => ({
      id: r['id'] as number,
      request: r['request'] as number,
      at: r['at'] instanceof Date ? r['at'].toISOString() : String(r['at']),
      user: (r['user'] as number | null) ?? null,
      kind: String(r['kind']),
      note: (r['note'] as string | null) ?? null,
    }));
  });
}

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
      if (stale.length > 0) {
        await stale.write({ state: 'cancelled' });
        await logEvents(
          su,
          stale.ids.map((request) => ({
            request,
            kind: 'cancelled',
            user: requester,
            note: 'Submitted again.',
          })),
        );
      }
      const [last] = await find(
        su,
        'approval.request',
        { targetModel: modelName, targetId: id },
        ['round'],
        ['round desc'],
      );
      const round = Number(last?.['round'] ?? 0) + 1;
      const company = (await companyOf(su, modelName, id)) ?? env.companyId;
      const policies = await policiesFor(su, modelName, company, [
        'name',
        'condition',
        'whenNobody',
      ]);
      const rows: Row[] = [];
      for (const policy of policies) {
        // A policy for some records only (a request category's): the record must match its condition.
        if (!(await matches(su, modelName, id, policy['condition'] as Row | null))) continue;
        const levels = await find(
          su,
          'approval.level',
          { policy: policy['id'] },
          [
            'sequence',
            'name',
            'condition',
            'approverKind',
            'approverRole',
            'approverUsers',
            'extraUsers',
            'backupUsers',
            'approverField',
            'quorum',
            'quorumCount',
            'deadlineHours',
          ],
          ['sequence asc', 'id asc'],
        );
        for (const level of levels) {
          if (!(await matches(su, modelName, id, level['condition'] as Row | null))) continue;
          const who = await approversOf(su, level, { model: modelName, id, company }, requester);
          const whenNobody = String(policy['whenNobody'] ?? 'refuse');
          if (who.nobody && whenNobody === 'refuse')
            refuse(
              422,
              'no-approver',
              'Nobody to approve',
              `Nobody can decide the level “${String(level['name'])}” of “${String(policy['name'])}”. ${who.explanation.join(' ')}`,
              'Set who approves (Workforce: the manager or the department), or change the approval policy.',
            );
          const skipped = who.nobody && whenNobody === 'skip';
          rows.push({
            policy: policy['id'],
            level: level['id'],
            levelName: level['name'],
            sequence: level['sequence'],
            targetModel: modelName,
            targetId: id,
            company,
            approverRole: who.role,
            approvers: { set: who.approvers },
            backups: {
              set: ((level['backupUsers'] as number[] | undefined) ?? []).filter(
                (u) => u !== requester,
              ),
            },
            required: who.required,
            round,
            explanation: [
              ...who.explanation,
              ...(((level['backupUsers'] as number[] | undefined) ?? []).length > 0
                ? [
                    `Backups: ${await namesOf(
                      su,
                      (level['backupUsers'] as number[]).filter((u) => u !== requester),
                    )}.`,
                  ]
                : []),
              ...(skipped ? ['Nobody could decide: the level is skipped.'] : []),
            ].join(' '),
            ...(skipped ? { state: 'approved', decidedAt: new Date() } : {}),
            requestedBy: requester,
          });
        }
      }
      if (rows.length === 0) continue;
      const made = await ref(su, 'approval.request').create(rows);
      created += rows.length;
      const now = new Date();
      await logEvents(
        su,
        made.ids.map((request, i) => ({
          request,
          kind: rows[i]?.['state'] === 'approved' ? 'skipped' : 'created',
          user: requester,
          note: String(rows[i]?.['explanation'] ?? ''),
          at: now,
        })),
      );
      await startTurn(su, modelName, id, now);
      // Every level skipped (nobody to ask, the policy says skip): approved now.
      if (rows.every((r) => r['state'] === 'approved'))
        for (const pid of new Set(rows.map((r) => r['policy'] as number))) {
          const [policy] = await find(su, 'approval.policy', { id: pid }, ['onApproved']);
          await runTransition(su, { model: modelName, id }, policy?.['onApproved']);
        }
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
        roles: [...new Set(rows.map((r) => r['approverRole']).filter((r) => r !== ''))],
        users: [...new Set(rows.flatMap((r) => (r['approvers'] as { set: number[] }).set))],
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
): Promise<'none' | 'pending' | 'approved' | 'rejected' | 'sent_back'> {
  const requests = await env.asSuperuser({ reason: 'approval state' }, (su) =>
    currentRequests(su, model, id),
  );
  if (requests.length === 0) return 'none';
  if (requests.some((r) => r.state === 'rejected')) return 'rejected';
  if (requests.some((r) => r.state === 'sent_back')) return 'sent_back';
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
    if (state === 'pending' || state === 'rejected' || state === 'sent_back') blocked.push(id);
  }
  return blocked;
}

function refuse(status: number, type: string, title: string, detail: string, hint?: string): never {
  throw new HttpProblem(status, type, title, detail, hint);
}

/** A user deciding: their groups, and who delegated their approvals to them today (with those people's roles). */
export interface Who {
  readonly uid: number;
  readonly administrator: boolean;
  readonly groups: ReadonlySet<string>;
  readonly companyId: number | null;
  readonly delegators: readonly {
    readonly user: number;
    readonly roles: readonly { readonly group: string; readonly company: number | null }[];
  }[];
}

/** `env`'s user as a decider (RFC 0025 §3.3: delegations active today count). */
export async function whoIs(su: Env, env: Env): Promise<Who> {
  const today = env.today();
  const delegations = await find(
    su,
    'approval.delegation',
    { delegate: env.uid, dateFrom: { lte: today }, dateTo: { gte: today } },
    ['user'],
  );
  const users = [...new Set(delegations.map((d) => d['user'] as number))];
  const groups =
    users.length === 0
      ? []
      : await find(su, 'auth.user_group', { user: { in: users } }, ['user', 'group', 'company']);
  return {
    uid: env.uid as number,
    administrator: env.administrator,
    groups: env.groups,
    companyId: (env.companyId as number | undefined) ?? null,
    delegators: users.map((user) => ({
      user,
      roles: groups
        .filter((g) => g['user'] === user)
        .map((g) => ({
          group: String(g['group']),
          company: (g['company'] as number | null) ?? null,
        })),
    })),
  };
}

const holds = (roles: Who['delegators'][number]['roles'], role: string, company: number | null) =>
  role !== '' &&
  roles.some(
    (r) => r.group === role && (r.company === null || company === null || r.company === company),
  );

/**
 * Whether `who` may decide `request` as an approver: as themselves (`{ for: null }`) — named, holding the role, or
 * the escalation role once it is late —, or for someone away who delegated to them (`{ for: <user> }`); null when not.
 */
function approverFor(who: Who, request: ApprovalRequestInfo): { for: number | null } | null {
  if (request.approvers.includes(who.uid) || request.backups.includes(who.uid))
    return { for: null };
  if (request.approvers.length === 0 && (who.administrator || who.groups.has(request.approverRole)))
    return { for: null };
  if (request.escalatedTo !== null && (who.administrator || who.groups.has(request.escalatedTo)))
    return { for: null };
  for (const d of who.delegators) {
    if (d.user === request.requestedBy) continue;
    if (request.approvers.includes(d.user) || request.backups.includes(d.user))
      return { for: d.user };
    if (request.approvers.length === 0 && holds(d.roles, request.approverRole, request.company))
      return { for: d.user };
    if (request.escalatedTo !== null && holds(d.roles, request.escalatedTo, request.company))
      return { for: d.user };
  }
  return null;
}

/**
 * Why `env`'s user may not decide `request` now — its turn, its approvers (or role), its company, not the requester,
 * not decided by them already —, or null when they may.
 */
function mayDecide(
  who: Who,
  request: ApprovalRequestInfo,
  round: readonly ApprovalRequestInfo[],
  decided: ReadonlyMap<number, ReadonlySet<number>> = new Map(),
): { reason: string | null; onBehalfOf: number | null } {
  const no = (reason: string) => ({ reason, onBehalfOf: null });
  if (request.state !== 'pending') return no('decided');
  if (round.some((r) => r.sequence < request.sequence && r.state !== 'approved'))
    return no('not-your-turn');
  if (request.requestedBy === who.uid) return no('separation-of-duties');
  if (request.company !== null && request.company !== who.companyId) return no('other-company');
  const as = approverFor(who, request);
  if (as === null) return no('not-approver');
  const done = decided.get(request.id) ?? new Set();
  if (done.has(who.uid) || (as.for !== null && done.has(as.for))) return no('voted');
  return { reason: null, onBehalfOf: as.for };
}

/** Who has decided each request of `ids` already (the voters, and those they decided for). */
async function decidedOn(su: Env, ids: readonly number[]): Promise<Map<number, Set<number>>> {
  const out = new Map<number, Set<number>>();
  if (ids.length === 0) return out;
  for (const v of await find(su, 'approval.vote', { request: { in: [...ids] } }, [
    'request',
    'user',
    'onBehalfOf',
  ])) {
    const set = out.get(v['request'] as number) ?? new Set<number>();
    set.add(v['user'] as number);
    if (typeof v['onBehalfOf'] === 'number') set.add(v['onBehalfOf'] as number);
    out.set(v['request'] as number, set);
  }
  return out;
}

export type Decision = 'approve' | 'reject' | 'send_back';

/**
 * Decides a request as `env`'s user: approves (the request is approved once it has the approvals it needs), rejects
 * or sends back for changes (with a reason, unless the policy says otherwise; the other open requests of the round are
 * cancelled). @throws {HttpProblem} 404 unknown, 409 decided / not its turn / decided by them already, 403 not an
 * approver, the requester, or another company, 422 a reason missing
 */
export async function decide(
  env: Env,
  requestId: number,
  decision: Decision,
  comment?: string,
  from?: { readonly ip?: string },
): Promise<ApprovalRequestInfo> {
  const actor = env.uid;
  return env.asSuperuser({ reason: `${decision} approval ${requestId}` }, async (su) => {
    const [request] = await loadRequests(su, { id: requestId }, ['id asc']);
    if (request === undefined)
      refuse(404, 'missing-record', 'Not found', `No approval request ${requestId}.`);
    const round = await currentRequests(su, request.targetModel, request.targetId);
    const who = await whoIs(su, env);
    const { reason, onBehalfOf } = mayDecide(
      who,
      request,
      round,
      await decidedOn(su, [request.id]),
    );
    if (reason === 'decided' || request.state === 'cancelled')
      refuse(409, 'approval-decided', 'Already decided', `This request is ${request.state}.`);
    if (reason === 'voted')
      refuse(409, 'approval-voted', 'Already decided by you', 'Another approver decides the rest.');
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
        request.approvers.length > 0
          ? 'This request is decided by the people it names.'
          : `Approving needs the role ${request.approverRole} in this company.`,
      );
    const [policy] =
      request.policy === null
        ? []
        : await find(su, 'approval.policy', { id: request.policy }, [
            'onApproved',
            'onRejected',
            'onSentBack',
            'reasonRequired',
          ]);
    const text = comment?.trim() ?? '';
    if (decision !== 'approve' && policy?.['reasonRequired'] !== false && text === '')
      refuse(
        422,
        'reason-required',
        'Say why',
        decision === 'reject' ? 'A rejection says why.' : 'Say what to change.',
      );
    await ref(su, 'approval.vote').create([
      {
        request: request.id,
        user: actor,
        decision,
        comment: text === '' ? null : text,
        at: new Date(),
        onBehalfOf,
        ip: from?.ip ?? null,
        asBackup:
          onBehalfOf === null &&
          request.backups.includes(actor) &&
          !request.approvers.includes(actor),
      },
    ]);
    const approvals = request.approvals + (decision === 'approve' ? 1 : 0);
    const state =
      decision === 'reject'
        ? 'rejected'
        : decision === 'send_back'
          ? 'sent_back'
          : approvals >= request.required
            ? 'approved'
            : 'pending';
    const target = { model: request.targetModel, id: request.targetId };
    await ref(su, 'approval.request')
      .browse([request.id])
      .write({
        state,
        ...(state === 'pending'
          ? {}
          : { decidedBy: actor, decidedAt: new Date(), comment: text === '' ? null : text }),
      });
    await logEvents(su, [
      {
        request: request.id,
        kind: state === 'pending' ? 'voted' : state,
        user: actor,
        note:
          [onBehalfOf === null ? '' : `For user ${onBehalfOf}.`, text]
            .filter((x) => x !== '')
            .join(' ') || null,
      },
    ]);
    if (state === 'rejected' || state === 'sent_back') {
      const open = round
        .filter((r) => r.id !== request.id && r.state === 'pending')
        .map((r) => r.id);
      if (open.length > 0) {
        await ref(su, 'approval.request').browse(open).write({ state: 'cancelled' });
        await logEvents(
          su,
          open.map((id) => ({
            request: id,
            kind: 'cancelled',
            user: actor,
            note: `${request.levelName} ${state === 'rejected' ? 'rejected' : 'sent back'}.`,
          })),
        );
      }
    }
    const done =
      state === 'rejected' ||
      state === 'sent_back' ||
      (state === 'approved' && round.every((r) => r.id === request.id || r.state === 'approved'));
    await audit(su, {
      kind: `approval.${state === 'pending' ? 'voted' : state}`,
      summary: `${request.levelName} ${decision === 'send_back' ? 'sent back' : `${decision}d`} for ${target.model} ${target.id}.`,
      actor,
      company: request.company,
      targetModel: target.model,
      targetId: target.id,
      details: {
        request: request.id,
        comment: text === '' ? null : text,
        approvals,
        required: request.required,
        onBehalfOf,
        ip: from?.ip ?? null,
      },
    });
    if (state === 'approved' && !done) await startTurn(su, target.model, target.id, new Date());
    await su.emit('approval.decided', { ...target, request: request.id, state, final: done });
    if (done && policy !== undefined) {
      const key =
        state === 'approved' ? 'onApproved' : state === 'rejected' ? 'onRejected' : 'onSentBack';
      await runTransition(su, target, policy[key]);
    }
    const [after] = await loadRequests(su, { id: request.id }, ['id asc']);
    return after as ApprovalRequestInfo;
  });
}

/** Runs a policy's transition on the record (as the system), when it names one. */
async function runTransition(
  su: Env,
  target: { model: string; id: number },
  transition: unknown,
): Promise<void> {
  if (typeof transition !== 'string' || transition === '') return;
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

/**
 * The requester withdraws the pending requests of their record's current round; the policy's `onWithdrawn`
 * transition runs. @throws {HttpProblem} 404 when nothing is pending, 403 when they did not ask
 */
export async function withdraw(env: Env, model: string, id: number): Promise<number> {
  await ref(env, model).browse([id]).load(['id']); // as the caller: ACL and rules decide
  const actor = env.uid;
  return env.asSuperuser({ reason: `withdraw approvals of ${model} ${id}` }, async (su) => {
    const pending = (await currentRequests(su, model, id)).filter((r) => r.state === 'pending');
    if (pending.length === 0)
      refuse(404, 'missing-record', 'Nothing to withdraw', 'No approval is pending.');
    if (!env.administrator && pending.some((r) => r.requestedBy !== actor))
      refuse(403, 'access', 'Not yours', 'Only who asked for the approvals withdraws them.');
    await ref(su, 'approval.request')
      .browse(pending.map((r) => r.id))
      .write({ state: 'cancelled' });
    await logEvents(
      su,
      pending.map((r) => ({ request: r.id, kind: 'cancelled', user: actor, note: 'Withdrawn.' })),
    );
    await audit(su, {
      kind: 'approval.withdrawn',
      summary: `Approvals withdrawn for ${model} ${id}.`,
      actor,
      company: pending[0]?.company ?? null,
      targetModel: model,
      targetId: id,
      details: { requests: pending.map((r) => r.id) },
    });
    await su.emit('approval.decided', { model, id, state: 'withdrawn', final: true });
    const policyIds = [
      ...new Set(pending.map((r) => r.policy).filter((p): p is number => p !== null)),
    ];
    for (const pid of policyIds) {
      const [policy] = await find(su, 'approval.policy', { id: pid }, ['onWithdrawn']);
      await runTransition(su, { model, id }, policy?.['onWithdrawn']);
    }
    return pending.length;
  });
}

const managesApprovals = (env: Env): boolean =>
  env.administrator || env.groups.has('approvals.manager');

/**
 * Reassigns a pending request (RFC 0027 §2.6), for Approvals managers: its approvers replaced by `users`, or `users`
 * added to them (a role's holders named first); never the requester; a reason required; logged, audited and
 * announced (`approval.reassigned`, with the people added). @throws {HttpProblem} 403 / 404 / 409 / 422
 */
export async function reassign(
  env: Env,
  requestId: number,
  users: readonly number[],
  mode: 'replace' | 'add',
  reason: string,
): Promise<ApprovalRequestInfo> {
  if (!managesApprovals(env))
    refuse(403, 'access', 'Approvals managers', 'Reassigning needs the Approvals manager role.');
  const text = reason.trim();
  if (text === '') refuse(422, 'reason-required', 'Say why', 'A reassignment says why.');
  const actor = env.uid;
  return env.asSuperuser({ reason: `reassign approval ${requestId}` }, async (su) => {
    const [request] = await loadRequests(su, { id: requestId }, ['id asc']);
    if (request === undefined)
      refuse(404, 'missing-record', 'Not found', `No approval request ${requestId}.`);
    if (request.state !== 'pending')
      refuse(409, 'approval-decided', 'Already decided', `This request is ${request.state}.`);
    const chosen = [...new Set(users)];
    if (chosen.length === 0) refuse(422, 'validation', 'Nobody chosen', 'Choose who decides.');
    if (request.requestedBy !== null && chosen.includes(request.requestedBy))
      refuse(
        422,
        'separation-of-duties',
        'Separation of duties',
        'The requester cannot approve their own record.',
      );
    const found = await find(su, 'res.users', { id: { in: chosen } }, ['id']);
    if (found.length !== chosen.length)
      refuse(422, 'validation', 'Unknown people', 'Every person must be a user.');
    const before =
      request.approvers.length > 0
        ? [...request.approvers]
        : request.approverRole === ''
          ? []
          : (await holders(su, request.approverRole, request.company)).filter(
              (u) => u !== request.requestedBy,
            );
    const next = mode === 'replace' ? chosen : [...new Set([...before, ...chosen])];
    const required = Math.min(request.required, Math.max(1, next.length));
    await ref(su, 'approval.request')
      .browse([request.id])
      .write({ approvers: { set: next }, required });
    const note = `${await namesOf(su, before)} → ${await namesOf(su, next)}. ${text}`;
    await logEvents(su, [{ request: request.id, kind: 'reassigned', user: actor, note }]);
    await audit(su, {
      kind: 'approval.reassigned',
      summary: `${request.levelName} reassigned for ${request.targetModel} ${request.targetId}.`,
      actor,
      company: request.company,
      targetModel: request.targetModel,
      targetId: request.targetId,
      details: { request: request.id, before, after: next, reason: text },
    });
    const added = next.filter((u) => !before.includes(u));
    if (added.length > 0 && request.startedAt !== null)
      await su.emit('approval.reassigned', { request: request.id, users: added });
    const [after] = await loadRequests(su, { id: request.id }, ['id asc']);
    return after as ApprovalRequestInfo;
  });
}

/**
 * Tells a current request's backups that it waits (RFC 0027 §2.6): for Approvals managers and the request's
 * approvers; logged and announced (`approval.backups`). @throws {HttpProblem} 403 / 404 / 409
 */
export async function notifyBackups(env: Env, requestId: number): Promise<number> {
  const actor = env.uid;
  return env.asSuperuser({ reason: `notify backups of approval ${requestId}` }, async (su) => {
    const [request] = await loadRequests(su, { id: requestId }, ['id asc']);
    if (request === undefined)
      refuse(404, 'missing-record', 'Not found', `No approval request ${requestId}.`);
    if (!managesApprovals(env) && !request.approvers.includes(actor))
      refuse(403, 'access', 'Not an approver', 'Approvers and Approvals managers tell backups.');
    if (request.state !== 'pending' || request.startedAt === null)
      refuse(409, 'approval-not-current', 'Not waiting', 'Only a request whose turn it is.');
    if (request.backups.length === 0)
      refuse(409, 'no-backups', 'No backups', 'This level has no backups.');
    await logEvents(su, [
      {
        request: request.id,
        kind: 'notified',
        user: actor,
        note: await namesOf(su, request.backups),
      },
    ]);
    await su.emit('approval.backups', { request: request.id, users: [...request.backups] });
    return request.backups.length;
  });
}

/** The fields of a level that decide its approvers: a change to one is synced to its waiting requests. */
export const APPROVER_KEYS: readonly string[] = [
  'approverKind',
  'approverRole',
  'approverUsers',
  'extraUsers',
  'backupUsers',
  'approverField',
  'quorum',
  'quorumCount',
];

/**
 * Keeps waiting requests in step with their levels (RFC 0027 §2.6), as the system: each pending request of these
 * levels gets its approvers found again — added to the ones it has, or replacing them, as its policy says (`mode`
 * overrides it, for "Sync now") — logged when they change. Returns what changed, with the people added to requests
 * whose turn it is (to tell, when the policy says so).
 */
export async function syncLevels(
  su: Env,
  levelIds: readonly number[],
  mode?: 'add' | 'replace',
): Promise<{ request: ApprovalRequestInfo; added: number[]; notify: boolean }[]> {
  const out: { request: ApprovalRequestInfo; added: number[]; notify: boolean }[] = [];
  if (levelIds.length === 0) return out;
  const levels = await find(su, 'approval.level', { id: { in: [...levelIds] } }, [
    'policy',
    'name',
    'approverKind',
    'approverRole',
    'approverUsers',
    'extraUsers',
    'backupUsers',
    'approverField',
    'quorum',
    'quorumCount',
  ]);
  for (const level of levels) {
    const [policy] = await find(su, 'approval.policy', { id: level['policy'] }, [
      'syncPending',
      'notifyOnSync',
    ]);
    const how = mode ?? (String(policy?.['syncPending'] ?? 'add') as 'off' | 'add' | 'replace');
    if (how === 'off') continue;
    const pending = await loadRequests(su, { level: level['id'], state: 'pending' }, ['id asc']);
    for (const request of pending) {
      const requester = request.requestedBy ?? 0;
      const who = await approversOf(
        su,
        level,
        { model: request.targetModel, id: request.targetId, company: request.company },
        requester,
      );
      const levelBackups = ((level['backupUsers'] as number[] | undefined) ?? []).filter(
        (u) => u !== requester,
      );
      const approvers =
        how === 'add'
          ? [...new Set([...request.approvers, ...who.approvers])]
          : who.approvers.length > 0 || who.role !== ''
            ? who.approvers
            : request.approvers;
      const backups =
        how === 'add' ? [...new Set([...request.backups, ...levelBackups])] : levelBackups;
      const same = (a: readonly number[], b: readonly number[]) =>
        a.length === b.length && a.every((x) => b.includes(x));
      const role = how === 'replace' ? who.role : request.approverRole;
      if (
        same(approvers, request.approvers) &&
        same(backups, request.backups) &&
        role === request.approverRole
      )
        continue;
      await ref(su, 'approval.request')
        .browse([request.id])
        .write({
          approvers: { set: approvers },
          backups: { set: backups },
          approverRole: role,
          required: how === 'replace' ? who.required : request.required,
          explanation: who.explanation.join(' '),
        });
      await logEvents(su, [
        {
          request: request.id,
          kind: 'synced',
          note: `${how === 'add' ? 'Added' : 'Replaced'}: ${await namesOf(su, approvers)}${backups.length > 0 ? `; backups: ${await namesOf(su, backups)}` : ''}.`,
        },
      ]);
      const [after] = await loadRequests(su, { id: request.id }, ['id asc']);
      if (after === undefined) continue;
      const added = [
        ...approvers.filter((u) => !request.approvers.includes(u)),
        ...backups.filter((u) => !request.backups.includes(u)),
      ];
      out.push({
        request: after,
        added: request.startedAt === null ? [] : added,
        notify: policy?.['notifyOnSync'] !== false,
      });
    }
  }
  return out;
}

/** A request as the Approvals app shows it (RFC 0025 §3.1): the record, who asked, since when, every level. */
export interface ApprovalCard {
  readonly id: number;
  readonly levelName: string;
  readonly state: ApprovalRequestInfo['state'];
  readonly round: number;
  readonly approvals: number;
  readonly required: number;
  readonly waitingSince: string;
  readonly decidedAt: string | null;
  /** When it should be decided by, and the role it was escalated to once late. */
  readonly dueAt: string | null;
  readonly escalatedTo: string | null;
  readonly comment: string | null;
  readonly record: {
    readonly model: string;
    readonly id: number;
    readonly name: string;
    readonly label: string;
  };
  readonly requester: { readonly id: number; readonly name: string } | null;
  readonly steps: readonly {
    id: number;
    levelName: string;
    sequence: number;
    state: ApprovalRequestInfo['state'];
    approvals: number;
    required: number;
  }[];
}

/** `purchase.order` as people say it: "Purchase order". */
const labelOf = (model: string): string => {
  const words = model.replace(/[._]/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** Cards of `requests` (the records' names, the requesters, each round's steps), as the system. */
async function cardsOf(
  su: Env,
  requests: readonly ApprovalRequestInfo[],
  overrides: ReadonlyMap<
    number,
    { state?: ApprovalCard['state']; decidedAt?: string; comment?: string | null }
  > = new Map(),
): Promise<ApprovalCard[]> {
  if (requests.length === 0) return [];
  const names = new Map<string, string>();
  for (const model of new Set(requests.map((r) => r.targetModel))) {
    const ids = [
      ...new Set(requests.filter((r) => r.targetModel === model).map((r) => r.targetId)),
    ];
    try {
      for (const row of (await ref(su, model).browse(ids).load(['displayName'])).read([
        'displayName',
      ]))
        names.set(`${model}:${row['id']}`, String(row['displayName'] ?? ''));
    } catch {
      // a model no longer installed: its records are named by id
    }
  }
  const users = new Map<number, string>();
  const askers = [
    ...new Set(requests.map((r) => r.requestedBy).filter((u): u is number => u !== null)),
  ];
  if (askers.length > 0)
    for (const row of (await ref(su, 'res.users').browse(askers).load(['name'])).read(['name']))
      users.set(row['id'] as number, String(row['name'] ?? ''));
  const created = new Map<number, string>();
  for (const row of await find(su, 'approval.request', { id: { in: requests.map((r) => r.id) } }, [
    'createdAt',
  ]))
    created.set(
      row['id'] as number,
      row['createdAt'] instanceof Date ? row['createdAt'].toISOString() : String(row['createdAt']),
    );
  const rounds = new Map<string, ApprovalRequestInfo[]>();
  const out: ApprovalCard[] = [];
  for (const r of requests) {
    const key = `${r.targetModel}:${r.targetId}:${r.round}`;
    let steps = rounds.get(key);
    if (steps === undefined) {
      steps = (
        await loadRequests(
          su,
          { targetModel: r.targetModel, targetId: r.targetId, round: r.round },
          ['sequence asc', 'id asc'],
        )
      ).filter((x) => x.state !== 'cancelled' || x.id === r.id);
      rounds.set(key, steps);
    }
    const o = overrides.get(r.id) ?? {};
    out.push({
      id: r.id,
      levelName: r.levelName,
      state: o.state ?? r.state,
      round: r.round,
      approvals: r.approvals,
      required: r.required,
      waitingSince: created.get(r.id) ?? new Date().toISOString(),
      decidedAt: o.decidedAt ?? r.decidedAt,
      dueAt: r.dueAt,
      escalatedTo: r.escalatedTo,
      comment: o.comment === undefined ? r.comment : o.comment,
      record: {
        model: r.targetModel,
        id: r.targetId,
        name: names.get(`${r.targetModel}:${r.targetId}`) || `#${r.targetId}`,
        label: labelOf(r.targetModel),
      },
      requester:
        r.requestedBy === null ? null : { id: r.requestedBy, name: users.get(r.requestedBy) ?? '' },
      steps: steps.map((x) => ({
        id: x.id,
        levelName: x.levelName,
        sequence: x.sequence,
        state: x.state,
        approvals: x.approvals,
        required: x.required,
      })),
    });
  }
  return out;
}

/**
 * The Approvals app's lists (RFC 0025 §3.1): `inbox` — what waits for the user's decision, oldest first —, `mine`
 * — the records they asked approvals for, the latest round of each, where it stands —, `history` — what they decided,
 * newest first.
 */
export async function approvalCards(
  env: Env,
  list: 'inbox' | 'mine' | 'history',
): Promise<ApprovalCard[]> {
  if (list === 'inbox') {
    const waiting = await inbox(env);
    return env.asSuperuser({ reason: 'approval cards' }, (su) => cardsOf(su, waiting));
  }
  const me = env.uid as number;
  return env.asSuperuser({ reason: 'approval cards' }, async (su) => {
    if (list === 'mine') {
      const asked = await loadRequests(su, { requestedBy: me }, [
        'round desc',
        'sequence asc',
        'id asc',
      ]);
      // One card per record: the latest round, its first open (or deciding) level, the round's state.
      const byRecord = new Map<string, ApprovalRequestInfo[]>();
      for (const r of asked) {
        const key = `${r.targetModel}:${r.targetId}`;
        const kept = byRecord.get(key);
        if (kept === undefined || kept[0]?.round === r.round)
          byRecord.set(key, [...(kept ?? []), r]);
      }
      const chosen: ApprovalRequestInfo[] = [];
      const overrides = new Map<number, { state: ApprovalCard['state'] }>();
      for (const round of byRecord.values()) {
        const live = round.filter((r) => r.state !== 'cancelled');
        const decisive =
          live.find((r) => r.state === 'rejected' || r.state === 'sent_back') ??
          live.find((r) => r.state === 'pending') ??
          live.at(-1) ??
          round[0];
        if (decisive === undefined) continue;
        const state: ApprovalCard['state'] =
          live.length === 0
            ? 'cancelled'
            : live.some((r) => r.state === 'rejected')
              ? 'rejected'
              : live.some((r) => r.state === 'sent_back')
                ? 'sent_back'
                : live.every((r) => r.state === 'approved')
                  ? 'approved'
                  : 'pending';
        chosen.push(decisive);
        overrides.set(decisive.id, { state });
      }
      return (await cardsOf(su, chosen, overrides)).sort((a, b) =>
        b.waitingSince.localeCompare(a.waitingSince),
      );
    }
    const votes = await find(
      su,
      'approval.vote',
      { user: me },
      ['request', 'decision', 'comment', 'at'],
      ['at desc', 'id desc'],
    );
    const requests = await loadRequests(
      su,
      { id: { in: votes.map((v) => v['request'] as number) } },
      ['id asc'],
    );
    const byId = new Map(requests.map((r) => [r.id, r]));
    const STATE = { approve: 'approved', reject: 'rejected', send_back: 'sent_back' } as const;
    const ordered: ApprovalRequestInfo[] = [];
    const overrides = new Map<
      number,
      { state: ApprovalCard['state']; decidedAt: string; comment: string | null }
    >();
    for (const v of votes.slice(0, 200)) {
      const r = byId.get(v['request'] as number);
      if (r === undefined) continue;
      ordered.push(r);
      overrides.set(r.id, {
        state: STATE[v['decision'] as keyof typeof STATE],
        decidedAt: v['at'] instanceof Date ? v['at'].toISOString() : String(v['at']),
        comment: (v['comment'] as string | null) ?? null,
      });
    }
    return cardsOf(su, ordered, overrides);
  });
}

/** Approves many requests (each checked as one decision); the ones refused say why. */
export async function approveMany(
  env: Env,
  ids: readonly number[],
  comment?: string,
): Promise<{ approved: number; failed: { id: number; reason: string }[] }> {
  let approved = 0;
  const failed: { id: number; reason: string }[] = [];
  for (const id of ids.slice(0, 100))
    try {
      await decide(env, id, 'approve', comment);
      approved += 1;
    } catch (error) {
      failed.push({ id, reason: error instanceof Error ? error.message : String(error) });
    }
  return { approved, failed };
}

/** The inbox's header: waiting, waiting over three days, decided this month, the median hours to decide them. */
export async function approvalStats(env: Env): Promise<{
  waiting: number;
  overdue: number;
  decidedThisMonth: number;
  medianHours: number | null;
}> {
  const waiting = await approvalCards(env, 'inbox');
  const now = Date.now();
  const overdue = waiting.filter((c) => now - Date.parse(c.waitingSince) >= 72 * 3_600_000).length;
  const me = env.uid as number;
  return env.asSuperuser({ reason: 'approval stats' }, async (su) => {
    const start = new Date();
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    const votes = await find(su, 'approval.vote', { user: me, at: { gte: start } }, [
      'request',
      'at',
    ]);
    const asked = new Map<number, number>();
    if (votes.length > 0)
      for (const row of await find(
        su,
        'approval.request',
        { id: { in: votes.map((v) => v['request'] as number) } },
        ['createdAt'],
      ))
        asked.set(row['id'] as number, new Date(row['createdAt'] as Date).getTime());
    const hours = votes
      .map(
        (v) =>
          (new Date(v['at'] as Date).getTime() - (asked.get(v['request'] as number) ?? 0)) /
          3_600_000,
      )
      .sort((a, b) => a - b);
    const mid = Math.floor(hours.length / 2);
    const median =
      hours.length === 0
        ? null
        : hours.length % 2 === 1
          ? (hours[mid] ?? 0)
          : ((hours[mid - 1] ?? 0) + (hours[mid] ?? 0)) / 2;
    return {
      waiting: waiting.length,
      overdue,
      decidedThisMonth: votes.length,
      medianHours: median === null ? null : Math.round(median * 10) / 10,
    };
  });
}

/** The periods of the matrix dashboard, in days (`all`: no limit). */
const MATRIX_DAYS = { '7d': 7, '30d': 30, '3m': 91, '6m': 182, '1y': 365, all: null } as const;
export type MatrixPeriod = keyof typeof MATRIX_DAYS;
export const MATRIX_PERIODS: readonly MatrixPeriod[] = Object.keys(MATRIX_DAYS) as MatrixPeriod[];

/** One card of the matrix: a policy's requests the user decides, by state. */
export interface MatrixCard {
  readonly policy: number | null;
  readonly title: string;
  readonly waiting: number;
  readonly approved: number;
  readonly rejected: number;
  readonly total: number;
}

/**
 * The matrix dashboard (RFC 0027 §2.7): the requests of the period the user decides — directly (named, or holding
 * the role) or delegated (as a backup or for someone away) — a card per policy with what waits, what was approved
 * and rejected; for Approvals managers also the hours each level takes to decide and the bottlenecks (who has the
 * most requests late).
 */
export async function approvalMatrix(
  env: Env,
  period: MatrixPeriod,
  mode: 'direct' | 'delegated',
): Promise<{
  cards: MatrixCard[];
  direct: number;
  delegated: number;
  levels: { policy: string; level: string; decided: number; averageHours: number }[] | null;
  bottlenecks: { user: number; name: string; late: number; waiting: number }[] | null;
}> {
  const manages = managesApprovals(env);
  return env.asSuperuser({ reason: 'approval matrix' }, async (su) => {
    const who = await whoIs(su, env);
    const days = MATRIX_DAYS[period];
    const since = days === null ? null : new Date(Date.now() - days * 86_400_000);
    const rows = await loadRequests(
      su,
      {
        state: { ne: 'cancelled' },
        ...(since === null ? {} : { createdAt: { gte: since } }),
      },
      ['id asc'],
    );
    const mine = (r: ApprovalRequestInfo): boolean =>
      r.approvers.includes(who.uid) ||
      (r.approvers.length === 0 &&
        r.approverRole !== '' &&
        (r.company === null || r.company === who.companyId) &&
        who.groups.has(r.approverRole));
    const forOthers = (r: ApprovalRequestInfo): boolean =>
      !mine(r) &&
      (r.backups.includes(who.uid) ||
        who.delegators.some(
          (d) =>
            d.user !== r.requestedBy &&
            (r.approvers.includes(d.user) ||
              (r.approvers.length === 0 && holds(d.roles, r.approverRole, r.company))),
        ));
    const waitingNow = (r: ApprovalRequestInfo) => r.state === 'pending' && r.startedAt !== null;
    const scoped = rows.filter((r) => r.requestedBy !== who.uid);
    const direct = scoped.filter(mine);
    const delegated = scoped.filter(forOthers);
    const names = new Map(
      (
        await find(
          // Archived policies keep their requests' history.
          su.withFlags({ activeTest: false }) as Env,
          'approval.policy',
          {
            id: {
              in: [...new Set(rows.map((r) => r.policy).filter((p): p is number => p !== null))],
            },
          },
          ['name'],
        )
      ).map((p) => [p['id'] as number, String(p['name'])]),
    );
    const cards = new Map<string, MatrixCard>();
    for (const r of mode === 'direct' ? direct : delegated) {
      const key = String(r.policy ?? 0);
      const card = cards.get(key) ?? {
        policy: r.policy,
        title: (r.policy === null ? undefined : names.get(r.policy)) ?? r.targetModel,
        waiting: 0,
        approved: 0,
        rejected: 0,
        total: 0,
      };
      if (r.state === 'pending' && !waitingNow(r)) continue; // a later level: not anyone's turn yet
      cards.set(key, {
        ...card,
        waiting: card.waiting + (waitingNow(r) ? 1 : 0),
        approved: card.approved + (r.state === 'approved' ? 1 : 0),
        rejected: card.rejected + (r.state === 'rejected' || r.state === 'sent_back' ? 1 : 0),
        total: card.total + 1,
      });
    }
    let levels: { policy: string; level: string; decided: number; averageHours: number }[] | null =
      null;
    let bottlenecks: { user: number; name: string; late: number; waiting: number }[] | null = null;
    if (manages) {
      const byLevel = new Map<string, { policy: string; level: string; hours: number[] }>();
      for (const r of rows) {
        if (r.decidedAt === null || r.startedAt === null || r.state === 'pending') continue;
        const policy = (r.policy === null ? undefined : names.get(r.policy)) ?? r.targetModel;
        const key = `${policy}\u0000${r.levelName}`;
        const entry = byLevel.get(key) ?? { policy, level: r.levelName, hours: [] };
        entry.hours.push((Date.parse(r.decidedAt) - Date.parse(r.startedAt)) / 3_600_000);
        byLevel.set(key, entry);
      }
      levels = [...byLevel.values()]
        .map((e) => ({
          policy: e.policy,
          level: e.level,
          decided: e.hours.length,
          averageHours: Math.round((e.hours.reduce((a, b) => a + b, 0) / e.hours.length) * 10) / 10,
        }))
        .sort((a, b) => b.averageHours - a.averageHours);
      const load = new Map<number, { late: number; waiting: number }>();
      const now = Date.now();
      for (const r of rows.filter(waitingNow))
        for (const u of r.approvers) {
          const entry = load.get(u) ?? { late: 0, waiting: 0 };
          entry.waiting += 1;
          if (r.dueAt !== null && Date.parse(r.dueAt) <= now) entry.late += 1;
          load.set(u, entry);
        }
      const people = new Map(
        load.size === 0
          ? []
          : (await find(su, 'res.users', { id: { in: [...load.keys()] } }, ['name'])).map((u) => [
              u['id'] as number,
              String(u['name']),
            ]),
      );
      bottlenecks = [...load.entries()]
        .map(([user, l]) => ({ user, name: people.get(user) ?? `#${user}`, ...l }))
        .sort((a, b) => b.late - a.late || b.waiting - a.waiting)
        .slice(0, 10);
    }
    return {
      cards: [...cards.values()].sort((a, b) => a.title.localeCompare(b.title)),
      direct: direct.filter(waitingNow).length,
      delegated: delegated.filter(waitingNow).length,
      levels,
      bottlenecks,
    };
  });
}

/** The people who may decide `request` now: its approvers (or its role's holders), the escalation role's once late,
 * and whoever they delegated to today; never the requester. */
export async function decidersOf(
  su: Env,
  request: ApprovalRequestInfo,
  today: string,
): Promise<number[]> {
  const people = new Set<number>([...request.approvers, ...request.backups]);
  if (request.approvers.length === 0 && request.approverRole !== '')
    for (const u of await holders(su, request.approverRole, request.company)) people.add(u);
  if (request.escalatedTo !== null)
    for (const u of await holders(su, request.escalatedTo, request.company)) people.add(u);
  if (people.size > 0)
    for (const d of await find(
      su,
      'approval.delegation',
      { user: { in: [...people] }, dateFrom: { lte: today }, dateTo: { gte: today } },
      ['delegate'],
    ))
      people.add(d['delegate'] as number);
  if (request.requestedBy !== null) people.delete(request.requestedBy);
  return [...people];
}

/** The pending requests of a record whose turn it is (every lower level approved). */
export async function turnOf(su: Env, model: string, id: number): Promise<ApprovalRequestInfo[]> {
  const round = await currentRequests(su, model, id);
  return round.filter(
    (r) =>
      r.state === 'pending' &&
      !round.some((x) => x.sequence < r.sequence && x.state !== 'approved'),
  );
}

/**
 * Deadlines (RFC 0025 §3.3), as the system: each pending request with a deadline is reminded once at half of it and,
 * once late, escalated to its level's role (who may then decide too), audited; returns what was done, with who to
 * tell.
 */
export async function sweepDeadlines(
  su: Env,
  now: Date = new Date(),
): Promise<{ kind: 'reminded' | 'escalated'; request: ApprovalRequestInfo }[]> {
  const out: { kind: 'reminded' | 'escalated'; request: ApprovalRequestInfo }[] = [];
  const rows = await find(su, 'approval.request', { state: 'pending', dueAt: { isNull: false } }, [
    'dueAt',
    'remindedAt',
    'escalatedTo',
    'createdAt',
    'startedAt',
    'level',
  ]);
  for (const row of rows) {
    const due = new Date(row['dueAt'] as Date).getTime();
    const start = new Date((row['startedAt'] ?? row['createdAt']) as Date).getTime();
    const [request] = await loadRequests(su, { id: row['id'] }, ['id asc']);
    if (request === undefined) continue;
    if (now.getTime() >= due && (row['escalatedTo'] ?? null) === null) {
      const [level] =
        typeof row['level'] === 'number'
          ? await find(su, 'approval.level', { id: row['level'] }, ['escalateRole'])
          : [];
      const role =
        typeof level?.['escalateRole'] === 'string' ? (level['escalateRole'] as string) : '';
      if (role !== '') {
        await ref(su, 'approval.request')
          .browse([request.id])
          .write({
            escalatedTo: role,
            escalatedAt: now,
            remindedAt: row['remindedAt'] == null ? now : new Date(row['remindedAt'] as string),
          });
        await audit(su, {
          kind: 'approval.escalated',
          summary: `${request.levelName} escalated to ${role} for ${request.targetModel} ${request.targetId}.`,
          actor: null,
          company: request.company,
          targetModel: request.targetModel,
          targetId: request.targetId,
          details: { request: request.id, role },
        });
        await logEvents(su, [{ request: request.id, kind: 'escalated', note: role, at: now }]);
        await su.emit('approval.escalated', { request: request.id, role });
        out.push({ kind: 'escalated', request: { ...request, escalatedTo: role } });
        continue;
      }
    }
    if ((row['remindedAt'] ?? null) === null && now.getTime() >= start + (due - start) / 2) {
      await ref(su, 'approval.request').browse([request.id]).write({ remindedAt: now });
      await logEvents(su, [{ request: request.id, kind: 'reminded', at: now }]);
      out.push({ kind: 'reminded', request });
    }
  }
  return out;
}

/** One-time links deciding `request` from an email, one per person who may decide it now (7 days). */
export async function issueLinks(
  su: Env,
  request: ApprovalRequestInfo,
  today: string,
  newToken: () => string,
  digestOf: (token: string) => string,
  only?: readonly number[],
): Promise<{ user: number; token: string }[]> {
  const out: { user: number; token: string }[] = [];
  const expiresAt = new Date(Date.now() + 7 * 86_400_000);
  for (const user of await decidersOf(su, request, today)) {
    if (only !== undefined && !only.includes(user)) continue;
    const token = newToken();
    await ref(su, 'approval.link').create([
      { request: request.id, user, tokenHash: digestOf(token), expiresAt },
    ]);
    out.push({ user, token });
  }
  return out;
}

/** The link of a token, while it is unused and not expired: who decides, which request. */
export async function linkOf(
  su: Env,
  tokenHash: string,
): Promise<{ id: number; user: number; request: ApprovalRequestInfo } | null> {
  const [link] = await find(su, 'approval.link', { tokenHash, usedAt: { isNull: true } }, [
    'request',
    'user',
    'expiresAt',
  ]);
  if (link === undefined || new Date(link['expiresAt'] as Date).getTime() < Date.now()) return null;
  const [request] = await loadRequests(su, { id: link['request'] }, ['id asc']);
  return request === undefined
    ? null
    : { id: link['id'] as number, user: link['user'] as number, request };
}

/** Marks a link used (as the system). */
export async function useLink(su: Env, id: number): Promise<void> {
  await ref(su, 'approval.link').browse([id]).write({ usedAt: new Date() });
}

/** A user's groups in a company (direct grants), to act as them from a link. */
export async function groupsOf(su: Env, user: number, company: number | null): Promise<string[]> {
  return (
    await find(
      su,
      'auth.user_group',
      { user, ...(company === null ? {} : { or: [{ company }, { company: null }] }) },
      ['group'],
    )
  ).map((r) => String(r['group']));
}

/** The pending requests `env`'s user may decide now, in the current company. */
export async function inbox(env: Env): Promise<ApprovalRequestInfo[]> {
  return env.asSuperuser({ reason: 'approval inbox' }, async (su) => {
    const pending = await loadRequests(su, { state: 'pending' }, ['id asc']);
    const who = await whoIs(su, env);
    const decided = await decidedOn(
      su,
      pending.map((r) => r.id),
    );
    const out: ApprovalRequestInfo[] = [];
    for (const request of pending) {
      if (approverFor(who, request) === null) continue;
      const round = await currentRequests(su, request.targetModel, request.targetId);
      if (mayDecide(who, request, round, decided).reason === null) out.push(request);
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
  return env.asSuperuser({ reason: 'approval history' }, (su) =>
    loadRequests(su, { targetModel: model, targetId: id }, ['round asc', 'sequence asc', 'id asc']),
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
          ...(spec.onSentBack === undefined ? {} : { onSentBack: spec.onSentBack }),
          ...(spec.onWithdrawn === undefined ? {} : { onWithdrawn: spec.onWithdrawn }),
          ...(spec.reasonRequired === undefined ? {} : { reasonRequired: spec.reasonRequired }),
        },
      ]);
      await ref(env, 'approval.level').create(
        spec.levels.map((level, i) => ({
          policy: policy.ids[0],
          sequence: (i + 1) * 10,
          name: level.name,
          condition: level.condition ?? null,
          approverRole: level.approverRole,
          approverKind:
            typeof level.approver === 'string'
              ? level.approver
              : typeof level.approver === 'object'
                ? 'record' in level.approver
                  ? 'record'
                  : 'employee' in level.approver
                    ? 'employee'
                    : 'field'
                : 'role',
          ...(typeof level.approver === 'object'
            ? {
                approverField:
                  'record' in level.approver
                    ? level.approver.record
                    : 'employee' in level.approver
                      ? level.approver.employee
                      : level.approver.field,
              }
            : {}),
          quorum:
            level.quorum === undefined || level.quorum === 'any'
              ? 'any'
              : level.quorum === 'all'
                ? 'all'
                : 'count',
          ...(typeof level.quorum === 'number' ? { quorumCount: level.quorum } : {}),
        })),
      );
      created += 1;
    }
  return created;
}
