/**
 * @packageDocumentation
 * `@kosh/indent_purchase`: the bridge between Requests and Purchase (RFC 0032 §3.4). Proposed whenever both apps
 * are installed. **Buy** on an approved indent drafts a purchase request for what the store lacks — its lines
 * linked to the indent's —, for the requester to submit; the indent shows what is being bought.
 */
import { indent } from '@kosh/indent';
import { defineModule } from '@kosh/modules-sdk';
import { purchase } from '@kosh/purchase';
import { stock } from '@kosh/stock';
import { field } from '@kosh/views';
import { indentPurchaseShutro } from './module.js';

export {
  IndentBuying,
  IndentLineBuying,
  indentPurchaseShutro,
  RequestFromIndent,
  RequestLineFromIndent,
} from './module.js';

export const indentPurchase: ReturnType<typeof defineModule> = defineModule({
  shutro: indentPurchaseShutro,
  kosh: '^0.1.0',
  depends: [indent, purchase, stock],
  bridge: [indent, purchase],
  accessLevels: {
    user: {
      label: 'Store keeper who asks Purchase for shortfalls',
      groups: ['indent_purchase.user'],
    },
  },
  // Bangla for the labels it serves (RFC 0023 §3.1; `pnpm i18n:extract`).
  i18n: { bn: () => import('./i18n/bn.js') },
  events: [
    {
      topic: 'indent.request.purchase_requested',
      model: 'indent.request',
      label: 'Purchase asked for an indent’s shortfall',
    },
  ],
  viewExtensions: [
    {
      view: 'indent.request.form',
      operations: [
        {
          insertAfter: 'issue',
          nodes: [
            {
              kind: 'button',
              id: 'buy',
              transition: 'buy',
              label: 'Ask Purchase for the shortfall',
              visibleWhen: { state: 'approved' },
            },
          ],
        },
        {
          insertAfter: 'qtyRemaining',
          nodes: [field({ field: 'qtyBuying', id: 'line_buying' })],
        },
      ],
    },
    {
      view: 'purchase.request.form',
      operations: [{ append: 'main', nodes: [field({ field: 'indent', id: 'request_indent' })] }],
    },
  ],
});
