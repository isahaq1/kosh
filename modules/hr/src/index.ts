/**
 * @packageDocumentation
 * `@kosh/hr` (RFC 0021): the **Workforce** app. The employee directory and the org chart, departments and positions,
 * contracts, and leave — working days by the company's week, the year's balance enforced, no overlaps, decided by
 * the line manager or HR, never by the person asking. Personal details and wages for HR managers only.
 *
 * - `POST /api/v1/workforce/leaves/:id/decide`   `{ decision: 'approve' | 'refuse' }`: HR, or the requester's leave
 *   approver (else their manager)
 * - `GET  /api/v1/workforce/balance?employee=&year=`   per leave type: days allowed, taken, waiting and left
 */
import { contacts } from '@kosh/contacts';
import { messaging } from '@kosh/messaging';
import { defineModule } from '@kosh/modules-sdk';
import { reporting } from '@kosh/reporting';
import { audit, HttpProblem, type ModuleContext } from '@kosh/server';
import type { Env } from '@kosh/server/orm';
import { action, calendar, form, hierarchy, kanban, list, search } from '@kosh/views';
import { hrDemo } from './demo.js';
import {
  HrContract,
  HrContractType,
  HrDepartment,
  HrEmployee,
  HrEmployeeTag,
  HrJob,
  HrLeave,
  HrLeaveType,
  hrShutro,
} from './module.js';

export {
  HrContract,
  HrContractType,
  HrDepartment,
  HrEmployee,
  HrEmployeeTag,
  HrJob,
  HrLeave,
  HrLeaveType,
  hrShutro,
  WEEKENDS,
  weekendOf,
  workingDays,
} from './module.js';

type Row = Record<string, unknown>;
interface Records {
  readonly length: number;
  readonly ids: readonly number[];
  load(keys: readonly string[]): Promise<Records>;
  read(keys: readonly string[]): Row[];
  write(values: Row): Promise<void>;
}
const ref = (env: Env, model: string) =>
  env.model(model as never) as unknown as {
    search(q: unknown): Promise<Records>;
    browse(ids: readonly number[]): Records;
  };
const rows = async (set: Records, keys: readonly string[]) =>
  set.length === 0 ? [] : (await set.load(keys)).read(['id', ...keys]);

