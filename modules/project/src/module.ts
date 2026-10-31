/**
 * The data layer of Projects (RFC 0008): projects with their customer and manager, tasks on a kanban of shared
 * stages (a stage may close the task), assignees, priorities, deadlines, planned hours, and timesheets whose hours
 * add up on the task. Users see every project and task of their companies and their own timesheets; managers
 * see everything.
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
  const [company] = (
    await env
      .model('res.company')
      .browse([env.companyId])
      .load(['projectPlannedHoursDefault', 'projectTimesheetStep'])
  ).read(['projectPlannedHoursDefault', 'projectTimesheetStep']);
  const planned = company?.['projectPlannedHoursDefault'];
  return {
    plannedHours: planned === null || planned === undefined ? null : String(planned),
    step:
      typeof company?.['projectTimesheetStep'] === 'string'
        ? company['projectTimesheetStep']
        : 'none',
  };
}

export const ProjectTaskStage = defineModel('project.task.stage', {
  label: 'Task stage',
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
  tracking: ['manager', 'partner', 'dateEnd'],
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
    partner: f.many2one('res.partner', { checkCompany: true, label: 'Customer' }),
    manager: f.many2one('res.users', {
      default: (env: Env) => env.userId,
      label: 'Project manager',
    }),
    sequence: f.integer({ required: true, default: 10 }),
    dateStart: f.date({ label: 'Start' }),
    dateEnd: f.date({ label: 'Deadline' }),
    description: f.text(),
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
});

export const ProjectTask = defineModel('project.task', {
  label: 'Task',
  order: ['sequence asc', 'priority desc', 'id desc'],
  archivable: true,
  companyScoped: { required: true },
  tracking: ['stage', 'assignee', 'deadline'],
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
    assignee: f.many2one('res.users', { label: 'Assigned to' }),
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
    sequence: f.integer({ required: true, default: 10 }),
    description: f.text(),
    timesheets: f.one2many('project.timesheet', 'task'),
  },
  onchange: {
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
  version: '0.2.0',
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
  models: [ProjectTaskStage, ProjectProject, ProjectTask, ProjectTimesheet],
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
