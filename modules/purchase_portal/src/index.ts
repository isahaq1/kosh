/**
 * @packageDocumentation
 * `@kosh/purchase_portal`: Purchase in the vendor portal (RFC 0015 §5.4). Proposed whenever Purchase and the portal
 * are installed. Vendors see the requests for quotation sent to them and their purchase orders, with the lines, and
 * write on them; a sent request is announced to them by email.
 */
import { defineModule } from '@kosh/modules-sdk';
import { portal } from '@kosh/portal';
import { purchase } from '@kosh/purchase';
import { purchasePortalShutro } from './module.js';

export { PurchaseOrderPortal, purchasePortalShutro } from './module.js';

export const purchasePortal: ReturnType<typeof defineModule> = defineModule({
  shutro: purchasePortalShutro,
  kosh: '^0.1.0',
  depends: [purchase, portal],
  changeEvents: ['purchase.order'],
  accessLevels: {
    manager: { label: 'Portal access (purchase documents)', groups: ['portal.manager'] },
  },
  portal: {
    documents: [
      {
        key: 'purchases',
        model: 'purchase.order',
        label: 'Requests and purchase orders',
        partner: 'partner',
        // Drafts, orders waiting for approval and cancelled ones stay internal.
        domain: { state: { in: ['sent', 'purchase', 'done'] } },
        order: ['dateOrder desc', 'id desc'],
        list: ['name', 'dateOrder', 'datePlanned', 'state', 'amountTotal'],
        fields: [
          'name',
          'state',
          'dateOrder',
          'datePlanned',
          'partnerReference',
          'user',
          'amountUntaxed',
          'amountTax',
          'amountTotal',
          'note',
        ],
        lines: {
          field: 'lines',
          fields: ['product', 'name', 'quantity', 'priceUnit', 'datePlanned', 'subtotal'],
        },
        thread: true,
        attention: { state: 'sent' },
        announce: { state: { in: ['sent', 'purchase'] } },
      },
    ],
  },
});
