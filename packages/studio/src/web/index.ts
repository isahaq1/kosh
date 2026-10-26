/**
 * @packageDocumentation
 * The web contribution of `@kosh/studio` (RFC 0012 §5.6): Studio mode (the header button `studio.Toggle`, with the
 * dialogs that add a field to a form section or a column to a list), the Studio app's page (`studio.Studio`: the
 * Studio modules and new models with a menu), the review (diff and SQL), and their messages.
 */
import { addMessages, type Registry } from '@kosh/ui';
import type { i18n } from 'i18next';
import { messages } from './messages.js';
import { StudioPage } from './StudioPage.js';
import { StudioToggle } from './StudioToggle.js';

export { ReviewDialog } from './Review.js';
export { StudioPage } from './StudioPage.js';
export { StudioToggle } from './StudioToggle.js';

/** Registers Studio mode, the Studio page (and the messages in `i18n`, when given). */
export function registerStudioWeb(registry: Registry, i18n?: i18n): Registry {
  registry.registerHeaderItem('studio.Toggle', StudioToggle);
  registry.registerPage('studio.Studio', StudioPage);
  if (i18n !== undefined) addMessages(i18n, 'studio', messages);
  return registry;
}

export { messages as studioMessages };
