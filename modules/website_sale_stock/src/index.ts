/**
 * @packageDocumentation
 * `@kosh/website_sale_stock`: the bridge between the Shop and Stockroom (RFC 0024 §2.7). Proposed whenever both are
 * installed: the shop's products say whether they are in stock, few left (with how many, by the site's threshold) or
 * out of stock, and a site that does not sell beyond stock refuses a cart line beyond what is available.
 */
import { defineModule } from '@kosh/modules-sdk';
import { stock } from '@kosh/stock';
import { websiteSale } from '@kosh/website_sale';
import { websiteSaleStockShutro } from './module.js';

export { ProductShopStock, websiteSaleStockShutro } from './module.js';

export const websiteSaleStock: ReturnType<typeof defineModule> = defineModule({
  shutro: websiteSaleStockShutro,
  kosh: '^0.1.0',
  depends: [websiteSale, stock],
  bridge: [websiteSale, stock],
  accessLevels: {
    user: { label: 'Stock on the shop', groups: ['website_sale.manager'] },
  },
});
