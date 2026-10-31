/**
 * The data layer of the Event Hub ↔ Accounting bridge (RFC 0021, Event Hub step 3): a place confirmed at a price gets
 * a draft customer invoice in the sales journal — the attendee as the customer (their contact, else the contact with
 * their email, else a new one) and a line for the event and the ticket — for Accounting to post.
 */
import { accountingShutro } from '@kosh/accounting';
import { eventShutro } from '@kosh/event';
import { orm } from '@kosh/server/orm';
import { defineModule, type Env, extendModel, f, type Records } from './.kosh/bindings.js';

export const RegistrationInvoice = extendModel('event.registration', {
  fields: {
    invoice: f.many2one('account.move', { ondelete: 'set null', label: 'Invoice' }),
  },
  overrides: {
    confirmed: async function (this: unknown, next: () => Promise<void>): Promise<void> {
      await next();
      const registrations = this as Records<'event.registration'>;
      const env = registrations.env as unknown as Env;
      await env.asSuperuser({ reason: 'event invoice' }, async (su) => {
        for (const r of await su
          .model('event.registration')
          .browse(registrations.ids)
          .load({ event: { currency: true }, ticket: true, company: { currency: true } })) {
          if (r.invoice !== null || r.price === null || r.price.lte(0)) continue;
          const journal = (
            await su
              .model('account.journal')
              .search({ where: { company: r.company.id, type: 'sale' }, limit: 1 })
          ).ids[0];
          if (journal === undefined)
            throw new orm.ValidationError(
              'event.registration',
              ['state'],
              'The company has no sales journal to invoice the place in.',
              'Install a chart of accounts (Accounting › Configuration).',
            );
          let partner = r.partner?.id ?? null;
          if (partner === null && r.email !== null && r.email !== '')
            partner =
              (await su.model('res.partner').search({ where: { email: r.email }, limit: 1 }))
                .ids[0] ?? null;
          if (partner === null)
            partner =
              (
                await su
                  .model('res.partner')
                  .create([
                    { name: r.name, email: r.email, isCustomer: true, company: r.company.id },
                  ])
              ).ids[0] ?? null;
          if (partner === null) continue;
          const made = await su.model('account.move').create([
            {
              kind: 'out_invoice',
              journal,
              partner,
              currency: r.event.currency?.id ?? r.company.currency.id,
              company: r.company.id,
              date: su.today(),
              invoiceOrigin: r.event.name,
              lines: {
                create: [
                  {
                    lineKind: 'product',
                    name: r.ticket === null ? r.event.name : `${r.event.name} — ${r.ticket.name}`,
                    quantity: '1',
                    priceUnit: r.price.toString(),
                    debit: '0',
                    credit: '0',
                  },
                ],
              },
            },
          ] as never);
          await su
            .model('event.registration')
            .browse([r.id])
            .write({ invoice: made.ids[0] ?? null, partner });
        }
      });
    },
  },
});

export const eventAccountShutro = defineModule({
  name: 'event_account',
  version: '0.1.0',
  depends: [eventShutro, accountingShutro],
  groups: [
    orm.defineGroup({
      code: 'event_account.user',
      label: 'Event places invoiced',
      implies: ['event.user'],
    }),
  ],
  models: [],
  extensions: [RegistrationInvoice],
});
