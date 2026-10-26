/**
 * Demo data of Purchase (RFC 0008 §5.8): a buyer's orders at every stage of the approval policy: confirmed after
 * submission, approved by the manager, and one large enough to wait for the director.
 */

import type { DemoContext } from '@kosh/modules-sdk';
import { idByName } from '@kosh/modules-sdk';
import { decide, requestsOf } from '@kosh/permissions';
import { orm } from '@kosh/server/orm';
import type { Env } from './.kosh/bindings.js';

/** The demo buyer and the manager who approves. */
export const KARIM = {
  login: 'karim',
  name: 'Karim Chowdhury',
  groups: ['purchase.user'],
} as const;
const DINA = { login: 'dina', name: 'Dina Rahman', groups: ['purchase.manager'] } as const;

type Line = { readonly product: string; readonly quantity: string; readonly price: string };
const ORDERS: readonly {
  readonly partner: string;
  readonly daysAgo: number;
  /** `confirmed`: no approval needed; `approved`: the manager approved it; `waiting`: still with the approvers. */
  readonly outcome: 'draft' | 'confirmed' | 'approved' | 'waiting';
  readonly lines: readonly Line[];
}[] = [
  {
    partner: 'Rajshahi Textiles',
    daysAgo: 30,
    outcome: 'confirmed',
    lines: [{ product: 'Copper cable 2.5 mm²', quantity: '800', price: '62' }],
  },
  {
    partner: 'Padma Cement',
    daysAgo: 20,
    outcome: 'approved',
    lines: [{ product: 'Cement bag 50 kg', quantity: '400', price: '480' }],
  },
  {
    partner: 'Bengal Steel Ltd',
    daysAgo: 8,
    outcome: 'approved',
    lines: [{ product: 'Rebar 12 mm', quantity: '2000', price: '80' }],
  },
  {
    partner: 'Dhaka Power Services',
    daysAgo: 2,
    outcome: 'waiting',
    lines: [{ product: 'Diesel generator 250 kVA', quantity: '1', price: '1200000' }],
  },
  {
    partner: 'Padma Cement',
    daysAgo: 0,
    outcome: 'draft',
    lines: [{ product: 'Cement bag 50 kg', quantity: '100', price: '475' }],
  },
];

type ApprovalEnv = Parameters<typeof decide>[0];

export async function purchaseDemo(context: DemoContext): Promise<string> {
  const toApprove: number[] = [];
  const made = await context.as(KARIM, async (raw) => {
    const env = raw as Env;
    const [company] = await env
      .model('res.company')
      .browse([env.companyRef])
      .load({ currency: true });
    if (company === undefined) throw new Error('Demo data: no company.');
    const vat = await idByName(env, 'account.tax', 'VAT 15% (purchases)');
    for (const o of ORDERS) {
      const lines = [];
      for (const l of o.lines) {
        const product = await idByName(env, 'product.product', l.product);
        lines.push({
          product: orm.asId(product, 'product.product'),
          name: l.product,
          quantity: l.quantity,
          priceUnit: l.price,
          tax: orm.asId(vat, 'account.tax'),
          datePlanned: context.date(14 - o.daysAgo),
        });
      }
      const created = await env.model('purchase.order').create([
        {
          partner: orm.asId(await idByName(env, 'res.partner', o.partner), 'res.partner'),
          currency: company.currency.id,
          dateOrder: context.date(-o.daysAgo),
          lines: { create: lines },
        },
      ]);
      const id = created.ids[0] as number;
      const order = env.model('purchase.order').browse(created.ids);
      if (o.outcome === 'draft') continue;
      await order.submit();
      if (o.outcome === 'confirmed') await order.confirm();
      if (o.outcome === 'approved') toApprove.push(id);
    }
    return ORDERS.length;
  });
  // The manager approves: the policy's last approval confirms the order.
  await context.as(DINA, async (raw) => {
    const env = raw as ApprovalEnv;
    for (const id of toApprove) {
      const pending = (await requestsOf(env, 'purchase.order', id)).filter(
        (r) => r.state === 'pending',
      );
      for (const r of pending) await decide(env, r.id, 'approve', 'Within budget');
    }
  });
  return `${made} orders (${toApprove.length} approved by the manager, 1 waiting for the director)`;
}
