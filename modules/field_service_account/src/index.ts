/**
 * @packageDocumentation
 * `@kosh/field_service_account`: the bridge between Field service and Accounting (RFC 0038 step 8). Proposed
 * whenever both apps are installed. A visit done and charged gets its draft customer invoice — parts and labour.
 */
import { accounting } from '@kosh/accounting';
import { fieldService } from '@kosh/field_service';
import { defineModule } from '@kosh/modules-sdk';
import { field } from '@kosh/views';
import { fieldServiceAccountShutro } from './module.js';

export { fieldServiceAccountShutro, VisitInvoice } from './module.js';

export const fieldServiceAccount: ReturnType<typeof defineModule> = defineModule({
  shutro: fieldServiceAccountShutro,
  kosh: '^0.1.0',
  depends: [fieldService, accounting],
  bridge: [fieldService, accounting],
  // Bangla for the labels it serves (RFC 0023 §3.1; `pnpm i18n:extract`).
  i18n: { bn: () => import('./i18n/bn.js') },
  accessLevels: {
    user: { label: 'Field visits invoiced', groups: ['field_service_account.user'] },
  },
  viewExtensions: [
    {
      view: 'field.visit.form',
      operations: [{ append: 'money', nodes: [field({ field: 'invoice', id: 'visit_invoice' })] }],
    },
  ],
});
