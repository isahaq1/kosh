/**
 * @packageDocumentation
 * The web contribution of `@kosh/automation` (RFC 0011 §5.6): the rule editor (the form renderer of
 * `automation.rule`), the "try again" of a failed run, and their messages.
 */
import { addMessages, type Registry } from '@kosh/ui';
import type { i18n } from 'i18next';
import { messages } from './messages.js';
import { RetryRun } from './RetryRun.js';
import { RuleEditor } from './RuleEditor.js';

export { RetryRun } from './RetryRun.js';
export { RuleEditor } from './RuleEditor.js';

/** Registers the editor and the retry (and the messages in `i18n`, when given). */
export function registerAutomationWeb(registry: Registry, i18n?: i18n): Registry {
  registry.registerView('automation.RuleEditor', RuleEditor);
  registry.registerComponent('automation.RetryRun', RetryRun);
  if (i18n !== undefined) addMessages(i18n, 'automation', messages);
  return registry;
}

export { messages as automationMessages };
