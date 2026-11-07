/**
 * The data layer of Projects (RFC 0008, RFC 0026): programmes and projects with their case — code, type, sponsor,
 * owner, priority, risk, scope, assumptions, constraints —, phases (nested) and work packages between a project and
 * its tasks, tasks on a kanban of shared stages with sub-tasks, several assignees, tags, a category, milestones and
 * finish-to-start dependencies, and timesheets whose hours add up on the task. Progress is computed — a task's from
 * its sub-tasks, a work package's, a phase's and a project's from their tasks weighted by planned hours — and may be
 * set by hand on phases and work packages. Users see every project and task of their companies and their own
 * timesheets; managers see everything.
 */
import { contactsShutro } from '@kosh/contacts';
import { type ChatterContext, messagingShutro, postMessage, setFollower } from '@kosh/messaging';
import { approvalGuard, permissionsShutro, requestApprovals } from '@kosh/permissions';
import { orm } from '@kosh/server/orm';
import {
  check,
  compute,
  defineModel,
  defineModule,
  type Env,
  extendModel,
  f,
  method,
  onchange,
  record,
  records,
} from './.kosh/bindings.js';

const READ = ['read'] as const;
const WRITE = ['read', 'write', 'create', 'unlink'] as const;
const ALL = ['read', 'write', 'create', 'unlink', 'export', 'import'] as const;

/** A column of the task kanban, shared by every project (per company later, if asked for). */
/** The company's project settings (RFC 0020): new tasks' planned hours, the step timesheets are entered in. */
export const CompanyProject = extendModel('res.company', {
  fields: {
    projectPlannedHoursDefault: f.decimal({ scale: 2, label: 'Planned hours of a new task' }),
    projectTimesheetStep: f.selection(
      { none: 'Any', quarter: 'Quarter hours', half: 'Half hours', whole: 'Whole hours' },
      { default: 'none', label: 'Timesheets in steps of' },
    ),
    projectRequirePlan: f.boolean({
      default: false,
      label: 'Require an approved plan',
      help: 'A new project (not inside a programme) starts from an approved plan.',
    }),
    projectHealthBehindRisk: f.integer({
      default: 10,
      label: 'At risk when behind by (points)',
      help: 'Progress this many points behind the share of time elapsed puts a project at risk.',
    }),
    projectHealthBehindOff: f.integer({
      default: 25,
      label: 'Off track when behind by (points)',
    }),
    projectHealthCostRisk: f.integer({
      default: 90,
      label: 'At risk when the budget is used to (%)',
      help: 'Actual and committed costs at this share of the budget put a project at risk; beyond the budget, off track.',
    }),
  },
});

/** Whether the company asks for an approved plan before a project (RFC 0026 step 2). */
async function planRequired(env: Env, company: number): Promise<boolean> {
  const read = async (e: Env) =>
    (
      await e
        .model('res.company')
        .browse([company as never])
        .load(['projectRequirePlan'])
    ).read(['projectRequirePlan']);
  let rows: Awaited<ReturnType<typeof read>>;
  try {
    rows = await read(env);
  } catch (error) {
    if (!(error instanceof Error && error.name === 'AccessError')) throw error;
    rows = await env.withGrants({ grants: ['res.company:read'], reason: 'project settings' }, read);
  }
  return rows[0]?.['projectRequirePlan'] === true;
}

/** The timesheet steps as hours. */
const STEPS: Readonly<Record<string, ReturnType<typeof orm.toDecimal>>> = {
  quarter: orm.toDecimal('0.25'),
  half: orm.toDecimal('0.5'),
  whole: orm.toDecimal('1'),
};

/** The current company's project settings. */
async function projectSettings(env: Env): Promise<{ plannedHours: string | null; step: string }> {
  // Read as the writer; a system or portal scope without the right to companies reads it with the narrow grant.
  const read = async (e: Env) =>
    (
      await e
        .model('res.company')
        .browse([e.companyId])
        .load(['projectPlannedHoursDefault', 'projectTimesheetStep'])
    ).read(['projectPlannedHoursDefault', 'projectTimesheetStep']);
  let rows: Awaited<ReturnType<typeof read>>;
  try {
    rows = await read(env);
  } catch (error) {
    if (!(error instanceof Error && error.name === 'AccessError')) throw error;
    rows = await env.withGrants({ grants: ['res.company:read'], reason: 'project settings' }, read);
  }
  const [company] = rows;
  const planned = company?.['projectPlannedHoursDefault'];
  return {
    plannedHours: planned === null || planned === undefined ? null : String(planned),
    step:
      typeof company?.['projectTimesheetStep'] === 'string'
        ? company['projectTimesheetStep']
        : 'none',
  };
}

const PRIORITIES = { low: 'Low', normal: 'Normal', high: 'High', critical: 'Critical' } as const;
const STATUSES = {
  draft: 'Draft',
  in_progress: 'In progress',
  on_hold: 'On hold',
  done: 'Done',
  cancelled: 'Cancelled',
} as const;
const zero = orm.toDecimal(0);
const hundred = orm.toDecimal(100);

/** The progress of tasks, weighted by their planned hours (a task without any weighs one hour). */
function weighted(
  tasks: readonly {
    readonly progress?: unknown;
    readonly plannedHours?: unknown;
    readonly active?: unknown;
  }[],
): ReturnType<typeof orm.toDecimal> {
  let total = zero;
  let weight = zero;
  for (const t of tasks) {
    if (t.active === false) continue;
    const hours = orm.toDecimal(String(t.plannedHours ?? 0));
    const w = hours.gt(0) ? hours : orm.toDecimal(1);
    total = total.plus(w.times(orm.toDecimal(String(t.progress ?? 0))));
    weight = weight.plus(w);
  }
  return weight.isZero() ? zero : total.div(weight).toDecimalPlaces(1);
}

/** What kind of project it is (a farm build, a software rollout): configuration of the company, not code. */
export const ProjectType = defineModel('project.type', {
  label: 'Project type',
  recName: 'name',
  order: ['sequence asc', 'name asc'],
  archivable: true,
  companyScoped: { required: false },
  access: { 'project.user': READ, 'project.manager': ALL },
  fields: {
    name: f.char({ required: true, translate: true }),
    code: f.char({ required: true }),
    sequence: f.integer({ required: true, default: 10 }),
    description: f.text({ translate: true }),
  },
  sqlConstraints: {
    oneCode: { unique: ['company', 'code'], message: 'Another type has this code.' },
  },
});

/** A kind of task (Civil construction, Development), for one type of project or every one. */
export const ProjectTaskCategory = defineModel('project.task.category', {
  label: 'Task category',
  recName: 'name',
  order: ['sequence asc', 'name asc'],
  archivable: true,
  companyScoped: { required: false },
  access: { 'project.user': READ, 'project.manager': ALL },
  fields: {
    name: f.char({ required: true, translate: true }),
    code: f.char({ required: true }),
    sequence: f.integer({ required: true, default: 10 }),
    type: f.many2one('project.type', { ondelete: 'set null', label: 'Project type' }),
  },
  sqlConstraints: {
    oneCode: { unique: ['company', 'code'], message: 'Another task category has this code.' },
  },
});

export const ProjectTag = defineModel('project.tag', {
  label: 'Task tag',
  recName: 'name',
  order: ['name asc'],
  archivable: true,
  access: { 'project.user': ['read', 'create'], 'project.manager': ALL },
  fields: {
    name: f.char({ required: true, translate: true }),
    color: f.char({ label: 'Colour' }),
  },
  sqlConstraints: { oneName: { unique: ['name'], message: 'Another tag has this name.' } },
});

/** Hourly costs: seen and set by Projects managers only (RFC 0026 step 3). */
const MANAGERS_ONLY = { read: ['project.manager'], write: ['project.manager'] } as const;
/** Computed costs: seen by Projects managers only (computes read and write them for anyone). */
const MANAGERS_SEE = { read: ['project.manager'] } as const;

/** A role people play in projects, with the hourly cost a member in it has unless given their own. */
export const ProjectRole = defineModel('project.role', {
  label: 'Project role',
  recName: 'name',
  order: ['sequence asc', 'name asc'],
  archivable: true,
  companyScoped: { required: true },
  access: { 'project.user': READ, 'project.manager': ALL },
  fields: {
    name: f.char({ required: true, translate: true }),
    code: f.char({ size: 16 }),
    sequence: f.integer({ required: true, default: 10 }),
    defaultHourlyCost: f.decimal({
      scale: 2,
      label: 'Default hourly cost',
      groups: MANAGERS_ONLY,
      help: 'The cost of an hour of a member in this role who has no cost of their own.',
    }),
  },
  sqlConstraints: {
    oneCode: { unique: ['company', 'code'], message: 'Another role has this code.' },
    costPositive: {
      check: orm.sql`default_hourly_cost IS NULL OR default_hourly_cost >= 0`,
      message: 'A cost is not negative.',
    },
  },
});

type Span = {
  readonly from: string | null;
  readonly to: string | null;
  readonly allocation: number;
};

