/**
 * @packageDocumentation
 * `@kosh/account_budget` (RFC 0024 §2.5): **Budgets** in Accounting. A budget for a period with lines by cost centre
 * and / or account; each line's actual (posted) and committed amount (confirmed purchase orders not billed), what is
 * left and how much is used; and a control on purchase orders — beyond a **warn** line an order needs an Accounting
 * manager's approval as well, beyond a **block** line it is refused with the shortfall.
 *
 * - `POST /api/v1/budgets/refresh`   `{ budgets? }`: the actual and committed amounts, now (daily on the server)
 */
import { accounting } from '@kosh/accounting';
import { defineModule } from '@kosh/modules-sdk';
import { purchaseAccount } from '@kosh/purchase_account';
import { HttpProblem, type ModuleContext } from '@kosh/server';
import { action, field, form, list, pivot, search } from '@kosh/views';
import type { Env } from './.kosh/bindings.js';
import { refreshBudgets } from './budget.js';
import { budgetDemo } from './demo.js';
import { accountBudgetShutro, Budget, BudgetLine } from './module.js';

export { checkOrders, refreshBudgets } from './budget.js';
export { accountBudgetShutro, Budget, BudgetLine, PurchaseBudget } from './module.js';

function registerBudgetRoutes(context: ModuleContext): void {
  const { app } = context;
  app.post('/api/v1/budgets/refresh', async (request) => {
    const given = (request.body as Record<string, unknown> | null)?.['budgets'];
    const budgets = Array.isArray(given) ? given.map(Number) : undefined;
    return request.env(
      async (raw) => {
        const env = raw as unknown as Env;
        if (!env.administrator && !env.groups.has('account.user'))
          throw new HttpProblem(403, 'access', 'Accountants', 'This needs the Accountant role.');
        return env.asSuperuser({ reason: 'budget figures' }, async (su) => ({
          lines: await refreshBudgets(su, budgets),
        }));
      },
      { write: true },
    );
  });
  if (process.env['KOSH_SCHEDULES'] === 'off') return;
  const run = async () => {
    try {
      const companies = await context.shutro.bootstrap(
        { reason: 'budget figures' },
        async (env) => (await (env as unknown as Env).model('res.company').search({})).ids,
      );
      for (const company of companies)
        await context.shutro.bootstrap({ reason: 'budget figures', company }, (env) =>
          (env as unknown as Env).asSuperuser({ reason: 'budget figures' }, (su) =>
            refreshBudgets(su),
          ),
        );
    } catch (error) {
      app.log.error({ err: error }, 'budget figures');
    }
  };
  const timer = setInterval(() => void run(), 3_600_000);
  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));
}

