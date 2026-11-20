/**
 * @packageDocumentation
 * `@kosh/project_billing` (RFC 0034 §2.5): projects **billed to their customer**. Proposed whenever Projects and
 * Accounting are installed.
 *
 * - **Rate cards**: an hour's price by person, role and kind of task; the most specific line wins.
 * - **Approval**: people submit their hours; a Projects manager approves or refuses them (never their own). The
 *   rate is frozen on the hour when it is approved.
 * - **Billing milestones**: a fixed price, invoiced once the milestone is reached.
 * - **Billing statements**: a project's approved hours and reached milestones up to a day, made into one customer
 *   invoice on the project's cost centre — once: an hour or a milestone is on one statement at most.
 */
import { accounting } from '@kosh/accounting';
import { messaging } from '@kosh/messaging';
import { defineModule } from '@kosh/modules-sdk';
import { product } from '@kosh/product';
import { project } from '@kosh/project';
import { projectAccount } from '@kosh/project_account';
import { action, field, form, list, pivot, search, stat } from '@kosh/views';
import type { Env } from './.kosh/bindings.js';
import {
  BillingMilestone,
  installBillingGuards,
  projectBillingShutro,
  RateCard,
  RateCardLine,
  Recognition,
  RecognitionLine,
  removeBillingGuards,
  Statement,
} from './module.js';

export {
  BillingMilestone,
  installBillingGuards,
  invoiceStatement,
  MoveStatement,
  PhaseProfit,
  ProjectBilling,
  postRecognition,
  projectBillingShutro,
  RateCard,
  RateCardLine,
  Recognition,
  RecognitionLine,
  Statement,
  TimesheetBilling,
  unbilledOf,
} from './module.js';
export {
  type RateFound,
  type RateLine,
  type RateQuery,
  type RateSource,
  rateFor,
} from './rates.js';

