/**
 * The data layer of the Campaigns ↔ Sales bridge (RFC 0038 step 3): a confirmed sales order is **credited to the
 * campaign** whose link its customer followed last, within {@link ATTRIBUTION_DAYS} days before the confirmation —
 * the customer being the contact a message was sent to, or a contact with the address it was sent to. Once: an
 * order keeps the campaign it was credited to. It follows the orders through the outbox (`sale.order.confirmed`).
 */
import { marketingShutro } from '@kosh/marketing';
import { salesShutro } from '@kosh/sales';
import { orm } from '@kosh/server/orm';
import { defineModule, type Env, extendModel, f } from './.kosh/bindings.js';

/** A click counts for an order confirmed within this many days after it. */
export const ATTRIBUTION_DAYS = 30;
/** Fields the server maintains: written by its own code and by Administrators only. */
const SYSTEM = ['base.admin'] as const;

export const OrderCampaign = extendModel('sale.order', {
  fields: {
    campaign: f.many2one('marketing.campaign', {
      ondelete: 'set null',
      index: true,
      label: 'Campaign',
      groups: { write: [...SYSTEM] },
      help: 'The campaign whose link the customer followed in the 30 days before the order was confirmed: the last one. Set by the server.',
    }),
  },
});

/**
 * Credits a confirmed order to a campaign, when its customer followed a link of one recently. Returns the
 * campaign, or `null` when nobody clicked — or the order has its campaign already.
 */
export async function creditOrder(env: Env, order: number): Promise<number | null> {
  const [o] = await env
    .model('sale.order')
    .browse([order as never])
    .load({ partner: true, company: true });
  if (o === undefined || o.campaign !== null) return null;
  const email = (o.partner.email ?? '').trim().toLowerCase();
  const [last] = await env.sql<{ campaign_id: number }>`
    SELECT d.campaign_id FROM marketing_delivery d
     WHERE d.company_id = ${o.company.id as number}
       AND d.clicked_at IS NOT NULL
       AND d.clicked_at >= now() - make_interval(days => ${ATTRIBUTION_DAYS})
       AND (d.partner_id = ${o.partner.id as number} OR (${email} <> '' AND lower(d.email) = ${email}))
     ORDER BY d.clicked_at DESC, d.id DESC LIMIT 1`;
  if (last === undefined) return null;
  const campaign = Number(last.campaign_id);
  await env
    .model('sale.order')
    .browse([order as never])
    .write({ campaign } as never);
  return campaign;
}

export const marketingSaleShutro = defineModule({
  name: 'marketing_sale',
  version: '0.1.0',
  depends: [salesShutro, marketingShutro],
  groups: [
    orm.defineGroup({
      code: 'marketing_sale.user',
      label: 'Orders credited to campaigns',
      implies: ['sales.user', 'marketing.user'],
    }),
  ],
  models: [],
  extensions: [OrderCampaign],
});
