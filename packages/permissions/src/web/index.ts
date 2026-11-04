/**
 * @packageDocumentation
 * The web contribution of `@kosh/permissions` (RFC 0007 §5): register it in the app's registry.
 */
import { addMessages, type Registry } from '@kosh/ui';
import type { i18n } from 'i18next';
import { ApprovalPanel } from './ApprovalPanel.js';
import { messages } from './messages.js';

export { ApprovalPanel, messages as approvalPanelMessages };

/** Registers `approvals.Panel` (and its messages in `i18n`, when given). */
export function registerPermissionsWeb(registry: Registry, i18n?: i18n): Registry {
  registry.registerComponent('approvals.Panel', ApprovalPanel);
  if (i18n !== undefined) addMessages(i18n, 'approvalPanel', messages);
  return registry;
}
