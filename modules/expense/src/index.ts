/**
 * @packageDocumentation
 * `@kosh/expense` (RFC 0024 §2.1): the **Spend** app. Expenses with their receipts (filled from a photo by the
 * assistant, as on any form), categories with a policy the server enforces, reports decided through the approval
 * engine — a further level when an expense goes beyond its policy, possible duplicates flagged — and cash advances
 * that later reports settle. Booking and reimbursement come with Accounting (`expense_account`).
 */
import { hr } from '@kosh/hr';
import { defineModule } from '@kosh/modules-sdk';
import { permissions } from '@kosh/permissions';
import { product } from '@kosh/product';
import { reporting } from '@kosh/reporting';
import { action, form, graph, kanban, list, pivot, search } from '@kosh/views';
import { expenseDemo } from './demo.js';
import {
  ExpenseAdvance,
  ExpenseCategory,
  ExpenseExpense,
  ExpenseSheet,
  expenseShutro,
} from './module.js';

export {
  advanceLeft,
  ExpenseAdvance,
  ExpenseCategory,
  ExpenseExpense,
  ExpenseSheet,
  expenseShutro,
  isoDate,
} from './module.js';

export const expense: ReturnType<typeof defineModule> = defineModule({
  shutro: expenseShutro,
  kosh: '^0.1.0',
  hooks: { demo: expenseDemo },
  depends: [hr, product, permissions, reporting],
  // Exceptions to the module standard (RFC 0023), each with its reason.
  standard: {
    waive: [
      {
        rule: 'I1',
        model: 'expense.sheet',
        reason: 'Reports are made from expenses, which import; a report is then submitted.',
      },
    ],
  },
  app: {
    code: 'spend',
    label: 'Spend',
    icon: 'spend',
    sequence: 22,
    category: 'Finance',
    summary: 'Expenses, receipts, approvals and cash advances',
  },
  // Bangla for the labels it serves (RFC 0023 §3.1; `pnpm i18n:extract`).
  i18n: { bn: () => import('./i18n/bn.js') },
  accessLevels: {
    user: { label: 'Employee (own expenses and advances)', groups: ['expense.user'] },
    approver: {
      label: 'Approver (sees and approves reports)',
      groups: ['expense.approver'],
      implies: ['user'],
    },
    manager: {
      label: 'Spend manager (policies, payouts, everything)',
      groups: ['expense.manager'],
      implies: ['approver'],
    },
  },
  approvals: [
    {
      name: 'Expense report approvals',
      model: 'expense.sheet',
      onApproved: 'approve',
      onRejected: 'refuse',
      levels: [
        { name: 'Approver', condition: {}, approverRole: 'expense.approver' },
        {
          name: 'Beyond the policy',
          condition: { overPolicy: true },
          approverRole: 'expense.manager',
        },
        {
          name: 'Large report',
          condition: { total: { gt: '50000' } },
          approverRole: 'expense.manager',
        },
      ],
    },
    {
      name: 'Cash advance approvals',
      model: 'expense.advance',
      onApproved: 'approve',
      onRejected: 'refuse',
      levels: [
        { name: 'Approver', condition: {}, approverRole: 'expense.approver' },
        {
          name: 'Large advance',
          condition: { amount: { gt: '25000' } },
          approverRole: 'expense.manager',
        },
      ],
    },
  ],
  events: [
    { topic: 'expense.sheet.submitted', model: 'expense.sheet', label: 'Expense report submitted' },
    { topic: 'expense.sheet.approved', model: 'expense.sheet', label: 'Expense report approved' },
    {
      topic: 'expense.advance.submitted',
      model: 'expense.advance',
      label: 'Cash advance requested',
    },
    { topic: 'expense.advance.paid', model: 'expense.advance', label: 'Cash advance paid out' },
  ],
  documents: [
    {
      key: 'expense_report',
      name: 'Expense report',
      model: 'expense.sheet',
      layout: {
        paper: 'A4',
        header: '{{company.name}}',
        footer: 'Page {{page}} of {{pages}}',
        blocks: [
          { kind: 'heading', id: 'title', text: 'Expense report {{name}}', level: 1 },
          {
            kind: 'fields',
            id: 'who',
            items: [
              { label: 'Employee', bind: 'employee.name' },
              { label: 'Purpose', bind: 'title' },
              { label: 'Status', bind: 'state' },
              { label: 'Settles advance', bind: 'advance.name' },
            ],
          },
          {
            kind: 'table',
            id: 'expenses',
            bind: 'expenses',
            columns: [
              { label: 'Date', bind: 'date' },
              { label: 'Description', bind: 'name' },
              { label: 'Category', bind: 'category.name' },
              { label: 'Paid by', bind: 'paidBy' },
              { label: 'Tax', bind: 'taxAmount' },
              { label: 'Amount', bind: 'amount' },
            ],
          },
          {
            kind: 'fields',
            id: 'totals',
            items: [
              { label: 'Total', bind: 'total' },
              { label: 'From the advance', bind: 'advanceUsed' },
              { label: 'To reimburse', bind: 'toReimburse' },
            ],
          },
          { kind: 'qr', id: 'qr', bind: 'name', size: 24, label: 'Report reference' },
        ],
      },
    },
    {
      key: 'advance_voucher',
      name: 'Cash advance voucher',
      model: 'expense.advance',
      layout: {
        paper: 'A4',
        header: '{{company.name}}',
        blocks: [
          { kind: 'heading', id: 'title', text: 'Cash advance {{name}}', level: 1 },
          {
            kind: 'fields',
            id: 'advance',
            items: [
              { label: 'Employee', bind: 'employee.name' },
              { label: 'Purpose', bind: 'purpose' },
              { label: 'Needed on', bind: 'date' },
              { label: 'Amount', bind: 'amount' },
              { label: 'Settled', bind: 'settled' },
              { label: 'Left to settle', bind: 'balance' },
              { label: 'Status', bind: 'state' },
            ],
          },
          {
            kind: 'table',
            id: 'sheets',
            bind: 'sheets',
            columns: [
              { label: 'Report', bind: 'name' },
              { label: 'Total', bind: 'total' },
              { label: 'From the advance', bind: 'advanceUsed' },
            ],
          },
          {
            kind: 'text',
            id: 'received',
            text: 'Received by: ______________________   Date: __________',
          },
          { kind: 'qr', id: 'qr', bind: 'name', size: 24, label: 'Advance reference' },
        ],
      },
    },
  ],
  importTemplates: [
    {
      key: 'expenses',
      model: 'expense.expense',
      label: 'Expenses',
      columns: [
        { header: 'Date', field: 'date' },
        { header: 'Description', field: 'name' },
        { header: 'Employee', field: 'employee' },
        { header: 'Category', field: 'category' },
        { header: 'Quantity', field: 'quantity' },
        { header: 'Amount', field: 'amount' },
        { header: 'Paid to', field: 'vendor' },
        { header: 'Receipt number', field: 'reference' },
        { header: 'Paid by', field: 'paidBy' },
      ],
    },
    {
      key: 'advances',
      model: 'expense.advance',
      label: 'Cash advances',
      columns: [
        { header: 'Employee', field: 'employee' },
        { header: 'Purpose', field: 'purpose' },
        { header: 'Needed on', field: 'date' },
        { header: 'Amount', field: 'amount' },
      ],
    },
    {
      key: 'categories',
      model: 'expense.category',
      label: 'Expense categories',
      columns: [
        { header: 'Name', field: 'name' },
        { header: 'Claimed as', field: 'kind' },
        { header: 'Rate', field: 'rate' },
        { header: 'Limit per expense', field: 'limitPerExpense' },
        { header: 'Limit per month', field: 'limitPerMonth' },
        { header: 'Receipt above', field: 'receiptAbove' },
      ],
    },
  ],
  overview: {
    cards: [
      {
        id: 'waiting',
        title: 'Reports waiting for approval',
        kind: 'kpi',
        model: 'expense.sheet',
        measure: 'count',
        filter: { state: 'to_approve' },
        w: 3,
      },
      {
        id: 'spent_month',
        title: 'Spent this month',
        kind: 'kpi',
        model: 'expense.expense',
        measure: 'sum:amount',
        filter: { status: { notIn: ['draft', 'refused'] } },
        comparison: { field: 'date', mode: 'previous' },
        w: 3,
      },
      {
        id: 'beyond_policy',
        title: 'Beyond the policy',
        kind: 'kpi',
        model: 'expense.expense',
        measure: 'count',
        filter: { overPolicy: true, status: { notIn: ['refused'] } },
        w: 3,
      },
      {
        id: 'advances_open',
        title: 'Advances to settle',
        kind: 'kpi',
        model: 'expense.advance',
        measure: 'sum:amount',
        filter: { state: 'paid' },
        w: 3,
      },
      {
        id: 'by_category',
        title: 'By category',
        kind: 'chart',
        model: 'expense.expense',
        measure: 'sum:amount',
        groupBy: 'category',
        chart: 'pie',
        filter: { status: { notIn: ['draft', 'refused'] } },
        w: 6,
      },
      {
        id: 'by_month',
        title: 'By month',
        kind: 'chart',
        model: 'expense.expense',
        measure: 'sum:amount',
        groupBy: 'date:month',
        chart: 'bar',
        filter: { status: { notIn: ['draft', 'refused'] } },
        w: 6,
      },
      {
        id: 'by_employee',
        title: 'By person',
        kind: 'pivot',
        model: 'expense.expense',
        measure: 'sum:amount',
        groupBy: 'employee',
        filter: { status: { notIn: ['draft', 'refused'] } },
        w: 12,
      },
    ],
  },
  actions: {
    'spend.action_expenses': action(ExpenseExpense, {
      label: 'My expenses',
      views: ['list', 'form', 'pivot', 'graph'],
    }),
    'spend.action_sheets': action(ExpenseSheet, {
      label: 'Expense reports',
      views: ['list', 'kanban', 'form'],
    }),
    'spend.action_advances': action(ExpenseAdvance, {
      label: 'Cash advances',
      views: ['list', 'form'],
    }),
    'spend.action_categories': action(ExpenseCategory, {
      label: 'Categories and policies',
      views: ['list', 'form'],
    }),
  },
  menus: [
    { id: 'spend.root', label: 'Spend', app: 'spend' },
    {
      id: 'spend.expenses',
      parent: 'spend.root',
      label: 'Expenses',
      action: 'spend.action_expenses',
      sequence: 1,
    },
    {
      id: 'spend.sheets',
      parent: 'spend.root',
      label: 'Reports',
      action: 'spend.action_sheets',
      sequence: 2,
    },
    {
      id: 'spend.advances',
      parent: 'spend.root',
      label: 'Advances',
      action: 'spend.action_advances',
      sequence: 3,
    },
    { id: 'spend.configuration', parent: 'spend.root', label: 'Configuration', sequence: 9 },
    {
      id: 'spend.categories',
      parent: 'spend.configuration',
      label: 'Categories and policies',
      action: 'spend.action_categories',
      sequence: 1,
    },
  ],
  views: {
    'expense.expense.list': list(ExpenseExpense, {
      columns: ['date', 'name', 'employee', 'category', 'amount', 'paidBy', 'sheet', 'status'],
      defaultOrder: ['date desc'],
      decorations: { warning: { overPolicy: true }, danger: { duplicate: true } },
    }),
    'expense.expense.form': form(ExpenseExpense, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.group(
          'main',
          ['name', 'employee', 'date', 'category', 'quantity', 'amount', 'tax', 'taxAmount'],
          {
            description: 'Attach the receipt in the panel on the right, or fill this form from it.',
          },
        ),
        k.group('paid', ['vendor', 'reference', 'paidBy', 'sheet', 'status'], { label: 'Payment' }),
        k.group('policy', ['policyReason', 'overPolicy', 'duplicate'], {
          label: 'Policy',
          description: 'Checked when the report is submitted.',
        }),
      ],
      chatter: true,
    })),
    'expense.expense.pivot': pivot(ExpenseExpense, {
      rows: ['category'],
      cols: ['date:month'],
      measures: [{ sum: 'amount' }],
    }),
    'expense.expense.graph': graph(ExpenseExpense, {
      chart: 'bar',
      groupBy: ['date:month'],
      measure: { sum: 'amount' },
    }),
    'expense.sheet.list': list(ExpenseSheet, {
      columns: ['name', 'employee', 'title', 'expenseCount', 'total', 'toReimburse', 'state'],
      decorations: { warning: { overPolicy: true } },
    }),
    'expense.sheet.kanban': kanban(ExpenseSheet, {
      groupBy: 'state',
      card: { title: 'name', subtitle: 'employee', footer: ['total'] },
    }),
    'expense.sheet.form': form(ExpenseSheet, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('submit', { primary: true, label: 'Submit for approval' }),
          k.button('reimbursed', { label: 'Settled outside the books' }),
          k.button('redraft', { label: 'Set to draft' }),
        ],
      },
      sheet: [
        k.group('main', ['name', 'title', 'employee', 'advance']),
        k.component('approvals', 'approvals.Panel'),
        k.lines('expenses', [
          'date',
          { field: 'name', id: 'expense_name' },
          'category',
          { field: 'amount', id: 'expense_amount' },
          'paidBy',
          { field: 'overPolicy', id: 'expense_over' },
          'duplicate',
        ]),
        k.group('totals', ['total', 'advanceUsed', 'toReimburse', 'overPolicy'], {
          label: 'Totals',
        }),
      ],
      chatter: true,
    })),
    'expense.advance.list': list(ExpenseAdvance, {
      columns: ['name', 'employee', 'purpose', 'date', 'amount', 'balance', 'state'],
    }),
    'expense.advance.form': form(ExpenseAdvance, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('submit', { primary: true, label: 'Submit for approval' }),
          k.button('pay', { primary: true, label: 'Paid out' }),
          k.button('settle', { label: 'Settled' }),
          k.button('redraft', { label: 'Set to draft' }),
        ],
      },
      sheet: [
        k.group('main', ['name', 'employee', 'purpose', 'date', 'amount']),
        k.component('advance_approvals', 'approvals.Panel'),
        k.group('settlement', ['settled', 'balance'], {
          label: 'Settlement',
          description: 'Reports that settle the advance take what is left of it.',
        }),
        k.lines('sheets', [
          { field: 'name', id: 'sheet_name' },
          { field: 'total', id: 'sheet_total' },
          { field: 'advanceUsed', id: 'sheet_used' },
          { field: 'state', id: 'sheet_state' },
        ]),
      ],
      chatter: true,
    })),
    'expense.category.list': list(ExpenseCategory, {
      columns: ['name', 'kind', 'rate', 'limitPerExpense', 'limitPerMonth', 'receiptAbove', 'tax'],
    }),
    'expense.category.form': form(ExpenseCategory, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.group('main', ['name', 'kind', 'rate', 'tax']),
        k.group('policy', ['limitPerExpense', 'limitPerMonth', 'receiptAbove'], {
          label: 'Policy',
          description: 'Enforced by the server when a report is submitted.',
        }),
        k.group('guidance', ['note'], { label: 'Guidance for employees' }),
      ],
    })),
  },
  search: {
    'expense.expense': search(ExpenseExpense, {
      fields: ['name', 'reference', 'employee.name', 'vendor.name'],
      filters: {
        mine: { label: 'Mine', domain: { 'employee.user': { $env: 'uid' } }, group: 'who' },
        unreported: { label: 'Not reported', domain: { status: 'draft' }, group: 'status' },
        waiting: { label: 'Waiting', domain: { status: 'submitted' }, group: 'status' },
        over: { label: 'Beyond the policy', domain: { overPolicy: true }, group: 'flags' },
        duplicate: { label: 'Possible duplicates', domain: { duplicate: true }, group: 'flags' },
      },
      groupBy: ['employee', 'category', 'status', 'date:month'],
    }),
    'expense.sheet': search(ExpenseSheet, {
      fields: ['name', 'title', 'employee.name'],
      filters: {
        mine: { label: 'Mine', domain: { 'employee.user': { $env: 'uid' } }, group: 'who' },
        waiting: { label: 'Waiting for approval', domain: { state: 'to_approve' }, group: 'state' },
        approved: { label: 'Approved', domain: { state: 'approved' }, group: 'state' },
        over: { label: 'Beyond the policy', domain: { overPolicy: true }, group: 'flags' },
      },
      groupBy: ['employee', 'state'],
    }),
    'expense.advance': search(ExpenseAdvance, {
      fields: ['name', 'purpose', 'employee.name'],
      filters: {
        open: { label: 'To settle', domain: { state: 'paid' }, group: 'state' },
      },
      groupBy: ['employee', 'state'],
    }),
    'expense.category': search(ExpenseCategory, {
      fields: ['name'],
      groupBy: ['kind'],
    }),
  },
});
