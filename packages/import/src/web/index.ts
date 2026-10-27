/**
 * @packageDocumentation
 * The web contribution of `@kosh/import` (RFC 0014): "Import" next to every list's "New" (`import.Import`), the
 * import screen, and their messages.
 */
import { addMessages, type Registry } from '@kosh/ui';
import type { i18n } from 'i18next';
import { ImportButton } from './ImportButton.js';
import { messages } from './messages.js';

export { ImportButton } from './ImportButton.js';
export { type ImportSession, ImportWizard } from './ImportWizard.js';

/** Registers "Import" (and the messages in `i18n`, when given). */
export function registerImportWeb(registry: Registry, i18n?: i18n): Registry {
  registry.registerCreateAssist('import.Import', ImportButton);
  if (i18n !== undefined) addMessages(i18n, 'import', messages);
  return registry;
}

export { messages as importMessages };
