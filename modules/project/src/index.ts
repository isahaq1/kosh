/**
 * @packageDocumentation
 * `@kosh/project` (RFC 0008): the Projects app. Projects with a customer and a manager, tasks on a kanban of shared
 * stages with assignees, priorities and deadlines (and a calendar of deadlines), timesheets whose hours add up on
 * the task and the project, and a pivot of hours by project, user and month. The chatter is on projects and tasks.
 */
import { contacts } from '@kosh/contacts';
import { messaging } from '@kosh/messaging';
import { defineModule } from '@kosh/modules-sdk';
import { action, calendar, form, kanban, list, pivot, search } from '@kosh/views';
import { projectDemo } from './demo.js';
import {
  ProjectProject,
  ProjectTask,
  ProjectTaskStage,
  ProjectTimesheet,
  projectShutro,
} from './module.js';

export { SUPPORT_PROJECT } from './demo.js';
export {
  ProjectProject,
  ProjectTask,
  ProjectTaskStage,
  ProjectTimesheet,
  projectShutro,
} from './module.js';

export const project: ReturnType<typeof defineModule> = defineModule({
  shutro: projectShutro,
  kosh: '^0.1.0',
  hooks: { demo: projectDemo },
  depends: [contacts, messaging],
  app: {
    code: 'projects',
    label: 'Projects',
    icon: 'projects',
    sequence: 40,
    category: 'Operations',
    summary: 'Projects, tasks on a kanban, timesheets',
  },
  accessLevels: {
    user: { label: 'User (projects and tasks, own timesheets)', groups: ['project.user'] },
    manager: {
      label: 'Manager (everything, stages)',
      groups: ['project.manager'],
      implies: ['user'],
    },
  },
  actions: {
    'projects.action_projects': action(ProjectProject, {
      label: 'Projects',
      views: ['list', 'form'],
    }),
    'projects.action_tasks': action(ProjectTask, {
      label: 'Tasks',
      views: ['kanban', 'list', 'form', 'calendar'],
    }),
    'projects.action_timesheets': action(ProjectTimesheet, {
      label: 'Timesheets',
      views: ['list', 'pivot', 'form'],
    }),
    'projects.action_stages': action(ProjectTaskStage, {
      label: 'Stages',
      views: ['list', 'form'],
    }),
  },
  menus: [
    { id: 'projects.root', label: 'Projects', app: 'projects' },
    {
      id: 'projects.projects',
      parent: 'projects.root',
      label: 'Projects',
      action: 'projects.action_projects',
      sequence: 1,
    },
    {
      id: 'projects.tasks',
      parent: 'projects.root',
      label: 'Tasks',
      action: 'projects.action_tasks',
      sequence: 2,
    },
    {
      id: 'projects.timesheets',
      parent: 'projects.root',
      label: 'Timesheets',
      action: 'projects.action_timesheets',
      sequence: 3,
    },
    { id: 'projects.configuration', parent: 'projects.root', label: 'Configuration', sequence: 9 },
    {
      id: 'projects.stages',
      parent: 'projects.configuration',
      label: 'Stages',
      action: 'projects.action_stages',
      sequence: 1,
    },
  ],
  views: {
    'project.project.list': list(ProjectProject, {
      columns: [
        'name',
        'partner',
        'manager',
        'dateEnd',
        { field: 'taskCount', sum: true },
        { field: 'hours', sum: true },
      ],
      defaultOrder: ['sequence asc', 'name asc'],
    }),
    'project.project.form': form(ProjectProject, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.group('main', ['name', 'partner', 'manager', 'sequence']),
        k.group('dates', ['dateStart', 'dateEnd', 'taskCount', 'hours']),
        k.group('about', ['description'], { columns: 1 }),
        k.lines('tasks', [
          { field: 'name', id: 'task_name' },
          'stage',
          'assignee',
          'deadline',
          'plannedHours',
          'effectiveHours',
        ]),
      ],
      chatter: true,
    })),
    'project.task.kanban': kanban(ProjectTask, {
      groupBy: 'stage',
      card: {
        title: 'name',
        subtitle: 'project',
        footer: ['assignee', 'deadline'],
        badges: [{ field: 'priority', widget: 'badge' }],
      },
    }),
    'project.task.list': list(ProjectTask, {
      columns: [
        'name',
        'project',
        'stage',
        'assignee',
        'deadline',
        { field: 'priority', widget: 'badge' },
        { field: 'plannedHours', sum: true },
        { field: 'effectiveHours', sum: true },
      ],
      inlineEdit: ['stage', 'assignee', 'deadline'],
    }),
    'project.task.form': form(ProjectTask, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.group('main', ['name', 'project', 'stage', 'assignee']),
        k.group('when', ['partner', 'priority', 'deadline', 'plannedHours', 'effectiveHours']),
        k.group('about', ['description'], { columns: 1 }),
        k.lines('timesheets', [
          'date',
          'user',
          { field: 'description', id: 'ts_description' },
          'hours',
        ]),
      ],
      chatter: true,
    })),
    'project.task.calendar': calendar(ProjectTask, {
      dateStart: 'deadline',
      title: 'name',
      color: 'project',
      mode: 'month',
    }),
    'project.timesheet.list': list(ProjectTimesheet, {
      columns: ['date', 'project', 'task', 'user', 'description', { field: 'hours', sum: true }],
      defaultOrder: ['date desc'],
      inlineEdit: ['description', 'hours'],
    }),
    'project.timesheet.form': form(ProjectTimesheet, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.group('main', ['task', 'project', 'user', 'date', 'hours']),
        k.group('about', ['description'], { columns: 1 }),
      ],
    })),
    'project.timesheet.pivot': pivot(ProjectTimesheet, {
      rows: ['project', 'user'],
      cols: ['date:month'],
      measures: [{ sum: 'hours' }],
      comparison: { field: 'date', mode: 'previous' },
    }),
    'project.task.stage.list': list(ProjectTaskStage, {
      columns: ['sequence', 'name', 'fold', 'done'],
      inlineEdit: ['name', 'sequence', 'fold', 'done'],
    }),
    'project.task.stage.form': form(ProjectTaskStage, (k) => ({
      header: { buttons: [] },
      sheet: [k.group('main', ['name', 'sequence', 'fold', 'done'])],
    })),
  },
  search: {
    'project.project': search(ProjectProject, {
      fields: ['name', 'partner.name'],
      groupBy: ['manager', 'partner'],
    }),
    'project.task': search(ProjectTask, {
      fields: ['name', 'project.name', 'partner.name'],
      filters: {
        open: { label: 'Open', domain: { done: false }, group: 'state' },
        done: { label: 'Done', domain: { done: true }, group: 'state' },
        high: { label: 'High priority', domain: { priority: 'high' } },
      },
      groupBy: ['project', 'stage', 'assignee', 'deadline:week'],
    }),
    'project.timesheet': search(ProjectTimesheet, {
      fields: ['description', 'task.name', 'project.name'],
      groupBy: ['project', 'task', 'user', 'date:month'],
    }),
  },
});
