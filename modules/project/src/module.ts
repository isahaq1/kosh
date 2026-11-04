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
import { messagingShutro } from '@kosh/messaging';
import { orm } from '@kosh/server/orm';
import {
  check,
  compute,
  defineModel,
  defineModule,
  type Env,
  extendModel,
  f,
  record,
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
  },
});

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

export const ProjectProject = defineModel('project.project', {
  label: 'Project',
  recName: 'name',
  order: ['sequence asc', 'name asc'],
  archivable: true,
  companyScoped: { required: true },
  hierarchy: { parent: 'parentProject', path: 'parentPath' },
  tracking: ['manager', 'partner', 'dateEnd', 'sponsor', 'owner', 'riskLevel', 'priority'],
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
    partner: f.many2one('res.partner', { checkCompany: true, label: 'Customer' }),
    manager: f.many2one('res.users', {
      default: (env: Env) => env.userId,
      label: 'Project manager',
    }),
    sponsor: f.many2one('res.users', { ondelete: 'set null', label: 'Sponsor' }),
    owner: f.many2one('res.users', { ondelete: 'set null', label: 'Owner' }),
    priority: f.selection(PRIORITIES, { required: true, default: 'normal' }),
    riskLevel: f.selection(
      { low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical' },
      { required: true, default: 'low', label: 'Risk' },
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
  status: f.selection(STATUSES, { required: true, default: 'draft' }),
  description: f.text(),
  /** Set by hand when the tasks do not tell the whole story (empty: computed). */
  progressOverride: f.decimal({ scale: 1, label: 'Progress set by hand %' }),
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
    priority: f.selection(PRIORITIES, { required: true, default: 'normal' }),
    workPackages: f.one2many('project.work.package', 'phase', { label: 'Work packages' }),
    tasks: f.one2many('project.task', 'phase'),
    progress: f.decimal({
      scale: 1,
      store: true,
      label: 'Progress %',
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
      { required: true, default: 'normal' },
    ),
    deadline: f.date(),
    plannedHours: f.decimal({ scale: 2, label: 'Planned hours' }),
    effectiveHours: f.decimal({
      scale: 2,
      store: true,
      label: 'Hours spent',
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
  depends: [contactsShutro, messagingShutro],
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
  sequences: [orm.defineSequence({ code: 'project.project', prefix: 'PRJ-', padding: 4 })],
  models: [
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
