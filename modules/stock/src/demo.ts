/**
 * Stockroom's demo data (RFC 0008 §5.8): a receipt from Padma Cement and Meghna Electronics into the main warehouse,
 * validated (cement bags, LED panels counted in dozens, copper cable); a delivery to Acme Trading that is ready (its
 * stock reserved); and a larger one waiting for stock, partly reserved.
 */
import type { DemoContext } from '@kosh/modules-sdk';
import { idByName } from '@kosh/modules-sdk';
import type { Env } from './.kosh/bindings.js';
import { defaultLocations } from './module.js';

const DINA = { login: 'dina', name: 'Dina Rahman', groups: ['stock.manager'] } as const;

export async function stockDemo(ctx: DemoContext): Promise<string> {
  await ctx.as(DINA, async (raw) => {
    const env = raw as Env;
    const id = (model: string, name: string) =>
      idByName(env as never, model, name) as Promise<never>;
    const cement = await id('product.product', 'Cement bag 50 kg');
    const panel = await id('product.product', 'LED panel 40 W');
    const cable = await id('product.product', 'Copper cable 2.5 mm²');
    const transfer = async (
      kind: 'receipt' | 'delivery',
      partner: string,
      lines: readonly { product: never; quantity: string; uom?: string }[],
    ) => {
      const places = await defaultLocations(env, kind);
      if (places.source === null || places.destination === null) return undefined;
      const moves = [];
      for (const l of lines)
        moves.push({
          product: l.product,
          quantity: l.quantity,
          ...(l.uom === undefined ? {} : { uom: await id('uom.uom', l.uom) }),
        });
      const made = await env.model('stock.picking').create([
        {
          kind,
          partner: await id('res.partner', partner),
          warehouse: places.warehouse,
          source: places.source,
          destination: places.destination,
          scheduledDate: ctx.date(kind === 'receipt' ? -3 : 2),
          moves: { create: moves },
        },
      ]);
      await made.confirm();
      return made;
    };
    const received = await transfer('receipt', 'Padma Cement', [
      { product: cement, quantity: '200' },
    ]);
    await received?.validate();
    const electronics = await transfer('receipt', 'Meghna Electronics', [
      { product: panel, quantity: '4', uom: 'Dozens' },
      { product: cable, quantity: '500' },
    ]);
    await electronics?.validate();
    await transfer('delivery', 'Acme Trading', [
      { product: cement, quantity: '40' },
      { product: panel, quantity: '12' },
    ]);
    const waiting = await transfer('delivery', 'Acme Trading', [
      { product: cable, quantity: '800' },
    ]);
    await waiting?.write({ origin: 'Site Banani, phase 2' });
  });
  return 'Stockroom: 2 receipts validated, a delivery ready, a delivery waiting for stock.';
}
