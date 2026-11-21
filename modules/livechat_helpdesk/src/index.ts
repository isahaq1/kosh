/**
 * @packageDocumentation
 * `@kosh/livechat_helpdesk` (RFC 0034 §2.6): the bridge between Live chat and Helpdesk. Proposed whenever both apps
 * are installed: a channel's routing rules may make a ticket of a conversation that ended (`helpdesk.ticket`),
 * with what was said, the visitor and their email; the ticket shows the conversation it came from.
 */
import { helpdesk } from '@kosh/helpdesk';
import { livechat } from '@kosh/livechat';
import { defineModule } from '@kosh/modules-sdk';
import { stat } from '@kosh/views';
import { livechatHelpdeskShutro } from './module.js';

export { ChatTicket, ChatTickets, livechatHelpdeskShutro } from './module.js';

export const livechatHelpdesk: ReturnType<typeof defineModule> = defineModule({
  shutro: livechatHelpdeskShutro,
  kosh: '^0.1.0',
  depends: [livechat, helpdesk],
  bridge: [livechat, helpdesk],
  // Bangla for the labels it serves (RFC 0023 §3.1; `pnpm i18n:extract`).
  i18n: { bn: () => import('./i18n/bn.js') },
  accessLevels: {
    user: { label: 'Chats to tickets', groups: ['livechat_helpdesk.user'] },
  },
  viewExtensions: [
    {
      view: 'helpdesk.ticket.form',
      operations: [
        {
          append: 'related',
          nodes: [
            stat({
              id: 'ticket_chats',
              label: 'Chats',
              model: 'livechat.session',
              where: { resModel: 'helpdesk.ticket', resId: { $record: 'id' } },
              action: 'livechat.action_sessions',
            }),
          ],
        },
      ],
    },
  ],
});
