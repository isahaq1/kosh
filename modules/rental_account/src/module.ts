/**
 * The data layer of the Rental ↔ Accounting bridge (RFC 0038 step 6): a rental order whose products are back
 * gets a draft customer invoice in the sales journal — a line per product with its rent, and one for the late
 * fee when there is one — for Accounting to post. The deposit is held and given back, not invoiced. Once per
 * order.
 */
import { accountingShutro } from '@kosh/accounting';
import { rentalShutro } from '@kosh/rental';
import { orm } from '@kosh/server/orm';
import { defineModule, type Env, extendModel, f, type Records } from './.kosh/bindings.js';

/** Fields the server maintains: written by its own code and by Administrators only. */
const SYSTEM = ['base.admin'] as const;

export const OrderInvoice = extendModel('rental.order', {
  fields: {
    invoice: f.many2one('account.move', {
      ondelete: 'set null',
      label: 'Invoice',
      groups: { write: [...SYSTEM] },
      help: 'Drafted when the products are back: the rent, and the late fee if any.',
    }),
  },
  overrides: {
    returned: async function (this: unknown, next: () => Promise<void>): Promise<void> {
      await next();
      const orders = this as Records<'rental.order'>;
      const env = orders.env as unknown as Env;
      await env.asSuperuser({ reason: 'rental invoice' }, async (su) => {
        for (const o of await su
          .model('rental.order')
          .browse(orders.ids)
          .load({ lines: { product: true }, company: { currency: true } })) {
          if (o.invoice !== null) continue;
          const lines = [...o.lines]
            .filter((l) => l.subtotal?.gt(0) === true)
            .map((l) => ({
              lineKind: 'product',
              product: l.product.id,
              name: `${l.product.name} — ${l.units} × ${l.unit ?? l.product.rentUnit}`,
              quantity: l.quantity.times(l.units ?? 0).toString(),
              priceUnit: (l.priceUnit ?? l.product.rentPrice).toString(),
              debit: '0',
              credit: '0',
            }));
          if (o.lateFee?.gt(0) === true)
            lines.push({
              lineKind: 'product',
              product: null as never,
              name: `Late return ${o.name}`,
              quantity: '1',
              priceUnit: o.lateFee.toString(),
              debit: '0',
              credit: '0',
            });
          if (lines.length === 0) continue;
          const journal = (
            await su
              .model('account.journal')
              .search({ where: { company: o.company.id, type: 'sale' }, limit: 1 })
          ).ids[0];
          if (journal === undefined)
            throw new orm.ValidationError(
              'rental.order',
              ['state'],
              'The company has no sales journal to invoice the rental in.',
              'Install a chart of accounts (Accounting › Configuration).',
            );
          const made = await su.model('account.move').create([
            {
              kind: 'out_invoice',
              journal,
              partner: o.partner.id,
              currency: o.company.currency.id,
              company: o.company.id,
              date: su.today(),
              invoiceOrigin: o.name,
              lines: { create: lines },
            },
          ] as never);
          await su
            .model('rental.order')
            .browse([o.id])
            .write({ invoice: made.ids[0] ?? null } as never);
        }
        // Written as the system, now: nothing of the invoice is left for the clerk's own rights to finish.
        await su.flush();
      });
    },
  },
});

export const rentalAccountShutro = defineModule({
  name: 'rental_account',
  version: '0.1.0',
  depends: [rentalShutro, accountingShutro],
  groups: [
    orm.defineGroup({
      code: 'rental_account.user',
      label: 'Rentals invoiced',
      implies: ['rental.user'],
    }),
  ],
  models: [],
  extensions: [OrderInvoice],
});
