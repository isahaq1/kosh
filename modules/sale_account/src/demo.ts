/** Demo data of the Sales ↔ Accounting bridge (RFC 0008 §5.8): the confirmed demo orders get their draft invoices. */
import type { DemoContext } from '@kosh/modules-sdk';
import type { Env } from './.kosh/bindings.js';

const RAHIM = { login: 'rahim', name: 'Rahim Uddin', groups: ['sale_account.user'] } as const;

export async function saleAccountDemo(context: DemoContext): Promise<string> {
  return context.as(RAHIM, async (raw) => {
    const env = raw as Env;
    const orders = await env.model('sale.order').search({ where: { state: 'sale' } });
    let invoiced = 0;
    for (const o of await orders.load({ invoices: true })) {
      if (o.invoices.length > 0) continue;
      await env.model('sale.order').browse([o.id]).invoice();
      invoiced += 1;
    }
    return `${invoiced} confirmed orders invoiced (draft invoices)`;
  });
}
