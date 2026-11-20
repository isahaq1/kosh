/**
 * The data layer of Loyalty in the Shop (RFC 0034 §2.6): each time the shop has priced a cart, the running
 * promotions go on it by themselves, and the gift card the visitor typed pays what the cart then comes to. The
 * lines are Loyalty's, marked as discounts so that the cart shows them as money off and the next pricing replaces
 * them. A promotion that ended or a gift card that no longer pays is taken off the cart rather than breaking it.
 */
import { applyCredits, loyaltyShutro, promoteOrder, releaseCredits } from '@kosh/loyalty';
import { type Module, type ModuleBase, orm } from '@kosh/server/orm';
import { websiteSaleShutro } from '@kosh/website_sale';
import { defineModule, type Env, extendModel, type Records } from './.kosh/bindings.js';

const refused = (error: unknown, field: string): boolean =>
  error instanceof orm.ValidationError && (error.fields as readonly string[]).includes(field);

/** Marks what Loyalty put on a cart as discounts: the cart shows them as money off, and repricing replaces them. */
async function markDiscounts(su: Env, order: number): Promise<void> {
  const lines = await su.model('sale.order.line').search({
    where: { order: order as never, loyaltyKind: { isNull: false }, isDiscount: false } as never,
  });
  if (lines.length > 0) await lines.write({ isDiscount: true } as never);
  await su.flush();
}

/**
 * Loyalty on a cart (RFC 0034 §2.6): the promotions that apply, then the gift card on what is left. With
 * `strict`, what cannot be taken is refused in words (the visitor just typed it); without, a code that no longer
 * works is taken off the cart, so that the cart itself never stops working.
 */
export async function loyaltyOnCart(
  env: Env,
  order: number,
  options: { readonly strict?: boolean } = {},
): Promise<void> {
  await env.asSuperuser({ reason: 'loyalty on a shop cart' }, async (su) => {
    const cart = su.model('sale.order').browse([order as never]);
    const [o] = await cart.load(['state']);
    if (o === undefined || o.state !== 'draft') return;
    // Earlier credit lines went with the pricing: the holds behind them are given back before anything else.
    await releaseCredits(su as never, order);
    await cart.write({ loyaltyRedeemed: 0, voucherUsed: '0' } as never);
    await su.flush();
    try {
      await promoteOrder(su as never, order);
    } catch (error) {
      if (options.strict === true || !refused(error, 'promoCode')) throw error;
      // The promotion behind the code ended: the cart goes on without it.
      await cart.write({ promoCode: null } as never);
      await su.flush();
      await promoteOrder(su as never, order);
    }
    const [now] = await cart.load(['voucherCode']);
    if ((now?.voucherCode ?? '').trim() !== '')
      try {
        await applyCredits(su as never, order);
      } catch (error) {
        if (options.strict === true || !refused(error, 'voucherCode')) throw error;
        // The gift card expired or is empty now: off the cart.
        await cart.write({ voucherCode: null } as never);
        await su.flush();
      }
    await markDiscounts(su, order);
  });
}

/** After the shop has priced a cart: promotions and the gift card. */
export const CartLoyalty = extendModel('sale.order', {
  overrides: {
    shopPriced: async function (this: unknown, next: () => Promise<void>): Promise<void> {
      await next();
      const orders = this as Records<'sale.order'>;
      for (const id of orders.ids) await loyaltyOnCart(orders.env as unknown as Env, id as number);
    },
  },
});

/** What Loyalty took off a cart, for the shop's page. */
export async function loyaltyOfCart(
  env: Env,
  order: number,
): Promise<{
  readonly promotions: readonly { readonly name: string; readonly amount: string }[];
  readonly promoCode: string | null;
  readonly giftCard: string | null;
  readonly giftCardPaid: string;
}> {
  const [o] = await env
    .model('sale.order')
    .browse([order as never])
    .load({ lines: true });
  const lines = [...(o?.lines ?? [])];
  const off = (l: { priceUnit: unknown; quantity: unknown }): string =>
    orm
      .toDecimal((l.priceUnit ?? 0) as never)
      .times(orm.toDecimal(l.quantity as never))
      .negated()
      .toFixed(2);
  return {
    promotions: lines
      .filter((l) => l.loyaltyKind === 'promotion')
      .map((l) => ({ name: l.name, amount: off(l) })),
    promoCode: o?.promoCode ?? null,
    giftCard: o?.voucherCode ?? null,
    giftCardPaid: orm.toDecimal((o?.voucherUsed ?? 0) as never).toFixed(2),
  };
}

// Named so the module's type stays short enough to emit (TS7056) with every model its dependencies carry.
const DEPENDS: readonly ModuleBase[] = [websiteSaleShutro, loyaltyShutro];
const MODELS = [] as const;
const EXTENSIONS = [CartLoyalty] as const;

export const websiteSaleLoyaltyShutro: Module<
  typeof MODELS,
  readonly ModuleBase[],
  typeof EXTENSIONS
> = defineModule({
  name: 'website_sale_loyalty',
  version: '0.1.0',
  depends: DEPENDS,
  groups: [
    orm.defineGroup({
      code: 'website_sale_loyalty.user',
      label: 'Loyalty in the Shop',
      implies: ['loyalty.user'],
    }),
  ],
  models: MODELS,
  extensions: EXTENSIONS,
});
