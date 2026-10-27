/**
 * The data layer of the Purchase ↔ Accounting bridge (RFC 0008 §5.1, RFC 0009 §5.8): a confirmed purchase order
 * gets its vendor bill with one transition (`bill`), a draft bill from the order's lines in the company's purchase
 * journal (bills above the policy's threshold then wait for approval, as any bill); the order shows its billing
 * state and its bills, the bill its order.
 */
import { accountingShutro } from '@kosh/accounting';
import { purchaseShutro } from '@kosh/purchase';
import { orm } from '@kosh/server/orm';
import { compute, defineModule, extendModel, f, records } from './.kosh/bindings.js';

export const MovePurchaseOrder = extendModel('account.move', {
  fields: {
    purchaseOrder: f.many2one('purchase.order', { label: 'Purchase order' }),
  },
});

export const PurchaseOrderBilling = extendModel('purchase.order', {
  fields: {
    bills: f.one2many('account.move', 'purchaseOrder'),
    billState: f.selection(
      { no: 'Nothing to bill', to_bill: 'To bill', billed: 'Billed' },
      {
        store: true,
        label: 'Billing',
        ...compute('purchase.order', 'billState', ['state', 'bills.state'], (orders) => {
          for (const o of orders)
            o.billState =
              o.state === 'purchase' || o.state === 'done'
                ? o.bills.filter((b) => b.state !== 'cancel').length > 0
                  ? 'billed'
                  : 'to_bill'
                : 'no';
        }),
      },
    ),
  },
  fieldOverrides: {
    state: {
      transitionsAdd: {
        bill: {
          from: ['purchase'],
          to: 'purchase',
          guard: records('purchase.order', async (orders) => {
            const loaded = await orders.load({ bills: true });
            return loaded.filter((o) => o.bills.filter((b) => b.state !== 'cancel').length > 0);
          }),
          message: 'This order is billed already.',
          after: records('purchase.order', async (orders) => {
            const env = orders.env;
            const loaded = await orders.load({
              lines: { product: true, taxes: true },
              partner: true,
              currency: true,
              company: true,
            });
            for (const o of loaded) {
              const journal = await env.model('account.journal').search({
                where: { company: o.company.id, type: 'purchase' },
                limit: 1,
              });
              const journalId = journal.ids[0];
              if (journalId === undefined)
                throw new orm.ValidationError(
                  'purchase.order',
                  ['state'],
                  'The company has no purchases journal.',
                  'Install a chart of accounts (Accounting › Configuration).',
                );
              await env.model('account.move').create([
                {
                  kind: 'in_invoice',
                  journal: journalId,
                  partner: o.partner.id,
                  currency: o.currency.id,
                  company: o.company.id,
                  date: env.today(),
                  invoiceOrigin: o.name,
                  ref: o.partnerReference,
                  purchaseOrder: o.id,
                  lines: {
                    create: o.lines.map((l) => ({
                      lineKind: 'product' as const,
                      product: l.product.id,
                      name: l.name,
                      quantity: l.quantity,
                      priceUnit: l.priceUnit,
                      taxes: { set: [...l.taxes].map((t) => t.id) },
                      debit: '0',
                      credit: '0',
                    })),
                  },
                },
              ]);
            }
          }),
        },
      },
    },
  },
});

export const purchaseAccountShutro = defineModule({
  name: 'purchase_account',
  version: '0.1.0',
  depends: [purchaseShutro, accountingShutro],
  groups: [
    orm.defineGroup({
      code: 'purchase_account.user',
      label: 'Billing from purchase orders',
      implies: ['purchase.user', 'account.invoicing'],
    }),
  ],
  models: [],
  extensions: [MovePurchaseOrder, PurchaseOrderBilling],
});