function registerWorkforceRoutes({ app }: ModuleContext): void {
  app.post('/api/v1/workforce/leaves/:id/decide', async (request) => {
    const id = Number((request.params as { id?: string }).id);
    const decision = (request.body as Row | null)?.['decision'];
    if (decision !== 'approve' && decision !== 'refuse')
      throw new HttpProblem(
        422,
        'invalid-decision',
        'Invalid decision',
        'Decide approve or refuse.',
      );
    return request.env(
      async (env) =>
        env.asSuperuser({ reason: 'leave decision' }, async (su) => {
          const [leave] = await rows(await ref(su, 'hr.leave').search({ where: { id } }), [
            'employee',
            'state',
          ]);
          if (leave === undefined)
            throw new HttpProblem(404, 'missing-record', 'Not found', `There is no leave ${id}.`);
          const [employee] = await rows(
            await ref(su, 'hr.employee').search({ where: { id: leave['employee'] } }),
            ['user', 'manager', 'leaveApprover'],
          );
          const [manager] =
            typeof employee?.['manager'] === 'number'
              ? await rows(
                  await ref(su, 'hr.employee').search({ where: { id: employee['manager'] } }),
                  ['user'],
                )
              : [];
          if (employee?.['user'] === env.uid)
            throw new HttpProblem(
              403,
              'own-request',
              'Your own request',
              'Someone else decides your leave.',
            );
          const hr = env.administrator || env.access.has('hr.leave_decide');
          // The employee's leave approver when they have one (RFC 0032 §3.2), else their manager.
          const approver =
            typeof employee?.['leaveApprover'] === 'number'
              ? employee['leaveApprover']
              : manager?.['user'];
          if (!hr && approver !== env.uid)
            throw new HttpProblem(
              403,
              'access',
              'Leave decisions',
              'The person’s leave approver (else their manager) or an HR manager decides this leave.',
            );
          if (leave['state'] !== 'submitted')
            throw new HttpProblem(
              409,
              'not-waiting',
              'Not waiting',
              'Only a waiting request is decided.',
            );
          const target = ref(su, 'hr.leave').browse([id]) as unknown as Records &
            Record<string, () => Promise<void>>;
          await (target[decision] as () => Promise<void>).call(target);
          await audit(env, {
            kind: decision === 'approve' ? 'hr.leave_approved' : 'hr.leave_refused',
            summary: `Leave ${id} ${decision === 'approve' ? 'approved' : 'refused'}.`,
            targetModel: 'hr.leave',
            targetId: id,
            ip: request.ip,
          });
          await su.flush();
          return { id, state: decision === 'approve' ? 'approved' : 'refused' };
        }),
      { write: true },
    );
  });

  app.get('/api/v1/workforce/balance', async (request) => {
    const q = (request.query ?? {}) as Row;
    const year = Number(q['year'] ?? new Date().getUTCFullYear());
    if (!Number.isInteger(year) || year < 2000 || year > 2100)
      throw new HttpProblem(400, 'invalid-year', 'Invalid year', 'A year such as 2026.');
    return request.env(async (env) => {
      // The employee: given (seen through the user's rules), else the user's own.
      const where = q['employee'] === undefined ? { user: env.uid } : { id: Number(q['employee']) };
      const [employee] = await rows(await ref(env, 'hr.employee').search({ where }), ['name']);
      if (employee === undefined)
        throw new HttpProblem(404, 'missing-record', 'Not found', 'No such employee.');
      // Their leave as the user sees it: their own, their team's, or everyone's for HR.
      const leaves = await rows(
        await ref(env, 'hr.leave').search({
          where: {
            employee: employee['id'],
            state: { in: ['submitted', 'approved'] },
            dateFrom: { gte: `${year}-01-01`, lte: `${year}-12-31` },
          },
        }),
        ['type', 'days', 'state'],
      );
      const types = await rows(await ref(env, 'hr.leave.type').search({ where: {} }), [
        'name',
        'daysPerYear',
      ]);
      return {
        employee: { id: employee['id'], name: employee['name'] },
        year,
        types: types.map((t) => {
          const mine = leaves.filter((l) => l['type'] === t['id']);
          const taken = mine
            .filter((l) => l['state'] === 'approved')
            .reduce((s, l) => s + Number(l['days']), 0);
          const waiting = mine
            .filter((l) => l['state'] === 'submitted')
            .reduce((s, l) => s + Number(l['days']), 0);
          const allowed = t['daysPerYear'] === null ? null : Number(t['daysPerYear']);
          return {
            type: t['id'],
            name: t['name'],
            allowed,
            taken,
            waiting,
            left: allowed === null ? null : allowed - taken - waiting,
          };
        }),
      };
    });
  });
}

