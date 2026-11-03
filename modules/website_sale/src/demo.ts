/**
 * The Shop's demo data (RFC 0024 §2.7): Padma Traders' site sells — cement, LED panels and copper cable published with
 * their weight and a Bangla description, related to one another; two delivery methods (by zone, Dhaka or outside,
 * free from 10 000; and a courier by weight); and an order placed on the shop with cash on delivery.
 */

import type { DemoContext } from '@kosh/modules-sdk';
import { idByName } from '@kosh/modules-sdk';
import { orm } from '@kosh/server/orm';
import type { Env } from './.kosh/bindings.js';
import { checkout, newCart, setLine } from './shop.js';

const DINA = {
  login: 'dina',
  name: 'Dina Rahman',
  groups: ['website_sale.manager', 'product.manager'],
} as const;

export async function shopDemo(ctx: DemoContext): Promise<string> {
  const placed = await ctx.as(DINA, async (raw) => {
    const env = raw as Env;
    const [site] = await (
      await env.model('website.site').search({ where: { key: 'padma' }, limit: 1 })
    ).load({});
    if (site === undefined) return null;
    await env.model('website.site').browse([site.id]).write({ shop: true, codLimit: '50000' });
    const products: [string, string, string][] = [
      ['Cement bag 50 kg', '50', 'পোর্টল্যান্ড কম্পোজিট সিমেন্ট, ৫০ কেজির বস্তা।'],
      ['LED panel 40 W', '2.5', '৪০ ওয়াটের এলইডি প্যানেল, অফিস ও দোকানের জন্য।'],
      ['Copper cable 2.5 mm²', '0.03', 'তামার তার, ২.৫ বর্গমিলিমিটার, মিটার হিসেবে।'],
    ];
    const ids: number[] = [];
    for (const [name, weight, bangla] of products) {
      const id = (await idByName(env as never, 'product.product', name)) as number | undefined;
      if (id === undefined) continue;
      ids.push(id);
      await env
        .model('product.product')
        .browse([id as never])
        .write({
          published: true,
          weight,
          websiteDescription: { en_US: `${name}, delivered across Bangladesh.`, bn_BD: bangla },
        } as never);
    }
    for (const id of ids)
      await env
        .model('product.product')
        .browse([id as never])
        .write({ related: { set: ids.filter((o) => o !== id) } } as never);
    const carriers = await env.model('delivery.carrier').create([
      {
        name: 'Home delivery',
        kind: 'zone',
        zoneCities: 'Dhaka',
        priceInside: '60',
        priceOutside: '120',
        freeOver: '10000',
        cod: true,
        courier: 'fake',
        sequence: 1,
      },
      {
        name: 'Courier by weight',
        kind: 'weight',
        price: '80',
        pricePerKg: '20',
        cod: false,
        sequence: 2,
      },
    ]);
    await env.flush();
    // An order placed with cash on delivery, as a visitor would (the shop works as the system).
    return env.asSuperuser({ reason: 'demo shop order' }, async (su) => {
      const shop = { id: site.id, key: site.key, company: site.company.id };
      const cart = await newCart(su, shop);
      const cement = ids[0];
      if (cement === undefined) return null;
      await setLine(su, cart.id as never, cement, orm.toDecimal(4));
      return checkout(su, shop, cart.id as never, {
        name: 'Rina Akter',
        email: 'rina@example.com',
        phone: '01700000000',
        street: 'House 12, Road 5, Dhanmondi',
        city: 'Dhaka',
        carrier: carriers.ids[0] as number,
        payment: 'cod',
      });
    });
  });
  return placed === null
    ? 'Shop: no site to sell on.'
    : `Shop: 3 products published, 2 delivery methods, order ${placed.order} placed with cash on delivery.`;
}
