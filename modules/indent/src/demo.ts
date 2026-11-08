/**
 * Requests' demo data (RFC 0008 §5.8): a "Spare parts" product group approved by Dina, and Rahim's indent for the
 * maintenance section — two products from the main store — waiting for approval. Products' demo made the products;
 * the indent takes the first two goods it finds.
 */
import type { DemoContext } from '@kosh/modules-sdk';
import type { Env } from './.kosh/bindings.js';

const DINA = { login: 'dina', name: 'Dina Rahman', groups: ['indent.manager'] } as const;
const RAHIM = { login: 'rahim', name: 'Rahim Uddin', groups: ['indent.user'] } as const;

export async function indentDemo(ctx: DemoContext): Promise<string> {
  const dina = await ctx.as(DINA, async (raw) => (raw as Env).userId);
  await ctx.as(RAHIM, async () => undefined);
  const products = await ctx.system('demo indent products', async (raw) => {
    const env = raw as Env;
    const goods = await env
      .model('product.product')
      .search({ where: { kind: 'goods' }, order: ['id asc'], limit: 2 });
    const [first] = await goods.load({ category: true });
    if (first?.category !== null && first?.category !== undefined)
      await env.model('indent.product.group').create([
        {
          name: 'Spare parts',
          categories: { set: [first.category.id] },
          approvalUsers: { set: [dina] },
        } as never,
      ]);
    return [...goods.ids] as number[];
  });
  if (products.length === 0) return 'Requests: no goods to ask for yet.';
  await ctx.as(RAHIM, async (raw) => {
    const env = raw as Env;
    const warehouse = (await env.model('stock.warehouse').search({ order: ['id asc'], limit: 1 }))
      .ids[0];
    const destination = (
      await env.model('stock.location').search({ where: { usage: 'consumption' }, limit: 1 })
    ).ids[0];
    if (warehouse === undefined || destination === undefined) return;
    const made = await env.model('indent.request').create([
      {
        requester: env.userId,
        warehouse,
        destination,
        dateRequired: ctx.date(2),
        priority: 'high',
        purpose: 'Belt and bearings for the pellet mill',
        lines: {
          create: products.map((product, i) => ({ product, quantity: i === 0 ? '4' : '10' })),
        },
      } as never,
    ]);
    await env.flush();
    await env.model('indent.request').browse(made.ids).submit();
  });
  return 'Requests: a maintenance indent waiting for approval.';
}
