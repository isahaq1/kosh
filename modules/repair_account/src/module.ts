/**
 * The data layer of the Repairs ↔ Accounting bridge (RFC 0038 step 4): an item handed back **repaired** gets a
 * draft customer invoice in the sales journal — a line per part and per labour line, the parts as their products
 * so that their accounts and taxes are theirs — for Accounting to post. Under warranty, and for a repair the
 * customer declined, nothing is invoiced. Once per order.
 */
import { accountingShutro } from '@kosh/accounting';
import { repairShutro } from '@kosh/repair';
import { orm } from '@kosh/server/orm';
import { defineModule, type Env, extendModel, f, type Records } from './.kosh/bindings.js';

/** Fields the server maintains: written by its own code and by Administrators only. */
const SYSTEM = ['base.admin'] as const;

export const OrderInvoice = extendModel('repair.order', {
  fields: {
    invoice: f.many2one('account.move', {
      ondelete: 'set null',
      label: 'Invoice',
      groups: { write: [...SYSTEM] },
      help: 'Drafted when the repaired item is handed back; nothing under warranty.',
    }),
  },
  overrides: {
    returned: async function (this: unknown, next: () => Promise<void>): Promise<void> {
      await next();
      const orders = this as Records<'repair.order'>;
      const env = orders.env as unknown as Env;
      await env.asSuperuser({ reason: 'repair invoice' }, async (su) => {
        for (const o of await su
          .model('repair.order')
          .browse(orders.ids)
          .load({ lines: true, company: { currency: true } })) {
          // Repaired (not handed back as it came), charged, and not invoiced yet.
          if (o.invoice !== null || o.repairedAt === null || o.warranty === true) continue;
          const lines = [...o.lines].filter((l) => l.subtotal?.gt(0) === true);
          if (lines.length === 0) continue;
          const journal = (
            await su
              .model('account.journal')
              .search({ where: { company: o.company.id, type: 'sale' }, limit: 1 })
          ).ids[0];
          if (journal === undefined)
            throw new orm.ValidationError(
              'repair.order',
              ['state'],
              'The company has no sales journal to invoice the repair in.',
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
              ref: o.itemName,
              lines: {
                create: lines.map((l) => ({
                  lineKind: 'product',
                  product: l.product?.id ?? null,
                  name: l.name,
                  quantity: l.quantity.toString(),
                  priceUnit: l.priceUnit.toString(),
                  debit: '0',
                  credit: '0',
                })),
              },
            },
          ] as never);
          await su
            .model('repair.order')
            .browse([o.id])
            .write({ invoice: made.ids[0] ?? null } as never);
        }
        // Written as the system, now: nothing of the invoice is left for the technician's own rights to finish.
        await su.flush();
      });
    },
  },
});

export const repairAccountShutro = defineModule({
  name: 'repair_account',
  version: '0.1.0',
  depends: [repairShutro, accountingShutro],
  groups: [
    orm.defineGroup({
      code: 'repair_account.user',
      label: 'Repairs invoiced',
      implies: ['repair.user'],
    }),
  ],
  models: [],
  extensions: [OrderInvoice],
});
