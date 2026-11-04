/**
 * @packageDocumentation
 * `@kosh/approvals_purchase`: the bridge between Approvals and Purchase (RFC 0025 step 4). Proposed whenever both
 * apps are installed. Request lines name a product, and an approved request of a category whose outcome is
 * `purchase` (the shipped *Purchase request*) becomes a request for quotation to its contact, shown on the request.
 */
import { approvals } from '@kosh/approvals';
import { defineModule } from '@kosh/modules-sdk';
import { purchase } from '@kosh/purchase';
import { field } from '@kosh/views';
import type { Env } from './.kosh/bindings.js';
import { approvalsPurchaseShutro } from './module.js';

export { AskLineProduct, AskPurchase, approvalsPurchaseShutro } from './module.js';

export const approvalsPurchase: ReturnType<typeof defineModule> = defineModule({
  shutro: approvalsPurchaseShutro,
  kosh: '^0.1.0',
  depends: [approvals, purchase],
  bridge: [approvals, purchase],
  accessLevels: {
    user: { label: 'Purchase requests', groups: ['approvals_purchase.user'] },
  },
  hooks: {
    // The shipped Purchase request category leads to a request for quotation (unless an outcome was chosen).
    defaults: async (raw) => {
      const env = raw as Env;
      const found = await env
        .model('approval.category')
        .search({ where: { code: 'PR', outcome: { isNull: true } } as never });
      if (found.ids.length === 0) return undefined;
      await found.write({ outcome: 'purchase' } as never);
      return 'purchase requests lead to requests for quotation';
    },
  },
  viewExtensions: [
    {
      view: 'approval.ask.form',
      operations: [
        {
          insertBefore: 'line_name',
          nodes: [field({ field: 'product', id: 'line_product' })],
        },
      ],
    },
  ],
});
