/**
 * @packageDocumentation
 * `@kosh/event_account`: the bridge between Event Hub and Accounting (RFC 0021, Event Hub step 3). Proposed whenever
 * both apps are installed: each place confirmed at a price gets a draft customer invoice for its attendee.
 */
import { accounting } from '@kosh/accounting';
import { event } from '@kosh/event';
import { defineModule } from '@kosh/modules-sdk';
import { field } from '@kosh/views';
import { eventAccountShutro } from './module.js';

export { eventAccountShutro, RegistrationInvoice } from './module.js';

export const eventAccount: ReturnType<typeof defineModule> = defineModule({
  shutro: eventAccountShutro,
  kosh: '^0.1.0',
  depends: [event, accounting],
  bridge: [event, accounting],
  accessLevels: {
    user: { label: 'Event places invoiced', groups: ['event_account.user'] },
  },
  viewExtensions: [
    {
      view: 'event.registration.form',
      operations: [
        { append: 'ticket_info', nodes: [field({ field: 'invoice', id: 'registration_invoice' })] },
      ],
    },
  ],
});
