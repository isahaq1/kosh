/**
 * @packageDocumentation
 * The web contribution of `@kosh/settings` (RFC 0008): the Settings → Apps page (`settings.Apps`, opened by the
 * client action `settings.action_apps`) and its messages.
 */
import { addMessages, type Registry } from '@kosh/ui';
import type { i18n } from 'i18next';
import { ApiKeysPage } from './ApiKeysPage.js';
import { AppsPage } from './AppsPage.js';
import { CompanyPage } from './CompanyPage.js';
import { messages } from './messages.js';

export { ApiKeysPage } from './ApiKeysPage.js';
export { AppsPage } from './AppsPage.js';
export { CompanyPage } from './CompanyPage.js';

/** Registers the Apps page (and its messages in `i18n`, when given). */
export function registerSettingsWeb(registry: Registry, i18n?: i18n): Registry {
  registry.registerPage('settings.Apps', AppsPage);
  registry.registerPage('settings.Company', CompanyPage);
  // Every signed-in user's own keys (RFC 0017 §5.1): in the user menu, not in the Settings app.
  registry.registerUserPage('settings.ApiKeys', ApiKeysPage, { label: 'settings:apiKeys.title' });
  if (i18n !== undefined) addMessages(i18n, 'settings', messages);
  return registry;
}

export { messages as settingsMessages };
