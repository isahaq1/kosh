/**
 * The data layer of Projects (RFC 0008): projects with their customer and manager, tasks on a kanban of shared
 * stages (a stage may close the task), assignees, priorities, deadlines, planned hours, and timesheets whose hours
 * add up on the task. Users see every project and task of their companies and their own timesheets; managers
 * see everything.
 */
import { contactsShutro } from '@kosh/contacts';
import { messagingShutro } from '@kosh/messaging';
import { orm } from '@kosh/server/orm';
import { compute, defineModel, defineModule, type Env, f, record } from './.kosh/bindings.js';

const READ = ['read'] as const;
const WRITE = ['read', 'write', 'create', 'unlink'] as const;
const ALL = ['read', 'write', 'create', 'unlink', 'export', 'import'] as const;

/** A column of the task kanban, shared by every project (per company later, if asked for). */
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
    // A task of a project takes the project's customer.
    project: async (d) => {
      const p = await (
        d as { record(key: string): Promise<{ partner: { id: number } | null } | null> }
      ).record('project');
      if (p?.partner)
        (d as { set(key: string, value: unknown): void }).set('partner', p.partner.id);
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
});

export const projectShutro = defineModule({
  name: 'project',
  version: '0.1.0',
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
