/**
 * @packageDocumentation
 * The web contribution of `@kosh/approvals`: the inbox, my requests and what I decided; the policy preview and a request category's policy.
 */
import { addMessages, type Registry } from '@kosh/ui';
import type { i18n } from 'i18next';
import { CategoryPolicy, PolicyPreview } from './Config.js';
import { History } from './History.js';
import { Inbox } from './Inbox.js';
import { Mine } from './Mine.js';
import { messages } from './messages.js';

export { CategoryPolicy, PolicyPreview } from './Config.js';
export { History } from './History.js';
export { Inbox } from './Inbox.js';
export { Mine } from './Mine.js';

/** Registers the pages (and the messages in `i18n`, when given). */
export function registerApprovalsWeb(registry: Registry, i18n?: i18n): Registry {
  registry.registerPage('approvals.Inbox', Inbox);
  registry.registerPage('approvals.Mine', Mine);
  registry.registerPage('approvals.History', History);
  registry.registerComponent('approvals.PolicyPreview', PolicyPreview);
  registry.registerComponent('approvals.CategoryPolicy', CategoryPolicy);
  if (i18n !== undefined) addMessages(i18n, 'approvals', messages);
  return registry;
}

export { messages as approvalsMessages };