/** The highest total allocation of `spans` on any day of `[from, to]` (open ends: unbounded). */
export function peakAllocation(
  spans: readonly Span[],
  from: string | null,
  to: string | null,
): number {
  const overlaps = (x: Span) =>
    (x.to === null || from === null || x.to >= from) &&
    (x.from === null || to === null || x.from <= to);
  const inside = spans.filter(overlaps);
  // The total changes only where a span starts: try the range's start and every start inside it.
  const points = new Set<string | null>([from]);
  for (const x of inside)
    if (x.from !== null && (from === null || x.from > from)) points.add(x.from);
  let peak = 0;
  for (const day of points) {
    let total = 0;
    for (const x of inside)
      if (
        (x.from === null || day === null || x.from <= day) &&
        (x.to === null || day === null || x.to >= day)
      )
        total += x.allocation;
    peak = Math.max(peak, total);
  }
  return peak;
}

/** Someone in a project's team: their role, how much of their time it takes, their hourly cost and when. */
export const ProjectMember = defineModel('project.member', {
  label: 'Project member',
  order: ['project asc', 'id asc'],
  companyScoped: { required: true },
  tracking: ['allocation', 'role', 'dateFrom', 'dateTo'],
  access: { 'project.user': READ, 'project.manager': ALL },
  rules: {
    all: {
      groups: ['project.user', 'project.manager'],
      perms: ['read', 'write', 'create', 'unlink'],
      domain: {},
    },
  },
  fields: {
    project: f.many2one('project.project', {
      required: true,
      checkCompany: true,
      ondelete: 'cascade',
    }),
    user: f.many2one('res.users', { required: true, ondelete: 'restrict', label: 'Person' }),
    role: f.many2one('project.role', { ondelete: 'set null', checkCompany: true }),
    allocation: f.integer({
      required: true,
      default: 100,
      label: 'Allocation %',
      help: 'The share of their working time this project takes while they are in it.',
    }),
    hourlyCost: f.decimal({
      scale: 2,
      label: 'Hourly cost',
      groups: MANAGERS_ONLY,
      help: 'Their timesheets on this project cost this an hour; empty: their role’s default cost.',
    }),
    dateFrom: f.date({ label: 'From' }),
    dateTo: f.date({ label: 'Until' }),
    notes: f.text(),
    /** Their projects take more than all their time on some day of this membership. */
    overallocated: f.boolean({
      label: 'Over-allocated',
      ...compute(
        'project.member',
        'overallocated',
        ['user', 'allocation', 'dateFrom', 'dateTo'],
        async (members) => {
          const env = members.env as unknown as Env;
          const users = [
            ...new Set([...members].flatMap((m) => (m.user === null ? [] : [m.user.id]))),
          ];
          const all =
            users.length === 0
              ? []
              : // As the reader: every Projects user sees every team (a GET cannot audit a superuser scope).
                (
                  await env
                    .model('project.member')
                    .search({
                      where: { user: { in: users }, 'project.active': true } as never,
                    })
                    .then((r) => r.load(['user', 'allocation', 'dateFrom', 'dateTo']))
                ).map((m) => ({
                  id: m.id as number,
                  user: m.user.id as number,
                  from: m.dateFrom === null ? null : String(m.dateFrom),
                  to: m.dateTo === null ? null : String(m.dateTo),
                  allocation: m.allocation,
                }));
          for (const m of members) {
            if (m.user === null) {
              m.overallocated = false;
              continue;
            }
            const from = m.dateFrom === null ? null : String(m.dateFrom);
            const to = m.dateTo === null ? null : String(m.dateTo);
            // The others as saved, this one as it is now (on the form, before it is saved).
            const spans = [
              ...all.filter((x) => x.user === m.user?.id && x.id !== m.id),
              { from, to, allocation: m.allocation ?? 0 },
            ];
            m.overallocated = peakAllocation(spans, from, to) > 100;
          }
        },
      ),
    }),
  },
  sqlConstraints: {
    allocationRange: {
      check: orm.sql`allocation > 0 AND allocation <= 100`,
      message: 'An allocation is from 1 to 100 %.',
    },
    costPositive: {
      check: orm.sql`hourly_cost IS NULL OR hourly_cost >= 0`,
      message: 'A cost is not negative.',
    },
    dates: {
      check: orm.sql`date_from IS NULL OR date_to IS NULL OR date_to >= date_from`,
      message: 'A membership ends on or after it starts.',
    },
  },
});

export const ProjectTaskStage = defineModel('project.task.stage', {
  label: 'Task stage',
  archivable: true,
  order: ['sequence asc', 'id asc'],
  access: { 'project.user': READ, 'project.manager': ALL },
  fields: {
    name: f.char({ required: true, translate: true }),
    sequence: f.integer({ required: true, default: 10 }),
    /** Folded on the kanban (done, cancelled). */
    fold: f.boolean({ default: false }),
    /** Tasks in this stage are done. */
    done: f.boolean({ default: false, label: 'Closes the task' }),
  },
});

const PLAN_STATES = {
  draft: 'Draft',
  submitted: 'Waiting for approval',
  approved: 'Approved',
  rejected: 'Rejected',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
} as const;

const me = { $env: 'uid' } as const;
/** Moved by the plan (as the system) or by Projects managers only. */
const MANAGERS_WRITE = { write: ['project.manager'] } as const;

/**
 * A project plan (RFC 0026 step 2): the case for a project before it exists — objectives, expected outcome, the
 * strategic goal, dates and an estimated budget —, submitted and decided through the approval engine (RFC 0025);
 * once approved, a project starts from it with the plan's dates as its baseline.
 */
