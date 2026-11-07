/**
 * @packageDocumentation
 * `@kosh/sale_portal`: Sales in the customer portal (RFC 0015 §5.4). Proposed whenever Sales and the portal are
 * installed. Customers see their sent quotations and their orders, print them, accept a quotation with their
 * signature (the order is confirmed) or decline it with a reason, and write on its thread.
 */
import { defineModule } from '@kosh/modules-sdk';
import { portal } from '@kosh/portal';
import { sales } from '@kosh/sales';
import { salePortalShutro } from './module.js';

export { OrderPortal, salePortalShutro } from './module.js';

export const salePortal: ReturnType<typeof defineModule> = defineModule({
  shutro: salePortalShutro,
  kosh: '^0.1.0',
  depends: [sales, portal],
  // A sent quotation is announced to its customer by email (the portal reads the order's changes).
  changeEvents: ['sale.order'],
  // Bangla for the labels it serves (RFC 0023 §3.1; `pnpm i18n:extract`).
  i18n: { bn: () => import('./i18n/bn.js') },
  accessLevels: {
    manager: { label: 'Portal access (sales documents)', groups: ['portal.manager'] },
  },
  portal: {
    documents: [
      {
        key: 'quotations',
        model: 'sale.order',
        label: 'Quotations and orders',
        partner: 'partner',
        // Drafts and cancelled quotations stay internal.
        domain: { state: { in: ['sent', 'sale', 'done'] } },
        order: ['dateOrder desc', 'id desc'],
        list: ['name', 'dateOrder', 'validityDate', 'state', 'amountTotal'],
        fields: [
          'name',
          'state',
          'dateOrder',
          'validityDate',
          'clientReference',
          'user',
          'amountUntaxed',
          'amountTax',
          'amountTotal',
          'note',
        ],
        lines: {
          field: 'lines',
          fields: ['product', 'name', 'quantity', 'priceUnit', 'discount', 'subtotal'],
        },
        // Optional products the customer adds before signing (RFC 0028 §3.5).
        options: {
          field: 'options',
          fields: ['product', 'name', 'quantity', 'priceUnit'],
          offered: { state: 'offered' },
          when: { state: 'sent' },
          add: 'add',
        },
        pdf: 'sales.quotation',
        actions: [
          {
            key: 'accept',
            label: 'Accept and sign',
            transition: 'confirm',
            when: { state: 'sent' },
            signature: true,
          },
          {
            key: 'decline',
            label: 'Decline',
            transition: 'cancel',
            when: { state: 'sent' },
            message: true,
          },
        ],
        thread: true,
        attention: { state: 'sent' },
        announce: { state: 'sent' },
      },
    ],
  },
});
