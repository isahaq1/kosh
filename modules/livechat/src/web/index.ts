/**
 * @packageDocumentation
 * The web contribution of `@kosh/livechat`: the operator's inbox.
 */
import { addMessages, type Registry } from '@kosh/ui';
import type { i18n } from 'i18next';
import { Inbox } from './Inbox.js';
import { messages } from './messages.js';

export { Inbox } from './Inbox.js';

/** Registers the page (and the messages in `i18n`, when given). */
export function registerLivechatWeb(registry: Registry, i18n?: i18n): Registry {
  registry.registerPage('livechat.Inbox', Inbox);
  if (i18n !== undefined) addMessages(i18n, 'livechat', messages);
  return registry;
}

export { messages as livechatMessages };