export const ProjectPlan = defineModel('project.plan', {
  label: 'Project plan',
  recName: 'title',
  order: ['id desc'],
  companyScoped: { required: true },
  tracking: [
    'state',
    'estimatedBudget',
    'approvedBudget',
    'manager',
    'sponsor',
    'dateStart',
    'dateEnd',
  ],
  access: { 'project.user': ['read', 'write', 'create', 'unlink'], 'project.manager': ALL },
  rules: {
    // Seen by who wrote it, its manager and its sponsor; changed by them while a draft.
    involved: {
      groups: ['project.user'],
      perms: ['read'],
      domain: { or: [{ requester: me }, { manager: me }, { sponsor: me }] },
    },
    draftOwn: {
      groups: ['project.user'],
      perms: ['write', 'create', 'unlink'],
      domain: {
        or: [{ requester: me }, { manager: me }],
        state: { in: ['draft', 'rejected'] },
      },
    },
    // Its manager starts the project from it and completes it once approved (audited, tracked).
    running: {
      groups: ['project.user'],
      perms: ['write'],
      domain: { manager: me, state: { in: ['approved', 'in_progress'] } },
    },
    managers: {
      groups: ['project.manager'],
      perms: ['read', 'write', 'create', 'unlink'],
      domain: {},
    },
  },
  fields: {
    /** Numbered when created: PLAN-0001. */
    name: f.char({ readonly: true, sequence: 'project.plan', label: 'Number' }),
    title: f.char({ required: true }),
    type: f.many2one('project.type', { ondelete: 'set null', label: 'Project type' }),
    requester: f.many2one('res.users', {
      default: (env: Env) => env.userId,
      ondelete: 'restrict',
      label: 'Written by',
    }),
    manager: f.many2one('res.users', {
      default: (env: Env) => env.userId,
      ondelete: 'set null',
      label: 'Project manager',
    }),
    sponsor: f.many2one('res.users', {
      ondelete: 'set null',
      label: 'Sponsor',
      help: 'Approves the plan first; a Projects manager when there is none.',
    }),
    priority: f.selection(PRIORITIES, {
      required: true,
      default: 'normal',
      help: 'How important the plan is against the others.',
    }),
    dateStart: f.date({ label: 'Planned start' }),
    dateEnd: f.date({ label: 'Planned end' }),
    description: f.text(),
    objectives: f.text(),
    expectedOutcome: f.text({ label: 'Expected outcome' }),
    strategicGoal: f.text({ label: 'Strategic goal' }),
    estimatedBudget: f.decimal({
      scale: 2,
      label: 'Estimated budget',
      help: 'Decides the approval levels: above 1 000 000 a Projects manager approves too.',
    }),
    approvedBudget: f.decimal({
      scale: 2,
      groups: MANAGERS_WRITE,
      label: 'Approved budget',
      help: 'The estimate unless changed before approving.',
    }),
    approvedAt: f.datetime({ label: 'Approved on', groups: MANAGERS_WRITE }),
    projects: f.one2many('project.project', 'plan'),
    projectCount: f.integer({
      label: 'Projects',
      ...compute('project.plan', 'projectCount', ['projects'], (plans) => {
        for (const p of plans) p.projectCount = p.projects.length;
      }),
    }),
    state: f.state({
      states: PLAN_STATES,
      initial: 'draft',
      help: 'Draft, then submitted for approval; once approved, a project starts from it.',
      transitions: {
        submit: {
          from: ['draft', 'rejected'],
          to: 'submitted',
          guard: records('project.plan', async (plans) =>
            [...(await plans.load({}))]
              .filter(
                (p) =>
                  p.estimatedBudget === null ||
                  p.dateStart === null ||
                  p.dateEnd === null ||
                  (p.objectives ?? '').trim() === '',
              )
              .map((p) => p.id),
          ),
          message:
            'A plan states its objectives, dates and estimated budget before it is submitted.',
          after: records('project.plan', async (plans) => {
            await requestApprovals(plans);
            for (const p of await plans.load({}))
              await plans.env.emit('project.plan.submitted', { id: p.id });
          }),
        },
        approve: {
          from: ['submitted'],
          to: 'approved',
          guard: records('project.plan', (plans) => approvalGuard(plans)),
          message: 'Waiting for approvals.',
          after: records('project.plan', async (plans) => {
            for (const p of await plans.load({})) {
              await plans.env
                .model('project.plan')
                .browse([p.id])
                .write({
                  approvedAt: new Date(),
                  ...(p.approvedBudget === null ? { approvedBudget: p.estimatedBudget } : {}),
                });
              await plans.env.emit('project.plan.approved', { id: p.id });
            }
          }),
        },
        reject: { from: ['submitted'], to: 'rejected' },
        /** Sent back for changes or withdrawn: a draft again. */
        redraft: { from: ['submitted', 'rejected', 'cancelled'], to: 'draft' },
        /** A project starts from the approved plan, with the plan's dates as its baseline. */
        start: {
          from: ['approved'],
          to: 'in_progress',
          after: records('project.plan', async (plans) => {
            for (const p of await plans.load({ projects: ['id'] })) {
              if (p.projects.length > 0) continue;
              const created = await plans.env.model('project.project').create([
                {
                  name: p.title,
                  plan: p.id,
                  type: p.type?.id ?? null,
                  manager: p.manager?.id ?? null,
                  sponsor: p.sponsor?.id ?? null,
                  priority: p.priority,
                  dateStart: p.dateStart,
                  dateEnd: p.dateEnd,
                  description: p.description,
                  company: p.company.id,
                },
              ]);
              // The baseline is the plan's, set by the system (managers alone move it by hand).
              await (plans.env as unknown as Env).asSuperuser(
                { reason: 'project baseline from its plan' },
                (su) =>
                  su.model('project.project').browse(created.ids).write({
                    baselineStart: p.dateStart,
                    baselineEnd: p.dateEnd,
                    baselineBudget: p.approvedBudget,
                  }),
              );
            }
          }),
        },
        /** The baseline taken again from the projects', phases' and work packages' current dates. */
        baseline: {
          from: ['in_progress'],
          to: 'in_progress',
          requires: 'project.baseline',
          after: records('project.plan', async (plans) => {
            const env = plans.env;
            for (const p of await plans.load({ projects: ['dateStart', 'dateEnd'] })) {
              for (const project of p.projects) {
                await env
                  .model('project.project')
                  .browse([project.id])
                  .write({ baselineStart: project.dateStart, baselineEnd: project.dateEnd });
                for (const model of ['project.phase', 'project.work.package'] as const) {
                  const rows = await env
                    .model(model)
                    .search({ where: { project: project.id } })
                    .then((r) => r.load(['dateStart', 'dateEnd']));
                  for (const row of rows)
                    await env
                      .model(model)
                      .browse([row.id as never])
                      .write({ baselineStart: row.dateStart, baselineEnd: row.dateEnd });
                }
                const tasks = await env
                  .model('project.task')
                  .search({ where: { project: project.id } })
                  .then((r) => r.load(['dateStart', 'deadline']));
                for (const t of tasks)
                  await env
                    .model('project.task')
                    .browse([t.id])
                    .write({ baselineStart: t.dateStart, baselineEnd: t.deadline });
              }
            }
          }),
        },
        complete: { from: ['in_progress'], to: 'completed' },
        cancel: { from: ['draft', 'submitted', 'approved', 'rejected'], to: 'cancelled' },
      },
    }),
  },
  sqlConstraints: {
    budgetPositive: {
      check: orm.sql`(estimated_budget IS NULL OR estimated_budget >= 0) AND (approved_budget IS NULL OR approved_budget >= 0)`,
      message: 'Budgets are not negative.',
    },
  },
  constraints: {
    dates: {
      ...check('project.plan', ['dateStart', 'dateEnd'], async (plans) =>
        plans
          .filter(
            (p) =>
              p.dateStart !== null && p.dateEnd !== null && String(p.dateEnd) < String(p.dateStart),
          )
          .map((p) => p.id),
      ),
      message: 'A plan ends on or after it starts.',
    },
  },
});

export const HEALTH = { on_track: 'On track', at_risk: 'At risk', off_track: 'Off track' } as const;
export type Health = keyof typeof HEALTH;

/** The health thresholds of a company (App settings › Projects › Health). */
export interface HealthRules {
  readonly behindRisk: number;
  readonly behindOff: number;
  readonly costRisk: number;
}

/** What a project's figures say, and why (RFC 0026 §2): the worst of schedule, milestones and cost. */
export function judgeHealth(
  p: {
    readonly today: string;
    readonly dateStart: string | null;
    readonly dateEnd: string | null;
    readonly progress: number;
    readonly milestonesLate: number;
    readonly budget: number;
    readonly spent: number;
  },
  rules: HealthRules,
): { health: Health; reasons: string[] } {
  const reasons: string[] = [];
  let level = 0;
  const raise = (to: number, why: string) => {
    level = Math.max(level, to);
    reasons.push(why);
  };
  if (p.dateEnd !== null && p.today > p.dateEnd && p.progress < 100)
    raise(2, `Past its deadline at ${p.progress}%.`);
  else if (p.dateStart !== null && p.dateEnd !== null && p.dateEnd > p.dateStart) {
    const span = Date.parse(p.dateEnd) - Date.parse(p.dateStart);
    const gone = Math.min(Math.max(Date.parse(p.today) - Date.parse(p.dateStart), 0), span);
    const elapsed = Math.round((gone / span) * 100);
    const behind = elapsed - p.progress;
    if (behind >= rules.behindOff)
      raise(2, `${behind} points behind: ${elapsed}% of the time gone, ${p.progress}% done.`);
    else if (behind >= rules.behindRisk)
      raise(1, `${behind} points behind: ${elapsed}% of the time gone, ${p.progress}% done.`);
  }
  if (p.milestonesLate > 0) raise(1, `${p.milestonesLate} milestone(s) late.`);
  if (p.budget > 0) {
    const used = Math.round((p.spent / p.budget) * 100);
    if (used > 100) raise(2, `${used}% of the budget used.`);
    else if (used >= rules.costRisk) raise(1, `${used}% of the budget used.`);
  }
  const health: Health = level === 2 ? 'off_track' : level === 1 ? 'at_risk' : 'on_track';
  return { health, reasons };
}

const BUDGET_CATEGORIES = {
  labour: 'Labour',
  materials: 'Materials',
  services: 'Services',
  equipment: 'Equipment',
  other: 'Other',
} as const;

/** A line of a project's budget (RFC 0026 step 4): what for, in which phase or work package, planned. */
export const ProjectBudgetLine = defineModel('project.budget.line', {
  label: 'Project budget line',
  order: ['project asc', 'sequence asc', 'id asc'],
  companyScoped: { required: true },
  access: { 'project.manager': ALL },
  fields: {
    project: f.many2one('project.project', {
      required: true,
      checkCompany: true,
      ondelete: 'cascade',
    }),
    sequence: f.integer({ required: true, default: 10 }),
    name: f.char({ required: true, label: 'What for' }),
    category: f.selection(BUDGET_CATEGORIES, {
      required: true,
      default: 'other',
      help: 'What kind of cost the line plans for.',
    }),
    phase: f.many2one('project.phase', { ondelete: 'set null' }),
    workPackage: f.many2one('project.work.package', {
      ondelete: 'set null',
      label: 'Work package',
    }),
    planned: f.decimal({ scale: 2, required: true, default: '0' }),
  },
  sqlConstraints: {
    planned: { check: orm.sql`planned >= 0`, message: 'A planned amount is not negative.' },
  },
  constraints: {
    sameProject: {
      ...check('project.budget.line', ['phase', 'workPackage', 'project'], async (lines) =>
        (await lines.load({ phase: ['project'], workPackage: ['project'] }))
          .filter(
            (l) =>
              (l.phase !== null && l.phase.project.id !== l.project.id) ||
              (l.workPackage !== null && l.workPackage.project.id !== l.project.id),
          )
          .map((l) => l.id),
      ),
      message: 'A budget line’s phase and work package are in its project.',
    },
  },
});

