/**
 * @packageDocumentation
 * `@kosh/payroll` (RFC 0024 §2.3): the **Payroll** app — a country-neutral engine. Salary structures of rules in a
 * safe formula language, versioned parameters and slab tables, monthly runs whose payslips explain every line,
 * Attendance's approved days, one-off inputs, loans, year-to-date sums, corrections that never edit an approved
 * run, and payment files for banks and mobile wallets. Country rules come as data (`l10n_bd_payroll`); booking in
 * Accounting with `payroll_account`.
 */
import { attendance } from '@kosh/attendance';
import { hr } from '@kosh/hr';
import { defineModule } from '@kosh/modules-sdk';
import { reporting } from '@kosh/reporting';
import type { ModuleContext } from '@kosh/server';
import { action, field, form, list, pivot, search, stat } from '@kosh/views';
import { payrollDemo } from './demo.js';
import {
  PayrollEmployeeValue,
  PayrollInput,
  PayrollLoan,
  PayrollParameter,
  PayrollRule,
  PayrollRun,
  PayrollSlab,
  PayrollSlip,
  PayrollSlipLine,
  PayrollStructure,
  payrollShutro,
} from './module.js';
import { registerPayrollRoutes } from './routes.js';

export {
  computeRuns,
  fiscalStartOf,
  fiscalYearStart,
  isoDate,
  PAYMENT_FORMATS,
  type PaymentFormat,
  type PaymentRow,
  paymentRows,
  recordRepayments,
} from './compute.js';
export {
  evaluate,
  explain,
  FormulaError,
  parse,
  type Scope,
  type Slab,
  slabTax,
  variablesOf,
} from './formula.js';
export {
  CATEGORIES,
  ContractStructure,
  EmployeePay,
  PayrollEmployeeValue,
  PayrollInput,
  PayrollLoan,
  PayrollLoanRepayment,
  PayrollParameter,
  PayrollRule,
  PayrollRun,
  PayrollSlab,
  PayrollSlabBand,
  PayrollSlip,
  PayrollSlipLine,
  PayrollStructure,
  payrollShutro,
} from './module.js';

const MONTHS = {
  '1': 'January',
  '2': 'February',
  '3': 'March',
  '4': 'April',
  '5': 'May',
  '6': 'June',
  '7': 'July',
  '8': 'August',
  '9': 'September',
  '10': 'October',
  '11': 'November',
  '12': 'December',
};

