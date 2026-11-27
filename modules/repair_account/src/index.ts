/**
 * @packageDocumentation
 * `@kosh/repair_account`: the bridge between Repairs and Accounting (RFC 0038 step 4). Proposed whenever both
 * apps are installed. An item handed back repaired gets its draft customer invoice — parts and labour —, unless
 * it was under warranty.
 */
import { accounting } from '@kosh/accounting';
import { defineModule } from '@kosh/modules-sdk';
import { repair } from '@kosh/repair';
import { field } from '@kosh/views';
import { repairAccountShutro } from './module.js';

export { OrderInvoice, repairAccountShutro } from './module.js';

export const repairAccount: ReturnType<typeof defineModule> = defineModule({
  shutro: repairAccountShutro,
  kosh: '^0.1.0',
  depends: [repair, accounting],
  bridge: [repair, accounting],
  // Bangla for the labels it serves (RFC 0023 §3.1; `pnpm i18n:extract`).
  i18n: { bn: () => import('./i18n/bn.js') },
  accessLevels: {
    user: { label: 'Repairs invoiced', groups: ['repair_account.user'] },
  },
  viewExtensions: [
    {
      view: 'repair.order.form',
      operations: [{ append: 'totals', nodes: [field({ field: 'invoice', id: 'order_invoice' })] }],
    },
  ],
});
