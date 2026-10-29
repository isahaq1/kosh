/**
 * @packageDocumentation
 * The web contribution of `@kosh/notify`: the bell in the header (`notify.Bell`) and its messages.
 */
import { addMessages, type Registry } from '@kosh/ui';
import type { i18n } from 'i18next';
import { messages } from './messages.js';
import { NotificationBell } from './NotificationBell.js';

export { NotificationBell } from './NotificationBell.js';
export { NotificationSettings } from './NotificationSettings.js';
export { type PushState, usePush } from './push.js';

/** Registers the bell (and its messages in `i18n`, when given). */
export function registerNotifyWeb(registry: Registry, i18n?: i18n): Registry {
  registry.registerHeaderItem('notify.Bell', NotificationBell, { home: true });
  if (i18n !== undefined) addMessages(i18n, 'notify', messages);
  return registry;
}

export { messages as notifyMessages };