export const ProjectProject = defineModel('project.project', {
  label: 'Project',
  recName: 'name',
  order: ['sequence asc', 'name asc'],
  archivable: true,
  companyScoped: { required: true },
  hierarchy: { parent: 'parentProject', path: 'parentPath' },
  tracking: [
    'manager',
    'partner',
    'dateEnd',
    'sponsor',
    'owner',
    'riskLevel',
    'priority',
    'health',
    'healthOverride',
    'healthReason',
  ],
  access: { 'project.user': ['read', 'write', 'create'], 'project.manager': ALL },
  rules: {
    all: {
      groups: ['project.user', 'project.manager'],
      perms: ['read', 'write', 'create', 'unlink'],
      domain: {},
    },
  },
  fields: {
    name: f.char({ required: true }),
    /** Numbered when created: PRJ-0001. */
    code: f.char({ readonly: true, sequence: 'project.project', label: 'Code' }),
    type: f.many2one('project.type', { ondelete: 'set null', label: 'Project type' }),
    /** The programme it belongs to (a project of projects). */
    parentProject: f.many2one('project.project', { ondelete: 'restrict', label: 'Programme' }),
    parentPath: f.char({ readonly: true, index: true }),
    children: f.one2many('project.project', 'parentProject', { label: 'Projects' }),
    /** The approved plan it started from (RFC 0026 step 2). */
    plan: f.many2one('project.plan', { ondelete: 'restrict', checkCompany: true }),
    baselineStart: f.date({ label: 'Baseline start', groups: MANAGERS_WRITE }),
    baselineEnd: f.date({ label: 'Baseline end', groups: MANAGERS_WRITE }),
    baselineBudget: f.decimal({ scale: 2, label: 'Baseline budget', groups: MANAGERS_WRITE }),
    /** Days the deadline moved past the baseline (negative: earlier). */
    slipDays: f.integer({
      label: 'Days late against the baseline',
      ...compute('project.project', 'slipDays', ['dateEnd', 'baselineEnd'], (projects) => {
        for (const p of projects)
          p.slipDays =
            p.dateEnd === null || p.baselineEnd === null
              ? 0
              : Math.round(
                  (Date.parse(String(p.dateEnd)) - Date.parse(String(p.baselineEnd))) / 86_400_000,
                );
      }),
    }),
    partner: f.many2one('res.partner', { checkCompany: true, label: 'Customer' }),
    manager: f.many2one('res.users', {
      default: (env: Env) => env.userId,
      label: 'Project manager',
    }),
    sponsor: f.many2one('res.users', { ondelete: 'set null', label: 'Sponsor' }),
    owner: f.many2one('res.users', { ondelete: 'set null', label: 'Owner' }),
    priority: f.selection(PRIORITIES, {
      required: true,
      default: 'normal',
      help: 'How important the project is against the others.',
    }),
    riskLevel: f.selection(
      { low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical' },
      {
        required: true,
        default: 'low',
        label: 'Risk',
        help: 'How risky the project is judged to be overall.',
      },
    ),
    location: f.char(),
    sequence: f.integer({ required: true, default: 10 }),
    dateStart: f.date({ label: 'Start' }),
    dateEnd: f.date({ label: 'Deadline' }),
    description: f.text(),
    scope: f.text(),
    assumptions: f.text(),
    constraints: f.text(),
    phases: f.one2many('project.phase', 'project'),
    workPackages: f.one2many('project.work.package', 'project', { label: 'Work packages' }),
    /** Done, as a percentage: its tasks' progress weighted by their planned hours. */
    progress: f.decimal({
      scale: 1,
      store: true,
      label: 'Progress %',
      help: 'How much is done, from its tasks weighted by their planned hours.',
      ...compute(
        'project.project',
        'progress',
        [
          'tasks.progress',
          'tasks.done',
          'tasks.stage',
          'tasks.plannedHours',
          'tasks.active',
          'tasks.parentTask',
        ],
        (projects) => {
          for (const p of projects)
            p.progress = weighted([...p.tasks].filter((t) => t.parentTask?.id === undefined));
        },
      ),
    }),
    tasks: f.one2many('project.task', 'project'),
    members: f.one2many('project.member', 'project', { label: 'Team' }),
    timesheets: f.one2many('project.timesheet', 'project'),
    /** Timesheet hours at each member's cost (RFC 0026 step 3); Projects managers only. */
    budgetLines: f.one2many('project.budget.line', 'project', { label: 'Budget' }),
    /** The budget lines' planned amounts together (managers only). */
    budget: f.decimal({
      scale: 2,
      store: true,
      label: 'Budget',
      groups: MANAGERS_SEE,
      help: 'The planned amounts of the budget lines added together.',
      ...compute('project.project', 'budget', ['budgetLines.planned'], (projects) => {
        for (const p of projects)
          p.budget = [...p.budgetLines].reduce((t, l) => t.plus(l.planned), orm.toDecimal(0));
      }),
    }),
    /** Posted costs from the books on the project's cost centre (written by the refresh; Accounting's bridge). */
    bookedCost: f.decimal({ scale: 2, label: 'Booked costs', groups: MANAGERS_SEE }),
    /** Confirmed purchase orders on its cost centre not billed yet (written by the refresh; Purchase's bridge). */
    committedCost: f.decimal({ scale: 2, label: 'Committed', groups: MANAGERS_SEE }),
    actualCost: f.decimal({
      scale: 2,
      label: 'Actual cost',
      groups: MANAGERS_SEE,
      help: 'Labour from timesheets plus costs booked on its cost centre.',
      ...compute('project.project', 'actualCost', ['labourCost', 'bookedCost'], (projects) => {
        for (const p of projects)
          p.actualCost = orm.toDecimal(p.labourCost ?? 0).plus(p.bookedCost ?? 0);
      }),
    }),
    variance: f.decimal({
      scale: 2,
      label: 'Left in the budget',
      groups: MANAGERS_SEE,
      help: 'The budget less the actual and committed costs; negative when beyond it.',
      ...compute(
        'project.project',
        'variance',
        ['budget', 'labourCost', 'bookedCost', 'committedCost'],
        (projects) => {
          for (const p of projects)
            p.variance = orm
              .toDecimal(p.budget ?? 0)
              .minus(p.labourCost ?? 0)
              .minus(p.bookedCost ?? 0)
              .minus(p.committedCost ?? 0);
        },
      ),
    }),
    /** What the figures say (written by the refresh, hourly and on demand). */
    healthComputed: f.selection(HEALTH, {
      label: 'Health by the figures',
      help: 'What the schedule, late milestones and costs say, checked every hour.',
    }),
    healthNotes: f.text({ label: 'Why', help: 'What the figures said at the last refresh.' }),
    healthCheckedAt: f.datetime({ label: 'Checked' }),
    healthOverride: f.selection(HEALTH, {
      label: 'Health set by the manager',
      help: 'Overrides the figures until cleared; give the reason.',
    }),
    healthReason: f.text({ label: 'Reason for the override' }),
    health: f.selection(HEALTH, {
      store: true,
      label: 'Health',
      help: 'The manager’s health if set, else the health by the figures.',
      ...compute('project.project', 'health', ['healthOverride', 'healthComputed'], (projects) => {
        for (const p of projects) p.health = p.healthOverride ?? p.healthComputed ?? 'on_track';
      }),
    }),
    labourCost: f.decimal({
      scale: 2,
      store: true,
      label: 'Labour cost',
      groups: MANAGERS_SEE,
      help: 'The cost of all the hours logged on the project’s timesheets.',
      ...compute('project.project', 'labourCost', ['timesheets.cost'], (projects) => {
        for (const p of projects) {
          let total = orm.toDecimal(0);
          for (const t of p.timesheets) total = total.plus(t.cost ?? 0);
          p.labourCost = total;
        }
      }),
    }),
    taskCount: f.integer({
      store: true,
      label: 'Tasks',
      ...compute('project.project', 'taskCount', ['tasks.done', 'tasks.active'], (projects) => {
        for (const p of projects) p.taskCount = p.tasks.filter((t) => t.active && !t.done).length;
      }),
    }),
    hours: f.decimal({
      scale: 2,
      store: true,
      label: 'Hours spent',
      help: 'The hours logged on all the project’s tasks.',
      ...compute('project.project', 'hours', ['tasks.effectiveHours'], (projects) => {
        for (const p of projects) {
          let total = orm.toDecimal(0);
          for (const t of p.tasks) total = total.plus(t.effectiveHours ?? 0);
          p.hours = total;
        }
      }),
    }),
  },
  constraints: {
    // A programme never contains itself; dates run forward.
    noCycle: {
      ...check('project.project', ['parentProject'], async (projects) => {
        const bad: number[] = [];
        for (const p of await projects.load({ parentProject: true })) {
          const seen = new Set<number>([p.id]);
          let up = p.parentProject?.id ?? null;
          while (up !== null) {
            if (seen.has(up)) {
              bad.push(p.id);
              break;
            }
            seen.add(up);
            const [row] = await projects.env
              .model('project.project')
              .browse([up as never])
              .load({ parentProject: true });
            up = row?.parentProject?.id ?? null;
          }
        }
        return bad;
      }),
      message: 'A programme cannot be inside one of its own projects.',
    },
    overrideReason: {
      ...check('project.project', ['healthOverride', 'healthReason'], async (projects) =>
        projects
          .filter((p) => p.healthOverride !== null && (p.healthReason ?? '').trim() === '')
          .map((p) => p.id),
      ),
      message: 'Setting the health by hand needs the reason.',
    },
    dates: {
      ...check('project.project', ['dateStart', 'dateEnd'], async (projects) =>
        projects
          .filter(
            (p) =>
              p.dateStart !== null && p.dateEnd !== null && String(p.dateEnd) < String(p.dateStart),
          )
          .map((p) => p.id),
      ),
      message: 'A project ends on or after it starts.',
    },
    // Only an approved plan starts a project; the company may require one (App settings › Projects).
    plan: {
      ...check('project.project', ['plan', 'parentProject', 'company'], async (projects) => {
        const bad: number[] = [];
        const loaded = await projects.load({ plan: true, company: true });
        const exempt = await (projects.env as unknown as Env)
          .model('project.project')
          .browse(projects.ids)
          .planNotNeeded();
        const required = new Map<number, boolean>();
        for (const p of loaded) {
          if (p.plan !== null) {
            if (!['approved', 'in_progress'].includes(p.plan.state)) bad.push(p.id);
            continue;
          }
          if (p.parentProject !== null || exempt.has(p.id)) continue;
          let need = required.get(p.company.id);
          if (need === undefined) {
            need = await planRequired(projects.env as unknown as Env, p.company.id);
            required.set(p.company.id, need);
          }
          if (need) bad.push(p.id);
        }
        return bad;
      }),
      message:
        'A project starts from an approved plan (App settings › Projects asks for one; projects inside a programme follow theirs).',
    },
  },
  methods: {
    /**
     * Of these projects, those that need no plan whatever the company's setting. None here; an app that makes
     * projects itself overrides it (`sale_project`: projects made by a confirmed order).
     */
    planNotNeeded: method('project.project', async (): Promise<Set<number>> => new Set<number>()),
    /**
     * The booked and committed costs of these projects, by project. Nothing here; the bridges add theirs
     * (`project_account`: posted costs on each project's cost centre, made when missing; `project_purchase`:
     * confirmed purchase orders not billed yet). Called as the system by the refresh.
     */
    moneyOf: method(
      'project.project',
      async (): Promise<Map<number, { booked: string; committed: string }>> =>
        new Map<number, { booked: string; committed: string }>(),
    ),
  },
});

/** The layers between a project and its tasks (RFC 0026 §3.1): their place, people, dates, status and progress. */
const layerFields = {
  name: f.char({ required: true }),
  code: f.char({ label: 'Code' }),
  sequence: f.integer({ required: true, default: 10 }),
  manager: f.many2one('res.users', { ondelete: 'set null', label: 'Manager' }),
  dateStart: f.date({ label: 'Start' }),
  dateEnd: f.date({ label: 'End' }),
  status: f.selection(STATUSES, {
    required: true,
    default: 'draft',
    help: 'Where the work stands, from draft to done.',
  }),
  description: f.text(),
  /** Set by hand when the tasks do not tell the whole story (empty: computed). */
  progressOverride: f.decimal({ scale: 1, label: 'Progress set by hand %' }),
  baselineStart: f.date({ label: 'Baseline start', groups: MANAGERS_WRITE }),
  baselineEnd: f.date({ label: 'Baseline end', groups: MANAGERS_WRITE }),
} as const;

export const ProjectPhase = defineModel('project.phase', {
  label: 'Phase',
  recName: 'name',
  order: ['project asc', 'sequence asc', 'id asc'],
  archivable: true,
  companyScoped: { required: true },
  hierarchy: { parent: 'parentPhase', path: 'parentPath' },
  tracking: ['status', 'manager', 'dateEnd'],
  access: { 'project.user': ['read', 'write', 'create'], 'project.manager': ALL },
  fields: {
    ...layerFields,
    project: f.many2one('project.project', {
      required: true,
      checkCompany: true,
      ondelete: 'cascade',
    }),
    parentPhase: f.many2one('project.phase', { ondelete: 'restrict', label: 'Inside' }),
    parentPath: f.char({ readonly: true, index: true }),
    children: f.one2many('project.phase', 'parentPhase', { label: 'Sub-phases' }),
    responsible: f.many2one('res.users', { ondelete: 'set null' }),
    /** Its end has passed and it is not done or cancelled (set by the refresh, hourly). */
    late: f.boolean({ default: false, label: 'Late' }),
    priority: f.selection(PRIORITIES, {
      required: true,
      default: 'normal',
      help: 'How important the phase is within its project.',
    }),
    workPackages: f.one2many('project.work.package', 'phase', { label: 'Work packages' }),
    tasks: f.one2many('project.task', 'phase'),
    progress: f.decimal({
      scale: 1,
      store: true,
      label: 'Progress %',
      help: 'How much is done: set by hand, else from its tasks weighted by their planned hours.',
      ...compute(
        'project.phase',
        'progress',
        [
          'progressOverride',
          'tasks.progress',
          'tasks.done',
          'tasks.stage',
          'tasks.plannedHours',
          'tasks.active',
          'tasks.parentTask',
        ],
        (phases) => {
          for (const x of phases)
            x.progress =
              x.progressOverride ??
              weighted([...x.tasks].filter((t) => t.parentTask?.id === undefined));
        },
      ),
    }),
  },
  sqlConstraints: {
    progressRange: {
      check: orm.sql`progress_override IS NULL OR (progress_override >= 0 AND progress_override <= 100)`,
      message: 'Progress is from 0 to 100.',
    },
  },
  constraints: {
    sameProject: {
      ...check('project.phase', ['parentPhase', 'project'], async (phases) =>
        (await phases.load({ parentPhase: { project: true }, project: true }))
          .filter(
            (x) =>
              x.parentPhase !== null &&
              (x.parentPhase.id === x.id || x.parentPhase.project.id !== x.project.id),
          )
          .map((x) => x.id),
      ),
      message: 'A sub-phase is in the same project as the phase it is inside.',
    },
    dates: {
      ...check('project.phase', ['dateStart', 'dateEnd'], async (phases) =>
        phases
          .filter(
            (x) =>
              x.dateStart !== null && x.dateEnd !== null && String(x.dateEnd) < String(x.dateStart),
          )
          .map((x) => x.id),
      ),
      message: 'A phase ends on or after it starts.',
    },
  },
});

export const ProjectWorkPackage = defineModel('project.work.package', {
  label: 'Work package',
  recName: 'name',
  order: ['project asc', 'sequence asc', 'id asc'],
  archivable: true,
  companyScoped: { required: true },
  tracking: ['status', 'manager', 'dateEnd'],
  access: { 'project.user': ['read', 'write', 'create'], 'project.manager': ALL },
  fields: {
    ...layerFields,
    project: f.many2one('project.project', {
      required: true,
      checkCompany: true,
      ondelete: 'cascade',
    }),
    phase: f.many2one('project.phase', { ondelete: 'set null' }),
    /** What it delivers. */
    deliverables: f.text(),
    tasks: f.one2many('project.task', 'workPackage'),
    progress: f.decimal({
      scale: 1,
      store: true,
      label: 'Progress %',
      help: 'How much is done: set by hand, else from its tasks weighted by their planned hours.',
      ...compute(
        'project.work.package',
        'progress',
        [
          'progressOverride',
          'tasks.progress',
          'tasks.done',
          'tasks.stage',
          'tasks.plannedHours',
          'tasks.active',
          'tasks.parentTask',
        ],
        (packages) => {
          for (const w of packages)
            w.progress =
              w.progressOverride ??
              weighted([...w.tasks].filter((t) => t.parentTask?.id === undefined));
        },
      ),
    }),
  },
  sqlConstraints: {
    progressRange: {
      check: orm.sql`progress_override IS NULL OR (progress_override >= 0 AND progress_override <= 100)`,
      message: 'Progress is from 0 to 100.',
    },
  },
  constraints: {
    samePhaseProject: {
      ...check('project.work.package', ['phase', 'project'], async (packages) =>
        (await packages.load({ phase: { project: true }, project: true }))
          .filter((w) => w.phase !== null && w.phase.project.id !== w.project.id)
          .map((w) => w.id),
      ),
      message: 'A work package is in the same project as its phase.',
    },
  },
});

export const ProjectTask = defineModel('project.task', {
  label: 'Task',
  order: ['sequence asc', 'priority desc', 'id desc'],
  archivable: true,
  companyScoped: { required: true },
  tracking: ['stage', 'assignee', 'deadline', 'phase', 'workPackage'],
  access: { 'project.user': WRITE, 'project.manager': ALL },
  rules: {
    all: {
      groups: ['project.user', 'project.manager'],
      perms: ['read', 'write', 'create', 'unlink'],
      domain: {},
    },
  },
  fields: {
    name: f.char({ required: true, label: 'Title' }),
    project: f.many2one('project.project', {
      required: true,
      checkCompany: true,
      ondelete: 'cascade',
    }),
    stage: f.many2one('project.task.stage', { ondelete: 'restrict' }),
    phase: f.many2one('project.phase', { ondelete: 'set null' }),
    workPackage: f.many2one('project.work.package', {
      ondelete: 'set null',
      label: 'Work package',
    }),
    category: f.many2one('project.task.category', { ondelete: 'set null' }),
    /** The task it is a sub-task of. */
    parentTask: f.many2one('project.task', { ondelete: 'cascade', label: 'Sub-task of' }),
    subtasks: f.one2many('project.task', 'parentTask', { label: 'Sub-tasks' }),
    assignee: f.many2one('res.users', { label: 'Assigned to' }),
    /** Everyone working on it (the first is `assignee`). */
    assignees: f.many2many('res.users', {
      relation: 'project_task_assignee_rel',
      label: 'Assignees',
    }),
    tags: f.many2many('project.tag', { relation: 'project_task_tag_rel' }),
    /** A point the project reaches (a handover, a go-live), shown as such on the timeline. */
    milestone: f.boolean({ default: false }),
    /** The tasks that must finish before this one starts. */
    predecessors: f.one2many('project.task.link', 'successor', { label: 'Waits for' }),
    successors: f.one2many('project.task.link', 'predecessor', { label: 'Followed by' }),
    partner: f.many2one('res.partner', { checkCompany: true, label: 'Customer' }),
    priority: f.selection(
      { normal: 'Normal', high: 'High' },
      { required: true, default: 'normal', help: 'How urgent the task is.' },
    ),
    deadline: f.date(),
    plannedHours: f.decimal({ scale: 2, label: 'Planned hours' }),
    effectiveHours: f.decimal({
      scale: 2,
      store: true,
      label: 'Hours spent',
      help: 'The hours logged on the task’s timesheets.',
      ...compute('project.task', 'effectiveHours', ['timesheets.hours'], (tasks) => {
        for (const t of tasks) {
          let total = orm.toDecimal(0);
          for (const line of t.timesheets) total = total.plus(line.hours);
          t.effectiveHours = total;
        }
      }),
    }),
    done: f.boolean({
      store: true,
      ...compute('project.task', 'done', ['stage.done'], (tasks) => {
        for (const t of tasks) t.done = t.stage?.done === true;
      }),
    }),
    /** Done, as a percentage: 100 when done, else its sub-tasks' (weighted by planned hours), else 0. */
    progress: f.decimal({
      scale: 1,
      store: true,
      label: 'Progress %',
      help: 'Full once done; until then, the share of its sub-tasks done, weighted by their planned hours.',
      ...compute(
        'project.task',
        'progress',
        ['done', 'subtasks.done', 'subtasks.plannedHours', 'subtasks.active'],
        (tasks) => {
          for (const t of tasks) {
            if (t.done) {
              t.progress = hundred;
              continue;
            }
            const subs = [...t.subtasks].filter((x) => x.active !== false);
            t.progress =
              subs.length === 0
                ? zero
                : weighted(
                    subs.map((x) => ({ progress: x.done ? 100 : 0, plannedHours: x.plannedHours })),
                  );
          }
        },
      ),
    }),
    /** A task it waits for is not done yet. */
    blocked: f.boolean({
      store: true,
      label: 'Waiting for another task',
      ...compute('project.task', 'blocked', ['predecessors.predecessor.done', 'done'], (tasks) => {
        for (const t of tasks)
          t.blocked = !t.done && [...t.predecessors].some((l) => !l.predecessor.done);
      }),
    }),
    sequence: f.integer({ required: true, default: 10 }),
    description: f.text(),
    timesheets: f.one2many('project.timesheet', 'task'),
    /** When it starts (RFC 0026 step 5); it ends on its deadline. */
    dateStart: f.date({ label: 'Start' }),
    baselineStart: f.date({ label: 'Baseline start', groups: MANAGERS_WRITE }),
    baselineEnd: f.date({ label: 'Baseline end', groups: MANAGERS_WRITE }),
    /** Repeats: once done, the next one is made (the hourly refresh), until the date given. */
    repeatEvery: f.integer({
      label: 'Repeat every',
      help: 'Once done, the next one is made with its dates moved by this many days, weeks or months.',
    }),
    repeatUnit: f.selection(
      { day: 'Days', week: 'Weeks', month: 'Months' },
      {
        default: 'week',
        label: 'Repeat unit',
        help: 'Whether the repeat is counted in days, weeks or months.',
      },
    ),
    repeatUntil: f.date({ label: 'Repeat until' }),
    nextTask: f.many2one('project.task', { ondelete: 'set null', label: 'Next one' }),
  },
  sqlConstraints: {
    datesOrdered: {
      check: orm.sql`date_start IS NULL OR deadline IS NULL OR deadline >= date_start`,
      message: 'A task ends on or after it starts.',
    },
    repeatPositive: {
      check: orm.sql`repeat_every IS NULL OR repeat_every > 0`,
      message: 'A task repeats every one or more days, weeks or months.',
    },
  },
  constraints: {
    // Its phase, work package and parent task are in its own project; a task is not its own parent.
    sameProject: {
      ...check('project.task', ['phase', 'workPackage', 'parentTask', 'project'], async (tasks) =>
        (
          await tasks.load({
            phase: { project: true },
            workPackage: { project: true },
            parentTask: { project: true },
            project: true,
          })
        )
          .filter(
            (t) =>
              (t.phase !== null && t.phase.project.id !== t.project.id) ||
              (t.workPackage !== null && t.workPackage.project.id !== t.project.id) ||
              (t.parentTask !== null &&
                (t.parentTask.id === t.id || t.parentTask.project.id !== t.project.id)),
          )
          .map((t) => t.id),
      ),
      message: 'A task’s phase, work package and parent task are in its own project.',
    },
  },
  onchange: {
    // A work package sets the task's phase.
    workPackage: async (d) => {
      const w = await (
        d as { record(key: string): Promise<{ phase: { id: number } | null } | null> }
      ).record('workPackage');
      if (w?.phase) (d as { set(key: string, value: unknown): void }).set('phase', w.phase.id);
    },
    // A task of a project takes the project's customer, and the company's planned hours when it has none.
    project: async (d, env) => {
      const p = await (
        d as { record(key: string): Promise<{ partner: { id: number } | null } | null> }
      ).record('project');
      const draft = d as { get(key: string): unknown; set(key: string, value: unknown): void };
      if (p?.partner) draft.set('partner', p.partner.id);
      if ((draft.get('plannedHours') ?? null) === null) {
        const { plannedHours } = await projectSettings(env as unknown as Env);
        if (plannedHours !== null) draft.set('plannedHours', plannedHours);
      }
    },
  },
});

/**
 * A finish-to-start dependency (RFC 0026): `successor` starts once `predecessor` is done, `lag` days later. Never a
 * task on itself, never twice, never in a circle.
 */
export const ProjectTaskLink = defineModel('project.task.link', {
  label: 'Task dependency',
  order: ['id asc'],
  access: { 'project.user': WRITE, 'project.manager': ALL },
  fields: {
    predecessor: f.many2one('project.task', {
      required: true,
      ondelete: 'cascade',
      label: 'Waits for',
    }),
    successor: f.many2one('project.task', { required: true, ondelete: 'cascade', label: 'Task' }),
    lag: f.integer({ required: true, default: 0, label: 'Lag (days)' }),
  },
  sqlConstraints: {
    once: { unique: ['predecessor', 'successor'], message: 'These tasks are linked already.' },
    notItself: {
      check: orm.sql`predecessor_id <> successor_id`,
      message: 'A task cannot wait for itself.',
    },
  },
  constraints: {
    noCircle: {
      ...check('project.task.link', ['predecessor', 'successor'], async (links) => {
        const bad: number[] = [];
        for (const l of await links.load({})) {
          // Walking forward from the successor must never reach the predecessor.
          const seen = new Set<number>();
          let frontier = [l.successor.id as number];
          let found = false;
          while (frontier.length > 0 && !found) {
            const next = await (
              await links.env
                .model('project.task.link')
                .search({ where: { predecessor: { in: frontier } } as never })
            ).load({});
            frontier = [];
            for (const n of next) {
              const id = n.successor.id as number;
              if (id === (l.predecessor.id as number)) found = true;
              if (!seen.has(id)) {
                seen.add(id);
                frontier.push(id);
              }
            }
          }
          if (found) bad.push(l.id);
        }
        return bad;
      }),
      message: 'These dependencies would go round in a circle.',
    },
  },
});

/** The chatter's served models, set when the app's routes register (status reports post on their project). */
let chatter: ChatterContext | undefined;
export function configureProjectChatter(context: ChatterContext): void {
  chatter = context;
}

/** Who reads and writes the control register: Projects users write, managers also delete. */
const CONTROL_ACCESS = {
  'project.user': ['read', 'write', 'create'],
  'project.manager': ALL,
} as const;

const RISK_LEVELS = { low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical' } as const;

/** Probability × impact (each 1–5) as a level: up to 4 low, 9 medium, 15 high, above critical. */
export function riskLevel(score: number): keyof typeof RISK_LEVELS {
  if (score <= 4) return 'low';
  if (score <= 9) return 'medium';
  if (score <= 15) return 'high';
  return 'critical';
}

/** A risk of a project (RFC 0026 step 5): how likely, how bad, who owns it and what is done about it. */
export const ProjectRisk = defineModel('project.risk', {
  label: 'Project risk',
  recName: 'name',
  order: ['score desc', 'id desc'],
  companyScoped: { required: true },
  tracking: ['status', 'probability', 'impact', 'owner'],
  access: CONTROL_ACCESS,
  fields: {
    project: f.many2one('project.project', {
      required: true,
      checkCompany: true,
      ondelete: 'cascade',
    }),
    name: f.char({ required: true, label: 'Risk' }),
    description: f.text(),
    category: f.selection(
      {
        schedule: 'Schedule',
        cost: 'Cost',
        scope: 'Scope',
        quality: 'Quality',
        safety: 'Safety',
        supply: 'Supply',
        other: 'Other',
      },
      { required: true, default: 'other', help: 'What part of the project the risk threatens.' },
    ),
    probability: f.integer({
      required: true,
      default: 3,
      help: 'How likely, from 1 (rare) to 5 (almost certain).',
    }),
    impact: f.integer({
      required: true,
      default: 3,
      help: 'How bad if it happens, from 1 (slight) to 5 (severe).',
    }),
    score: f.integer({
      store: true,
      label: 'Score',
      ...compute('project.risk', 'score', ['probability', 'impact'], (risks) => {
        for (const r of risks) r.score = (r.probability ?? 0) * (r.impact ?? 0);
      }),
    }),
    level: f.selection(RISK_LEVELS, {
      store: true,
      label: 'Level',
      help: 'From the probability times the impact: up to 4 low, 9 medium, 15 high, above that critical.',
      ...compute('project.risk', 'level', ['probability', 'impact'], (risks) => {
        for (const r of risks) r.level = riskLevel((r.probability ?? 0) * (r.impact ?? 0));
      }),
    }),
    owner: f.many2one('res.users', {
      ondelete: 'set null',
      default: (env: Env) => env.userId,
    }),
    mitigation: f.text({ help: 'What is done to make it less likely or less bad.' }),
    contingency: f.text({ help: 'What is done if it happens.' }),
    dueDate: f.date({ label: 'Review by' }),
    status: f.selection(
      { open: 'Open', mitigating: 'Being mitigated', occurred: 'Occurred', closed: 'Closed' },
      {
        required: true,
        default: 'open',
        help: 'Where the risk stands: open, being dealt with, happened or closed.',
      },
    ),
  },
  sqlConstraints: {
    scale: {
      check: orm.sql`probability BETWEEN 1 AND 5 AND impact BETWEEN 1 AND 5`,
      message: 'Probability and impact are from 1 to 5.',
    },
  },
});

/** An issue of a project: something wrong now, how serious, who resolves it and how it was resolved. */
export const ProjectIssue = defineModel('project.issue', {
  label: 'Project issue',
  recName: 'name',
  order: ['id desc'],
  companyScoped: { required: true },
  tracking: ['status', 'severity', 'owner'],
  access: CONTROL_ACCESS,
  fields: {
    project: f.many2one('project.project', {
      required: true,
      checkCompany: true,
      ondelete: 'cascade',
    }),
    name: f.char({ required: true, label: 'Issue' }),
    description: f.text(),
    severity: f.selection(RISK_LEVELS, {
      required: true,
      default: 'medium',
      help: 'How serious the issue is for the project.',
    }),
    raisedBy: f.many2one('res.users', {
      default: (env: Env) => env.userId,
      ondelete: 'set null',
      label: 'Raised by',
    }),
    owner: f.many2one('res.users', { ondelete: 'set null' }),
    dueDate: f.date({ label: 'Resolve by' }),
    status: f.selection(
      { open: 'Open', in_progress: 'In progress', resolved: 'Resolved', closed: 'Closed' },
      {
        required: true,
        default: 'open',
        help: 'Where the issue stands, from open to resolved and closed.',
      },
    ),
    resolution: f.text(),
    risk: f.many2one('project.risk', { ondelete: 'set null', label: 'From the risk' }),
  },
  constraints: {
    resolution: {
      ...check('project.issue', ['status', 'resolution'], async (issues) =>
        issues
          .filter(
            (i) => ['resolved', 'closed'].includes(i.status) && (i.resolution ?? '').trim() === '',
          )
          .map((i) => i.id),
      ),
      message: 'A resolved issue says how it was resolved.',
    },
  },
});

const CHANGE_STATES = {
  draft: 'Draft',
  submitted: 'Waiting for approval',
  applied: 'Approved and applied',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
} as const;

/**
 * A change request (RFC 0026 step 5): a new deadline or budget for a project, with the reason and the impact, decided
 * through the approval engine; once approved it moves the project's dates and baseline (and its baseline budget) and
 * keeps what they were.
 */
export const ProjectChange = defineModel('project.change', {
  label: 'Change request',
  recName: 'title',
  order: ['id desc'],
  companyScoped: { required: true },
  tracking: ['state', 'newDateEnd', 'newBudget'],
  access: CONTROL_ACCESS,
  rules: {
    // Changed while a draft (or rejected); managers anywhere.
    read: { groups: ['project.user'], perms: ['read'], domain: {} },
    draft: {
      groups: ['project.user'],
      perms: ['write', 'create'],
      domain: { state: { in: ['draft', 'rejected'] } },
    },
    managers: {
      groups: ['project.manager'],
      perms: ['read', 'write', 'create', 'unlink'],
      domain: {},
    },
  },
  fields: {
    name: f.char({ readonly: true, sequence: 'project.change', label: 'Number' }),
    project: f.many2one('project.project', {
      required: true,
      checkCompany: true,
      ondelete: 'cascade',
    }),
    title: f.char({ required: true }),
    requester: f.many2one('res.users', {
      default: (env: Env) => env.userId,
      ondelete: 'restrict',
      label: 'Asked by',
    }),
    /** The project's sponsor, who decides it first (a Projects manager when there is none). */
    sponsor: f.many2one('res.users', {
      store: true,
      label: 'Sponsor',
      ...compute('project.change', 'sponsor', ['project.sponsor'], (changes) => {
        for (const c of changes) c.sponsor = c.project?.sponsor?.id ?? null;
      }),
    }),
    reason: f.text({ required: true }),
    impact: f.text({ help: 'What else it changes: scope, people, other projects.' }),
    newDateEnd: f.date({ label: 'New deadline' }),
    newBudget: f.decimal({ scale: 2, label: 'New baseline budget', groups: MANAGERS_ONLY }),
    previousDateEnd: f.date({ label: 'Deadline before' }),
    previousBaselineEnd: f.date({ label: 'Baseline end before' }),
    previousBudget: f.decimal({ scale: 2, label: 'Baseline budget before', groups: MANAGERS_ONLY }),
    appliedAt: f.datetime({ label: 'Applied on' }),
    state: f.state({
      states: CHANGE_STATES,
      initial: 'draft',
      help: 'Submitted for approval; once approved, applied to the project and its baseline.',
      transitions: {
        submit: {
          from: ['draft', 'rejected'],
          to: 'submitted',
          // The new budget is the managers' to see: read as the system (a transition is a write).
          guard: records(
            'project.change',
            async (changes): Promise<number[]> =>
              (changes.env as unknown as Env).asSuperuser(
                { reason: 'change request check' },
                async (su) =>
                  [
                    ...(await su
                      .model('project.change')
                      .browse(changes.ids)
                      .load(['newDateEnd', 'newBudget'])),
                  ]
                    .filter((c) => c.newDateEnd === null && c.newBudget === null)
                    .map((c) => c.id),
              ),
          ),
          message: 'A change request asks for a new deadline, a new budget or both.',
          after: records('project.change', async (changes) => {
            await requestApprovals(changes);
          }),
        },
        approve: {
          from: ['submitted'],
          to: 'applied',
          guard: records('project.change', (changes) => approvalGuard(changes)),
          message: 'Waiting for approvals.',
          // Run as the system by the engine: the deadline, the baseline and its budget move, what they were kept.
          after: records('project.change', async (changes) => {
            const env = changes.env as unknown as Env;
            await env.asSuperuser({ reason: 'change request applied' }, async (su) => {
              for (const c of await su
                .model('project.change')
                .browse(changes.ids)
                .load({ project: ['dateEnd', 'baselineEnd', 'baselineBudget'] })) {
                const project = c.project;
                const moves: Record<string, unknown> = {};
                if (c.newDateEnd !== null) {
                  moves['dateEnd'] = c.newDateEnd;
                  moves['baselineEnd'] = c.newDateEnd;
                }
                if (c.newBudget !== null) moves['baselineBudget'] = c.newBudget;
                await su
                  .model('project.change')
                  .browse([c.id])
                  .write({
                    previousDateEnd: project.dateEnd,
                    previousBaselineEnd: project.baselineEnd,
                    previousBudget: project.baselineBudget,
                    appliedAt: new Date(),
                  } as never);
                await su
                  .model('project.project')
                  .browse([project.id])
                  .write(moves as never);
                await su.emit('project.change.applied', { id: c.id });
              }
            });
          }),
        },
        reject: { from: ['submitted'], to: 'rejected' },
        redraft: { from: ['submitted', 'rejected'], to: 'draft' },
        cancel: { from: ['draft', 'submitted', 'rejected'], to: 'cancelled' },
      },
    }),
  },
});

/**
 * A weekly status report (RFC 0026 step 5): the project's health and progress when written, what was done, what is
 * next and the risks; sent, it is posted on the project for its followers, the sponsor among them.
 */
export const ProjectStatusReport = defineModel('project.status.report', {
  label: 'Status report',
  recName: 'name',
  order: ['date desc', 'id desc'],
  companyScoped: { required: true },
  access: CONTROL_ACCESS,
  rules: {
    read: { groups: ['project.user'], perms: ['read'], domain: {} },
    draftOwn: {
      groups: ['project.user'],
      perms: ['write', 'create'],
      domain: { author: { $env: 'uid' }, state: 'draft' },
    },
    managers: {
      groups: ['project.manager'],
      perms: ['read', 'write', 'create', 'unlink'],
      domain: {},
    },
  },
  fields: {
    project: f.many2one('project.project', {
      required: true,
      checkCompany: true,
      ondelete: 'cascade',
    }),
    date: f.date({ required: true, default: (env: Env) => env.today(), label: 'Week of' }),
    name: f.char({
      store: true,
      label: 'Report',
      ...compute('project.status.report', 'name', ['project.name', 'date'], (reports) => {
        for (const r of reports)
          r.name = `${r.project?.name ?? ''} — ${String(r.date ?? '').slice(0, 10)}`;
      }),
    }),
    author: f.many2one('res.users', {
      default: (env: Env) => env.userId,
      ondelete: 'restrict',
    }),
    health: f.selection(HEALTH, {
      label: 'Health then',
      help: 'The project’s health when the report was written.',
    }),
    progress: f.decimal({ scale: 1, label: 'Progress then %' }),
    done: f.text({ label: 'Done this week' }),
    next: f.text({ label: 'Next week' }),
    risks: f.text({ label: 'Risks and issues' }),
    sentAt: f.datetime({ label: 'Sent' }),
    state: f.state({
      states: { draft: 'Draft', sent: 'Sent' },
      initial: 'draft',
      help: 'A draft can still be edited; once sent, it is posted on the project for its followers.',
      transitions: {
        send: {
          from: ['draft'],
          to: 'sent',
          guard: records('project.status.report', async (reports) =>
            [...(await reports.load({}))]
              .filter((r) => (r.done ?? '').trim() === '' && (r.next ?? '').trim() === '')
              .map((r) => r.id),
          ),
          message: 'A report says what was done or what is next.',
          after: records('project.status.report', async (reports) => {
            const env = reports.env as unknown as Env;
            for (const r of await reports.load({ project: ['sponsor'] })) {
              await env
                .model('project.status.report')
                .browse([r.id])
                .write({ sentAt: new Date() } as never);
              // Posted on the project for its followers; its sponsor follows it.
              if (chatter !== undefined) {
                const projectId = r.project.id as number;
                const sponsor = r.project.sponsor?.id ?? null;
                if (sponsor !== null)
                  await setFollower(env as never, chatter, 'project.project', projectId, {
                    user: sponsor,
                    follow: true,
                  });
                const parts = [
                  `Status report, week of ${String(r.date ?? '').slice(0, 10)}`,
                  `Health: ${r.health === null ? '—' : HEALTH[r.health]} · Progress: ${String(r.progress ?? 0)}%`,
                  (r.done ?? '').trim() === '' ? '' : `Done: ${r.done}`,
                  (r.next ?? '').trim() === '' ? '' : `Next: ${r.next}`,
                  (r.risks ?? '').trim() === '' ? '' : `Risks and issues: ${r.risks}`,
                ].filter((x) => x !== '');
                await postMessage(env as never, chatter, 'project.project', projectId, {
                  kind: 'comment',
                  text: parts.join('\n\n'),
                });
              }
              await reports.env.emit('project.status.report.sent', { id: r.id });
            }
          }),
        },
      },
    }),
  },
  onchange: {
    // The project's figures and its open risks and issues, filled in for the author to edit.
    project: onchange('project.status.report', async (d, env) => {
      const id = Number(d.get('project') ?? 0);
      if (!Number.isSafeInteger(id) || id <= 0) return;
      const [p] = await env
        .model('project.project')
        .browse([id as never])
        .load(['health', 'progress']);
      const risks = await env
        .model('project.risk')
        .search({ where: { project: id, status: { in: ['open', 'mitigating'] } } as never })
        .then((r) => r.load(['name', 'level']));
      const issues = await env
        .model('project.issue')
        .search({ where: { project: id, status: { in: ['open', 'in_progress'] } } as never })
        .then((r) => r.load(['name', 'severity']));
      d.set('health', p?.health ?? null);
      d.set('progress', p?.progress ?? null);
      d.set(
        'risks',
        [
          ...[...risks].map((x) => `Risk (${x.level}): ${x.name}`),
          ...[...issues].map((x) => `Issue (${x.severity}): ${x.name}`),
        ].join('\n'),
      );
    }),
  },
});

export const ProjectTimesheet = defineModel('project.timesheet', {
  label: 'Timesheet',
  order: ['date desc', 'id desc'],
  companyScoped: { required: true },
  access: { 'project.user': WRITE, 'project.manager': ALL },
  rules: {
    own: {
      groups: ['project.user'],
      perms: ['read', 'write', 'create', 'unlink'],
      domain: { user: { $env: 'uid' } },
    },
    all: { groups: ['project.manager'], perms: ['read', 'write', 'create', 'unlink'], domain: {} },
  },
  fields: {
    task: f.many2one('project.task', { required: true, checkCompany: true, ondelete: 'cascade' }),
    project: f.many2one('project.project', {
      store: true,
      readonly: true,
      ...compute('project.timesheet', 'project', ['task.project'], (lines) => {
        for (const l of lines) l.project = l.task.project.id;
      }),
    }),
    user: f.many2one('res.users', { required: true, default: (env: Env) => env.userId }),
    date: f.date({ required: true, default: (env: Env) => env.today() }),
    hours: f.decimal({ scale: 2, required: true, default: '1' }),
    description: f.char(),
    /** The hours at the person's cost in the project on that day, else their role's default (managers only). */
    cost: f.decimal({
      scale: 2,
      store: true,
      label: 'Cost',
      groups: MANAGERS_SEE,
      help: 'The hours at the person’s hourly cost in the project that day, else their role’s.',
      ...compute(
        'project.timesheet',
        'cost',
        [
          'hours',
          'user',
          'date',
          'project',
          'project.members.hourlyCost',
          'project.members.user',
          'project.members.dateFrom',
          'project.members.dateTo',
          'project.members.role.defaultHourlyCost',
        ],
        (lines) => {
          for (const l of lines) {
            const day = String(l.date);
            const member = [...(l.project?.members ?? [])].find(
              (m) =>
                m.user.id === l.user.id &&
                (m.dateFrom === null || String(m.dateFrom) <= day) &&
                (m.dateTo === null || String(m.dateTo) >= day),
            );
            const rate = member?.hourlyCost ?? member?.role?.defaultHourlyCost ?? null;
            l.cost = rate === null ? orm.toDecimal(0) : l.hours.times(rate).toDecimalPlaces(2);
          }
        },
      ),
    }),
  },
  sqlConstraints: {
    hoursPositive: { check: orm.sql`hours > 0`, message: 'Hours are positive.' },
  },
  constraints: {
    // The company's step (App settings › Projects): quarter, half or whole hours.
    hoursOnTheStep: {
      ...check('project.timesheet', ['hours'], async (lines) => {
        const { step } = await projectSettings(lines.env as unknown as Env);
        const unit = STEPS[step];
        if (unit === undefined) return [];
        return lines.filter((l) => !l.hours.mod(unit).isZero());
      }),
      message: 'Timesheet hours are entered in the company’s steps (App settings › Projects).',
    },
  },
});

export const projectShutro = defineModule({
  name: 'project',
  version: '0.4.0',
  depends: [contactsShutro, messagingShutro, permissionsShutro],
  groups: [
    orm.defineGroup({
      code: 'project.user',
      label: 'Project user',
      implies: ['contacts.user', 'messaging.user'],
    }),
    orm.defineGroup({
      code: 'project.manager',
      label: 'Project manager',
      implies: ['project.user'],
    }),
  ],
  permissions: [
    orm.definePermission({
      code: 'project.baseline',
      label: 'Take a plan’s baseline again',
      groups: ['project.manager'],
    }),
  ],
  sequences: [
    orm.defineSequence({ code: 'project.project', prefix: 'PRJ-', padding: 4 }),
    orm.defineSequence({ code: 'project.plan', prefix: 'PLAN-', padding: 4 }),
    orm.defineSequence({ code: 'project.change', prefix: 'CR-', padding: 4 }),
  ],
  models: [
    ProjectRisk,
    ProjectIssue,
    ProjectChange,
    ProjectStatusReport,
    ProjectBudgetLine,
    ProjectRole,
    ProjectMember,
    ProjectPlan,
    ProjectType,
    ProjectTaskCategory,
    ProjectTag,
    ProjectTaskStage,
    ProjectProject,
    ProjectPhase,
    ProjectWorkPackage,
    ProjectTask,
    ProjectTaskLink,
    ProjectTimesheet,
  ],
  extensions: [CompanyProject],
  // The kanban every installation starts with (theirs to change afterwards).
  data: [
    record('project.task.stage', 'stage_new', { name: 'New', sequence: 1 }, { noupdate: true }),
    record(
      'project.task.stage',
      'stage_progress',
      { name: 'In progress', sequence: 2 },
      { noupdate: true },
    ),
    record(
      'project.task.stage',
      'stage_done',
      { name: 'Done', sequence: 3, fold: true, done: true },
      { noupdate: true },
    ),
  ],
});
