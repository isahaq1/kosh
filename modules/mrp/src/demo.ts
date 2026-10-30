/**
 * Production's demo data (RFC 0008 §5.8): an assembly work centre and a bill of materials for an LED fixture
 * (an LED panel and copper cable, 20 minutes of assembly), and an order for 5 fixtures checked — its components
 * listed with what is short and what it costs.
 */
import type { DemoContext } from '@kosh/modules-sdk';
import { idByName } from '@kosh/modules-sdk';
import type { Env } from './.kosh/bindings.js';

const DINA = { login: 'dina', name: 'Dina Rahman', groups: ['mrp.manager'] } as const;

export async function mrpDemo(ctx: DemoContext): Promise<string> {
  await ctx.as(DINA, async (raw) => {
    const env = raw as Env;
    const id = (model: string, name: string) =>
      idByName(env as never, model, name) as Promise<never>;
    const units = await id('uom.uom', 'Units');
    const fixture = (
      await env
        .model('product.product')
        .create([{ name: 'LED fixture', uom: units, listPrice: '4500', standardPrice: '0' }])
    ).ids[0];
    if (fixture === undefined) return;
    const assembly = (
      await env.model('mrp.workcenter').create([{ name: 'Assembly', costPerHour: '600' }])
    ).ids[0];
    if (assembly === undefined) return;
    const bom = (
      await env.model('mrp.bom').create([
        {
          product: fixture,
          quantity: '1',
          version: 'v1',
          lines: {
            create: [
              { product: await id('product.product', 'LED panel 40 W'), quantity: '1', uom: units },
              {
                product: await id('product.product', 'Copper cable 2.5 mm²'),
                quantity: '3',
                uom: await id('uom.uom', 'm'),
              },
            ],
          },
          operations: {
            create: [{ name: 'Assemble and test', workcenter: assembly, minutes: '20' }],
          },
        },
      ])
    ).ids[0];
    const order = await env
      .model('mrp.production')
      .create([{ product: fixture, quantity: '5', bom: bom ?? null, date: ctx.date(3) }]);
    await order.check();
  });
  return 'Production: a bill of materials and an order for 5 LED fixtures, checked.';
}
