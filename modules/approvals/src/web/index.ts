/**
 * @packageDocumentation
 * The web contribution of `@kosh/approvals`: the inbox, my requests and what I decided.
 */
import { addMessages, type Registry } from '@kosh/ui';
import type { i18n } from 'i18next';
import { History } from './History.js';
import { Inbox } from './Inbox.js';
import { Mine } from './Mine.js';
import { messages } from './messages.js';

export { History } from './History.js';
export { Inbox } from './Inbox.js';
export { Mine } from './Mine.js';

/** Registers the pages (and the messages in `i18n`, when given). */
export function registerApprovalsWeb(registry: Registry, i18n?: i18n): Registry {
  registry.registerPage('approvals.Inbox', Inbox);
  registry.registerPage('approvals.Mine', Mine);
  registry.registerPage('approvals.History', History);
  if (i18n !== undefined) addMessages(i18n, 'approvals', messages);
  return registry;
}

export { messages as approvalsMessages };
