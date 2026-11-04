/**
 * @packageDocumentation
 * `@kosh/project` (RFC 0008): the Projects app. Projects with a customer and a manager, tasks on a kanban of shared
 * stages with assignees, priorities and deadlines (and a calendar of deadlines), timesheets whose hours add up on
 * the task and the project, and a pivot of hours by project, user and month. The chatter is on projects and tasks.
 */
import { contacts } from '@kosh/contacts';
import { messaging } from '@kosh/messaging';
import { defineModule } from '@kosh/modules-sdk';
import { permissions } from '@kosh/permissions';
import { reporting } from '@kosh/reporting';
import type { ModuleContext } from '@kosh/server';
import { action, calendar, form, gantt, hierarchy, kanban, list, pivot, search } from '@kosh/views';
import type { Env } from './.kosh/bindings.js';
import { projectDemo, SUPPORT_PROJECT } from './demo.js';
import {
  ProjectBudgetLine,
  ProjectChange,
  ProjectIssue,
  ProjectMember,
  ProjectPhase,
  ProjectPlan,
  ProjectProject,
  ProjectRisk,
  ProjectRole,
  ProjectStatusReport,
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
import { registerProjectRoutes } from './routes.js';

export { SUPPORT_PROJECT } from './demo.js';
export {
  configureProjectChatter,
  HEALTH,
  judgeHealth,
  ProjectBudgetLine,
  ProjectChange,
  ProjectIssue,
  ProjectMember,
  ProjectPhase,
  ProjectPlan,
  ProjectProject,
  ProjectRisk,
  ProjectRole,
  ProjectStatusReport,
  ProjectTag,
  ProjectTask,
  ProjectTaskCategory,
  ProjectTaskLink,
  ProjectTaskStage,
  ProjectTimesheet,
  ProjectType,
  ProjectWorkPackage,
  peakAllocation,
  projectShutro,
  riskLevel,
} from './module.js';
export { mondayOf, refreshProjects, shiftDate, workload } from './routes.js';
export { criticalPath, type PlanTask, type Scheduled, scheduleOf, slipMoves } from './schedule.js';

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
      {
        key: 'health',
        label: 'Health',
        description:
          'When a project shows at risk or off track: how far behind its schedule, how much of its budget used.',
        keywords: 'health schedule behind budget risk off track',
        scope: 'company',
        editors: ['project.manager'],
        fields: [
          { key: 'projectHealthBehindRisk', min: 0 },
          { key: 'projectHealthBehindOff', min: 0 },
          { key: 'projectHealthCostRisk', min: 0 },
        ],
      },
      {
        key: 'plans',
        label: 'Plans',
        description: 'Whether a project starts only from an approved plan.',
        keywords: 'plan approval require proposal budget',
        scope: 'company',
        editors: ['project.manager'],
        fields: [
          {
            key: 'projectRequirePlan',
            help: 'Projects inside a programme and projects made by sales orders need none of their own.',
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
  depends: [contacts, messaging, permissions, reporting],
  routes: (context: ModuleContext) => registerProjectRoutes(context),
  // A plan is decided by its sponsor (a Projects manager when there is none), and a large one by a manager too.
  approvals: [
    {
      name: 'Project plans',
      model: 'project.plan',
      onApproved: 'approve',
      onRejected: 'reject',
      onSentBack: 'redraft',
      onWithdrawn: 'redraft',
      levels: [
        {
          name: 'Sponsor',
          condition: {},
          approver: { field: 'sponsor' },
          approverRole: 'project.manager',
        },
        {
          name: 'Large budget',
          condition: { estimatedBudget: { gt: '1000000' } },
          approverRole: 'project.manager',
        },
      ],
    },
    // A change to a project's deadline or budget: its sponsor, then a Projects manager.
    {
      name: 'Project change requests',
      model: 'project.change',
      onApproved: 'approve',
      onRejected: 'reject',
      onSentBack: 'redraft',
      onWithdrawn: 'redraft',
      levels: [
        {
          name: 'Sponsor',
          condition: {},
          approver: { field: 'sponsor' },
          approverRole: 'project.manager',
        },
        { name: 'Projects manager', condition: {}, approverRole: 'project.manager' },
      ],
    },
  ],
  events: [
    { topic: 'project.change.applied', model: 'project.change', label: 'Change request applied' },
    {
      topic: 'project.status.report.sent',
      model: 'project.status.report',
      label: 'Status report sent',
    },
    { topic: 'project.plan.submitted', model: 'project.plan', label: 'Project plan submitted' },
    { topic: 'project.plan.approved', model: 'project.plan', label: 'Project plan approved' },
  ],
  app: {
    code: 'projects',
    label: 'Projects',
    icon: 'projects',
    sequence: 40,
    category: 'Operations',
    summary: 'Projects, tasks on a kanban, timesheets',
  },
  documents: [
    {
      key: 'project_plan',
      name: 'Project plan',
      model: 'project.plan',
      layout: {
        paper: 'A4',
        header: '{{company.name}}',
        footer: 'Page {{page}} of {{pages}}',
        blocks: [
          { kind: 'heading', id: 'title', text: 'Project plan {{name}}: {{title}}', level: 1 },
          {
            kind: 'fields',
            id: 'plan',
            items: [
              { label: 'Type', bind: 'type.name' },
              { label: 'Written by', bind: 'requester.name' },
              { label: 'Project manager', bind: 'manager.name' },
              { label: 'Sponsor', bind: 'sponsor.name' },
              { label: 'Priority', bind: 'priority' },
              { label: 'Planned start', bind: 'dateStart' },
              { label: 'Planned end', bind: 'dateEnd' },
              { label: 'Estimated budget', bind: 'estimatedBudget' },
              { label: 'Approved budget', bind: 'approvedBudget' },
              { label: 'Approved on', bind: 'approvedAt' },
              { label: 'Status', bind: 'state' },
            ],
          },
          { kind: 'text', id: 'objectives', text: 'Objectives: {{objectives}}' },
          { kind: 'text', id: 'outcome', text: 'Expected outcome: {{expectedOutcome}}' },
          { kind: 'text', id: 'goal', text: 'Strategic goal: {{strategicGoal}}' },
          { kind: 'text', id: 'about', text: '{{description}}' },
          { kind: 'signature', id: 'sign', labels: ['Project manager', 'Sponsor'] },
        ],
      },
    },
  ],
  importTemplates: [
    {
      key: 'project_plan',
      model: 'project.plan',
      label: 'Project plan',
      columns: [
        { header: 'Title', field: 'title' },
        { header: 'Project type', field: 'type' },
        { header: 'Written by', field: 'requester' },
        { header: 'Project manager', field: 'manager' },
        { header: 'Sponsor', field: 'sponsor' },
        { header: 'Priority', field: 'priority' },
        { header: 'Planned start', field: 'dateStart' },
        { header: 'Planned end', field: 'dateEnd' },
        { header: 'Description', field: 'description' },
        { header: 'Objectives', field: 'objectives' },
        { header: 'Expected outcome', field: 'expectedOutcome' },
        { header: 'Strategic goal', field: 'strategicGoal' },
        { header: 'Estimated budget', field: 'estimatedBudget' },
      ],
    },
    {
      key: 'project_role',
      model: 'project.role',
      label: 'Project role',
      columns: [
        { header: 'Name', field: 'name' },
        { header: 'Code', field: 'code' },
        { header: 'Default hourly cost', field: 'defaultHourlyCost' },
      ],
    },
    {
      key: 'project_type',
      model: 'project.type',
      label: 'Project type',
      columns: [
        { header: 'Name', field: 'name' },
        { header: 'Code', field: 'code' },
        { header: 'Description', field: 'description' },
      ],
    },
    {
      key: 'project_task_category',
      model: 'project.task.category',
      label: 'Task category',
      columns: [
        { header: 'Name', field: 'name' },
        { header: 'Code', field: 'code' },
        { header: 'Project type', field: 'type' },
      ],
    },
    {
      key: 'project_task_stage',
      model: 'project.task.stage',
      label: 'Task stage',
      columns: [
        { header: 'Name', field: 'name' },
        { header: 'Fold', field: 'fold' },
        { header: 'Closes the task', field: 'done' },
      ],
    },
    {
      key: 'project_project',
      model: 'project.project',
      label: 'Project',
      columns: [
        { header: 'Name', field: 'name' },
        { header: 'Project type', field: 'type' },
        { header: 'Programme', field: 'parentProject' },
        { header: 'Customer', field: 'partner' },
        { header: 'Project manager', field: 'manager' },
        { header: 'Sponsor', field: 'sponsor' },
        { header: 'Owner', field: 'owner' },
        { header: 'Priority', field: 'priority' },
        { header: 'Risk', field: 'riskLevel' },
        { header: 'Location', field: 'location' },
        { header: 'Phases › Name', field: 'phases.name' },
        { header: 'Phases › Code', field: 'phases.code' },
        { header: 'Phases › Manager', field: 'phases.manager' },
        { header: 'Phases › Start', field: 'phases.dateStart' },
        { header: 'Phases › End', field: 'phases.dateEnd' },
      ],
    },
  ],
  // Bangla for the labels it serves (RFC 0023 §3.1; `pnpm i18n:extract`).
  i18n: { bn: () => import('./i18n/bn.js') },
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
        id: 'projects_by_health',
        title: 'Projects by health',
        kind: 'chart',
        model: 'project.project',
        measure: 'count',
        groupBy: 'health',
        chart: 'pie',
        w: 6,
      },
      {
        id: 'plans_waiting',
        title: 'Plans waiting for a decision',
        kind: 'kpi',
        model: 'project.plan',
        measure: 'count',
        filter: { state: 'submitted' },
        w: 3,
      },
      {
        id: 'phases_overdue',
        title: 'Phases overdue',
        kind: 'kpi',
        model: 'project.phase',
        measure: 'count',
        filter: { late: true },
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
    'projects.action_plans': action(ProjectPlan, {
      label: 'Plans',
      views: ['list', 'kanban', 'form'],
    }),
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
    'projects.action_roles': action(ProjectRole, { label: 'Roles', views: ['list', 'form'] }),
    'projects.action_members': action(ProjectMember, {
      label: 'Team members',
      views: ['list', 'form'],
    }),
    'projects.action_workload': { type: 'client', page: 'projects.Workload', label: 'Workload' },
    'projects.action_risks': action(ProjectRisk, {
      label: 'Risks',
      views: ['list', 'kanban', 'form'],
    }),
    'projects.action_issues': action(ProjectIssue, {
      label: 'Issues',
      views: ['list', 'kanban', 'form'],
    }),
    'projects.action_changes': action(ProjectChange, {
      label: 'Change requests',
      views: ['list', 'form'],
    }),
    'projects.action_reports': action(ProjectStatusReport, {
      label: 'Status reports',
      views: ['list', 'form'],
    }),
    'projects.action_categories': action(ProjectTaskCategory, {
      label: 'Task categories',
      views: ['list', 'form'],
    }),
    'projects.action_tags': action(ProjectTag, { label: 'Tags', views: ['list', 'form'] }),
    'projects.action_tasks': action(ProjectTask, {
      label: 'Tasks',
      views: ['kanban', 'list', 'form', 'calendar', 'gantt'],
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
      id: 'projects.plans',
      parent: 'projects.root',
      label: 'Plans',
      action: 'projects.action_plans',
      sequence: 0.5,
    },
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
    { id: 'projects.control', parent: 'projects.root', label: 'Control', sequence: 5 },
    {
      id: 'projects.risks',
      parent: 'projects.control',
      label: 'Risks',
      action: 'projects.action_risks',
      sequence: 1,
    },
    {
      id: 'projects.issues',
      parent: 'projects.control',
      label: 'Issues',
      action: 'projects.action_issues',
      sequence: 2,
    },
    {
      id: 'projects.changes',
      parent: 'projects.control',
      label: 'Change requests',
      action: 'projects.action_changes',
      sequence: 3,
    },
    {
      id: 'projects.reports',
      parent: 'projects.control',
      label: 'Status reports',
      action: 'projects.action_reports',
      sequence: 4,
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
      id: 'projects.workload',
      parent: 'projects.root',
      label: 'Workload',
      action: 'projects.action_workload',
      sequence: 2.5,
    },
    {
      id: 'projects.roles',
      parent: 'projects.configuration',
      label: 'Roles',
      action: 'projects.action_roles',
      sequence: 1.5,
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
        { field: 'health', widget: 'badge' },
        { field: 'progress', widget: 'progress' },
        { field: 'dateEnd', widget: 'daysLeft' },
        { field: 'taskCount', sum: true },
        { field: 'hours', sum: true },
      ],
      defaultOrder: ['sequence asc', 'name asc'],
      decorations: {
        danger: { health: 'off_track' },
        warning: { health: 'at_risk' },
      },
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
            id: 'project_risks',
            label: 'Open risks',
            model: ProjectRisk,
            where: { project: { $record: 'id' }, status: { in: ['open', 'mitigating'] } },
            action: 'projects.action_risks',
          },
          {
            id: 'project_issues',
            label: 'Open issues',
            model: ProjectIssue,
            where: { project: { $record: 'id' }, status: { in: ['open', 'in_progress'] } },
            action: 'projects.action_issues',
          },
          {
            id: 'project_changes',
            label: 'Change requests',
            model: ProjectChange,
            where: { project: { $record: 'id' } },
            action: 'projects.action_changes',
          },
          {
            id: 'project_reports',
            label: 'Status reports',
            model: ProjectStatusReport,
            where: { project: { $record: 'id' } },
            action: 'projects.action_reports',
          },
          {
            id: 'project_children',
            label: 'Projects in it',
            model: ProjectProject,
            where: { parentProject: { $record: 'id' } },
            action: 'projects.action_projects',
          },
        ]),
        k.group('main', ['name', 'code', 'type', 'parentProject', 'plan', 'partner', 'location']),
        k.group('people', ['manager', 'sponsor', 'owner', 'priority', 'riskLevel'], {
          label: 'People and risk',
        }),
        k.group('dates', ['dateStart', 'dateEnd', 'progress', 'taskCount', 'hours']),
        k.group('health_group', ['health', 'healthNotes', 'healthCheckedAt'], {
          label: 'Health',
          description:
            'From the figures — schedule against time elapsed, late milestones, the budget used —, refreshed hourly.',
        }),
        k.group('health_override', ['healthComputed', 'healthOverride', 'healthReason'], {
          label: 'Health set by hand',
          description:
            'The manager may override what the figures say, with the reason; it stays in the history.',
        }),
        k.group(
          'money',
          ['budget', 'labourCost', 'bookedCost', 'committedCost', 'actualCost', 'variance'],
          {
            label: 'Money',
            description:
              'Labour from timesheets at each member’s cost; booked and committed costs from Accounting and Purchase on the project’s cost centre.',
          },
        ),
        k.component('refresh', 'projects.Refresh'),
        k.lines('budgetLines', [
          { field: 'name', id: 'budget_name' },
          { field: 'category', id: 'budget_category' },
          { field: 'phase', id: 'budget_phase' },
          { field: 'workPackage', id: 'budget_wp' },
          { field: 'planned', id: 'budget_planned', sum: true },
        ]),
        k.group('baseline', ['baselineStart', 'baselineEnd', 'baselineBudget', 'slipDays'], {
          label: 'Baseline',
          description:
            'The dates and budget approved with the plan; the deadline is compared with them.',
        }),
        k.group('about', ['description', 'scope', 'assumptions', 'constraints'], {
          columns: 1,
          label: 'Scope',
        }),
        k.component('structure', 'projects.Structure'),
        k.component('schedule', 'projects.Schedule'),
        k.lines('members', [
          { field: 'user', id: 'member_user' },
          { field: 'role', id: 'member_role' },
          { field: 'allocation', id: 'member_allocation' },
          { field: 'hourlyCost', id: 'member_cost' },
          { field: 'dateFrom', id: 'member_from' },
          { field: 'dateTo', id: 'member_to' },
          { field: 'overallocated', id: 'member_over' },
        ]),
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
          'dateStart',
          'deadline',
          'plannedHours',
          'effectiveHours',
          'progress',
        ]),
        k.group('repeat', ['repeatEvery', 'repeatUnit', 'repeatUntil', 'nextTask'], {
          label: 'Repeats',
          description:
            'Once done, the next one is made with its dates moved, until the date given.',
        }),
        k.group('task_baseline', ['baselineStart', 'baselineEnd'], { label: 'Baseline' }),
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
    'project.task.gantt': gantt(ProjectTask, {
      dateStart: 'dateStart',
      dateStop: 'deadline',
      title: 'name',
      groupBy: 'project',
      progress: 'progress',
      scale: 'week',
    }),
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
    'project.risk.list': list(ProjectRisk, {
      columns: [
        'project',
        'name',
        'category',
        'probability',
        'impact',
        'score',
        { field: 'level', widget: 'badge' },
        'owner',
        { field: 'dueDate', widget: 'daysLeft' },
        { field: 'status', widget: 'badge' },
      ],
      decorations: {
        danger: { level: 'critical' },
        warning: { level: 'high' },
        neutral: { status: 'closed' },
      },
    }),
    'project.risk.kanban': kanban(ProjectRisk, {
      groupBy: 'level',
      card: {
        title: 'name',
        subtitle: 'project',
        avatar: 'owner',
        footer: ['score', { field: 'status', widget: 'badge' }],
      },
    }),
    'project.risk.form': form(ProjectRisk, (k) => ({
      sheet: [
        k.group('main', ['name', 'project', 'category', 'owner', 'status', 'dueDate']),
        k.group('assessment', ['probability', 'impact', 'score', 'level'], {
          label: 'Assessment',
          description: 'Probability and impact from 1 to 5; their product is the score.',
        }),
        k.group('response', ['description', 'mitigation', 'contingency'], {
          columns: 1,
          label: 'Response',
        }),
      ],
      chatter: true,
    })),
    'project.issue.list': list(ProjectIssue, {
      columns: [
        'project',
        'name',
        { field: 'severity', widget: 'badge' },
        'owner',
        { field: 'dueDate', widget: 'daysLeft' },
        { field: 'status', widget: 'badge' },
      ],
      decorations: { danger: { severity: 'critical' }, neutral: { status: 'closed' } },
    }),
    'project.issue.kanban': kanban(ProjectIssue, {
      groupBy: 'status',
      card: {
        title: 'name',
        subtitle: 'project',
        avatar: 'owner',
        footer: [
          { field: 'severity', widget: 'badge' },
          { field: 'dueDate', widget: 'daysLeft' },
        ],
      },
    }),
    'project.issue.form': form(ProjectIssue, (k) => ({
      sheet: [
        k.group('main', ['name', 'project', 'severity', 'status', 'risk']),
        k.group('people', ['raisedBy', 'owner', 'dueDate']),
        k.group('about', ['description', 'resolution'], { columns: 1 }),
      ],
      chatter: true,
    })),
    'project.change.list': list(ProjectChange, {
      columns: [
        'name',
        'project',
        'title',
        'requester',
        'newDateEnd',
        'newBudget',
        { field: 'state', widget: 'badge' },
      ],
      decorations: { warning: { state: 'submitted' }, danger: { state: 'rejected' } },
    }),
    'project.change.form': form(ProjectChange, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('submit', { primary: true, label: 'Submit for approval' }),
          k.button('redraft', { label: 'Set to draft' }),
          k.button('cancel', { label: 'Cancel' }),
        ],
      },
      sheet: [
        k.group('main', ['title', 'name', 'project', 'requester', 'sponsor']),
        k.component('approvals', 'approvals.Panel'),
        k.group('asked', ['newDateEnd', 'newBudget'], {
          label: 'What it asks for',
          description:
            'Once approved, the project’s deadline and baseline end move to the new deadline, and its baseline budget to the new budget.',
        }),
        k.group('why', ['reason', 'impact'], { columns: 1, label: 'Why' }),
        k.group(
          'before',
          ['previousDateEnd', 'previousBaselineEnd', 'previousBudget', 'appliedAt'],
          {
            label: 'What it changed',
          },
        ),
      ],
      chatter: true,
    })),
    'project.status.report.list': list(ProjectStatusReport, {
      columns: [
        'project',
        'date',
        'author',
        { field: 'health', widget: 'badge' },
        { field: 'progress', widget: 'progress' },
        { field: 'state', widget: 'badge' },
      ],
      decorations: { danger: { health: 'off_track' }, warning: { health: 'at_risk' } },
    }),
    'project.status.report.form': form(ProjectStatusReport, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('send', {
            primary: true,
            label: 'Send',
            confirm:
              'Send the report? It is posted on the project for its followers and its sponsor.',
          }),
        ],
      },
      sheet: [
        k.group('main', ['project', 'date', 'author', 'sentAt']),
        k.group('figures', ['health', 'progress'], {
          label: 'Figures',
          description: 'Filled in from the project when it is chosen.',
        }),
        k.group('report', ['done', 'next', 'risks'], { columns: 1, label: 'Report' }),
      ],
    })),
    'project.budget.line.list': list(ProjectBudgetLine, {
      columns: [
        'project',
        'name',
        'category',
        'phase',
        'workPackage',
        { field: 'planned', sum: true },
      ],
    }),
    'project.budget.line.form': form(ProjectBudgetLine, (k) => ({
      sheet: [k.group('main', ['project', 'name', 'category', 'phase', 'workPackage', 'planned'])],
    })),
    'project.role.list': list(ProjectRole, {
      columns: ['sequence', 'code', 'name', 'defaultHourlyCost'],
      inlineEdit: ['sequence', 'code', 'name', 'defaultHourlyCost'],
    }),
    'project.role.form': form(ProjectRole, (k) => ({
      sheet: [k.group('main', ['name', 'code', 'sequence', 'defaultHourlyCost'])],
    })),
    'project.member.list': list(ProjectMember, {
      columns: [
        'project',
        'user',
        'role',
        'allocation',
        'hourlyCost',
        'dateFrom',
        'dateTo',
        'overallocated',
      ],
      decorations: { danger: { overallocated: true } },
    }),
    'project.member.form': form(ProjectMember, (k) => ({
      sheet: [
        k.group('main', ['project', 'user', 'role', 'allocation', 'overallocated']),
        k.group('when', ['dateFrom', 'dateTo', 'hourlyCost']),
        k.group('about', ['notes'], { columns: 1 }),
      ],
    })),
    'project.plan.list': list(ProjectPlan, {
      columns: [
        'name',
        'title',
        'type',
        'manager',
        'sponsor',
        'dateStart',
        'dateEnd',
        { field: 'estimatedBudget', sum: true },
        { field: 'approvedBudget', sum: true },
        { field: 'state', widget: 'badge' },
      ],
      decorations: {
        warning: { state: 'submitted' },
        danger: { state: 'rejected' },
        neutral: { state: { in: ['completed', 'cancelled'] } },
      },
    }),
    'project.plan.kanban': kanban(ProjectPlan, {
      groupBy: 'state',
      card: {
        title: 'title',
        subtitle: 'name',
        avatar: 'manager',
        footer: ['estimatedBudget', { field: 'dateStart', widget: 'daysLeft' }],
      },
    }),
    'project.plan.form': form(ProjectPlan, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('submit', { primary: true, label: 'Submit for approval' }),
          k.button('start', {
            primary: true,
            label: 'Start the project',
            confirm: 'Start the project? It is made from the plan, with its dates as the baseline.',
          }),
          k.button('baseline', {
            label: 'Take the baseline again',
            confirm:
              'Take the baseline again? The projects’, phases’ and work packages’ current dates become the baseline.',
          }),
          k.button('complete', { label: 'Completed' }),
          k.button('redraft', { label: 'Set to draft' }),
          k.button('cancel', { label: 'Cancel' }),
        ],
      },
      sheet: [
        k.stats('related', [
          {
            id: 'plan_projects',
            label: 'Projects',
            model: ProjectProject,
            where: { plan: { $record: 'id' } },
            action: 'projects.action_projects',
          },
        ]),
        k.group('main', ['title', 'name', 'type', 'priority']),
        k.group('people', ['requester', 'manager', 'sponsor'], { label: 'People' }),
        k.component('approvals', 'approvals.Panel'),
        k.group(
          'when',
          ['dateStart', 'dateEnd', 'estimatedBudget', 'approvedBudget', 'approvedAt'],
          {
            label: 'Dates and budget',
            description:
              'The estimate decides who approves: the sponsor, and above 1 000 000 a Projects manager too.',
          },
        ),
        k.group('case', ['objectives', 'expectedOutcome', 'strategicGoal', 'description'], {
          columns: 1,
          label: 'The case',
        }),
      ],
      chatter: true,
    })),
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
      decorations: {
        danger: { late: true },
        neutral: { status: { in: ['done', 'cancelled'] } },
      },
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
        k.group('baseline', ['baselineStart', 'baselineEnd'], { label: 'Baseline' }),
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
          domain: { late: true },
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
    'project.risk': search(ProjectRisk, {
      fields: ['name', 'project.name'],
      filters: {
        open: {
          label: 'Open',
          domain: { status: { in: ['open', 'mitigating'] } },
          group: 'status',
        },
        severe: { label: 'High and critical', domain: { level: { in: ['high', 'critical'] } } },
        mine: { label: 'Mine', domain: { owner: { $env: 'uid' } } },
      },
      groupBy: ['project', 'level', 'category', 'status', 'owner'],
    }),
    'project.issue': search(ProjectIssue, {
      fields: ['name', 'project.name'],
      filters: {
        open: {
          label: 'Open',
          domain: { status: { in: ['open', 'in_progress'] } },
          group: 'status',
        },
        mine: { label: 'Mine', domain: { owner: { $env: 'uid' } } },
      },
      groupBy: ['project', 'severity', 'status', 'owner'],
    }),
    'project.change': search(ProjectChange, {
      fields: ['title', 'name', 'project.name'],
      filters: { waiting: { label: 'Waiting for approval', domain: { state: 'submitted' } } },
      groupBy: ['project', 'state'],
    }),
    'project.status.report': search(ProjectStatusReport, {
      fields: ['name', 'project.name'],
      filters: { drafts: { label: 'Drafts', domain: { state: 'draft' } } },
      groupBy: ['project', 'health', 'author', 'date:month'],
    }),
    'project.role': search(ProjectRole, { fields: ['name', 'code'] }),
    'project.budget.line': search(ProjectBudgetLine, {
      fields: ['name', 'project.name'],
      groupBy: ['project', 'category', 'phase'],
    }),
    'project.member': search(ProjectMember, {
      fields: ['user.name', 'project.name'],
      groupBy: ['project', 'user', 'role'],
    }),
    'project.plan': search(ProjectPlan, {
      fields: ['title', 'name'],
      filters: {
        mine: {
          label: 'Mine',
          domain: { or: [{ requester: { $env: 'uid' } }, { manager: { $env: 'uid' } }] },
        },
        waiting: { label: 'Waiting for approval', domain: { state: 'submitted' }, group: 'state' },
        approved: { label: 'Approved', domain: { state: 'approved' }, group: 'state' },
      },
      groupBy: ['state', 'type', 'manager', 'sponsor'],
    }),
    'project.project': search(ProjectProject, {
      fields: ['name', 'code', 'partner.name'],
      filters: {
        atRisk: { label: 'At risk', domain: { health: 'at_risk' }, group: 'health' },
        offTrack: { label: 'Off track', domain: { health: 'off_track' }, group: 'health' },
        risky: { label: 'High risk', domain: { riskLevel: { in: ['high', 'critical'] } } },
        programmes: { label: 'Programmes', domain: { children: { any: {} } } },
      },
      groupBy: ['health', 'manager', 'partner', 'type', 'parentProject', 'riskLevel'],
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
