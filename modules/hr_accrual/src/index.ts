/**
 * @packageDocumentation
 * `@kosh/hr_accrual` (RFC 0034 §2.5): **leave accruals as rules**. Proposed whenever Workforce and Payroll are
 * installed.
 *
 * - **Accrual plans**: a leave type's days earned by a formula in Payroll's formula language, month by month —
 *   `10 / 12`, `WORKED_DAYS / 18`, `if(SERVICE_YEARS >= 5, 2, 1.5)` —, with probation, a cap, the carry-over into
 *   a new year and the expiry of what was carried.
 * - **The ledger**: every day earned, lost, given or paid out; a mistake is another line.
 * - **Balances**: per person and plan — today, available, this year, on 31 December, what expires and when.
 * - Leave of a type with a plan is checked against the balance **on the day it starts**.
 *
 * - `POST /api/v1/leave-accruals/run`                                      HR managers: the months that are over, now
 * - `GET  /api/v1/leave-accruals/projection?employee=&type=&date=`         the balance on a day, with its steps
 */
import { attendance } from '@kosh/attendance';
import { hr } from '@kosh/hr';
import { defineModule } from '@kosh/modules-sdk';
import { payroll } from '@kosh/payroll';
import { audit, HttpProblem, type ModuleContext } from '@kosh/server';
import { action, form, list, search } from '@kosh/views';
import type { Env } from './.kosh/bindings.js';
import {
  AccrualBalance,
  AccrualEntry,
  AccrualPlan,
  accrueLeave,
  hrAccrualShutro,
  LeaveEncashment,
  projectLeave,
} from './module.js';

export {
  type AccrualRules,
  type AccrualState,
  type MonthInput,
  type Movement,
  monthEnd,
  monthsBetween,
  serviceMonthsAt,
  stepMonth,
  stepMonths,
} from './accrual.js';
export {
  ACCRUAL_VARIABLES,
  AccrualBalance,
  AccrualEntry,
  AccrualPlan,
  accrueLeave,
  ENCASH_VARIABLES,
  formulaProblem,
  hrAccrualShutro,
  LeaveByAccrual,
  LeaveEncashment,
  type Projection,
  type ProjectionStep,
  payOut,
  projectLeave,
} from './module.js';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function registerAccrualRoutes(context: ModuleContext): void {
  const { app } = context;
  app.post('/api/v1/leave-accruals/run', async (request) =>
    request.env(
      async (raw) => {
        const env = raw as unknown as Env;
        if (!(env.administrator || env.groups.has('hr.manager')))
          throw new HttpProblem(
            403,
            'access',
            'HR managers',
            'Running the leave accruals needs the HR manager role.',
          );
        const lines = await accrueLeave(env);
        await audit(env as never, {
          kind: 'hr_accrual.run',
          summary: `${lines} leave ledger line(s) written by hand.`,
          ip: request.ip,
        });
        return { lines };
      },
      { write: true },
    ),
  );
  app.get('/api/v1/leave-accruals/projection', async (request) => {
    const query = request.query as Record<string, string | undefined>;
    const employee = Number(query['employee']);
    const type = Number(query['type']);
    const date = query['date'] ?? '';
    if (!Number.isSafeInteger(employee) || !Number.isSafeInteger(type) || !DAY.test(date))
      throw new HttpProblem(
        400,
        'bad-request',
        'What to project',
        'Give employee, type and date (YYYY-MM-DD).',
      );
    return request.env(
      async (raw) => {
        const env = raw as unknown as Env;
        // Whoever may read the person's leave may ask: themselves, their manager, HR (the record rules decide).
        const seen = await env
          .model('hr.employee')
          .search({ where: { id: employee as never }, limit: 1 });
        const mine = await env.asSuperuser({ reason: 'whose balance' }, async (su) => {
          const [e] = await su
            .model('hr.employee')
            .search({ where: { id: employee as never }, limit: 1 })
            .then((found) => found.load({ user: true, manager: { user: true } }));
          return (
            e !== undefined && (e.user?.id === env.userId || e.manager?.user?.id === env.userId)
          );
        });
        if (seen.length === 0 || !(env.administrator || env.groups.has('hr.manager') || mine))
          throw new HttpProblem(
            403,
            'access',
            'Not yours to read',
            'A balance is read by the person, their manager and HR managers.',
          );
        const projection = await projectLeave(env, employee, type, date);
        if (projection === null)
          throw new HttpProblem(
            404,
            'missing-record',
            'No plan',
            'This leave type has no accrual plan, or the person has no joining date.',
          );
        return projection;
      },
      { write: true },
    );
  });
  if (process.env['KOSH_SCHEDULES'] === 'off') return;
  // Every six hours, each company: the months that are over go to the ledger once, so a second server finds
  // nothing left; balances follow the leave asked for in between.
  const run = async () => {
    try {
      const companies = await context.shutro.bootstrap({ reason: 'leave accruals' }, (env) =>
        (env as unknown as Env)
          .model('res.company')
          .search({ where: {} })
          .then((found) => found.ids.map(Number)),
      );
      for (const company of companies)
        await context.shutro.bootstrap({ reason: 'leave accruals', company }, (env) =>
          accrueLeave(env as unknown as Env),
        );
    } catch (error) {
      app.log.warn({ err: error }, 'leave was not accrued');
    }
  };
  const timer = setInterval(() => void run(), 6 * 60 * 60 * 1000);
  timer.unref();
  const first = setTimeout(() => void run(), 3 * 60 * 1000);
  first.unref();
  app.addHook('onClose', async () => {
    clearInterval(timer);
    clearTimeout(first);
  });
}

