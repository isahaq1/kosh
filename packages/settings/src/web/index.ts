/**
 * @packageDocumentation
 * The web contribution of `@kosh/settings` (RFC 0008): the Settings → Apps page (`settings.Apps`, opened by the
 * client action `settings.action_apps`) and its messages.
 */
import { addMessages, type Registry } from '@kosh/ui';
import type { i18n } from 'i18next';
import { ApiKeysPage } from './ApiKeysPage.js';
import { AppsPage } from './AppsPage.js';
import { CompaniesPage } from './CompaniesPage.js';
import { CompanyPage } from './CompanyPage.js';
import { messages } from './messages.js';
import { OverviewPage } from './OverviewPage.js';
import { PeoplePage } from './PeoplePage.js';
import { ProfilePage } from './ProfilePage.js';
import { RolesPage } from './RolesPage.js';

export { ApiKeysPage } from './ApiKeysPage.js';
export { AppsPage } from './AppsPage.js';
export { CompaniesPage } from './CompaniesPage.js';
export { CompanyPage } from './CompanyPage.js';
export { OverviewPage } from './OverviewPage.js';
export { PeoplePage } from './PeoplePage.js';
export { deviceOf, ProfilePage } from './ProfilePage.js';
export { RolesEditor } from './RolesEditor.js';
export { RolesPage } from './RolesPage.js';

/** Registers the Apps page (and its messages in `i18n`, when given). */
export function registerSettingsWeb(registry: Registry, i18n?: i18n): Registry {
  registry.registerPage('settings.Overview', OverviewPage);
  registry.registerPage('settings.Apps', AppsPage);
  registry.registerPage('settings.People', PeoplePage);
  registry.registerPage('settings.Roles', RolesPage);
  registry.registerPage('settings.Company', CompanyPage);
  registry.registerPage('settings.Companies', CompaniesPage);
  // Every signed-in user's own profile (RFC 0019) and keys (RFC 0017 §5.1): in the user menu, not in Settings.
  registry.registerUserPage('settings.Profile', ProfilePage, { label: 'settings:profile.title' });
  registry.registerUserPage('settings.ApiKeys', ApiKeysPage, { label: 'settings:apiKeys.title' });
  if (i18n !== undefined) addMessages(i18n, 'settings', messages);
  return registry;
}

export { messages as settingsMessages };
