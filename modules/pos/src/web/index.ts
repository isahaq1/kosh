/**
 * @packageDocumentation
 * The web contribution of `@kosh/pos`: the register page.
 */
import { addMessages, type Registry } from '@kosh/ui';
import type { i18n } from 'i18next';
import { messages } from './messages.js';
import { Register } from './Register.js';

export { Register } from './Register.js';

/** Registers the page (and the messages in `i18n`, when given). */
export function registerPosWeb(registry: Registry, i18n?: i18n): Registry {
  registry.registerPage('counter.Register', Register);
  if (i18n !== undefined) addMessages(i18n, 'pos', messages);
  return registry;
}

export { messages as posMessages };
