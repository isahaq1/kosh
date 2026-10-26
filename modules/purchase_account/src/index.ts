/**
 * @packageDocumentation
 * `@kosh/purchase_account`: the bridge between Purchase and Accounting (RFC 0008 §5.1). Proposed whenever both
 * apps are installed. "Create bill" on a confirmed purchase order makes a draft vendor bill from its lines; the
 * order shows its billing state.
 */
import { accounting } from '@kosh/accounting';
import { defineModule } from '@kosh/modules-sdk';
import { purchase } from '@kosh/purchase';
import { field } from '@kosh/views';
import { purchaseAccountDemo } from './demo.js';
import { purchaseAccountShutro } from './module.js';

export { MovePurchaseOrder, PurchaseOrderBilling, purchaseAccountShutro } from './module.js';

export const purchaseAccount: ReturnType<typeof defineModule> = defineModule({
  shutro: purchaseAccountShutro,
  kosh: '^0.1.0',
  hooks: { demo: purchaseAccountDemo },
  depends: [purchase, accounting],
  bridge: [purchase, accounting],
  accessLevels: {
    user: { label: 'Bill purchase orders', groups: ['purchase_account.user'] },
  },
  viewExtensions: [
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