export const hr: ReturnType<typeof defineModule> = defineModule({
  shutro: hrShutro,
  kosh: '^0.1.0',
  hooks: { demo: hrDemo },
  depends: [contacts, messaging, reporting],
  app: {
    code: 'workforce',
    label: 'Workforce',
    icon: 'workforce',
    sequence: 20,
    category: 'People',
    summary: 'Employees, the org chart, contracts and leave',
  },
  importTemplates: [
    {
      key: 'hr_contract_type',
      model: 'hr.contract.type',
      label: 'Employment types',
      columns: [
        { header: 'Name', field: 'name' },
        { header: 'Code', field: 'code' },
        { header: 'Country', field: 'country' },
      ],
    },
    {
      key: 'hr_employee_tag',
      model: 'hr.employee.tag',
      label: 'Employee tags',
      columns: [{ header: 'Name', field: 'name' }],
    },
    {
      key: 'hr_department',
      model: 'hr.department',
      label: 'Department',
      columns: [
        { header: 'Name', field: 'name' },
        { header: 'Part of', field: 'parent' },
        { header: 'Head', field: 'head' },
      ],
    },
    {
      key: 'hr_job',
      model: 'hr.job',
      label: 'Position',
      columns: [
        { header: 'Name', field: 'name' },
        { header: 'Department', field: 'department' },
      ],
    },
    {
      key: 'hr_employee',
      model: 'hr.employee',
      label: 'Employee',
      columns: [
        { header: 'Name', field: 'name' },
        { header: 'User', field: 'user' },
        { header: 'Department', field: 'department' },
        { header: 'Position', field: 'job' },
        { header: 'Manager', field: 'manager' },
        { header: 'Job title', field: 'jobTitle' },
        { header: 'Unit head', field: 'unitHead' },
        { header: 'Coach', field: 'coach' },
        { header: 'Property', field: 'property' },
        { header: 'Work mobile', field: 'mobile' },
        { header: 'Expense approver', field: 'expenseApprover' },
        { header: 'Leave approver', field: 'leaveApprover' },
        { header: 'Work email', field: 'workEmail' },
        { header: 'Work phone', field: 'workPhone' },
        { header: 'Joined', field: 'hireDate' },
        { header: 'Birthday', field: 'birthday' },
        { header: 'National ID', field: 'nationalId' },
        { header: 'Home address', field: 'privateAddress' },
        { header: 'Emergency contact', field: 'emergencyContact' },
      ],
    },
    {
      key: 'hr_leave_type',
      model: 'hr.leave.type',
      label: 'Leave type',
      columns: [
        { header: 'Name', field: 'name' },
        { header: 'Days per year', field: 'daysPerYear' },
      ],
    },
  ],
  // Bangla for the labels it serves (RFC 0023 §3.1; `pnpm i18n:extract`).
  i18n: { bn: () => import('./i18n/bn.js') },
  accessLevels: {
    user: { label: 'Employee (directory, own leave, team’s leave)', groups: ['hr.user'] },
    manager: {
      label: 'HR manager (everything, personal data)',
      groups: ['hr.manager'],
      implies: ['user'],
    },
  },
  settings: {
    sections: [
      {
        key: 'week',
        label: 'Working week',
        description: 'Which days are the weekend: leave counts working days only.',
        keywords: 'weekend friday saturday sunday working days leave',
        scope: 'installation',
        editors: ['hr.manager'],
        fields: [
          {
            key: 'weekend',
            type: 'selection',
            label: 'Weekend',
            options: {
              fri_sat: 'Friday and Saturday',
              sat_sun: 'Saturday and Sunday',
              fri: 'Friday only',
            },
            default: 'fri_sat',
            help: 'Leave already requested keeps its days; new requests count by this week.',
          },
        ],
      },
    ],
  },
  routes: (context: ModuleContext) => registerWorkforceRoutes(context),
  // The Overview (RFC 0022 step 2).
  overview: {
    cards: [
      {
        id: 'employees',
        title: 'Employees',
        kind: 'kpi',
        model: 'hr.employee',
        measure: 'count',
        w: 3,
      },
      {
        id: 'departments',
        title: 'Departments',
        kind: 'kpi',
        model: 'hr.department',
        measure: 'count',
        w: 3,
      },
      {
        id: 'leave_waiting',
        title: 'Leave waiting approval',
        kind: 'kpi',
        model: 'hr.leave',
        measure: 'count',
        filter: { state: 'submitted' },
        w: 3,
      },
      {
        id: 'leave_month',
        title: 'Leave days this month',
        kind: 'kpi',
        model: 'hr.leave',
        measure: 'sum:days',
        filter: { state: 'approved' },
        comparison: { field: 'dateFrom', mode: 'previous' },
        w: 3,
      },
      {
        id: 'by_department',
        title: 'By department',
        kind: 'chart',
        model: 'hr.employee',
        measure: 'count',
        groupBy: 'department',
        chart: 'pie',
        w: 6,
      },
      {
        id: 'joined_by_month',
        title: 'Joined by month',
        kind: 'chart',
        model: 'hr.employee',
        measure: 'count',
        groupBy: 'hireDate:month',
        chart: 'bar',
        w: 6,
      },
      {
        id: 'contracts_running',
        title: 'Running contracts',
        kind: 'kpi',
        model: 'hr.contract',
        measure: 'count',
        filter: { state: 'running' },
        w: 3,
      },
      {
        id: 'leave_by_employee',
        title: 'Leave days by person',
        kind: 'pivot',
        model: 'hr.leave',
        measure: 'sum:days',
        groupBy: 'employee',
        filter: { state: 'approved' },
        w: 6,
      },
    ],
  },
  actions: {
    'workforce.action_employees': action(HrEmployee, {
      label: 'Employees',
      views: ['list', 'kanban', 'form', 'hierarchy'],
    }),
    'workforce.action_leaves': action(HrLeave, {
      label: 'Leave',
      views: ['list', 'calendar', 'form'],
    }),
    'workforce.action_contracts': action(HrContract, {
      label: 'Contracts',
      views: ['list', 'form'],
    }),
    'workforce.action_departments': action(HrDepartment, {
      label: 'Departments',
      views: ['list', 'form', 'hierarchy'],
    }),
    'workforce.action_jobs': action(HrJob, { label: 'Positions', views: ['list', 'form'] }),
    'workforce.action_leave_types': action(HrLeaveType, {
      label: 'Leave types',
      views: ['list', 'form'],
    }),
    'workforce.action_contract_types': action(HrContractType, {
      label: 'Employment types',
      views: ['list', 'form'],
    }),
    'workforce.action_employee_tags': action(HrEmployeeTag, {
      label: 'Employee tags',
      views: ['list', 'form'],
    }),
  },
  menus: [
    { id: 'workforce.root', label: 'Workforce', app: 'workforce' },
    {
      id: 'workforce.employees',
      parent: 'workforce.root',
      label: 'Employees',
      action: 'workforce.action_employees',
      sequence: 1,
    },
    {
      id: 'workforce.leaves',
      parent: 'workforce.root',
      label: 'Leave',
      action: 'workforce.action_leaves',
      sequence: 2,
    },
    {
      id: 'workforce.contracts',
      parent: 'workforce.root',
      label: 'Contracts',
      action: 'workforce.action_contracts',
      sequence: 3,
    },
    {
      id: 'workforce.configuration',
      parent: 'workforce.root',
      label: 'Configuration',
      sequence: 9,
    },
    {
      id: 'workforce.departments',
      parent: 'workforce.configuration',
      label: 'Departments',
      action: 'workforce.action_departments',
      sequence: 1,
    },
    {
      id: 'workforce.jobs',
      parent: 'workforce.configuration',
      label: 'Positions',
      action: 'workforce.action_jobs',
      sequence: 2,
    },
    {
      id: 'workforce.leave_types',
      parent: 'workforce.configuration',
      label: 'Leave types',
      action: 'workforce.action_leave_types',
      sequence: 3,
    },
    {
      id: 'workforce.contract_types',
      parent: 'workforce.configuration',
      label: 'Employment types',
      action: 'workforce.action_contract_types',
      sequence: 4,
    },
    {
      id: 'workforce.employee_tags',
      parent: 'workforce.configuration',
      label: 'Employee tags',
      action: 'workforce.action_employee_tags',
      sequence: 5,
    },
  ],
  views: {
    'hr.employee.list': list(HrEmployee, {
      columns: [
        'name',
        'jobTitle',
        'department',
        'manager',
        'unitHead',
        'property',
        { field: 'tags', widget: 'tags' },
        { field: 'workEmail', widget: 'email' },
        { field: 'workPhone', widget: 'phone' },
      ],
      defaultOrder: ['name asc'],
    }),
    'hr.employee.kanban': kanban(HrEmployee, {
      groupBy: 'department',
      card: {
        title: 'name',
        subtitle: 'job',
        avatar: 'user',
        footer: [{ field: 'workEmail', widget: 'email' }],
      },
    }),
    'hr.employee.hierarchy': hierarchy(HrEmployee, {
      parent: 'manager',
      title: 'name',
      subtitle: 'job',
    }),
    'hr.employee.form': form(HrEmployee, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.stats('related', [
          {
            id: 'employee_team',
            label: 'Team',
            model: HrEmployee,
            where: { manager: { $record: 'id' } },
            action: 'workforce.action_employees',
          },
          {
            id: 'employee_leave_days',
            label: 'Leave days taken',
            model: HrLeave,
            where: { employee: { $record: 'id' }, state: 'approved' },
            measure: { sum: 'days' },
            action: 'workforce.action_leaves',
          },
          {
            id: 'employee_contracts',
            label: 'Contracts',
            model: HrContract,
            where: { employee: { $record: 'id' } },
            action: 'workforce.action_contracts',
          },
        ]),
        k.group('identity', ['name', 'jobTitle', 'user', 'hireDate']),
        // As Paragon's pg_employee lays it out: how to reach the person and where, beside whom they answer to.
        k.group('contact', [
          { field: 'workEmail', widget: 'email' },
          { field: 'workPhone', widget: 'phone' },
          { field: 'mobile', widget: 'phone' },
          { field: 'tags', widget: 'tags' },
          'company',
          'property',
        ]),
        k.group('work', ['department', 'job', 'manager', 'unitHead', 'coach'], {
          label: 'Reports to',
        }),
        k.group('approvers', ['expenseApprover', 'leaveApprover'], {
          label: 'Approvers',
          description: 'Who approves this person’s expenses and leave first.',
        }),
        k.group('schedule', ['timezone'], { label: 'Schedule' }),
        k.group('personal', ['birthday', 'nationalId', 'emergencyContact', 'privateAddress']),
      ],
      chatter: true,
    })),
    'hr.department.list': list(HrDepartment, { columns: ['name', 'parent', 'head'] }),
    'hr.department.hierarchy': hierarchy(HrDepartment, {
      parent: 'parent',
      title: 'name',
      subtitle: 'head',
    }),
    'hr.department.form': form(HrDepartment, (k) => ({
      header: { buttons: [] },
      sheet: [k.group('main', ['name', 'parent', 'head'])],
    })),
    'hr.job.list': list(HrJob, {
      columns: ['name', 'department'],
      inlineEdit: ['name', 'department'],
    }),
    'hr.job.form': form(HrJob, (k) => ({
      header: { buttons: [] },
      sheet: [k.group('main', ['name', 'department'])],
    })),
    'hr.contract.list': list(HrContract, {
      columns: [
        'name',
        'employee',
        'kind',
        'dateStart',
        'dateEnd',
        { field: 'state', widget: 'badge' },
      ],
      defaultOrder: ['dateStart desc'],
    }),
    'hr.contract.form': form(HrContract, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('start', { primary: true, label: 'Start' }),
          k.button('end', { label: 'End' }),
          k.button('cancel', { label: 'Cancel', confirm: 'Cancel this contract?' }),
        ],
      },
      sheet: [
        k.group('main', ['name', 'employee', 'employmentType', 'kind', 'state']),
        k.group('terms', ['dateStart', 'dateEnd', 'wage']),
      ],
      chatter: true,
    })),
    'hr.contract.type.list': list(HrContractType, {
      columns: ['name', 'code', 'country'],
      inlineEdit: ['name', 'code', 'country'],
    }),
    'hr.contract.type.form': form(HrContractType, (k) => ({
      header: { buttons: [] },
      sheet: [k.group('main', ['name', 'code', 'country', 'sequence'])],
    })),
    'hr.employee.tag.list': list(HrEmployeeTag, {
      columns: ['name', 'color'],
      inlineEdit: ['name', 'color'],
    }),
    'hr.employee.tag.form': form(HrEmployeeTag, (k) => ({
      header: { buttons: [] },
      sheet: [k.group('main', ['name', 'color'])],
    })),
    'hr.leave.type.list': list(HrLeaveType, {
      columns: ['name', 'daysPerYear'],
      inlineEdit: ['name', 'daysPerYear'],
    }),
    'hr.leave.type.form': form(HrLeaveType, (k) => ({
      header: { buttons: [] },
      sheet: [k.group('main', ['name', 'daysPerYear'])],
    })),
    'hr.leave.list': list(HrLeave, {
      columns: [
        'employee',
        'type',
        'dateFrom',
        'dateTo',
        'days',
        { field: 'state', widget: 'badge' },
      ],
      defaultOrder: ['dateFrom desc'],
      decorations: {
        success: { state: 'approved' },
        warning: { state: 'submitted' },
        danger: { state: 'refused' },
      },
    }),
    'hr.leave.calendar': calendar(HrLeave, {
      dateStart: 'dateFrom',
      dateStop: 'dateTo',
      title: 'employee',
      color: 'type',
      mode: 'month',
    }),
    'hr.leave.form': form(HrLeave, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('submit', { primary: true, label: 'Submit' }),
          k.button('approve', { primary: true, label: 'Approve' }),
          k.button('refuse', { label: 'Refuse' }),
          k.button('redraft', { label: 'Back to draft' }),
        ],
      },
      sheet: [
        k.group('main', ['employee', 'type', 'state']),
        k.group('when', ['dateFrom', 'dateTo', 'days']),
        k.group('why', ['reason'], { columns: 1 }),
      ],
      chatter: true,
    })),
  },
  search: {
    'hr.employee': search(HrEmployee, {
      fields: [
        'name',
        'jobTitle',
        'workEmail',
        'mobile',
        'property',
        'job.name',
        'department.name',
      ],
      groupBy: ['department', 'job', 'manager', 'unitHead', 'property'],
    }),
    'hr.leave': search(HrLeave, {
      fields: ['employee.name', 'reason'],
      filters: {
        waiting: { label: 'Waiting', domain: { state: 'submitted' }, group: 'state' },
        approved: { label: 'Approved', domain: { state: 'approved' }, group: 'state' },
        mine: { label: 'Mine', domain: { 'employee.user': { $env: 'uid' } } },
        team: { label: 'My team', domain: { 'employee.manager.user': { $env: 'uid' } } },
      },
      groupBy: ['employee', 'type', 'state', 'dateFrom:month'],
    }),
    'hr.contract': search(HrContract, {
      fields: ['name', 'employee.name'],
      filters: { running: { label: 'Running', domain: { state: 'running' } } },
      groupBy: ['kind', 'state'],
    }),
    'hr.department': search(HrDepartment, { fields: ['name'] }),
    'hr.job': search(HrJob, { fields: ['name'], groupBy: ['department'] }),
    'hr.leave.type': search(HrLeaveType, { fields: ['name'] }),
    'hr.contract.type': search(HrContractType, { fields: ['name', 'code'] }),
    'hr.employee.tag': search(HrEmployeeTag, { fields: ['name'] }),
  },
});
