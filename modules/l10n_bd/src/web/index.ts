/**
 * @packageDocumentation
 * The web contribution of `@kosh/l10n_bd`: the Mushak returns page (the sales and purchase registers and the
 * monthly return).
 */
import { addMessages, type Registry } from '@kosh/ui';
import type { i18n } from 'i18next';
import { MushakPage } from './MushakPage.js';
import { messages } from './messages.js';

export { MushakPage } from './MushakPage.js';

/** Registers the page (and the messages in `i18n`, when given). */
export function registerL10nBdWeb(registry: Registry, i18n?: i18n): Registry {
  registry.registerPage('l10n_bd.Mushak', MushakPage);
  if (i18n !== undefined) addMessages(i18n, 'l10n_bd', messages);
  return registry;
}

/** The messages, named as the starter project's back-office imports them (`<app>Messages`). */
export { messages as l10n_bdMessages };
