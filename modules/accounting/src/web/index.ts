/**
 * @packageDocumentation
 * The web contribution of `@kosh/accounting`: the settings page (chart of accounts, lock dates), the
 * reconciliation screen, the aged balances report and the "Register payment" dialog on documents.
 */
import { addMessages, type Registry } from '@kosh/ui';
import type { i18n } from 'i18next';
import { AgingPage } from './AgingPage.js';
import { messages } from './messages.js';
import { ReconcilePage } from './ReconcilePage.js';
import { RegisterPayment } from './RegisterPayment.js';
import { SettingsPage } from './SettingsPage.js';

export { AgingPage } from './AgingPage.js';
export { ReconcilePage } from './ReconcilePage.js';
export { RegisterPayment } from './RegisterPayment.js';
export { SettingsPage } from './SettingsPage.js';

/** Registers the pages and the component (and the messages in `i18n`, when given). */
export function registerAccountingWeb(registry: Registry, i18n?: i18n): Registry {
  registry.registerPage('accounting.Settings', SettingsPage);
  registry.registerPage('accounting.Reconcile', ReconcilePage);
  registry.registerPage('accounting.Aging', AgingPage);
  registry.registerComponent('accounting.RegisterPayment', RegisterPayment);
  if (i18n !== undefined) addMessages(i18n, 'accounting', messages);
  return registry;
}

export { messages as accountingMessages };
