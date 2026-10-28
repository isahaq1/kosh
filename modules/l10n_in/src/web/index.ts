/**
 * @packageDocumentation
 * The web contribution of `@kosh/l10n_in`: the GST returns page (GSTR-1, GSTR-3B, the company's GST settings) and
 * the e-invoice panel on customer invoices.
 */
import { addMessages, type Registry } from '@kosh/ui';
import type { i18n } from 'i18next';
import { EInvoicePanel } from './EInvoicePanel.js';
import { GstPage } from './GstPage.js';
import { messages } from './messages.js';

export { EInvoicePanel } from './EInvoicePanel.js';
export { GstPage } from './GstPage.js';
export { GstSettings } from './GstSettings.js';

/** Registers the page (and the messages in `i18n`, when given). */
export function registerL10nInWeb(registry: Registry, i18n?: i18n): Registry {
  registry.registerPage('l10n_in.Gst', GstPage);
  registry.registerComponent('l10n_in.EInvoice', EInvoicePanel);
  if (i18n !== undefined) addMessages(i18n, 'l10n_in', messages);
  return registry;
}

/** The messages, named as the starter project's back-office imports them (`<app>Messages`). */
export { messages as l10n_inMessages };
