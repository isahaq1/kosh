/**
 * @packageDocumentation
 * The web contribution of `@kosh/assistant` (RFC 0013): "Ask" next to every search box (`assistant.Ask`), the
 * Settings → AI assistant page (`assistant.Settings`) and their messages.
 */
import { addMessages, type Registry } from '@kosh/ui';
import type { i18n } from 'i18next';
import { AskButton } from './AskButton.js';
import { AssistantSettings } from './AssistantSettings.js';
import { ChatterAssist } from './ChatterAssist.js';
import { messages } from './messages.js';

export { AskButton } from './AskButton.js';
export { AssistantSettings } from './AssistantSettings.js';
export { ChatterAssist } from './ChatterAssist.js';

/** Registers "Ask" and the settings page (and the messages in `i18n`, when given). */
export function registerAssistantWeb(registry: Registry, i18n?: i18n): Registry {
  registry.registerSearchAssist('assistant.Ask', AskButton);
  registry.registerChatterAssist('assistant.Chatter', ChatterAssist);
  registry.registerPage('assistant.Settings', AssistantSettings);
  if (i18n !== undefined) addMessages(i18n, 'assistant', messages);
  return registry;
}

export { messages as assistantMessages };
