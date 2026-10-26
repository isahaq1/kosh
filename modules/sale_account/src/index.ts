/**
 * @packageDocumentation
 * `@kosh/sale_account`: the bridge between Sales and Accounting (RFC 0008 §5.1). Proposed whenever both apps are
 * installed. "Create invoice" on a confirmed sales order makes a draft customer invoice from its lines; the order
 * shows its invoicing state.
 */
import { accounting } from '@kosh/accounting';
import { defineModule } from '@kosh/modules-sdk';
import { sales } from '@kosh/sales';
import { field } from '@kosh/views';
import { saleAccountDemo } from './demo.js';
import { saleAccountShutro } from './module.js';

export { MoveSaleOrder, SaleOrderInvoicing, saleAccountShutro } from './module.js';

export const saleAccount: ReturnType<typeof defineModule> = defineModule({
  shutro: saleAccountShutro,
  kosh: '^0.1.0',
  hooks: { demo: saleAccountDemo },
  depends: [sales, accounting],
  bridge: [sales, accounting],
  accessLevels: {
    user: { label: 'Invoice sales orders', groups: ['sale_account.user'] },
  },
  viewExtensions: [
    {
      view: 'sale.order.form',
      operations: [
        {
          insertAfter: 'confirm',
          nodes: [
            {
              kind: 'button',
              id: 'invoice',
              transition: 'invoice',
              label: 'Create invoice',
              visibleWhen: { state: 'sale' },
            },
          ],
        },
        { append: 'dates', nodes: [field({ field: 'invoiceState', id: 'invoice_state' })] },
      ],
    },
    {
      view: 'sale.order.list',
      operations: [
        {
          insertAfter: 'state',
          nodes: [{ kind: 'field', id: 'invoice_state', field: 'invoiceState', widget: 'badge' }],
        },
      ],
    },
  ],
});
