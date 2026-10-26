/**
 * @packageDocumentation
 * The web contribution of `@kosh/mail` (RFC 0006 part 7): the inbound email page (`mail.Inbound`) where
 * messages that matched no one are attached to a record by hand or discarded, and its messages.
 */
import { addMessages, type Registry } from '@kosh/ui';
import type { i18n } from 'i18next';
import { InboundPage } from './InboundPage.js';
import { messages } from './messages.js';

export { InboundPage } from './InboundPage.js';

/** Registers the page (and its messages in `i18n`, when given). */
export function registerMailWeb(registry: Registry, i18n?: i18n): Registry {
  registry.registerPage('mail.Inbound', InboundPage);
  if (i18n !== undefined) addMessages(i18n, 'mail', messages);
  return registry;
}

export { messages as mailMessages };
