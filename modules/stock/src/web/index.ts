/**
 * @packageDocumentation
 * The web contribution of `@kosh/stock`: the scan box of counts (a barcode scanner, the keyboard or the camera) and
 * the Replenishment page.
 */
import { addMessages, type Registry } from '@kosh/ui';
import type { i18n } from 'i18next';
import { Ledger } from './Ledger.js';
import { messages } from './messages.js';
import { Operations } from './Operations.js';
import { Replenishment } from './Replenishment.js';
import { ReturnButton } from './ReturnButton.js';
import { ScanBox } from './ScanBox.js';

export { Ledger } from './Ledger.js';
export { Operations } from './Operations.js';
export { Replenishment } from './Replenishment.js';
export { ReturnButton } from './ReturnButton.js';
export { ScanBox } from './ScanBox.js';

/** Registers the component and the page (and the messages in `i18n`, when given). */
export function registerStockWeb(registry: Registry, i18n?: i18n): Registry {
  registry.registerComponent('stock.Scan', ScanBox);
  registry.registerComponent('stock.Return', ReturnButton);
  registry.registerPage('stock.Replenishment', Replenishment);
  registry.registerPage('stock.Operations', Operations);
  registry.registerPage('stock.Ledger', Ledger);
  if (i18n !== undefined) addMessages(i18n, 'stock', messages);
  return registry;
}

export { messages as stockMessages };
