/**
 * @packageDocumentation
 * The web contribution of `@kosh/messaging` (RFC 0006, RFC 0007): the `chatter` component that forms with
 * `chatter: true` show below the sheet, the Chat app (`messaging.Chat`) with its dock in the header, and their
 * messages.
 */
import { addMessages, type Registry } from '@kosh/ui';
import type { i18n } from 'i18next';
import { ChatPage } from './Chat.js';
import { ChatDock } from './ChatDock.js';
import { Chatter } from './Chatter.js';
import { messages } from './messages.js';

export { ChatPage, Conversation, useChannels } from './Chat.js';
export { ChatDock } from './ChatDock.js';
export { Chatter } from './Chatter.js';

/** Registers the chatter, the Chat page and its dock (and the messages in `i18n`, when given). */
export function registerMessagingWeb(registry: Registry, i18n?: i18n): Registry {
  registry.registerComponent('chatter', Chatter);
  registry.registerPage('messaging.Chat', ChatPage);
  registry.registerHeaderItem('messaging.Dock', ChatDock, { home: true });
  if (i18n !== undefined) addMessages(i18n, 'messaging', messages);
  return registry;
}

export { messages as messagingMessages };
