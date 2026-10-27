/**
 * @packageDocumentation
 * `@kosh/account_portal`: Accounting in the portal (RFC 0015 §5.4). Proposed whenever Accounting and the portal
 * are installed. Customers see their posted invoices and credit notes, what is still due, print them and write on
 * them; vendors see the bills recorded for them. Payment is by the details on the invoice (online payment comes
 * with the integrations RFC).
 */
import { accounting } from '@kosh/accounting';
import { defineModule } from '@kosh/modules-sdk';
import { portal } from '@kosh/portal';
import { accountPortalShutro } from './module.js';

export { accountPortalShutro, MovePortal } from './module.js';

const LINES = {
  field: 'invoiceLines',
  fields: ['product', 'name', 'quantity', 'priceUnit', 'discount', 'subtotal'],
} as const;
const FIELDS = [
  'name',
  'kind',
  'date',
  'dateDue',
  'ref',
  'invoiceOrigin',
  'paymentState',
  'amountUntaxed',
  'amountTax',
  'amountTotal',
  'amountResidual',
  'paymentDetails',
  'narration',
];
const LIST = ['name', 'kind', 'date', 'dateDue', 'paymentState', 'amountTotal', 'amountResidual'];

export const accountPortal: ReturnType<typeof defineModule> = defineModule({
  shutro: accountPortalShutro,
  kosh: '^0.1.0',
  depends: [accounting, portal],
  // A posted invoice is announced to its customer by email (the portal reads the entries' changes).
  changeEvents: ['account.move'],
  accessLevels: {
    manager: { label: 'Portal access (invoices)', groups: ['portal.manager'] },
  },
  portal: {
    documents: [
      {
        key: 'invoices',
        model: 'account.move',
        label: 'Invoices',
        partner: 'partner',
        domain: { state: 'posted', kind: { in: ['out_invoice', 'out_refund'] } },
        order: ['date desc', 'id desc'],
        list: LIST,
        fields: FIELDS,
        lines: LINES,
        pdf: 'accounting.invoice',
        thread: true,
        attention: { kind: 'out_invoice', paymentState: { in: ['not_paid', 'partial'] } },
        announce: { state: 'posted' },
      },
      {
        key: 'bills',
        model: 'account.move',
        label: 'Bills',
        partner: 'partner',
        domain: { state: 'posted', kind: { in: ['in_invoice', 'in_refund'] } },
        order: ['date desc', 'id desc'],
        list: LIST,
        fields: FIELDS,
        lines: LINES,
        thread: true,
      },
    ],
  },
});
