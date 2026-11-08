/**
 * @packageDocumentation
 * The web contribution of `@kosh/purchase_stock`: the vendor scorecard on contacts (RFC 0030 §3.1).
 */
import { addMessages, type Registry } from '@kosh/ui';
import type { i18n } from 'i18next';
import { messages } from './messages.js';
import { VendorScorecard } from './Scorecard.js';

export { VendorScorecard } from './Scorecard.js';

/** Registers the component (and the messages in `i18n`, when given). */
export function registerPurchaseStockWeb(registry: Registry, i18n?: i18n): Registry {
  registry.registerComponent('purchase_stock.Scorecard', VendorScorecard);
  if (i18n !== undefined) addMessages(i18n, 'purchase_stock', messages);
  return registry;
}

export { messages as purchaseStockMessages };
