/** Demo data of the Purchase ↔ Accounting bridge (RFC 0008 §5.8): the confirmed demo orders get their draft bills. */
import type { DemoContext } from '@kosh/modules-sdk';
import type { Env } from './.kosh/bindings.js';

const KARIM = {
  login: 'karim',
  name: 'Karim Chowdhury',
  groups: ['purchase_account.user'],
} as const;

export async function purchaseAccountDemo(context: DemoContext): Promise<string> {
  return context.as(KARIM, async (raw) => {
    const env = raw as Env;
    const orders = await env.model('purchase.order').search({ where: { state: 'purchase' } });
    let billed = 0;
    for (const o of await orders.load({ bills: true })) {
      if (o.bills.length > 0) continue;
      await env.model('purchase.order').browse([o.id]).bill();
      billed += 1;
    }
    return `${billed} confirmed orders billed (draft bills)`;
  });
}
