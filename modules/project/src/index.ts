/**
 * @packageDocumentation
 * `@kosh/project` (RFC 0008): the Projects app. Projects with a customer and a manager, tasks on a kanban of shared
 * stages with assignees, priorities and deadlines (and a calendar of deadlines), timesheets whose hours add up on
 * the task and the project, and a pivot of hours by project, user and month. The chatter is on projects and tasks.
 */
import { contacts } from '@kosh/contacts';
import { messaging } from '@kosh/messaging';
import { defineModule } from '@kosh/modules-sdk';
import { reporting } from '@kosh/reporting';
import { action, calendar, form, gantt, kanban, list, pivot, search } from '@kosh/views';
import type { Env } from './.kosh/bindings.js';
import { projectDemo, SUPPORT_PROJECT } from './demo.js';
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
  // Defaults for tasks and timesheets (RFC 0020), per company.
  settings: {
    sections: [
      {
        key: 'work',
        label: 'Tasks and timesheets',
        description: 'What new tasks start with, and the steps timesheets are entered in.',
        keywords: 'planned hours timesheet rounding step quarter half',
        scope: 'company',
        editors: ['project.manager'],
        fields: [
          {
            key: 'projectPlannedHoursDefault',
            min: 0,
            help: 'Filled in on a new task when its project is chosen; each task can still be changed.',
          },
          {
            key: 'projectTimesheetStep',
            help: 'Hours that are not a multiple of the step are refused.',
          },
        ],
      },
    ],
  },
  // support@<inbound domain>: a task in the support project (RFC 0006 §7.1), or the first project there is.
  inboundAliases: [
    {
      alias: 'support',
      model: 'project.task',
      subjectField: 'name',
      bodyField: 'description',
      defaults: async (raw) => {
        const env = raw as Env;
        const named = await env
          .model('project.project')
          .search({ where: { name: SUPPORT_PROJECT }, limit: 1 });
        const any =
          named.ids.length > 0 ? named : await env.model('project.project').search({ limit: 1 });
        const project = any.ids[0];
        return project === undefined ? null : { project };
      },
    },
  ],
  depends: [contacts, messaging, reporting],
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
  // The Overview (RFC 0022 step 2): what is open, where the hours go, who carries the load.
  overview: {
    cards: [
      {
        id: 'projects_all',
        title: 'Projects',
        kind: 'kpi',
        model: 'project.project',
        measure: 'count',
        w: 3,
      },
      {
        id: 'open_tasks',
        title: 'Open tasks',
        kind: 'kpi',
        model: 'project.task',
        measure: 'count',
        filter: { 'stage.done': false },
        w: 3,
      },
      {
        id: 'hours_month',
        title: 'Hours this month',
        kind: 'kpi',
        model: 'project.timesheet',
        measure: 'sum:hours',
        comparison: { field: 'date', mode: 'previous' },
        w: 3,
      },
      {
        id: 'planned_open',
        title: 'Planned hours open',
        kind: 'kpi',
        model: 'project.task',
        measure: 'sum:plannedHours',
        filter: { 'stage.done': false },
        w: 3,
      },
      {
        id: 'tasks_by_stage',
        title: 'Tasks by stage',
        kind: 'chart',
        model: 'project.task',
        measure: 'count',
        groupBy: 'stage',
        chart: 'bar',
        w: 6,
      },
      {
        id: 'hours_by_project',
        title: 'Hours by project',
        kind: 'chart',
        model: 'project.timesheet',
        measure: 'sum:hours',
        groupBy: 'project',
        chart: 'pie',
        w: 6,
      },
      {
        id: 'load_by_person',
        title: 'Open tasks by person',
        kind: 'chart',
        model: 'project.task',
        measure: 'count',
        groupBy: 'assignee',
        filter: { 'stage.done': false },
        chart: 'bar',
        w: 6,
      },
      {
        id: 'busiest',
        title: 'Projects with most hours',
        kind: 'list',
        model: 'project.project',
        measure: 'sum:hours',
        w: 6,
      },
    ],
  },
  actions: {
    'projects.action_projects': action(ProjectProject, {
      label: 'Projects',
      views: ['list', 'gantt', 'form'],
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
        k.stats('related', [
          {
            id: 'project_tasks',
            label: 'Tasks',
            model: ProjectTask,
            where: { project: { $record: 'id' } },
            action: 'projects.action_tasks',
          },
          {
            id: 'project_open_tasks',
            label: 'Open',
            model: ProjectTask,
            where: { project: { $record: 'id' }, 'stage.done': false },
            action: 'projects.action_tasks',
            tone: 'warning',
          },
          {
            id: 'project_hours',
            label: 'Hours',
            model: ProjectTimesheet,
            where: { project: { $record: 'id' } },
            measure: { sum: 'hours' },
            action: 'projects.action_timesheets',
          },
        ]),
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
        avatar: 'assignee',
        color: 'project',
        footer: [
          { field: 'deadline', widget: 'daysLeft' },
          { field: 'priority', widget: 'priority' },
        ],
      },
    }),
    // Projects on a timeline, from their start to their deadline.
    'project.project.gantt': gantt(ProjectProject, {
      dateStart: 'dateStart',
      dateStop: 'dateEnd',
      title: 'name',
      scale: 'week',
    }),
    'project.task.list': list(ProjectTask, {
      columns: [
        'name',
        'project',
        'stage',
        'assignee',
        { field: 'deadline', widget: 'daysLeft' },
        { field: 'priority', widget: 'priority' },
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
    'project.task.stage': search(ProjectTaskStage, {
      fields: ['name'],
      filters: {
        closing: { label: 'Closes the task', domain: { done: true }, group: 'done' },
        folded: { label: 'Folded on the board', domain: { fold: true }, group: 'fold' },
      },
    }),
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
