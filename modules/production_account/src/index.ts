/**
 * @packageDocumentation
 * `@kosh/production_account`: the bridge between Production and Accounting (RFC 0021, Production step 2). Proposed whenever
 * both apps are installed. Products made are valued at what they consumed plus their operations; the operations are
 * posted into Work in progress, which clears with each order.
 */
import { accounting } from '@kosh/accounting';
import { defineModule } from '@kosh/modules-sdk';
import { production } from '@kosh/production';
import { stock } from '@kosh/stock';
import { stockAccount } from '@kosh/stock_account';
import { action, field, form, list, search } from '@kosh/views';
import { productionAccountShutro } from './module.js';
import { ProductionCosting, ProductionOverheadAllocation } from './overhead.js';

export { LABOUR_ACCOUNT, OperationsPosted, OutputCost, productionAccountShutro } from './module.js';
export {
  applyOverheads,
  monthOf,
  OrderOverhead,
  ProductionCosting,
  ProductionCostingLine,
  ProductionOrderOverhead,
  ProductionOverheadAllocation,
  ProductionOverheadAllocationLine,
  ProductionOverheadAllocationShare,
  postAllocation,
  reckonAllocation,
} from './overhead.js';

export const productionAccount: ReturnType<typeof defineModule> = defineModule({
  shutro: productionAccountShutro,
  kosh: '^0.1.0',
  depends: [production, stock, stockAccount, accounting],
  bridge: [production, accounting],
  // Exceptions to the module standard (RFC 0023), each with its reason.
  standard: {
    waive: [
      { rule: 'I1', model: 'production.order.overhead', reason: 'Written when an order produces.' },
      {
        rule: 'I1',
        model: 'production.overhead.allocation.line',
        reason: 'Worked out by the allocation.',
      },
      {
        rule: 'I1',
        model: 'production.overhead.allocation.share',
        reason: 'Worked out by the allocation.',
      },
    ],
  },
  events: [
    {
      topic: 'production.overhead.allocation.posted',
      model: 'production.overhead.allocation',
      label: 'Overhead allocation posted',
    },
  ],
  documents: [
    {
      key: 'production_overhead_allocation',
      name: 'Overhead allocation',
      model: 'production.overhead.allocation',
      layout: {
        paper: 'A4',
        header: '{{company.name}}',
        footer: 'Page {{page}} of {{pages}}',
        blocks: [
          { kind: 'heading', id: 'title', text: 'Overhead allocation {{name}}', level: 1 },
          {
            kind: 'fields',
            id: 'about',
            items: [
              { label: 'Month', bind: 'month' },
              { label: 'Distribution', bind: 'distribution' },
              { label: 'Under-absorbed', bind: 'difference' },
              { label: 'Status', bind: 'state' },
            ],
          },
          {
            kind: 'table',
            id: 'lines',
            bind: 'lines',
            columns: [
              { label: 'Account', bind: 'account.displayName' },
              { label: 'Actual', bind: 'actual' },
              { label: 'Absorbed', bind: 'absorbed' },
              { label: 'Difference', bind: 'difference' },
            ],
          },
          {
            kind: 'table',
            id: 'shares',
            bind: 'shares',
            columns: [
              { label: 'Production order', bind: 'order.name' },
              { label: 'Product', bind: 'product.name' },
              { label: 'Produced', bind: 'quantity' },
              { label: 'Share %', bind: 'share' },
              { label: 'Amount', bind: 'amount' },
            ],
          },
          { kind: 'text', id: 'note', text: '{{note}}' },
        ],
      },
    },
  ],
  importTemplates: [
    {
      key: 'production_costings',
      model: 'production.costing',
      label: 'Costing masters',
      columns: [
        { header: 'Name', field: 'name' },
        { header: 'Product', field: 'product' },
        { header: 'Category', field: 'category' },
        { header: 'Valid from', field: 'validFrom' },
        { header: 'Valid to', field: 'validTo' },
        { header: 'Overheads › Overhead', field: 'lines.name' },
        { header: 'Overheads › Account', field: 'lines.account' },
        { header: 'Overheads › Method', field: 'lines.method' },
        { header: 'Overheads › Rate', field: 'lines.amount' },
      ],
    },
    {
      key: 'production_overhead_allocations',
      model: 'production.overhead.allocation',
      label: 'Overhead allocations',
      columns: [
        { header: 'Month', field: 'month' },
        { header: 'Distribution', field: 'distribution' },
        { header: 'Note', field: 'note' },
      ],
    },
  ],
  actions: {
    'production_account.action_costings': action(ProductionCosting, {
      label: 'Costing masters',
      views: ['list', 'form'],
    }),
    'production_account.action_allocations': action(ProductionOverheadAllocation, {
      label: 'Overhead allocations',
      views: ['list', 'form'],
    }),
  },
  menus: [
    {
      id: 'production_account.costings',
      parent: 'production.root',
      label: 'Costing masters',
      action: 'production_account.action_costings',
      sequence: 8,
    },
    {
      id: 'production_account.allocations',
      parent: 'production.root',
      label: 'Overhead allocations',
      action: 'production_account.action_allocations',
      sequence: 9,
    },
  ],
  views: {
    'production.costing.list': list(ProductionCosting, {
      columns: ['name', 'product', 'category', 'validFrom', 'validTo', 'active'],
    }),
    'production.costing.form': form(ProductionCosting, (k) => ({
      sheet: [
        k.group('main', ['name', 'product', 'category', 'validFrom', 'validTo', 'active']),
        k.lines('lines', [
          { field: 'sequence', id: 'costing_sequence' },
          { field: 'name', id: 'costing_name' },
          { field: 'account', id: 'costing_account' },
          { field: 'method', id: 'costing_method' },
          { field: 'amount', id: 'costing_amount' },
        ]),
        k.group('about', ['note'], { columns: 1 }),
      ],
      chatter: true,
    })),
    'production.overhead.allocation.list': list(ProductionOverheadAllocation, {
      columns: ['name', 'month', 'distribution', 'difference', 'state'],
    }),
    'production.overhead.allocation.form': form(ProductionOverheadAllocation, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('reckon', { primary: true, label: 'Work out the month' }),
          k.button('post', {
            primary: true,
            label: 'Post',
            confirm: 'Post? The difference goes onto the month’s orders and the month is closed.',
          }),
          k.button('cancel', { label: 'Cancel' }),
          k.button('redraft', { label: 'Set to draft' }),
        ],
      },
      sheet: [
        k.group('main', ['name', 'month', 'distribution', 'difference', 'move']),
        k.lines(
          'lines',
          [
            { field: 'account', id: 'allocation_account' },
            { field: 'actual', id: 'allocation_actual' },
            { field: 'absorbed', id: 'allocation_absorbed' },
            { field: 'difference', id: 'allocation_difference' },
          ],
          { readonlyWhen: {} },
        ),
        k.lines(
          'shares',
          [
            { field: 'order', id: 'share_order' },
            { field: 'product', id: 'share_product' },
            { field: 'quantity', id: 'share_quantity' },
            { field: 'share', id: 'share_share' },
            { field: 'amount', id: 'share_amount' },
          ],
          { readonlyWhen: {} },
        ),
        k.group('about', ['note'], { columns: 1 }),
      ],
      chatter: true,
    })),
  },
  search: {
    'production.costing': search(ProductionCosting, {
      fields: ['name', 'product.name', 'category.name'],
      filters: { active: { label: 'Active', domain: { active: true }, group: 'state' } },
      groupBy: ['category', 'product'],
    }),
    'production.overhead.allocation': search(ProductionOverheadAllocation, {
      fields: ['name'],
      filters: {
        draft: { label: 'Draft', domain: { state: 'draft' }, group: 'state' },
        posted: { label: 'Posted', domain: { state: 'posted' }, group: 'state' },
      },
      groupBy: ['state', 'month:month'],
    }),
  },
  viewExtensions: [
    {
      view: 'production.order.form',
      operations: [
        {
          append: 'cost',
          nodes: [
            field({ field: 'overheadCost', id: 'order_overhead_cost' }),
            field({ field: 'fullCost', id: 'order_full_cost' }),
          ],
        },
      ],
    },
    {
      view: 'production.workcenter.form',
      operations: [
        {
          append: 'main',
          nodes: [field({ field: 'expenseAccount', id: 'workcenter_expense_account' })],
        },
      ],
    },
  ],
  // Bangla for the labels it serves (RFC 0023 §3.1; `pnpm i18n:extract`).
  i18n: { bn: () => import('./i18n/bn.js') },
  accessLevels: {
    user: { label: 'Production valued', groups: ['production_account.user'] },
  },
});
