/**
 * Counter's demo data (RFC 0008 §5.8): the shop with cash and card, a session opened by the cashier with the
 * drawer's cash, and two sales paid — one by card, one in cash with change given.
 */
import type { DemoContext } from '@kosh/modules-sdk';
import { orm } from '@kosh/server/orm';
import type { Env } from './.kosh/bindings.js';

const DINA = { login: 'dina', name: 'Dina Rahman', groups: ['pos.manager'] } as const;
const RAHIM = { login: 'rahim', name: 'Rahim Uddin', groups: ['pos.cashier'] } as const;

export async function posDemo(ctx: DemoContext): Promise<string> {
  let shop: number | undefined;
  let cash: number | undefined;
  let card: number | undefined;
  await ctx.as(DINA, async (raw) => {
    const env = raw as Env;
    const [journal] = (
      await env.model('account.journal').search({ where: { type: 'sale' }, limit: 1 })
    ).ids;
    const made = await env.model('pos.shop').create([
      {
        name: 'Padma Shop, Dhanmondi',
        pricesIncludeTax: true,
        receiptFooter: 'Thank you — exchanges within 7 days with this receipt.',
        ...(journal === undefined ? {} : { salesJournal: journal }),
        methods: {
          create: [
            { name: 'Cash', kind: 'cash', sequence: 1 },
            { name: 'Card', kind: 'card', sequence: 2 },
            { name: 'bKash', kind: 'mobile', sequence: 3 },
          ],
        },
      },
    ]);
    shop = made.ids[0] as number | undefined;
    if (shop === undefined) return;
    const methods = await env
      .model('pos.payment.method')
      .search({ where: { shop: shop as never } });
    for (const m of methods) {
      if (m.kind === 'cash') cash = m.id;
      if (m.kind === 'card') card = m.id;
    }
  });
  if (shop === undefined || cash === undefined || card === undefined) return 'Counter: no shop';
  await ctx.as(RAHIM, async (raw) => {
    const env = raw as Env;
    const session = await env
      .model('pos.session')
      .create([{ shop: shop as never, openingCash: orm.toDecimal('5000') } as never]);
    const [sessionId] = session.ids;
    if (sessionId === undefined) return;
    const products = await env
      .model('product.product')
      .search({ where: { saleOk: true, kind: 'goods' }, order: ['id asc'], limit: 2 });
    const [first, second] = [...products];
    if (first === undefined) return;
    const sale = async (
      lines: readonly { product: typeof first; quantity: string }[],
      payments: readonly { method: number; amount: string }[],
      clientId: string,
    ): Promise<void> => {
      const made = await env.model('pos.order').create([
        {
          session: sessionId,
          clientId,
          lines: {
            create: lines.map((l) => ({
              product: l.product.id,
              name: l.product.name,
              quantity: orm.toDecimal(l.quantity),
              priceUnit: l.product.listPrice,
              discount: orm.toDecimal(0),
            })),
          },
          payments: {
            create: payments.map((p) => ({ method: p.method, amount: orm.toDecimal(p.amount) })),
          },
        } as never,
      ]);
      await env.flush();
      await made.pay();
    };
    const price = (p: typeof first, qty: number) => p.listPrice.times(qty).toString();
    await sale(
      [{ product: first, quantity: '2' }],
      [{ method: card as number, amount: price(first, 2) }],
      'demo-1',
    );
    if (second !== undefined) {
      const due = second.listPrice.plus(first.listPrice);
      const given = due.plus(100);
      await sale(
        [
          { product: second, quantity: '1' },
          { product: first, quantity: '1' },
        ],
        [{ method: cash as number, amount: given.toString() }],
        'demo-2',
      );
      void due;
    }
  });
  return 'Counter: a shop with 3 payment methods, an open session, 2 sales';
}
