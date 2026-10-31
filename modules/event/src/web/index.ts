/**
 * @packageDocumentation
 * The web contribution of `@kosh/event`: check-in at the door (a scanner, the keyboard or the phone's camera).
 */
import { addMessages, type Registry } from '@kosh/ui';
import type { i18n } from 'i18next';
import { CheckInBox } from './CheckInBox.js';
import { messages } from './messages.js';

export { CheckInBox } from './CheckInBox.js';

/** Registers the component (and the messages in `i18n`, when given). */
export function registerEventWeb(registry: Registry, i18n?: i18n): Registry {
  registry.registerComponent('event.CheckIn', CheckInBox);
  if (i18n !== undefined) addMessages(i18n, 'event', messages);
  return registry;
}

export { messages as eventMessages };
