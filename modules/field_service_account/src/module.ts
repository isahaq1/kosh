/**
 * The data layer of the Field service ↔ Accounting bridge (RFC 0038 step 8): a visit done and charged gets a draft
 * customer invoice in the sales journal — its parts as their products and its labour — for Accounting to post.
 * Once per visit; nothing for a visit that is not charged.
 */
import { accountingShutro } from '@kosh/accounting';
import { fieldServiceShutro } from '@kosh/field_service';
import { orm } from '@kosh/server/orm';
import { defineModule, type Env, extendModel, f, type Records } from './.kosh/bindings.js';

/** Fields the server maintains: written by its own code and by Administrators only. */
const SYSTEM = ['base.admin'] as const;

export const VisitInvoice = extendModel('field.visit', {
  fields: {
    invoice: f.many2one('account.move', {
      ondelete: 'set null',
      label: 'Invoice',
      groups: { write: [...SYSTEM] },
      help: 'Drafted when a charged visit is done.',
    }),
  },
  overrides: {
    completed: async function (this: unknown, next: () => Promise<void>): Promise<void> {
      await next();
      const visits = this as Records<'field.visit'>;
      const env = visits.env as unknown as Env;
      await env.asSuperuser({ reason: 'field visit invoice' }, async (su) => {
        for (const v of await su
          .model('field.visit')
          .browse(visits.ids)
          .load({ lines: true, company: { currency: true } })) {
          if (v.invoice !== null || v.billable !== true) continue;
          const lines = [...v.lines].filter((l) => l.subtotal?.gt(0) === true);
          if (lines.length === 0) continue;
          const journal = (
            await su
              .model('account.journal')
              .search({ where: { company: v.company.id, type: 'sale' }, limit: 1 })
          ).ids[0];
          if (journal === undefined)
            throw new orm.ValidationError(
              'field.visit',
              ['state'],
              'The company has no sales journal to invoice the visit in.',
              'Install a chart of accounts (Accounting › Configuration).',
            );
          const made = await su.model('account.move').create([
            {
              kind: 'out_invoice',
              journal,
              partner: v.partner.id,
              currency: v.company.currency.id,
              company: v.company.id,
              date: su.today(),
              invoiceOrigin: v.name,
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
            .model('field.visit')
            .browse([v.id])
            .write({ invoice: made.ids[0] ?? null } as never);
        }
        // Written as the system, now: nothing of the invoice is left for the technician's own rights to finish.
        await su.flush();
      });
    },
  },
});

export const fieldServiceAccountShutro = defineModule({
  name: 'field_service_account',
  version: '0.1.0',
  depends: [fieldServiceShutro, accountingShutro],
  groups: [
    orm.defineGroup({
      code: 'field_service_account.user',
      label: 'Field visits invoiced',
      implies: ['field_service.user'],
    }),
  ],
  models: [],
  extensions: [VisitInvoice],
});
