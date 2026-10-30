/**
 * @packageDocumentation
 * The web contribution of `@kosh/recruitment`: the "Hire" button on applicants.
 */
import { addMessages, type Registry } from '@kosh/ui';
import type { i18n } from 'i18next';
import { HireButton } from './HireButton.js';
import { messages } from './messages.js';

export { HireButton } from './HireButton.js';

/** Registers the component (and the messages in `i18n`, when given). */
export function registerRecruitmentWeb(registry: Registry, i18n?: i18n): Registry {
  registry.registerComponent('hiring.Hire', HireButton);
  if (i18n !== undefined) addMessages(i18n, 'recruitment', messages);
  return registry;
}

export { messages as recruitmentMessages };
