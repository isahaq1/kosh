/**
 * @packageDocumentation
 * The web contribution of `@kosh/messaging` (RFC 0006, RFC 0007): the `chatter` component that forms with
 * `chatter: true` show below the sheet, and its messages.
 */
import { addMessages, type Registry } from '@kosh/ui';
import type { i18n } from 'i18next';
import { Chatter } from './Chatter.js';
import { messages } from './messages.js';

export { Chatter } from './Chatter.js';

/** Registers the chatter (and its messages in `i18n`, when given). */
export function registerMessagingWeb(registry: Registry, i18n?: i18n): Registry {
  registry.registerComponent('chatter', Chatter);
  if (i18n !== undefined) addMessages(i18n, 'messaging', messages);
  return registry;
}

export { messages as messagingMessages };