export const accountBudget: ReturnType<typeof defineModule> = defineModule({
  shutro: accountBudgetShutro,
  kosh: '^0.1.0',
  hooks: { demo: budgetDemo },
  depends: [accounting, purchaseAccount],
  // Bangla for the labels it serves (RFC 0023 §3.1; `pnpm i18n:extract`).
  i18n: { bn: () => import('./i18n/bn.js') },
  accessLevels: { user: { label: 'Budgets', groups: ['account_budget.user'] } },
  routes: (context: ModuleContext) => registerBudgetRoutes(context),
  // Beyond a budget's warn line, a purchase order needs an Accounting manager as well (RFC 0003 approvals).
  approvals: [
    {
      name: 'Purchases beyond a budget',
      model: 'purchase.order',
      onApproved: 'confirm',
      onRejected: 'reject',
      levels: [
        {
          name: 'Beyond the budget',
          condition: { overBudget: true },
          approverRole: 'account.manager',
        },
      ],
    },
  ],
  events: [{ topic: 'account.budget.approved', model: 'account.budget', label: 'Budget approved' }],
  documents: [
    {
      key: 'budget_report',
      name: 'Budget against actuals',
      model: 'account.budget',
      layout: {
        paper: 'A4',
        orientation: 'landscape',
        header: '{{company.name}} — {{name}}',
        footer: 'Page {{page}} of {{pages}}',
        blocks: [
          { kind: 'heading', id: 'title', text: '{{name}}: {{dateFrom}} to {{dateTo}}', level: 1 },
          {
            kind: 'table',
            id: 'lines',
            bind: 'lines',
            columns: [
              { label: 'What for', bind: 'name' },
              { label: 'Cost centre', bind: 'analytic.name' },
              { label: 'Account', bind: 'account.displayName' },
              { label: 'Planned', bind: 'planned' },
              { label: 'Actual', bind: 'actual' },
              { label: 'Committed', bind: 'committed' },
              { label: 'Left', bind: 'available' },
              { label: 'Used %', bind: 'used' },
            ],
          },
          { kind: 'fields', id: 'totals', items: [{ label: 'Planned in all', bind: 'planned' }] },
        ],
      },
    },
  ],
  importTemplates: [
    {
      key: 'budgets',
      model: 'account.budget',
      label: 'Budgets (with their lines)',
      columns: [
        { header: 'Budget', field: 'name' },
        { header: 'From', field: 'dateFrom' },
        { header: 'To', field: 'dateTo' },
        { header: 'What for', field: 'lines.name' },
        { header: 'Cost centre', field: 'lines.analytic' },
        { header: 'Account', field: 'lines.account' },
        { header: 'Planned', field: 'lines.planned' },
        { header: 'Control', field: 'lines.control' },
      ],
    },
  ],
  actions: {
    'accounting.action_budgets': action(Budget, { label: 'Budgets', views: ['list', 'form'] }),
    'accounting.action_budget_lines': action(BudgetLine, {
      label: 'Budget lines',
      views: ['list', 'pivot'],
    }),
  },
  menus: [
    {
      id: 'accounting.budgets',
      parent: 'accounting.root',
      label: 'Budgets',
      action: 'accounting.action_budgets',
      sequence: 7,
    },
    {
      id: 'accounting.budget_lines',
      parent: 'accounting.reporting',
      label: 'Budget against actuals',
      action: 'accounting.action_budget_lines',
      sequence: 9,
    },
  ],
  views: {
    'account.budget.list': list(Budget, {
      columns: ['name', 'dateFrom', 'dateTo', 'planned', 'state'],
    }),
    'account.budget.form': form(Budget, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('approve', { primary: true, label: 'Approve' }),
          k.button('close', { label: 'Close' }),
          k.button('redraft', { label: 'Back to draft' }),
        ],
      },
      sheet: [
        k.group('main', ['name', 'dateFrom', 'dateTo', 'planned'], {
          description:
            'Approved budgets are compared with the books every hour and checked when purchase orders are submitted.',
        }),
        k.lines('lines', [
          { field: 'name', id: 'line_name' },
          'analytic',
          'account',
          { field: 'planned', id: 'line_planned' },
          'control',
          'actual',
          'committed',
          'available',
          { field: 'used', id: 'line_used', widget: 'progress' },
        ]),
      ],
      chatter: true,
    })),
    'account.budget.line.list': list(BudgetLine, {
      columns: [
        'budget',
        'name',
        'analytic',
        'account',
        'planned',
        'actual',
        'committed',
        'available',
        { field: 'used', widget: 'progress' },
      ],
      decorations: { danger: { available: { lt: 0 } } },
    }),
    'account.budget.line.pivot': pivot(BudgetLine, {
      rows: ['analytic'],
      cols: ['budget'],
      measures: [{ sum: 'planned' }, { sum: 'actual' }, { sum: 'committed' }, { sum: 'available' }],
    }),
  },
  viewExtensions: [
    {
      view: 'purchase.order.form',
      operations: [
        {
          append: 'dates',
          nodes: [
            field({ field: 'overBudget', id: 'order_over_budget' }),
            field({ field: 'budgetNote', id: 'order_budget_note' }),
          ],
        },
      ],
    },
  ],
  search: {
    'account.budget': search(Budget, {
      fields: ['name'],
      filters: { approved: { label: 'Approved', domain: { state: 'approved' }, group: 'state' } },
      groupBy: ['state'],
    }),
    'account.budget.line': search(BudgetLine, {
      fields: ['name', 'analytic.name'],
      filters: { over: { label: 'Overspent', domain: { available: { lt: 0 } }, group: 'state' } },
      groupBy: ['budget', 'analytic', 'account', 'control'],
    }),
  },
});
