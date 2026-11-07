/**
 * @packageDocumentation
 * `@kosh/purchase_account`: the bridge between Purchase and Accounting (RFC 0008 §5.1). Proposed whenever both
 * apps are installed. "Create bill" on a confirmed purchase order makes a draft vendor bill from its lines; the
 * order shows its billing state.
 */
import { accounting } from '@kosh/accounting';
import { defineModule } from '@kosh/modules-sdk';
import { purchase } from '@kosh/purchase';
import { field, stat } from '@kosh/views';
import { purchaseAccountDemo } from './demo.js';
import { purchaseAccountShutro } from './module.js';

export { MovePurchaseOrder, PurchaseOrderBilling, purchaseAccountShutro } from './module.js';

export const purchaseAccount: ReturnType<typeof defineModule> = defineModule({
  shutro: purchaseAccountShutro,
  kosh: '^0.1.0',
  hooks: { demo: purchaseAccountDemo },
  depends: [purchase, accounting],
  bridge: [purchase, accounting],
  // Bangla for the labels it serves (RFC 0023 §3.1; `pnpm i18n:extract`).
  i18n: { bn: () => import('./i18n/bn.js') },
  accessLevels: {
    user: { label: 'Bill purchase orders', groups: ['purchase_account.user'] },
  },
  viewExtensions: [
    // The three-way check on each bill line (RFC 0028 §3.3): ordered, received and billed on its order line.
    {
      view: 'account.move.invoice.form',
      operations: [
        {
          insertAfter: 'quantity',
          nodes: [{ kind: 'field', id: 'line_match', field: 'matchNote', readonlyWhen: {} }],
        },
      ],
    },
    {
      view: 'purchase.order.form',
      operations: [
        {
          append: 'related',
          nodes: [
            stat({
              id: 'order_bills',
              label: 'Bills',
              model: 'account.move',
              where: { purchaseOrder: { $record: 'id' } },
              action: 'accounting.action_vendor_bills',
            }),
            stat({
              id: 'order_billed',
              label: 'Billed total',
              model: 'account.move',
              where: { purchaseOrder: { $record: 'id' }, state: 'posted' },
              measure: { sum: 'amountTotal' },
              action: 'accounting.action_vendor_bills',
            }),
          ],
        },
      ],
    },
    {
      view: 'purchase.order.form',
      operations: [
        {
          insertAfter: 'confirm',
          nodes: [
            {
              kind: 'button',
              id: 'bill',
              transition: 'bill',
              label: 'Create bill',
              visibleWhen: { state: 'purchase' },
            },
          ],
        },
        { append: 'dates', nodes: [field({ field: 'billState', id: 'bill_state' })] },
        { insertAfter: 'taxes', nodes: [field({ field: 'analytic', id: 'line_analytic' })] },
      ],
    },
    {
      view: 'purchase.order.list',
      operations: [
        {
          insertAfter: 'state',
          nodes: [{ kind: 'field', id: 'bill_state', field: 'billState', widget: 'badge' }],
        },
      ],
    },
  ],
});
