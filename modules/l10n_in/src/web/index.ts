/**
 * @packageDocumentation
 * The web contribution of `@kosh/l10n_in`: the GST returns page (GSTR-1 and GSTR-3B).
 */
import { addMessages, type Registry } from '@kosh/ui';
import type { i18n } from 'i18next';
import { GstPage } from './GstPage.js';
import { messages } from './messages.js';

export { GstPage } from './GstPage.js';

/** Registers the page (and the messages in `i18n`, when given). */
export function registerL10nInWeb(registry: Registry, i18n?: i18n): Registry {
  registry.registerPage('l10n_in.Gst', GstPage);
  if (i18n !== undefined) addMessages(i18n, 'l10n_in', messages);
  return registry;
}

/** The messages, named as the starter project's back-office imports them (`<app>Messages`). */
export { messages as l10n_inMessages };
