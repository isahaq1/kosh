/**
 * @packageDocumentation
 * The web contribution of `@kosh/product`: the variant grid on order forms (RFC 0030 §3.4).
 */
import { addMessages, type Registry } from '@kosh/ui';
import type { i18n } from 'i18next';
import { messages } from './messages.js';
import { VariantGrid } from './VariantGrid.js';

export { VariantGrid } from './VariantGrid.js';

/** Registers the component (and the messages in `i18n`, when given). */
export function registerProductWeb(registry: Registry, i18n?: i18n): Registry {
  registry.registerComponent('product.VariantGrid', VariantGrid);
  if (i18n !== undefined) addMessages(i18n, 'product', messages);
  return registry;
}

export { messages as productMessages };