export const projectBilling: ReturnType<typeof defineModule> = defineModule({
  shutro: projectBillingShutro,
  kosh: '^0.1.0',
  depends: [project, projectAccount, accounting, product, messaging],
  bridge: [project, accounting],
  standard: {
    waive: [
      {
        rule: 'I1',
        model: 'project.statement',
        reason:
          'A statement is made of approved hours and reached milestones by the server; there is nothing to import.',
      },
      {
        rule: 'I1',
        model: 'project.recognition',
        reason:
          'A recognition is computed from the projects’ work in progress and posted by the server.',
      },
    ],
  },
  hooks: {
    // The delete guards, idempotent (with every seed and app install); gone before the module is.
    defaults: async (env) => {
      await installBillingGuards(env as Env);
      return undefined;
    },
    preUninstall: async (env) => removeBillingGuards(env as Env),
  },
  // Bangla for the labels it serves (RFC 0023 §3.1; `pnpm i18n:extract`).
  i18n: { bn: () => import('./i18n/bn.js') },
  accessLevels: {
    manager: {
      label: 'Project billing (rate cards, milestones, statements)',
      groups: ['project_billing.manager'],
    },
  },
  events: [
    {
      topic: 'project.recognition.posted',
      model: 'project.recognition',
      label: 'Revenue recognised',
    },
    {
      topic: 'project.statement.billed',
      model: 'project.statement',
      label: 'Billing statement invoiced',
    },
    {
      topic: 'project.billing.milestone.reached',
      model: 'project.billing.milestone',
      label: 'Billing milestone reached',
    },
  ],
  documents: [
    {
      key: 'project_recognition',
      name: 'Revenue recognition',
      model: 'project.recognition',
      layout: {
        paper: 'A4',
        header: '{{company.name}}',
        footer: 'Page {{page}} of {{pages}}',
        blocks: [
          { kind: 'heading', id: 'title', text: 'Revenue recognition {{name}}', level: 1 },
          {
            kind: 'fields',
            id: 'what',
            items: [
              { label: 'On', bind: 'date' },
              { label: 'Entry', bind: 'move.name' },
              { label: 'Reversed by', bind: 'reversal.name' },
              { label: 'Recognised', bind: 'amount' },
            ],
          },
          {
            kind: 'table',
            id: 'projects',
            bind: 'lines',
            columns: [
              { label: 'Project', bind: 'project.name' },
              { label: 'Hours', bind: 'hours' },
              { label: 'Time', bind: 'amountTime' },
              { label: 'Milestones', bind: 'amountMilestones' },
              { label: 'Recognised', bind: 'amount' },
            ],
          },
        ],
      },
    },
    {
      key: 'project_statement',
      name: 'Billing statement',
      model: 'project.statement',
      layout: {
        paper: 'A4',
        header: '{{company.name}}',
        footer: 'Page {{page}} of {{pages}}',
        blocks: [
          { kind: 'heading', id: 'title', text: 'Billing statement {{name}}', level: 1 },
          {
            kind: 'fields',
            id: 'who',
            items: [
              { label: 'Project', bind: 'project.name' },
              { label: 'Customer', bind: 'partner.name' },
              { label: 'Hours up to', bind: 'dateTo' },
              { label: 'Invoice', bind: 'invoice.name' },
            ],
          },
          {
            kind: 'table',
            id: 'hours',
            bind: 'timesheets',
            columns: [
              { label: 'Date', bind: 'date' },
              { label: 'Person', bind: 'user.name' },
              { label: 'Task', bind: 'task.name' },
              { label: 'Work done', bind: 'description' },
              { label: 'Hours', bind: 'hours' },
              { label: 'Per hour', bind: 'billRate' },
              { label: 'Amount', bind: 'billAmount' },
            ],
          },
          {
            kind: 'table',
            id: 'milestones',
            bind: 'milestones',
            columns: [
              { label: 'Milestone', bind: 'name' },
              { label: 'Reached on', bind: 'reachedOn' },
              { label: 'Amount', bind: 'amount' },
            ],
          },
          {
            kind: 'fields',
            id: 'totals',
            items: [
              { label: 'Hours', bind: 'hours' },
              { label: 'Time', bind: 'amountTime' },
              { label: 'Milestones', bind: 'amountMilestones' },
              { label: 'Total before taxes', bind: 'amount' },
            ],
          },
        ],
      },
    },
  ],
  importTemplates: [
    {
      key: 'project_rate_card',
      model: 'project.rate.card',
      label: 'Rate cards (with their rates)',
      columns: [
        { header: 'Name', field: 'name' },
        { header: 'Rate for everyone else', field: 'defaultRate' },
        { header: 'Rates › Person', field: 'lines.user' },
        { header: 'Rates › Role', field: 'lines.role' },
        { header: 'Rates › Kind of task', field: 'lines.category' },
        { header: 'Rates › Per hour', field: 'lines.rate' },
      ],
    },
    {
      key: 'project_billing_milestone',
      model: 'project.billing.milestone',
      label: 'Billing milestones',
      columns: [
        { header: 'Project', field: 'project' },
        { header: 'Name', field: 'name' },
        { header: 'Price', field: 'amount' },
        { header: 'Expected', field: 'dateDue' },
      ],
    },
  ],
  actions: {
    'projects.action_statements': action(Statement, {
      label: 'Billing statements',
      views: ['list', 'form'],
    }),
    'projects.action_billing_milestones': action(BillingMilestone, {
      label: 'Billing milestones',
      views: ['list', 'form'],
    }),
    'projects.action_rate_cards': action(RateCard, {
      label: 'Rate cards',
      views: ['list', 'form'],
    }),
    'projects.action_recognitions': action(Recognition, {
      label: 'Revenue recognition',
      views: ['list', 'form'],
    }),
    'projects.action_recognition_lines': action(RecognitionLine, {
      label: 'Recognised work',
      views: ['list', 'form', 'pivot'],
    }),
    'projects.action_rate_lines': action(RateCardLine, { label: 'Rates', views: ['list', 'form'] }),
  },
  menus: [
    {
      id: 'projects.billing',
      parent: 'projects.root',
      label: 'Billing',
      sequence: 6.5,
    },
    {
      id: 'projects.statements',
      parent: 'projects.billing',
      label: 'Billing statements',
      action: 'projects.action_statements',
      sequence: 1,
    },
    {
      id: 'projects.billing_milestones',
      parent: 'projects.billing',
      label: 'Billing milestones',
      action: 'projects.action_billing_milestones',
      sequence: 2,
    },
    {
      id: 'projects.recognitions',
      parent: 'projects.billing',
      label: 'Revenue recognition',
      action: 'projects.action_recognitions',
      sequence: 3,
    },
    {
      id: 'projects.rate_cards',
      parent: 'projects.configuration',
      label: 'Rate cards',
      action: 'projects.action_rate_cards',
      sequence: 1.7,
    },
  ],
  views: {
    'project.rate.card.list': list(RateCard, { columns: ['name', 'defaultRate'] }),
    'project.rate.card.form': form(RateCard, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.group('main', ['name', 'defaultRate'], {
          description:
            'The most specific rate wins: a person before a role, a role before a kind of task; then the rate for everyone else.',
        }),
        k.lines('lines', ['sequence', 'user', 'role', 'category', 'rate']),
      ],
    })),
    'project.rate.line.list': list(RateCardLine, {
      columns: ['card', 'user', 'role', 'category', 'rate'],
    }),
    'project.rate.line.form': form(RateCardLine, (k) => ({
      header: { buttons: [] },
      sheet: [k.group('main', ['card', 'sequence', 'user', 'role', 'category', 'rate'])],
    })),
    'project.billing.milestone.list': list(BillingMilestone, {
      columns: [
        'project',
        'name',
        { field: 'dateDue', widget: 'daysLeft' },
        { field: 'amount', sum: true },
        'state',
        'statement',
      ],
      decorations: { success: { state: 'reached' }, neutral: { statement: { isNull: false } } },
    }),
    'project.billing.milestone.form': form(BillingMilestone, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('reach', { primary: true, label: 'Reached' }),
          k.button('revert', { label: 'Not reached after all' }),
        ],
      },
      sheet: [
        k.group('main', ['name', 'project', 'amount', 'dateDue', 'task', 'product']),
        k.group('billed', ['reachedOn', 'statement'], { label: 'Billing' }),
      ],
      chatter: true,
    })),
    'project.recognition.list': list(Recognition, {
      columns: ['name', 'date', { field: 'amount', sum: true }, 'move', 'state'],
      decorations: { neutral: { state: 'cancelled' } },
    }),
    'project.recognition.form': form(Recognition, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('recognise', {
            primary: true,
            label: 'Recognise',
            confirm:
              'Book the work in progress of every billed project on that day as revenue, reversed the day after?',
          }),
          k.button('discard', { label: 'Discard' }),
        ],
      },
      sheet: [
        k.group('main', ['name', 'date', 'note'], {
          description:
            'Work approved up to the day and on no posted invoice is booked as revenue on that day — accrued income against income, on each project’s cost centre — and reversed the day after, so the invoices that follow are not counted twice.',
        }),
        k.group('booked', ['amount', 'move', 'reversal'], { label: 'In the books' }),
        k.lines(
          'lines',
          [
            { field: 'project', id: 'line_project' },
            { field: 'hours', id: 'line_hours', sum: true },
            { field: 'amountTime', id: 'line_time', sum: true },
            { field: 'amountMilestones', id: 'line_milestones', sum: true },
            { field: 'amount', id: 'line_amount', sum: true },
          ],
          { readonlyWhen: {} },
        ),
      ],
      chatter: true,
    })),
    'project.recognition.line.list': list(RecognitionLine, {
      columns: [
        'recognition',
        'project',
        'hours',
        'amountTime',
        'amountMilestones',
        { field: 'amount', sum: true },
      ],
    }),
    'project.recognition.line.form': form(RecognitionLine, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.group('main', [
          'recognition',
          'project',
          'hours',
          'amountTime',
          'amountMilestones',
          'amount',
        ]),
      ],
    })),
    'project.recognition.line.pivot': pivot(RecognitionLine, {
      rows: ['project'],
      cols: ['recognition'],
      measures: [{ sum: 'amount' }],
    }),
    'project.statement.list': list(Statement, {
      columns: [
        'name',
        'project',
        'partner',
        'dateTo',
        'hours',
        { field: 'amount', sum: true },
        'invoice',
        'state',
      ],
      decorations: { neutral: { state: 'cancelled' } },
    }),
    'project.statement.form': form(Statement, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('bill', {
            primary: true,
            label: 'Make the invoice',
            confirm:
              'Invoice the project’s approved hours up to that day and its reached milestones?',
          }),
          k.button('discard', { label: 'Discard' }),
          k.button('release', {
            label: 'Release',
            confirm:
              'Release its hours and milestones, so that they can be invoiced again? Its invoice must be cancelled.',
          }),
        ],
      },
      sheet: [
        k.group('main', ['name', 'project', 'partner', 'dateTo', 'note'], {
          description:
            'Make the invoice gathers the project’s approved billable hours up to the day and its reached milestones; each is invoiced once.',
        }),
        k.group('totals', ['hours', 'amountTime', 'amountMilestones', 'amount', 'invoice'], {
          label: 'Invoiced',
        }),
        k.lines(
          'timesheets',
          [
            { field: 'date', id: 'hour_date' },
            { field: 'user', id: 'hour_user' },
            { field: 'task', id: 'hour_task' },
            { field: 'hours', id: 'hour_hours', sum: true },
            { field: 'billRate', id: 'hour_rate' },
            { field: 'billAmount', id: 'hour_amount', sum: true },
          ],
          { readonlyWhen: {} },
        ),
        k.lines(
          'milestones',
          [
            { field: 'name', id: 'milestone_name' },
            { field: 'reachedOn', id: 'milestone_reached' },
            { field: 'amount', id: 'milestone_amount', sum: true },
          ],
          { readonlyWhen: {} },
        ),
      ],
      chatter: true,
    })),
  },
  viewExtensions: [
    {
      view: 'project.project.form',
      operations: [
        {
          append: 'money',
          nodes: [
            field({ field: 'billable', id: 'billing_billable' }),
            field({ field: 'rateCard', id: 'billing_rate_card' }),
            field({ field: 'billingProduct', id: 'billing_product' }),
            field({ field: 'revenue', id: 'billing_revenue' }),
            field({ field: 'unbilled', id: 'billing_unbilled' }),
            field({ field: 'profit', id: 'billing_profit' }),
            field({ field: 'margin', id: 'billing_margin' }),
          ],
        },
        {
          append: 'related',
          nodes: [
            stat({
              id: 'hours_to_approve',
              label: 'Hours to approve',
              model: 'project.timesheet',
              where: { project: { $record: 'id' }, approval: 'submitted' },
              action: 'projects.action_timesheets',
            }),
            stat({
              id: 'billing_statements',
              label: 'Billing statements',
              model: 'project.statement',
              where: { project: { $record: 'id' } },
              action: 'projects.action_statements',
            }),
          ],
        },
        {
          append: 'header',
          nodes: [
            {
              kind: 'button',
              id: 'new_statement',
              label: 'New billing statement',
              open: { model: 'project.statement', values: { project: { $record: 'id' } } },
              visibleWhen: { billable: true },
            },
          ],
        },
      ],
    },
    {
      view: 'project.timesheet.form',
      operations: [
        {
          append: 'header',
          nodes: [
            {
              kind: 'button',
              id: 'submit_hours',
              transition: 'submit',
              label: 'Submit',
              primary: true,
              visibleWhen: { approval: { in: ['draft', 'refused'] } },
            },
            {
              kind: 'button',
              id: 'approve_hours',
              transition: 'approve',
              label: 'Approve',
              primary: true,
              visibleWhen: { approval: 'submitted' },
            },
            {
              kind: 'button',
              id: 'refuse_hours',
              transition: 'refuse',
              label: 'Refuse',
              visibleWhen: { approval: 'submitted' },
            },
            {
              kind: 'button',
              id: 'reopen_hours',
              transition: 'reopen',
              label: 'Reopen',
              visibleWhen: { approval: { in: ['submitted', 'refused', 'approved'] } },
            },
          ],
        },
        {
          append: 'main',
          nodes: [
            field({ field: 'billable', id: 'hours_billable' }),
            field({ field: 'approval', id: 'hours_approval' }),
            field({ field: 'refuseReason', id: 'hours_refuse_reason' }),
            field({ field: 'billRate', id: 'hours_bill_rate' }),
            field({ field: 'billAmount', id: 'hours_bill_amount' }),
            field({ field: 'approvedBy', id: 'hours_approved_by' }),
            field({ field: 'statement', id: 'hours_statement' }),
          ],
        },
      ],
    },
    {
      view: 'project.phase.list',
      operations: [
        {
          insertAfter: 'progress',
          nodes: [
            field({ field: 'phaseCost', id: 'phase_cost', sum: true }),
            field({ field: 'phaseEarned', id: 'phase_earned', sum: true }),
            field({ field: 'phaseProfit', id: 'phase_profit', sum: true }),
          ],
        },
      ],
    },
    {
      view: 'project.timesheet.list',
      operations: [
        {
          insertAfter: 'hours',
          nodes: [
            field({ field: 'billable', id: 'list_billable' }),
            field({ field: 'approval', id: 'list_approval' }),
            field({ field: 'billAmount', id: 'list_bill_amount', sum: true }),
          ],
        },
      ],
    },
  ],
  search: {
    'project.rate.card': search(RateCard, { fields: ['name'] }),
    'project.rate.line': search(RateCardLine, {
      fields: ['card.name', 'user.name'],
      groupBy: ['card', 'role', 'category'],
    }),
    'project.billing.milestone': search(BillingMilestone, {
      fields: ['name', 'project.name'],
      filters: {
        pending: { label: 'To reach', domain: { state: 'pending' }, group: 'state' },
        to_bill: {
          label: 'Reached, not invoiced',
          domain: { state: 'reached', statement: { isNull: true } },
          group: 'state',
        },
      },
      groupBy: ['project', 'state'],
    }),
    'project.recognition': search(Recognition, {
      fields: ['name'],
      filters: { posted: { label: 'Posted', domain: { state: 'posted' }, group: 'state' } },
      groupBy: ['state', 'date:month'],
    }),
    'project.recognition.line': search(RecognitionLine, {
      fields: ['project.name', 'recognition.name'],
      groupBy: ['project', 'recognition'],
    }),
    'project.statement': search(Statement, {
      fields: ['name', 'project.name', 'partner.name'],
      filters: {
        draft: { label: 'Draft', domain: { state: 'draft' }, group: 'state' },
        invoiced: { label: 'Invoiced', domain: { state: 'invoiced' }, group: 'state' },
      },
      groupBy: ['project', 'partner', 'state', 'dateTo:month'],
    }),
  },
});