export const hrAccrual: ReturnType<typeof defineModule> = defineModule({
  shutro: hrAccrualShutro,
  kosh: '^0.1.0',
  depends: [hr, attendance, payroll],
  bridge: [hr, payroll],
  // Bangla for the labels it serves (RFC 0023 §3.1; `pnpm i18n:extract`).
  i18n: { bn: () => import('./i18n/bn.js') },
  accessLevels: {
    user: { label: 'Leave balances', groups: ['hr_accrual.user'] },
  },
  routes: (context: ModuleContext) => registerAccrualRoutes(context),
  // Exceptions to the module standard (RFC 0023), each with its reason.
  standard: {
    waive: [
      {
        rule: 'I1',
        model: 'hr.leave.encashment',
        reason:
          'A payout is asked for by its person and approved against the balance; there is nothing to import.',
      },
    ],
  },
  events: [
    {
      topic: 'hr.leave.encashment.approved',
      model: 'hr.leave.encashment',
      label: 'Leave payout approved',
    },
  ],
  documents: [
    {
      key: 'hr_leave_encashment',
      name: 'Leave payout',
      model: 'hr.leave.encashment',
      layout: {
        paper: 'A4',
        header: '{{company.name}}',
        footer: 'Page {{page}} of {{pages}}',
        blocks: [
          { kind: 'heading', id: 'title', text: 'Leave payout {{name}}', level: 1 },
          {
            kind: 'fields',
            id: 'what',
            items: [
              { label: 'Employee', bind: 'employee.name' },
              { label: 'Plan', bind: 'plan.name' },
              { label: 'Days', bind: 'days' },
              { label: 'Paid in the month of', bind: 'date' },
              { label: 'A day is worth', bind: 'dayValue' },
              { label: 'Amount', bind: 'amount' },
              { label: 'Status', bind: 'state' },
            ],
          },
        ],
      },
    },
  ],
  importTemplates: [
    {
      key: 'hr_accrual_plan',
      model: 'hr.accrual.plan',
      label: 'Accrual plans',
      columns: [
        { header: 'Name', field: 'name' },
        { header: 'Leave type', field: 'type' },
        { header: 'Accrues from', field: 'dateStart' },
        { header: 'Days a month', field: 'formula' },
        { header: 'Probation (months)', field: 'probationMonths' },
        { header: 'Never above (days)', field: 'cap' },
        { header: 'Carried into a new year (days)', field: 'carryOver' },
        { header: 'Carried days expire after month', field: 'carryExpiryMonth' },
      ],
    },
    {
      key: 'hr_accrual_opening',
      model: 'hr.accrual.entry',
      label: 'Opening leave balances (adjustments)',
      columns: [
        { header: 'Employee', field: 'employee' },
        { header: 'Plan', field: 'plan' },
        { header: 'Date', field: 'date' },
        { header: 'Days', field: 'days' },
        { header: 'Why', field: 'note' },
      ],
    },
  ],
  actions: {
    'workforce.action_leave_balances': action(AccrualBalance, {
      label: 'Leave balances',
      views: ['list', 'form'],
    }),
    'workforce.action_leave_ledger': action(AccrualEntry, {
      label: 'Leave ledger',
      views: ['list', 'form'],
    }),
    'workforce.action_leave_payouts': action(LeaveEncashment, {
      label: 'Leave payouts',
      views: ['list', 'form'],
    }),
    'workforce.action_accrual_plans': action(AccrualPlan, {
      label: 'Accrual plans',
      views: ['list', 'form'],
    }),
  },
  menus: [
    {
      id: 'workforce.leave_balances',
      parent: 'workforce.root',
      label: 'Leave balances',
      action: 'workforce.action_leave_balances',
      sequence: 2.3,
    },
    {
      id: 'workforce.leave_ledger',
      parent: 'workforce.root',
      label: 'Leave ledger',
      action: 'workforce.action_leave_ledger',
      sequence: 2.6,
    },
    {
      id: 'workforce.leave_payouts',
      parent: 'workforce.root',
      label: 'Leave payouts',
      action: 'workforce.action_leave_payouts',
      sequence: 2.8,
    },
    {
      id: 'workforce.accrual_plans',
      parent: 'workforce.configuration',
      label: 'Accrual plans',
      action: 'workforce.action_accrual_plans',
      sequence: 3.5,
    },
  ],
  views: {
    'hr.accrual.plan.list': list(AccrualPlan, {
      columns: [
        'name',
        'type',
        'formula',
        'probationMonths',
        'cap',
        'carryOver',
        'carryExpiryMonth',
      ],
    }),
    'hr.accrual.plan.form': form(AccrualPlan, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.group('main', ['name', 'type', 'dateStart', 'formula', 'probationMonths', 'note'], {
          description:
            'Each month that is over, every employee with a joining date earns what the formula gives, at the month’s end. Balances from before the plan are given in the Leave ledger as adjustments.',
        }),
        k.group('limits', ['cap', 'carryOver', 'carryExpiryMonth'], {
          label: 'Limits',
          description:
            'The cap stops the accrual; the carry-over is checked on 1 January; carried days are used first and expire at the end of the month given.',
        }),
        k.group('comp', ['compDays', 'compMinHours', 'compExpiryDays'], {
          label: 'Compensatory days',
          description:
            'For a leave type of its own (days a month: 0): an approved attendance day worked on a weekend or a holiday earns these days, once. They are used the oldest first and, when they last only so many days, what is left is lost.',
        }),
        k.group('payout', ['encashable', 'encashKeep', 'encashFormula', 'encashCode'], {
          label: 'Paying days out',
          description:
            'An approved payout takes the days from the ledger and leaves the amount as a Payroll input of that month; the person’s salary structure pays it with a rule that reads that input.',
        }),
      ],
      chatter: true,
    })),
    'hr.leave.encashment.list': list(LeaveEncashment, {
      columns: [
        'name',
        'employee',
        'plan',
        'days',
        'date',
        { field: 'amount', sum: true },
        'state',
      ],
      decorations: { neutral: { state: 'refused' }, success: { state: 'approved' } },
    }),
    'hr.leave.encashment.form': form(LeaveEncashment, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('submit', { primary: true, label: 'Submit' }),
          k.button('approve', {
            primary: true,
            label: 'Approve',
            confirm:
              'Take the days from the balance and leave the amount for this month’s payroll?',
          }),
          k.button('refuse', { label: 'Refuse' }),
          k.button('redraft', { label: 'Back to draft' }),
        ],
      },
      sheet: [
        k.group('main', ['name', 'employee', 'plan', 'days', 'date', 'note'], {
          description:
            'Days not taken, paid instead: approved by an HR manager against the balance on that day, paid with the month’s payroll.',
        }),
        k.group('paid', ['dayValue', 'amount', 'entry', 'input', 'refuseReason'], {
          label: 'Decision',
        }),
      ],
      chatter: true,
    })),
    'hr.accrual.entry.list': list(AccrualEntry, {
      columns: ['date', 'employee', 'plan', 'kind', { field: 'days', sum: true }, 'period', 'note'],
      decorations: { danger: { days: { lt: 0 } } },
    }),
    'hr.accrual.entry.form': form(AccrualEntry, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.group('main', ['employee', 'plan', 'date', 'days', 'note', 'kind', 'period', 'source'], {
          description:
            'A line added here is an adjustment: an opening balance, days given, a correction. Lines are not changed afterwards — correct one with another.',
        }),
      ],
    })),
    'hr.accrual.balance.list': list(AccrualBalance, {
      columns: [
        'employee',
        'type',
        'balance',
        'available',
        'accruedYear',
        'takenYear',
        'yearEnd',
        'expiring',
        { field: 'expiresOn', widget: 'daysLeft' },
      ],
      decorations: { danger: { available: { lt: 0 } }, warning: { expiring: { gt: 0 } } },
    }),
    'hr.accrual.balance.form': form(AccrualBalance, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.group('main', ['employee', 'plan', 'type', 'accruedThrough']),
        k.group('now', ['balance', 'available', 'carried'], { label: 'Now' }),
        k.group('year', ['accruedYear', 'takenYear', 'yearEnd'], { label: 'This year' }),
        k.group('expiry', ['expiring', 'expiresOn'], { label: 'To use or lose' }),
      ],
    })),
  },
  search: {
    'hr.accrual.plan': search(AccrualPlan, { fields: ['name', 'type.name'], groupBy: ['type'] }),
    'hr.leave.encashment': search(LeaveEncashment, {
      fields: ['name', 'employee.name'],
      filters: {
        waiting: { label: 'To decide', domain: { state: 'submitted' }, group: 'state' },
        approved: { label: 'Approved', domain: { state: 'approved' }, group: 'state' },
      },
      groupBy: ['employee', 'plan', 'state', 'date:month'],
    }),
    'hr.accrual.entry': search(AccrualEntry, {
      fields: ['employee.name', 'note'],
      filters: {
        accrued: { label: 'Accrued', domain: { kind: 'accrual' }, group: 'kind' },
        lost: {
          label: 'Lost',
          domain: { kind: { in: ['lapse', 'expiry', 'comp_expiry'] } },
          group: 'kind',
        },
        adjustments: { label: 'Adjustments', domain: { kind: 'adjustment' }, group: 'kind' },
        paid: { label: 'Paid out', domain: { kind: 'encashment' }, group: 'kind' },
        compensatory: {
          label: 'Earned on a day off',
          domain: { kind: { in: ['compensatory', 'comp_expiry'] } },
          group: 'kind',
        },
      },
      groupBy: ['employee', 'plan', 'kind', 'date:month'],
    }),
    'hr.accrual.balance': search(AccrualBalance, {
      fields: ['employee.name'],
      filters: {
        expiring: { label: 'Days expiring', domain: { expiring: { gt: 0 } } },
        negative: { label: 'Below zero', domain: { available: { lt: 0 } } },
      },
      groupBy: ['type', 'plan'],
    }),
  },
});
