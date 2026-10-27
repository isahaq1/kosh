/** Demo data of Sales (RFC 0008 §5.8): quotations and confirmed orders of a salesperson, with VAT. */

import type { DemoContext } from '@kosh/modules-sdk';
import { idByName } from '@kosh/modules-sdk';
import { orm } from '@kosh/server/orm';
import type { Env } from './.kosh/bindings.js';

/** The demo salesperson. */
export const RAHIM = { login: 'rahim', name: 'Rahim Uddin', groups: ['sales.user'] } as const;

type Line = { readonly product: string; readonly quantity: string; readonly price: string };
const ORDERS: readonly {
  readonly partner: string;
  readonly daysAgo: number;
  readonly reference?: string;
  readonly state: 'draft' | 'sent' | 'sale';
  readonly lines: readonly Line[];
}[] = [
  {
    partner: 'Bengal Steel Ltd',
    daysAgo: 40,
    reference: 'BS-PO-2201',
    state: 'sale',
    lines: [
      { product: 'Steel beam IPE 200', quantity: '20', price: '85000' },
      { product: 'Installation hours', quantity: '16', price: '1500' },
    ],
  },
  {
    partner: 'Acme Trading',
    daysAgo: 25,
    state: 'sale',
    lines: [{ product: 'Cement bag 50 kg', quantity: '500', price: '540' }],
  },
  {
    partner: 'Meghna Electronics',
    daysAgo: 12,
    state: 'sale',
    lines: [
      { product: 'LED panel 40 W', quantity: '40', price: '2400' },
      { product: 'Copper cable 2.5 mm²', quantity: '200', price: '85' },
    ],
  },
  {
    partner: 'Sylhet Tea Estates',
    daysAgo: 5,
    state: 'sent',
    lines: [
      { product: 'Site audit', quantity: '2', price: '25000' },
      { product: 'Consulting day', quantity: '3', price: '40000' },
    ],
  },
  {
    partner: 'Khulna Shipyard',
    daysAgo: 1,
    state: 'draft',
    lines: [{ product: 'Rebar 12 mm', quantity: '3000', price: '95' }],
  },
];

export async function salesDemo(context: DemoContext): Promise<string> {
  return context.as(RAHIM, async (raw) => {
    const env = raw as Env;
    const [company] = await env
      .model('res.company')
      .browse([env.companyRef])
      .load({ currency: true });
    if (company === undefined) throw new Error('Demo data: no company.');
    const vat = await idByName(env, 'account.tax', 'VAT 15%');
    let confirmed = 0;
    for (const o of ORDERS) {
      const lines = [];
      for (const l of o.lines) {
        const product = await idByName(env, 'product.product', l.product);
        lines.push({
          product: orm.asId(product, 'product.product'),
          name: l.product,
          quantity: l.quantity,
          priceUnit: l.price,
          taxes: { set: [orm.asId(vat, 'account.tax')] },
        });
      }
      const created = await env.model('sale.order').create([
        {
          partner: orm.asId(await idByName(env, 'res.partner', o.partner), 'res.partner'),
          currency: company.currency.id,
          dateOrder: context.date(-o.daysAgo),
          validityDate: context.date(30 - o.daysAgo),
          ...(o.reference === undefined ? {} : { clientReference: o.reference }),
          lines: { create: lines },
        },
      ]);
      const order = env.model('sale.order').browse(created.ids);
      if (o.state === 'sent') await order.send();
      if (o.state === 'sale') {
        await order.confirm();
        confirmed += 1;
      }
    }
    return `${ORDERS.length} orders, ${confirmed} confirmed`;
  });
}
