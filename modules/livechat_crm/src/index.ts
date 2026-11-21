/**
 * @packageDocumentation
 * `@kosh/livechat_crm` (RFC 0034 §2.6): the bridge between Live chat and Pipeline. Proposed whenever both apps
 * are installed: a channel's routing rules may make a deal of a conversation that ended (`crm.deal`),
 * with what was said, the visitor and their email; the deal shows the conversation it came from.
 */
import { crm } from '@kosh/crm';
import { livechat } from '@kosh/livechat';
import { defineModule } from '@kosh/modules-sdk';
import { stat } from '@kosh/views';
import { livechatCrmShutro } from './module.js';

export { ChatDeal, ChatDeals, livechatCrmShutro } from './module.js';

export const livechatCrm: ReturnType<typeof defineModule> = defineModule({
  shutro: livechatCrmShutro,
  kosh: '^0.1.0',
  depends: [livechat, crm],
  bridge: [livechat, crm],
  // Bangla for the labels it serves (RFC 0023 §3.1; `pnpm i18n:extract`).
  i18n: { bn: () => import('./i18n/bn.js') },
  accessLevels: {
    user: { label: 'Chats to deals', groups: ['livechat_crm.user'] },
  },
  viewExtensions: [
    {
      view: 'crm.deal.form',
      operations: [
        {
          append: 'related',
          nodes: [
            stat({
              id: 'deal_chats',
              label: 'Chats',
              model: 'livechat.session',
              where: { resModel: 'crm.deal', resId: { $record: 'id' } },
              action: 'livechat.action_sessions',
            }),
          ],
        },
      ],
    },
  ],
});
