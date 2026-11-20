/**
 * @packageDocumentation
 * `@kosh/website_sale_loyalty` (RFC 0034 §2.6): Loyalty in the Shop. Proposed whenever both apps are installed.
 *
 * - The running **promotions** go on every cart by themselves, each time the shop prices it.
 * - A visitor types a **promotion code** or a **gift card**'s code; the gift card pays what the cart comes to,
 *   delivery included, or all it holds.
 * - A placed order earns **points** for its customer like any confirmed order (Loyalty does that already).
 *
 * - `PUT /api/v1/public/shop/:site/cart/promotion`   `{ code }` (empty: none) — the cart, with what was taken off
 * - `PUT /api/v1/public/shop/:site/cart/gift-card`   `{ code }` (empty: none) — the cart, with what the card paid
 * - `GET /api/v1/public/shop/:site/cart/loyalty`     the promotions on the cart, the codes and what the card paid
 */
import { loyalty } from '@kosh/loyalty';
import { defineModule } from '@kosh/modules-sdk';
import type { ModuleContext } from '@kosh/server';
import { cartView, shopAccess, websiteSale } from '@kosh/website_sale';
import type { Env } from './.kosh/bindings.js';
import { loyaltyOfCart, loyaltyOnCart, websiteSaleLoyaltyShutro } from './module.js';

export { CartLoyalty, loyaltyOfCart, loyaltyOnCart, websiteSaleLoyaltyShutro } from './module.js';

function registerRoutes(context: ModuleContext): void {
  const { app, shutro } = context;
  const { inShop, tokenOf, cartOr404 } = shopAccess(shutro);
  const pub = { config: { auth: false } };
  const base = '/api/v1/public/shop/:site';
  const codeOf = (body: unknown): string | null => {
    const code = String((body as Record<string, unknown> | null)?.['code'] ?? '')
      .trim()
      .toUpperCase()
      .slice(0, 40);
    return code === '' ? null : code;
  };
  /** The cart as the shop shows it, with what Loyalty took off. */
  const view = async (env: Env, id: number) => ({
    ...(await cartView(env as never, id as never)),
    loyalty: await loyaltyOfCart(env, id),
  });
  const put = (path: string, field: 'promoCode' | 'voucherCode'): void => {
    app.put(`${base}${path}`, { ...pub, bodyLimit: 4 * 1024 }, async (request) =>
      inShop(request.params, 'loyalty', async (raw, site) => {
        const env = raw as unknown as Env;
        const id = Number(
          await cartOr404(raw, site, tokenOf(request.headers as Record<string, unknown>)),
        );
        await env
          .model('sale.order')
          .browse([id as never])
          .write({ [field]: codeOf(request.body) } as never);
        await env.flush();
        // Refused in words when the code does not work: the cart is then left as it was.
        await loyaltyOnCart(env, id, { strict: true });
        return view(env, id);
      }),
    );
  };
  put('/cart/promotion', 'promoCode');
  put('/cart/gift-card', 'voucherCode');
  app.get(`${base}/cart/loyalty`, pub, async (request) =>
    inShop(request.params, 'loyalty', async (raw, site) => {
      const env = raw as unknown as Env;
      const id = Number(
        await cartOr404(raw, site, tokenOf(request.headers as Record<string, unknown>)),
      );
      return loyaltyOfCart(env, id);
    }),
  );
}

export const websiteSaleLoyalty: ReturnType<typeof defineModule> = defineModule({
  shutro: websiteSaleLoyaltyShutro,
  kosh: '^0.1.0',
  depends: [websiteSale, loyalty],
  bridge: [websiteSale, loyalty],
  // Bangla for the labels it serves (RFC 0023 §3.1; `pnpm i18n:extract`).
  i18n: { bn: () => import('./i18n/bn.js') },
  accessLevels: {
    user: { label: 'Loyalty in the Shop', groups: ['website_sale_loyalty.user'] },
  },
  routes: (context: ModuleContext) => registerRoutes(context),
});
