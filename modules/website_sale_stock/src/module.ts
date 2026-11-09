/**
 * The data layer of the Shop ↔ Stockroom bridge (RFC 0024 §2.7): the shop says what Stockroom has available of each
 * product — on hand in the company's stock locations less what is reserved — so a storefront shows in stock, few
 * left or out of stock, and a site that does not sell beyond stock refuses more than is available.
 */
import { type Module, type ModuleBase, orm } from '@kosh/server/orm';
import { stockShutro } from '@kosh/stock';
import { websiteSaleShutro } from '@kosh/website_sale';
import { defineModule, extendModel, type Records } from './.kosh/bindings.js';

export const ProductShopStock = extendModel('product.product', {
  overrides: {
    shopAvailable: async function (
      this: unknown,
      next: () => Promise<Map<number, string | null>>,
    ): Promise<Map<number, string | null>> {
      const out = await next();
      const products = this as Records<'product.product'>;
      for (const p of await products.load(['kind', 'qtyAvailable']))
        if (p.kind === 'goods') out.set(p.id, (p.qtyAvailable ?? orm.toDecimal(0)).toString());
      return out;
    },
  },
});

// Named so the module's type stays short enough to emit (TS7056) with every model its dependencies carry.
const DEPENDS: readonly ModuleBase[] = [websiteSaleShutro, stockShutro];
const MODELS = [] as const;
const EXTENSIONS = [ProductShopStock] as const;

export const websiteSaleStockShutro: Module<
  typeof MODELS,
  readonly ModuleBase[],
  typeof EXTENSIONS
> = defineModule({
  name: 'website_sale_stock',
  version: '0.1.0',
  depends: DEPENDS,
  models: MODELS,
  extensions: EXTENSIONS,
});
