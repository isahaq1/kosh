/**
 * @packageDocumentation
 * The web contribution of `@kosh/website`: the live preview on the page form.
 */
import { addMessages, type Registry } from '@kosh/ui';
import type { i18n } from 'i18next';
import { messages } from './messages.js';
import { PagePreview } from './PagePreview.js';

export { PagePreview } from './PagePreview.js';

/** Registers the component (and the messages in `i18n`, when given). */
export function registerWebsiteWeb(registry: Registry, i18n?: i18n): Registry {
  registry.registerComponent('sites.Preview', PagePreview);
  if (i18n !== undefined) addMessages(i18n, 'website', messages);
  return registry;
}

export { messages as websiteMessages };
