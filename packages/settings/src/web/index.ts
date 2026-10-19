/**
 * @packageDocumentation
 * The web contribution of `@kosh/settings` (RFC 0008): the Settings → Apps page (`settings.Apps`, opened by the
 * client action `settings.action_apps`) and its messages.
 */
import { addMessages, type Registry } from '@kosh/ui';
import type { i18n } from 'i18next';
import { AppsPage } from './AppsPage.js';
import { messages } from './messages.js';

export { AppsPage } from './AppsPage.js';

/** Registers the Apps page (and its messages in `i18n`, when given). */
export function registerSettingsWeb(registry: Registry, i18n?: i18n): Registry {
  registry.registerPage('settings.Apps', AppsPage);
  if (i18n !== undefined) addMessages(i18n, 'settings', messages);
  return registry;
}

export { messages as settingsMessages };
