/**
 * @packageDocumentation
 * The web contribution of `@kosh/documents`: the versions panel of a document's form.
 */
import { addMessages, type Registry } from '@kosh/ui';
import type { i18n } from 'i18next';
import { messages } from './messages.js';
import { Versions } from './Versions.js';

export { Versions } from './Versions.js';

/** Registers the component (and the messages in `i18n`, when given). */
export function registerDocumentsWeb(registry: Registry, i18n?: i18n): Registry {
  registry.registerComponent('documents.Versions', Versions);
  if (i18n !== undefined) addMessages(i18n, 'documents', messages);
  return registry;
}

export { messages as documentsMessages };
