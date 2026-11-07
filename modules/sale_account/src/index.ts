/**
 * @packageDocumentation
 * `@kosh/sale_account`: the bridge between Sales and Accounting (RFC 0008 §5.1). Proposed whenever both apps are
 * installed. "Create invoice" on a confirmed sales order makes a draft customer invoice from its lines; the order
 * shows its invoicing state. Credit control (RFC 0028 §3.2): customers' limits, the company's mode, the credit
 * approval of an order over its customer's limit; payment terms and the invoice address.
 */
import { accounting } from '@kosh/accounting';
import { defineModule } from '@kosh/modules-sdk';
import { permissions } from '@kosh/permissions';
import { sales } from '@kosh/sales';
import { field, stat } from '@kosh/views';
import { saleAccountDemo } from './demo.js';
import { saleAccountShutro } from './module.js';

export {
  CompanyCredit,
  creditOf,
  MoveSaleOrder,
  PartnerCredit,
  SaleOrderInvoicing,
  saleAccountShutro,
} from './module.js';

export const saleAccount: ReturnType<typeof defineModule> = defineModule({
  shutro: saleAccountShutro,
  kosh: '^0.1.0',
  hooks: { demo: saleAccountDemo },
  depends: [sales, accounting, permissions],
  bridge: [sales, accounting],
  // An order over its customer's limit, in approval mode: Accounting managers decide (RFC 0028 §3.2).
  approvals: [
    {
      name: 'Credit approvals',
      model: 'sale.order',
      onApproved: 'creditApprove',
      onRejected: 'creditReject',
      onSentBack: 'creditReject',
      levels: [
        { name: 'Credit', condition: { creditHeld: true }, approverRole: 'account.manager' },
      ],
    },
  ],
  settings: {
    sections: [
      {
        key: 'credit',
        label: 'Credit control',
        description:
          'What happens when confirming an order takes a customer over their credit limit, and the limit of customers without one.',
        keywords: 'credit limit exposure overdue block approval',
        scope: 'company',
        editors: ['account.manager'],
        fields: [
          {
            key: 'creditControl',
            help: 'Warn shows it on the order; Refuse stops the confirmation; Approval sends the order to Accounting managers.',
          },
          {
            key: 'creditLimitDefault',
            help: 'Empty: customers without a limit of their own have none.',
          },
        ],
      },
    ],
  },
  // Bangla for the labels it serves (RFC 0023 §3.1; `pnpm i18n:extract`).
  i18n: { bn: () => import('./i18n/bn.js') },
  accessLevels: {
    user: { label: 'Invoice sales orders', groups: ['sale_account.user'] },
  },
  viewExtensions: [
    // A customer's credit limit and payment terms on the contact (RFC 0028 §3.2).
    {
      view: 'res.partner.form',
      operations: [
        {
          append: 'roles',
          nodes: [
            field({ field: 'creditLimit', id: 'partner_credit_limit' }),
            field({ field: 'customerPaymentTerm', id: 'partner_payment_term' }),
          ],
        },
      ],
    },
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
            {
              kind: 'button',
              id: 'invoice_down_payment',
              transition: 'invoiceDownPayment',
              label: 'Invoice a down payment',
              visibleWhen: { state: 'sale' },
            },
            {
              kind: 'button',
              id: 'ask_credit',
              transition: 'askCredit',
              label: 'Ask for credit approval',
              visibleWhen: { state: { in: ['draft', 'sent'] } },
            },
          ],
        },
        {
          append: 'dates',
          nodes: [
            field({ field: 'invoiceState', id: 'invoice_state' }),
            field({ field: 'paymentTerm', id: 'payment_term' }),
            field({
              field: 'downPaymentPercent',
              id: 'down_payment_percent',
              visibleWhen: { state: 'sale' },
            }),
            field({
              field: 'downPaymentAmount',
              id: 'down_payment_amount',
              visibleWhen: { state: 'sale' },
            }),
            field({ field: 'creditNote', id: 'credit_note', readonlyWhen: {} }),
          ],
        },
        {
          append: 'related',
          nodes: [
            stat({
              id: 'order_invoices',
              label: 'Invoices',
              model: 'account.move',
              where: { saleOrder: { $record: 'id' } },
              action: 'accounting.action_customer_invoices',
            }),
            stat({
              id: 'order_down_payments',
              label: 'Down payments',
              model: 'account.move.line',
              where: { downPaymentOf: { $record: 'id' }, 'move.state': { ne: 'cancel' } },
              measure: { sum: 'subtotal' },
              action: 'accounting.action_customer_invoices',
            }),
            stat({
              id: 'order_invoiced',
              label: 'Invoiced total',
              model: 'account.move',
              where: { saleOrder: { $record: 'id' }, state: 'posted' },
              measure: { sum: 'amountTotal' },
              action: 'accounting.action_customer_invoices',
              tone: 'success',
            }),
          ],
        },
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
