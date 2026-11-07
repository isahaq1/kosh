/**
 * The data layer of the Pipeline ↔ Sales bridge (RFC 0028 §3.4): a quotation keeps its deal, a deal its quotations.
 * A confirmed quotation wins its deal (the first winning stage); a deal whose quotations are all cancelled is lost.
 * Both follow the orders through the outbox (`sale.order.confirmed`, `sale.order.cancelled`), once each.
 */
import { crmShutro } from '@kosh/crm';
import { salesShutro } from '@kosh/sales';
import { orm } from '@kosh/server/orm';
import { defineModule, type Env, extendModel, f, record } from './.kosh/bindings.js';

export const OrderDeal = extendModel('sale.order', {
  fields: {
    deal: f.many2one('crm.deal', {
      ondelete: 'set null',
      label: 'Deal',
      help: 'The Pipeline deal this quotation is for: confirming it wins the deal.',
    }),
  },
});

export const DealQuotations = extendModel('crm.deal', {
  fields: {
    quotations: f.one2many('sale.order', 'deal', { label: 'Quotations' }),
  },
});

/** A confirmed order wins its deal: the deal moves to the first winning stage, unless it is lost or won already. */
export async function winDealOf(env: Env, order: number): Promise<boolean> {
  const [o] = await env
    .model('sale.order')
    .browse([order as never])
    .load({ deal: { stage: true } });
  const deal = o?.deal;
  if (deal === null || deal === undefined || deal.lost === true || deal.stage?.won === true)
    return false;
  const [won] = await (
    await env.model('crm.stage').search({ where: { won: true }, order: ['sequence asc'], limit: 1 })
  ).load([]);
  if (won === undefined) return false;
  await env.model('crm.deal').browse([deal.id]).write({ stage: won.id });
  return true;
}

/** A cancelled order loses its deal when every quotation of the deal is cancelled and the deal is still open. */
export async function loseDealOf(env: Env, order: number): Promise<boolean> {
  const [o] = await env
    .model('sale.order')
    .browse([order as never])
    .load({ deal: { stage: true, quotations: true } });
  const deal = o?.deal;
  if (deal === null || deal === undefined || deal.lost === true || deal.stage?.won === true)
    return false;
  if ([...deal.quotations].some((q) => q.state !== 'cancel')) return false;
  // A lost deal says why: the bridge's own reason.
  const reason = await env
    .refId('crm.lost.reason', 'sale_crm.reason_quotations_cancelled')
    .catch(() => null);
  await env.model('crm.deal').browse([deal.id]).write({ lost: true, lostReason: reason });
  return true;
}

export const saleCrmShutro = defineModule({
  name: 'sale_crm',
  version: '0.1.0',
  depends: [salesShutro, crmShutro],
  groups: [
    orm.defineGroup({
      code: 'sale_crm.user',
      label: 'Quotations from deals',
      implies: ['sales.user', 'crm.user'],
    }),
  ],
  models: [],
  extensions: [OrderDeal, DealQuotations],
  data: [
    record(
      'crm.lost.reason',
      'reason_quotations_cancelled',
      { name: 'Every quotation was cancelled' },
      { noupdate: true },
    ),
  ],
});