export const payroll: ReturnType<typeof defineModule> = defineModule({
  shutro: payrollShutro,
  kosh: '^0.1.0',
  hooks: { demo: payrollDemo },
  depends: [hr, attendance, reporting],
  app: {
    code: 'payroll',
    label: 'Payroll',
    icon: 'payroll',
    sequence: 23,
    category: 'People',
    summary: 'Salary structures, monthly runs with explained payslips, loans and payment files',
  },
  // Bangla for the labels it serves (RFC 0023 §3.1; `pnpm i18n:extract`).
  i18n: { bn: () => import('./i18n/bn.js') },
  accessLevels: {
    user: { label: 'Employee (own payslips once approved)', groups: ['payroll.user'] },
    officer: {
      label: 'Payroll officer (prepares runs)',
      groups: ['payroll.officer'],
      implies: ['user'],
    },
    manager: {
      label: 'Payroll manager (approves and pays runs)',
      groups: ['payroll.manager'],
      implies: ['officer'],
    },
  },
  routes: (context: ModuleContext) => registerPayrollRoutes(context),
  settings: {
    sections: [
      {
        key: 'year',
        label: 'Fiscal year',
        description:
          'Year-to-date sums and the months left in the year (for tax spread over the year) count from here.',
        keywords: 'fiscal year july income year tax',
        scope: 'installation',
        editors: ['payroll.manager'],
        fields: [
          {
            key: 'fiscalStart',
            type: 'selection',
            label: 'The fiscal year starts in',
            options: MONTHS,
            default: '7',
            help: 'Bangladesh: July; India: April.',
          },
        ],
      },
    ],
  },
  events: [
    { topic: 'payroll.run.approved', model: 'payroll.run', label: 'Payroll run approved' },
    { topic: 'payroll.loan.started', model: 'payroll.loan', label: 'Salary loan started' },
  ],
  documents: [
    {
      key: 'payslip',
      name: 'Payslip',
      model: 'payroll.slip',
      layout: {
        paper: 'A4',
        header: '{{company.name}}',
        blocks: [
          { kind: 'heading', id: 'title', text: 'Payslip', level: 1 },
          {
            kind: 'fields',
            id: 'who',
            items: [
              { label: 'Employee', bind: 'employee.name' },
              { label: 'Position', bind: 'employee.job.name' },
              { label: 'Period', bind: 'dateFrom' },
              { label: 'To', bind: 'dateTo' },
              { label: 'Run', bind: 'run.name' },
            ],
          },
          {
            kind: 'table',
            id: 'lines',
            bind: 'lines',
            columns: [
              { label: 'Item', bind: 'name' },
              { label: 'Kind', bind: 'category' },
              { label: 'Amount', bind: 'amount' },
            ],
          },
          {
            kind: 'fields',
            id: 'totals',
            items: [
              { label: 'Gross', bind: 'gross' },
              { label: 'Deductions', bind: 'deductions' },
              { label: 'Net pay', bind: 'net' },
            ],
          },
          { kind: 'qr', id: 'qr', bind: 'name', size: 22, label: 'Payslip reference' },
        ],
      },
    },
    {
      key: 'payroll_summary',
      name: 'Payroll summary',
      model: 'payroll.run',
      layout: {
        paper: 'A4',
        orientation: 'landscape',
        header: '{{company.name}} — {{name}}',
        footer: 'Page {{page}} of {{pages}}',
        blocks: [
          { kind: 'heading', id: 'title', text: 'Payroll {{name}} {{title}}', level: 1 },
          {
            kind: 'table',
            id: 'slips',
            bind: 'slips',
            columns: [
              { label: 'Employee', bind: 'employee.name' },
              { label: 'Gross', bind: 'gross' },
              { label: 'Deductions', bind: 'deductions' },
              { label: 'Contributions', bind: 'contributions' },
              { label: 'Net', bind: 'net' },
            ],
          },
          {
            kind: 'fields',
            id: 'totals',
            items: [
              { label: 'Gross', bind: 'gross' },
              { label: 'Net', bind: 'net' },
            ],
          },
          {
            kind: 'text',
            id: 'sign',
            text: 'Prepared by: ______________   Approved by: ______________',
          },
        ],
      },
    },
    {
      key: 'loan_agreement',
      name: 'Salary loan agreement',
      model: 'payroll.loan',
      layout: {
        paper: 'A4',
        header: '{{company.name}}',
        blocks: [
          { kind: 'heading', id: 'title', text: 'Salary loan {{name}}', level: 1 },
          {
            kind: 'fields',
            id: 'loan',
            items: [
              { label: 'Employee', bind: 'employee.name' },
              { label: 'Amount', bind: 'amount' },
              { label: 'Deducted each month', bind: 'installment' },
              { label: 'First deduction in', bind: 'dateStart' },
              { label: 'Repaid', bind: 'repaid' },
              { label: 'Remaining', bind: 'remaining' },
            ],
          },
          {
            kind: 'text',
            id: 'terms',
            text: 'The employee agrees that the instalment is deducted from each month’s pay until the loan is repaid.',
          },
          {
            kind: 'text',
            id: 'sign',
            text: 'Employee: ______________   For the company: ______________',
          },
        ],
      },
    },
  ],
  importTemplates: [
    {
      key: 'inputs',
      model: 'payroll.input',
      label: 'Payroll inputs',
      columns: [
        { header: 'Employee', field: 'employee' },
        { header: 'Month', field: 'date' },
        { header: 'Code', field: 'code' },
        { header: 'Amount', field: 'amount' },
        { header: 'Note', field: 'note' },
      ],
    },
    {
      key: 'values',
      model: 'payroll.employee.value',
      label: 'Per-person values',
      columns: [
        { header: 'Employee', field: 'employee' },
        { header: 'Code', field: 'code' },
        { header: 'Value', field: 'value' },
        { header: 'Valid from', field: 'dateFrom' },
      ],
    },
    {
      key: 'loans',
      model: 'payroll.loan',
      label: 'Salary loans',
      columns: [
        { header: 'Employee', field: 'employee' },
        { header: 'Amount', field: 'amount' },
        { header: 'Per month', field: 'installment' },
        { header: 'First deduction in', field: 'dateStart' },
      ],
    },
    {
      key: 'structures',
      model: 'payroll.structure',
      label: 'Salary structures',
      columns: [{ header: 'Name', field: 'name' }],
    },
    {
      key: 'rules',
      model: 'payroll.rule',
      label: 'Salary rules',
      columns: [
        { header: 'Structure', field: 'structure' },
        { header: 'Sequence', field: 'sequence' },
        { header: 'Code', field: 'code' },
        { header: 'Name', field: 'name' },
        { header: 'Category', field: 'category' },
        { header: 'Formula', field: 'formula' },
        { header: 'Applies when', field: 'condition' },
      ],
    },
    {
      key: 'slabs',
      model: 'payroll.slab',
      label: 'Slab tables (with their bands)',
      columns: [
        { header: 'Code', field: 'code' },
        { header: 'Name', field: 'name' },
        { header: 'Valid from', field: 'dateFrom' },
        { header: 'Valid to', field: 'dateTo' },
        { header: 'Band up to', field: 'bands.upTo' },
        { header: 'Band rate (%)', field: 'bands.rate' },
      ],
    },
    {
      key: 'parameters',
      model: 'payroll.parameter',
      label: 'Payroll parameters',
      columns: [
        { header: 'Code', field: 'code' },
        { header: 'Name', field: 'name' },
        { header: 'Value', field: 'value' },
        { header: 'Valid from', field: 'dateFrom' },
        { header: 'Valid to', field: 'dateTo' },
      ],
    },
  ],
  standard: {
    waive: [
      {
        rule: 'I1',
        model: 'payroll.run',
        reason:
          'Runs are computed from contracts, attendance and inputs, which import; a run is never typed in.',
      },
    ],
  },
  overview: {
    cards: [
      {
        id: 'net_month',
        title: 'Net pay this month',
        kind: 'kpi',
        model: 'payroll.run',
        measure: 'sum:net',
        filter: { state: { in: ['approved', 'paid'] }, kind: 'regular' },
        comparison: { field: 'dateFrom', mode: 'previous' },
        w: 3,
      },
      {
        id: 'to_approve',
        title: 'Runs to approve',
        kind: 'kpi',
        model: 'payroll.run',
        measure: 'count',
        filter: { state: 'computed' },
        w: 3,
      },
      {
        id: 'loans_out',
        title: 'Loans outstanding',
        kind: 'kpi',
        model: 'payroll.loan',
        measure: 'sum:remaining',
        filter: { state: 'running' },
        w: 3,
      },
      {
        id: 'payslips',
        title: 'Payslips this month',
        kind: 'kpi',
        model: 'payroll.slip',
        measure: 'count',
        comparison: { field: 'dateFrom', mode: 'previous' },
        w: 3,
      },
      {
        id: 'net_by_month',
        title: 'Net pay by month',
        kind: 'chart',
        model: 'payroll.slip',
        measure: 'sum:net',
        groupBy: 'dateFrom:month',
        chart: 'bar',
        w: 6,
      },
      {
        id: 'by_person',
        title: 'Gross by person',
        kind: 'pivot',
        model: 'payroll.slip',
        measure: 'sum:gross',
        groupBy: 'employee',
        w: 6,
      },
    ],
  },
  actions: {
    'payroll.action_runs': action(PayrollRun, { label: 'Runs', views: ['list', 'form'] }),
    'payroll.action_slips': action(PayrollSlip, {
      label: 'Payslips',
      views: ['list', 'form', 'pivot'],
    }),
    'payroll.action_inputs': action(PayrollInput, { label: 'Inputs', views: ['list', 'form'] }),
    'payroll.action_values': action(PayrollEmployeeValue, {
      label: 'Per-person values',
      views: ['list', 'form'],
    }),
    'payroll.action_loans': action(PayrollLoan, { label: 'Loans', views: ['list', 'form'] }),
    'payroll.action_structures': action(PayrollStructure, {
      label: 'Salary structures',
      views: ['list', 'form'],
    }),
    'payroll.action_rules': action(PayrollRule, { label: 'Salary rules', views: ['list', 'form'] }),
    'payroll.action_parameters': action(PayrollParameter, {
      label: 'Parameters',
      views: ['list', 'form'],
    }),
    'payroll.action_slabs': action(PayrollSlab, { label: 'Slab tables', views: ['list', 'form'] }),
  },
  menus: [
    { id: 'payroll.root', label: 'Payroll', app: 'payroll' },
    {
      id: 'payroll.runs',
      parent: 'payroll.root',
      label: 'Runs',
      action: 'payroll.action_runs',
      sequence: 1,
    },
    {
      id: 'payroll.slips',
      parent: 'payroll.root',
      label: 'Payslips',
      action: 'payroll.action_slips',
      sequence: 2,
    },
    {
      id: 'payroll.inputs',
      parent: 'payroll.root',
      label: 'Inputs',
      action: 'payroll.action_inputs',
      sequence: 3,
      visibleTo: ['payroll.officer'],
    },
    {
      id: 'payroll.loans',
      parent: 'payroll.root',
      label: 'Loans',
      action: 'payroll.action_loans',
      sequence: 4,
    },
    {
      id: 'payroll.values',
      parent: 'payroll.root',
      label: 'Per-person values',
      action: 'payroll.action_values',
      sequence: 5,
      visibleTo: ['payroll.officer'],
    },
    {
      id: 'payroll.configuration',
      parent: 'payroll.root',
      label: 'Configuration',
      sequence: 9,
      visibleTo: ['payroll.officer'],
    },
    {
      id: 'payroll.structures',
      parent: 'payroll.configuration',
      label: 'Salary structures',
      action: 'payroll.action_structures',
      sequence: 1,
    },
    {
      id: 'payroll.rules',
      parent: 'payroll.configuration',
      label: 'Salary rules',
      action: 'payroll.action_rules',
      sequence: 2,
    },
    {
      id: 'payroll.parameters',
      parent: 'payroll.configuration',
      label: 'Parameters',
      action: 'payroll.action_parameters',
      sequence: 3,
    },
    {
      id: 'payroll.slabs',
      parent: 'payroll.configuration',
      label: 'Slab tables',
      action: 'payroll.action_slabs',
      sequence: 4,
    },
  ],
  views: {
    'payroll.run.list': list(PayrollRun, {
      columns: [
        'name',
        'title',
        'kind',
        'dateFrom',
        'dateTo',
        'slipCount',
        'gross',
        'net',
        'state',
      ],
      defaultOrder: ['dateFrom desc'],
    }),
    'payroll.run.form': form(PayrollRun, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('compute', { primary: true, label: 'Compute payslips' }),
          k.button('approve', {
            primary: true,
            label: 'Approve',
            confirm: 'Approve and lock this run?',
          }),
          k.button('pay', { label: 'Mark as paid' }),
          k.button('redraft', { label: 'Back to draft' }),
          k.button('cancel', { label: 'Cancel' }),
        ],
      },
      readonlyWhen: { state: { in: ['approved', 'paid', 'cancelled'] } },
      sheet: [
        k.group(
          'main',
          [
            'name',
            'title',
            'kind',
            'correctionOf',
            'dateFrom',
            'dateTo',
            'festival',
            'paymentDate',
          ],
          {
            description:
              'Compute the payslips, read their warnings, then approve: an approved run is locked.',
          },
        ),
        k.lines('slips', [
          'employee',
          { field: 'gross', id: 'slip_gross' },
          'deductions',
          'contributions',
          { field: 'net', id: 'slip_net' },
          'difference',
          'warnings',
        ]),
        k.group('totals', ['slipCount', 'gross', 'net'], { label: 'Totals' }),
      ],
      chatter: true,
    })),
    'payroll.slip.list': list(PayrollSlip, {
      columns: ['name', 'employee', 'dateFrom', 'gross', 'deductions', 'net', 'run'],
      defaultOrder: ['dateFrom desc'],
      decorations: { warning: { warnings: { ne: null } } },
    }),
    'payroll.slip.pivot': pivot(PayrollSlip, {
      rows: ['employee'],
      cols: ['dateFrom:month'],
      measures: [{ sum: 'net' }],
    }),
    'payroll.slip.form': form(PayrollSlip, (k) => ({
      header: { buttons: [] },
      readonlyWhen: {},
      sheet: [
        k.group('main', ['employee', 'run', 'contract', 'structure', 'dateFrom', 'dateTo']),
        k.lines('lines', [
          { field: 'code', id: 'line_code' },
          { field: 'name', id: 'line_name' },
          'category',
          'amount',
          'explanation',
        ]),
        k.group(
          'totals',
          ['gross', 'deductions', 'contributions', 'net', 'previousNet', 'difference'],
          {
            label: 'Totals',
          },
        ),
        k.group('check', ['warnings'], { label: 'To check' }),
      ],
    })),
    'payroll.input.list': list(PayrollInput, {
      columns: ['date', 'employee', 'code', 'amount', 'note'],
      inlineEdit: ['code', 'amount', 'note'],
    }),
    'payroll.employee.value.list': list(PayrollEmployeeValue, {
      columns: ['employee', 'code', 'value', 'dateFrom', 'dateTo', 'note'],
      inlineEdit: ['value', 'dateTo', 'note'],
    }),
    'payroll.employee.value.form': form(PayrollEmployeeValue, (k) => ({
      header: { buttons: [] },
      sheet: [k.group('main', ['employee', 'code', 'value', 'dateFrom', 'dateTo', 'note'])],
    })),
    'payroll.input.form': form(PayrollInput, (k) => ({
      header: { buttons: [] },
      sheet: [k.group('main', ['employee', 'date', 'code', 'amount', 'note'])],
    })),
    'payroll.loan.list': list(PayrollLoan, {
      columns: ['name', 'employee', 'amount', 'installment', 'dateStart', 'remaining', 'state'],
    }),
    'payroll.loan.form': form(PayrollLoan, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('start', { primary: true, label: 'Start deductions' }),
          k.button('cancel', { label: 'Cancel' }),
        ],
      },
      sheet: [
        k.group('main', ['name', 'employee', 'amount', 'installment', 'dateStart']),
        k.group('progress', ['repaid', 'remaining'], { label: 'Repayment' }),
        k.lines('repayments', ['date', { field: 'amount', id: 'repayment_amount' }, 'slip'], {
          readonlyWhen: {},
        }),
      ],
      chatter: true,
    })),
    'payroll.structure.list': list(PayrollStructure, { columns: ['name'] }),
    'payroll.structure.form': form(PayrollStructure, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.group('main', ['name', 'note']),
        k.lines('rules', [
          'sequence',
          'code',
          { field: 'name', id: 'rule_name' },
          'category',
          'formula',
          'condition',
          'appearsOnSlip',
        ]),
      ],
    })),
    'payroll.rule.list': list(PayrollRule, {
      columns: [
        'structure',
        'sequence',
        'code',
        'name',
        'category',
        'formula',
        'dateFrom',
        'dateTo',
      ],
    }),
    'payroll.rule.form': form(PayrollRule, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.group('main', ['structure', 'sequence', 'code', 'name', 'category', 'appearsOnSlip']),
        k.group('calculation', ['formula', 'condition'], {
          label: 'Formula',
          description:
            'Variables: WAGE, PERIOD_DAYS, CONTRACT_DAYS, SERVICE_MONTHS, MONTH, FY_MONTH, MONTHS_LEFT, FESTIVAL, E_…, PRESENT_DAYS, ABSENT_DAYS, LEAVE_DAYS, HOLIDAYS, LATE_DAYS, OVERTIME_HOURS, OVERTIME_RATE, LOAN, INPUT_…, YTD_…, P_…, and the codes of earlier rules. Functions: min, max, abs, round, floor, ceil, if, slab.',
        }),
        k.group('validity', ['dateFrom', 'dateTo', 'note'], { label: 'In force' }),
      ],
    })),
    'payroll.parameter.list': list(PayrollParameter, {
      columns: ['code', 'name', 'value', 'dateFrom', 'dateTo'],
    }),
    'payroll.parameter.form': form(PayrollParameter, (k) => ({
      header: { buttons: [] },
      sheet: [k.group('main', ['code', 'name', 'value', 'dateFrom', 'dateTo', 'note'])],
    })),
    'payroll.slab.list': list(PayrollSlab, { columns: ['code', 'name', 'dateFrom', 'dateTo'] }),
    'payroll.slab.form': form(PayrollSlab, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.group('main', ['code', 'name', 'dateFrom', 'dateTo', 'note']),
        k.lines('bands', ['sequence', 'upTo', 'rate']),
      ],
    })),
  },
  viewExtensions: [
    {
      view: 'hr.employee.form',
      operations: [
        {
          insertAfter: 'contact',
          nodes: [
            {
              kind: 'group',
              id: 'pay',
              label: 'Pay',
              children: [
                field({ field: 'payMethod', id: 'employee_pay_method' }),
                field({ field: 'bankName', id: 'employee_bank' }),
                field({ field: 'bankBranch', id: 'employee_branch' }),
                field({ field: 'bankAccount', id: 'employee_account' }),
                field({ field: 'routingNumber', id: 'employee_routing' }),
                field({ field: 'walletProvider', id: 'employee_wallet' }),
                field({ field: 'walletNumber', id: 'employee_wallet_number' }),
              ],
            },
          ],
        },
        {
          append: 'related',
          nodes: [
            stat({
              id: 'employee_payslips',
              label: 'Payslips',
              model: 'payroll.slip',
              where: { employee: { $record: 'id' } },
              action: 'payroll.action_slips',
            }),
          ],
        },
      ],
    },
    {
      view: 'hr.contract.form',
      operations: [
        { append: 'main', nodes: [field({ field: 'structure', id: 'contract_structure' })] },
      ],
    },
  ],
  search: {
    'payroll.run': search(PayrollRun, {
      fields: ['name', 'title'],
      filters: {
        to_approve: { label: 'To approve', domain: { state: 'computed' }, group: 'state' },
        corrections: { label: 'Corrections', domain: { kind: 'correction' }, group: 'kind' },
      },
      groupBy: ['state', 'dateFrom:year'],
    }),
    'payroll.slip': search(PayrollSlip, {
      fields: ['employee.name', 'name'],
      filters: {
        mine: { label: 'Mine', domain: { 'employee.user': { $env: 'uid' } }, group: 'who' },
        warnings: { label: 'With warnings', domain: { warnings: { ne: null } }, group: 'check' },
      },
      groupBy: ['employee', 'run', 'dateFrom:month'],
    }),
    'payroll.employee.value': search(PayrollEmployeeValue, {
      fields: ['employee.name', 'code'],
      groupBy: ['code', 'employee'],
    }),
    'payroll.input': search(PayrollInput, {
      fields: ['employee.name', 'code', 'note'],
      groupBy: ['code', 'employee', 'date:month'],
    }),
    'payroll.loan': search(PayrollLoan, {
      fields: ['name', 'employee.name'],
      filters: { running: { label: 'Being repaid', domain: { state: 'running' }, group: 'state' } },
      groupBy: ['employee', 'state'],
    }),
    'payroll.structure': search(PayrollStructure, { fields: ['name'] }),
    'payroll.rule': search(PayrollRule, {
      fields: ['code', 'name', 'formula'],
      groupBy: ['structure', 'category'],
    }),
    'payroll.parameter': search(PayrollParameter, { fields: ['code', 'name'] }),
    'payroll.slab': search(PayrollSlab, { fields: ['code', 'name'] }),
  },
});

/** The line model, for those who extend payslips. */
export const PAYSLIP_LINE = PayrollSlipLine;
