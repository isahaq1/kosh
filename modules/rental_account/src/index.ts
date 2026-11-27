/**
 * @packageDocumentation
 * `@kosh/rental_account`: the bridge between Rental and Accounting (RFC 0038 step 6). Proposed whenever both apps
 * are installed. A rental whose products are back gets its draft customer invoice — the rent, and the late fee.
 */
import { accounting } from '@kosh/accounting';
import { defineModule } from '@kosh/modules-sdk';
import { rental } from '@kosh/rental';
import { field } from '@kosh/views';
import { rentalAccountShutro } from './module.js';

export { OrderInvoice, rentalAccountShutro } from './module.js';

export const rentalAccount: ReturnType<typeof defineModule> = defineModule({
  shutro: rentalAccountShutro,
  kosh: '^0.1.0',
  depends: [rental, accounting],
  bridge: [rental, accounting],
  // Bangla for the labels it serves (RFC 0023 §3.1; `pnpm i18n:extract`).
  i18n: { bn: () => import('./i18n/bn.js') },
  accessLevels: {
    user: { label: 'Rentals invoiced', groups: ['rental_account.user'] },
  },
  viewExtensions: [
    {
      view: 'rental.order.form',
      operations: [{ append: 'totals', nodes: [field({ field: 'invoice', id: 'order_invoice' })] }],
    },
  ],
});
