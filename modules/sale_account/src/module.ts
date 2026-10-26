/**
 * The data layer of the Sales ↔ Accounting bridge (RFC 0008 §5.1, RFC 0009 §5.8): a confirmed sales order is
 * invoiced with one transition (`invoice`), which creates a draft customer invoice from the order's lines
 * (product, description, quantity, price, discount, tax) in the company's sales journal; the order shows its
 * invoicing state and its invoices, the invoice its order.
 */
import { accountingShutro } from '@kosh/accounting';
import { salesShutro } from '@kosh/sales';
import { orm } from '@kosh/server/orm';
import { compute, defineModule, extendModel, f, records } from './.kosh/bindings.js';

export const MoveSaleOrder = extendModel('account.move', {
  fields: {
    saleOrder: f.many2one('sale.order', { label: 'Sales order' }),
  },
});

export const SaleOrderInvoicing = extendModel('sale.order', {
  fields: {
    invoices: f.one2many('account.move', 'saleOrder'),
    invoiceState: f.selection(
      { no: 'Nothing to invoice', to_invoice: 'To invoice', invoiced: 'Invoiced' },
      {
        store: true,
        label: 'Invoicing',
        ...compute('sale.order', 'invoiceState', ['state', 'invoices.state'], (orders) => {
          for (const o of orders)
            o.invoiceState =
              o.state === 'sale' || o.state === 'done'
                ? o.invoices.filter((i) => i.state !== 'cancel').length > 0
                  ? 'invoiced'
                  : 'to_invoice'
                : 'no';
        }),
      },
    ),
  },
  fieldOverrides: {
    state: {
      transitionsAdd: {
        invoice: {
          from: ['sale'],
          to: 'sale',
          guard: records('sale.order', async (orders) => {
            const loaded = await orders.load({ invoices: true });
            return loaded.filter((o) => o.invoices.filter((i) => i.state !== 'cancel').length > 0);
          }),
          message: 'This order is invoiced already.',
          after: records('sale.order', async (orders) => {
            const env = orders.env;
            const loaded = await orders.load({
              lines: { product: true, tax: true },
              partner: true,
              currency: true,
              company: true,
            });
            for (const o of loaded) {
              const journal = await env.model('account.journal').search({
                where: { company: o.company.id, type: 'sale' },
                limit: 1,
              });
              const journalId = journal.ids[0];
              if (journalId === undefined)
                throw new orm.ValidationError(
                  'sale.order',
                  ['state'],
                  'The company has no sales journal.',
                  'Install a chart of accounts (Accounting › Configuration).',
                );
              await env.model('account.move').create([
                {
                  kind: 'out_invoice',
                  journal: journalId,
                  partner: o.partner.id,
                  currency: o.currency.id,
                  company: o.company.id,
                  date: env.today(),
                  invoiceOrigin: o.name,
                  saleOrder: o.id,
                  lines: {
                    create: o.lines.map((l) => ({
                      lineKind: 'product' as const,
                      product: l.product.id,
                      name: l.name,
                      quantity: l.quantity,
                      priceUnit: l.priceUnit,
                      discount: l.discount,
                      tax: l.tax?.id ?? null,
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

export const saleAccountShutro = defineModule({
  name: 'sale_account',
  version: '0.1.0',
  depends: [salesShutro, accountingShutro],
  groups: [
    orm.defineGroup({
      code: 'sale_account.user',
      label: 'Invoicing from sales orders',
      implies: ['sales.user', 'account.invoicing'],
    }),
  ],
  models: [],
  extensions: [MoveSaleOrder, SaleOrderInvoicing],
});
