/**
 * The data layer of the Approvals ↔ Purchase bridge (RFC 0025 step 4): request lines name a product; the outcome
 * `purchase` — offered to request categories — makes, once a request is approved, a request for quotation to the
 * request's contact from its lines with products (in the company's currency), and shows it on the request.
 */
import { approvalsShutro } from '@kosh/approvals';
import { productShutro } from '@kosh/product';
import { purchaseShutro } from '@kosh/purchase';
import { orm } from '@kosh/server/orm';
import { defineModule, type Env, extendModel, f, type Records } from './.kosh/bindings.js';

export const AskLineProduct = extendModel('approval.ask.line', {
  fields: {
    product: f.many2one('product.product', { ondelete: 'restrict', label: 'Product' }),
  },
});

export const AskPurchase = extendModel('approval.ask', {
  overrides: {
    outcomes: async function (
      this: unknown,
      next: () => Promise<Map<string, string>>,
    ): Promise<Map<string, string>> {
      const out = await next();
      out.set('purchase', 'A request for quotation from the lines');
      return out;
    },
    runOutcome: async function (this: unknown, next: () => Promise<void>): Promise<void> {
      await next();
      const asks = this as Records<'approval.ask'>;
      const env = asks.env as unknown as Env;
      for (const a of await asks.load({
        category: ['outcome'],
        lines: ['product', 'name', 'quantity', 'priceUnit'],
        partner: true,
        company: ['currency'],
      })) {
        if (a.category.outcome !== 'purchase' || a.resultId !== null) continue;
        const lines = [...a.lines].filter((l) => l.product !== null);
        if (a.partner === null || lines.length === 0) {
          await env.model('approval.ask').browse([a.id]).write({
            resultName: 'No request for quotation: it needs a contact and lines with products.',
          });
          continue;
        }
        const order = await env.model('purchase.order').create([
          {
            partner: a.partner.id,
            currency: a.company.currency.id,
            company: a.company.id,
            partnerReference: a.name ?? null,
            lines: {
              create: lines.map((l) => ({
                product: l.product?.id,
                name: l.name,
                quantity: l.quantity,
                priceUnit: l.priceUnit,
              })),
            },
          } as never,
        ]);
        const [made] = await env.model('purchase.order').browse(order.ids).load(['name']);
        await env
          .model('approval.ask')
          .browse([a.id])
          .write({
            resultModel: 'purchase.order',
            resultId: order.ids[0] as number,
            resultName: String(made?.name ?? ''),
          });
      }
    },
  },
});

export const approvalsPurchaseShutro = defineModule({
  name: 'approvals_purchase',
  version: '0.1.0',
  depends: [approvalsShutro, purchaseShutro, productShutro],
  groups: [
    orm.defineGroup({
      code: 'approvals_purchase.user',
      label: 'Purchase requests',
      implies: ['purchase.user'],
    }),
  ],
  models: [],
  extensions: [AskLineProduct, AskPurchase],
});
