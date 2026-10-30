/**
 * @packageDocumentation
 * The web contribution of `@kosh/stock`: the scan box of counts (a barcode scanner, the keyboard or the camera).
 */
import { addMessages, type Registry } from '@kosh/ui';
import type { i18n } from 'i18next';
import { messages } from './messages.js';
import { ScanBox } from './ScanBox.js';

export { ScanBox } from './ScanBox.js';

/** Registers the component (and the messages in `i18n`, when given). */
export function registerStockWeb(registry: Registry, i18n?: i18n): Registry {
  registry.registerComponent('stock.Scan', ScanBox);
  if (i18n !== undefined) addMessages(i18n, 'stock', messages);
  return registry;
}

export { messages as stockMessages };
