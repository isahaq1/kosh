/**
 * The data layer of budgets (RFC 0024 §2.5): a budget for a period, approved by an Accounting manager, with lines by
 * cost centre and / or account — the planned amount, and a control: none, **warn** (a purchase order beyond it needs
 * an Accounting manager's approval as well) or **block** (refused). Each line's **actual** (posted lines) and
 * **committed** amount (confirmed purchase orders not billed yet) are refreshed by `budget.ts`; the purchase order
 * carries whether it goes beyond a budget and why.
 */
import { accountingShutro } from '@kosh/accounting';
import { purchaseAccountShutro } from '@kosh/purchase_account';
import { orm } from '@kosh/server/orm';
import {
  compute,
  defineModel,
  defineModule,
  type Env,
  extendModel,
  f,
  type Records,
  records,
} from './.kosh/bindings.js';
import { checkOrders } from './budget.js';

const READ = ['read'] as const;
const ALL = ['read', 'write', 'create', 'unlink', 'export', 'import'] as const;
const ZERO = orm.toDecimal(0);

export const Budget = defineModel('account.budget', {
  label: 'Budget',
  recName: 'name',
  order: ['dateFrom desc', 'id desc'],
  companyScoped: { required: true },
  tracking: ['state', 'dateFrom', 'dateTo'],
  access: { 'account.user': READ, 'account.manager': ALL },
  fields: {
    name: f.char({ required: true }),
    dateFrom: f.date({ required: true, label: 'From' }),
    dateTo: f.date({ required: true, label: 'To' }),
    lines: f.one2many('account.budget.line', 'budget'),
    planned: f.decimal({
      scale: 2,
      label: 'Planned',
      help: 'The lines’ planned amounts together.',
      ...compute('account.budget', 'planned', ['lines.planned'], (budgets) => {
        for (const b of budgets) b.planned = [...b.lines].reduce((s, l) => s.plus(l.planned), ZERO);
      }),
      store: true,
    }),
    state: f.state({
      states: { draft: 'Draft', approved: 'Approved', closed: 'Closed' },
      initial: 'draft',
      help: 'Approved budgets are compared with the books and checked when purchase orders are submitted.',
      transitions: {
        approve: {
          from: ['draft'],
          to: 'approved',
          requires: 'account.budget',
          after: records('account.budget', async (budgets) => {
            const env = budgets.env as unknown as Env;
            await env.flush();
            const { refreshBudgets } = await import('./budget.js');
            await env.asSuperuser({ reason: 'budget figures' }, (su) =>
              refreshBudgets(su, budgets.ids as readonly number[]),
            );
            for (const id of budgets.ids) await env.emit('account.budget.approved', { id });
          }),
        },
        close: { from: ['approved'], to: 'closed', requires: 'account.budget' },
        redraft: { from: ['approved'], to: 'draft', requires: 'account.budget' },
      },
    }),
  },
  sqlConstraints: {
    ordered: {
      check: orm.sql`date_to >= date_from`,
      message: 'A budget ends on or after it starts.',
    },
  },
});

export const BudgetLine = defineModel('account.budget.line', {
  label: 'Budget line',
  order: ['id asc'],
  access: { 'account.user': READ, 'account.manager': ALL },
  fields: {
    budget: f.many2one('account.budget', { required: true, ondelete: 'cascade' }),
    name: f.char({ required: true, label: 'What for' }),
    analytic: f.many2one('account.analytic', {
      ondelete: 'restrict',
      label: 'Cost centre',
      help: 'Empty: every cost centre.',
    }),
    account: f.many2one('account.account', {
      ondelete: 'restrict',
      help: 'Empty: every expense account. Purchase orders commit against lines without an account or on the purchases account.',
    }),
    planned: f.decimal({ scale: 2, required: true, default: '0' }),
    control: f.selection(
      { none: 'Report only', warn: 'Warn: a further approval', block: 'Block' },
      {
        required: true,
        default: 'warn',
        help: 'What a purchase order that would go beyond what is left does: needs an Accounting manager’s approval, or is refused.',
      },
    ),
    actual: f.decimal({
      scale: 2,
      required: true,
      default: '0',
      label: 'Actual',
      help: 'Posted in the period.',
    }),
    committed: f.decimal({
      scale: 2,
      required: true,
      default: '0',
      label: 'Committed',
      help: 'Confirmed purchase orders of the period not billed yet (untaxed).',
    }),
    available: f.decimal({
      scale: 2,
      label: 'Left',
      help: 'Planned less actual and committed.',
      ...compute(
        'account.budget.line',
        'available',
        ['planned', 'actual', 'committed'],
        (lines) => {
          for (const l of lines) l.available = l.planned.minus(l.actual).minus(l.committed);
        },
      ),
      store: true,
    }),
    used: f.decimal({
      scale: 2,
      label: 'Used (%)',
      help: 'Actual and committed against the planned amount.',
      ...compute('account.budget.line', 'used', ['planned', 'actual', 'committed'], (lines) => {
        for (const l of lines)
          l.used = l.planned.isZero()
            ? ZERO
            : l.actual.plus(l.committed).div(l.planned).times(100).toDecimalPlaces(2);
      }),
      store: true,
    }),
  },
  sqlConstraints: {
    planned: { check: orm.sql`planned >= 0`, message: 'A planned amount is not negative.' },
  },
});

/** Whether a purchase order goes beyond a budget, and which. */
export const PurchaseBudget = extendModel('purchase.order', {
  fields: {
    overBudget: f.boolean({
      default: false,
      label: 'Beyond a budget',
      help: 'Set when the order is submitted: an Accounting manager approves it as well.',
    }),
    budgetNote: f.text({ label: 'Budget check' }),
  },
  fieldOverrides: {
    state: {
      transitionsAdd: {
        /** The budgets checked now, before submitting (RFC 0032 §3.4): the order says where it stands. */
        budget: {
          from: ['draft', 'sent'],
          to: 'draft',
          after: records('purchase.order', async (orders) => {
            await checkOrders(orders.env as unknown as Env, [...orders.ids] as number[]);
          }),
        },
      },
    },
  },
  overrides: {
    // Before the approvals: the order checked against the approved budgets of its date.
    submitting: async function (this: unknown, next: () => Promise<void>): Promise<void> {
      await next();
      const orders = this as Records<'purchase.order'>;
      const env = orders.env as unknown as Env;
      const { checkOrders } = await import('./budget.js');
      await env.asSuperuser({ reason: 'budget check' }, (su) =>
        checkOrders(su, orders.ids as readonly number[]),
      );
    },
  },
});

export const accountBudgetShutro = defineModule({
  name: 'account_budget',
  version: '0.1.0',
  depends: [accountingShutro, purchaseAccountShutro],
  groups: [
    orm.defineGroup({ code: 'account_budget.user', label: 'Budgets', implies: ['account.user'] }),
  ],
  permissions: [
    orm.definePermission({
      code: 'account.budget',
      label: 'Approve and close budgets',
      groups: ['account.manager'],
    }),
  ],
  models: [Budget, BudgetLine],
  extensions: [PurchaseBudget],
});
