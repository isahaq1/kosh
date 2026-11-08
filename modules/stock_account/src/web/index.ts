/**
 * @packageDocumentation
 * The web contribution of `@kosh/stock_account`: the landed cost split preview (RFC 0030 §3.3).
 */
import { addMessages, type Registry } from '@kosh/ui';
import type { i18n } from 'i18next';
import { LandedPreview } from './LandedPreview.js';
import { messages } from './messages.js';

export { LandedPreview } from './LandedPreview.js';

/** Registers the component (and the messages in `i18n`, when given). */
export function registerStockAccountWeb(registry: Registry, i18n?: i18n): Registry {
  registry.registerComponent('stock_account.LandedPreview', LandedPreview);
  if (i18n !== undefined) addMessages(i18n, 'stock_account', messages);
  return registry;
}

export { messages as stockAccountMessages };
