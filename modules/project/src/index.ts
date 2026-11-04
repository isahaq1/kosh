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
import { action, calendar, form, gantt, hierarchy, kanban, list, pivot, search } from '@kosh/views';
import type { Env } from './.kosh/bindings.js';
import { projectDemo, SUPPORT_PROJECT } from './demo.js';
import {
  ProjectPhase,
  ProjectProject,
  ProjectTag,
  ProjectTask,
  ProjectTaskCategory,
  ProjectTaskLink,
  ProjectTaskStage,
  ProjectTimesheet,
  ProjectType,
  ProjectWorkPackage,
  projectShutro,
} from './module.js';

export { SUPPORT_PROJECT } from './demo.js';
export {
  ProjectPhase,
  ProjectProject,
  ProjectTag,
  ProjectTask,
  ProjectTaskCategory,
  ProjectTaskLink,
  ProjectTaskStage,
  ProjectTimesheet,
  ProjectType,
  ProjectWorkPackage,
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
      views: ['list', 'gantt', 'hierarchy', 'form'],
    }),
    'projects.action_phases': action(ProjectPhase, {
      label: 'Phases',
      views: ['list', 'gantt', 'form'],
    }),
    'projects.action_work_packages': action(ProjectWorkPackage, {
      label: 'Work packages',
      views: ['list', 'kanban', 'form'],
    }),
    'projects.action_types': action(ProjectType, {
      label: 'Project types',
      views: ['list', 'form'],
    }),
    'projects.action_categories': action(ProjectTaskCategory, {
      label: 'Task categories',
      views: ['list', 'form'],
    }),
    'projects.action_tags': action(ProjectTag, { label: 'Tags', views: ['list', 'form'] }),
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
      id: 'projects.phases',
      parent: 'projects.root',
      label: 'Phases',
      action: 'projects.action_phases',
      sequence: 1.3,
    },
    {
      id: 'projects.work_packages',
      parent: 'projects.root',
      label: 'Work packages',
      action: 'projects.action_work_packages',
      sequence: 1.6,
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
    {
      id: 'projects.types',
      parent: 'projects.configuration',
      label: 'Project types',
      action: 'projects.action_types',
      sequence: 2,
    },
    {
      id: 'projects.categories',
      parent: 'projects.configuration',
      label: 'Task categories',
      action: 'projects.action_categories',
      sequence: 3,
    },
    {
      id: 'projects.tags',
      parent: 'projects.configuration',
      label: 'Tags',
      action: 'projects.action_tags',
      sequence: 4,
    },
  ],
  views: {
    'project.project.list': list(ProjectProject, {
      columns: [
        'code',
        'name',
        'type',
        'partner',
        'manager',
        { field: 'priority', widget: 'badge' },
        { field: 'riskLevel', widget: 'badge' },
        { field: 'progress', widget: 'progress' },
        { field: 'dateEnd', widget: 'daysLeft' },
        { field: 'taskCount', sum: true },
        { field: 'hours', sum: true },
      ],
      defaultOrder: ['sequence asc', 'name asc'],
      decorations: { danger: { riskLevel: { in: ['high', 'critical'] } } },
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
          {
            id: 'project_phases',
            label: 'Phases',
            model: ProjectPhase,
            where: { project: { $record: 'id' } },
            action: 'projects.action_phases',
          },
          {
            id: 'project_work_packages',
            label: 'Work packages',
            model: ProjectWorkPackage,
            where: { project: { $record: 'id' } },
            action: 'projects.action_work_packages',
          },
          {
            id: 'project_children',
            label: 'Projects in it',
            model: ProjectProject,
            where: { parentProject: { $record: 'id' } },
            action: 'projects.action_projects',
          },
        ]),
        k.group('main', ['name', 'code', 'type', 'parentProject', 'partner', 'location']),
        k.group('people', ['manager', 'sponsor', 'owner', 'priority', 'riskLevel'], {
          label: 'People and risk',
        }),
        k.group('dates', ['dateStart', 'dateEnd', 'progress', 'taskCount', 'hours']),
        k.group('about', ['description', 'scope', 'assumptions', 'constraints'], {
          columns: 1,
          label: 'Scope',
        }),
        k.component('structure', 'projects.Structure'),
        k.lines('phases', [
          { field: 'sequence', id: 'phase_sequence' },
          { field: 'name', id: 'phase_name' },
          { field: 'manager', id: 'phase_manager' },
          { field: 'dateStart', id: 'phase_start' },
          { field: 'dateEnd', id: 'phase_end' },
          { field: 'status', id: 'phase_status' },
          { field: 'progress', id: 'phase_progress', widget: 'progress' },
        ]),
        k.lines('workPackages', [
          { field: 'name', id: 'wp_name' },
          { field: 'phase', id: 'wp_phase' },
          { field: 'manager', id: 'wp_manager' },
          { field: 'dateEnd', id: 'wp_end' },
          { field: 'status', id: 'wp_status' },
          { field: 'progress', id: 'wp_progress', widget: 'progress' },
        ]),
        k.lines('tasks', [
          { field: 'name', id: 'task_name' },
          { field: 'phase', id: 'task_phase' },
          'stage',
          'assignee',
          'deadline',
          'plannedHours',
          'effectiveHours',
          { field: 'progress', id: 'task_progress', widget: 'progress' },
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
          { field: 'tags', widget: 'tags' },
        ],
        progress: 'progress',
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
        'phase',
        'workPackage',
        'stage',
        'assignee',
        { field: 'progress', widget: 'progress' },
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
        k.group('main', ['name', 'project', 'phase', 'workPackage', 'parentTask', 'stage']),
        k.group('people', ['assignee', 'assignees', 'category', 'tags', 'milestone', 'blocked']),
        k.group('when', [
          'partner',
          'priority',
          'deadline',
          'plannedHours',
          'effectiveHours',
          'progress',
        ]),
        k.group('about', ['description'], { columns: 1 }),
        k.lines('subtasks', [
          { field: 'name', id: 'sub_name' },
          { field: 'assignee', id: 'sub_assignee' },
          { field: 'deadline', id: 'sub_deadline' },
          { field: 'plannedHours', id: 'sub_planned' },
          { field: 'stage', id: 'sub_stage' },
        ]),
        k.lines('predecessors', [
          { field: 'predecessor', id: 'dep_predecessor' },
          { field: 'lag', id: 'dep_lag' },
        ]),
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
    'project.project.hierarchy': hierarchy(ProjectProject, {
      parent: 'parentProject',
      title: 'name',
      subtitle: 'manager',
    }),
    'project.phase.list': list(ProjectPhase, {
      columns: [
        'project',
        'sequence',
        'name',
        'parentPhase',
        'manager',
        'dateStart',
        { field: 'dateEnd', widget: 'daysLeft' },
        { field: 'status', widget: 'badge' },
        { field: 'progress', widget: 'progress' },
      ],
      decorations: { neutral: { status: { in: ['done', 'cancelled'] } } },
    }),
    'project.phase.form': form(ProjectPhase, (k) => ({
      sheet: [
        k.stats('related', [
          {
            id: 'phase_tasks',
            label: 'Tasks',
            model: ProjectTask,
            where: { phase: { $record: 'id' } },
            action: 'projects.action_tasks',
          },
          {
            id: 'phase_work_packages',
            label: 'Work packages',
            model: ProjectWorkPackage,
            where: { phase: { $record: 'id' } },
            action: 'projects.action_work_packages',
          },
        ]),
        k.group('main', ['name', 'code', 'project', 'parentPhase', 'sequence', 'priority']),
        k.group('people', ['manager', 'responsible', 'dateStart', 'dateEnd', 'status']),
        k.group('progress_group', ['progress', 'progressOverride'], {
          label: 'Progress',
          description:
            'Computed from its tasks, weighted by their planned hours; set it by hand only when the tasks do not tell the whole story.',
        }),
        k.group('about', ['description'], { columns: 1 }),
      ],
      chatter: true,
    })),
    'project.phase.gantt': gantt(ProjectPhase, {
      dateStart: 'dateStart',
      dateStop: 'dateEnd',
      title: 'name',
      scale: 'week',
    }),
    'project.work.package.list': list(ProjectWorkPackage, {
      columns: [
        'project',
        'phase',
        'name',
        'manager',
        { field: 'dateEnd', widget: 'daysLeft' },
        { field: 'status', widget: 'badge' },
        { field: 'progress', widget: 'progress' },
      ],
      decorations: { neutral: { status: { in: ['done', 'cancelled'] } } },
    }),
    'project.work.package.kanban': kanban(ProjectWorkPackage, {
      groupBy: 'status',
      card: {
        title: 'name',
        subtitle: 'project',
        avatar: 'manager',
        footer: [{ field: 'dateEnd', widget: 'daysLeft' }],
        progress: 'progress',
      },
    }),
    'project.work.package.form': form(ProjectWorkPackage, (k) => ({
      sheet: [
        k.stats('related', [
          {
            id: 'wp_tasks',
            label: 'Tasks',
            model: ProjectTask,
            where: { workPackage: { $record: 'id' } },
            action: 'projects.action_tasks',
          },
        ]),
        k.group('main', ['name', 'code', 'project', 'phase', 'sequence']),
        k.group('people', ['manager', 'dateStart', 'dateEnd', 'status']),
        k.group('progress_group', ['progress', 'progressOverride'], { label: 'Progress' }),
        k.group('about', ['deliverables', 'description'], { columns: 1 }),
      ],
      chatter: true,
    })),
    'project.type.list': list(ProjectType, {
      columns: ['sequence', 'code', 'name'],
      inlineEdit: ['sequence', 'code', 'name'],
    }),
    'project.type.form': form(ProjectType, (k) => ({
      sheet: [
        k.group('main', ['name', 'code', 'sequence']),
        k.group('about', ['description'], { columns: 1 }),
      ],
    })),
    'project.task.category.list': list(ProjectTaskCategory, {
      columns: ['sequence', 'code', 'name', 'type'],
      inlineEdit: ['sequence', 'code', 'name', 'type'],
    }),
    'project.task.category.form': form(ProjectTaskCategory, (k) => ({
      sheet: [k.group('main', ['name', 'code', 'type', 'sequence'])],
    })),
    'project.tag.list': list(ProjectTag, {
      columns: ['name', 'color'],
      inlineEdit: ['name', 'color'],
    }),
    'project.tag.form': form(ProjectTag, (k) => ({ sheet: [k.group('main', ['name', 'color'])] })),
    'project.task.link.list': list(ProjectTaskLink, {
      columns: ['successor', 'predecessor', 'lag'],
    }),
    'project.task.link.form': form(ProjectTaskLink, (k) => ({
      sheet: [k.group('main', ['successor', 'predecessor', 'lag'])],
    })),
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
    'project.phase': search(ProjectPhase, {
      fields: ['name', 'code', 'project.name'],
      filters: {
        open: {
          label: 'Open',
          domain: { status: { in: ['draft', 'in_progress', 'on_hold'] } },
          group: 'status',
        },
        late: {
          label: 'Late',
          domain: { dateEnd: { lt: { $today: 0 } }, status: { notIn: ['done', 'cancelled'] } },
        },
      },
      groupBy: ['project', 'status', 'manager'],
    }),
    'project.work.package': search(ProjectWorkPackage, {
      fields: ['name', 'code', 'project.name', 'phase.name'],
      filters: {
        open: {
          label: 'Open',
          domain: { status: { in: ['draft', 'in_progress', 'on_hold'] } },
          group: 'status',
        },
      },
      groupBy: ['project', 'phase', 'status', 'manager'],
    }),
    'project.type': search(ProjectType, { fields: ['name', 'code'] }),
    'project.task.category': search(ProjectTaskCategory, {
      fields: ['name', 'code'],
      groupBy: ['type'],
    }),
    'project.tag': search(ProjectTag, { fields: ['name'] }),
    'project.task.link': search(ProjectTaskLink, {
      fields: ['successor.name', 'predecessor.name'],
    }),
    'project.project': search(ProjectProject, {
      fields: ['name', 'code', 'partner.name'],
      filters: {
        risky: { label: 'High risk', domain: { riskLevel: { in: ['high', 'critical'] } } },
        programmes: { label: 'Programmes', domain: { children: { any: {} } } },
      },
      groupBy: ['manager', 'partner', 'type', 'parentProject', 'riskLevel'],
    }),
    'project.task': search(ProjectTask, {
      fields: ['name', 'project.name', 'partner.name'],
      filters: {
        open: { label: 'Open', domain: { done: false }, group: 'state' },
        done: { label: 'Done', domain: { done: true }, group: 'state' },
        high: { label: 'High priority', domain: { priority: 'high' } },
        blocked: { label: 'Waiting for another task', domain: { blocked: true } },
        milestones: { label: 'Milestones', domain: { milestone: true } },
        top: { label: 'Not sub-tasks', domain: { parentTask: { isNull: true } } },
      },
      groupBy: [
        'project',
        'phase',
        'workPackage',
        'stage',
        'assignee',
        'category',
        'deadline:week',
      ],
    }),
    'project.timesheet': search(ProjectTimesheet, {
      fields: ['description', 'task.name', 'project.name'],
      groupBy: ['project', 'task', 'user', 'date:month'],
    }),
  },
});
