/**
 * @packageDocumentation
 * The web contribution of `@kosh/integrations`: the tools on a webhook's form (test event, new secret, the events
 * offered) and on a delivery's (send again).
 */
import { addMessages, type Registry } from '@kosh/ui';
import type { i18n } from 'i18next';
import { DeliveryTools } from './DeliveryTools.js';
import { messages } from './messages.js';
import { WebhookTools } from './WebhookTools.js';

export { DeliveryTools } from './DeliveryTools.js';
export { WebhookTools } from './WebhookTools.js';

/** Registers the components (and the messages in `i18n`, when given). */
export function registerIntegrationsWeb(registry: Registry, i18n?: i18n): Registry {
  registry.registerComponent('integrations.WebhookTools', WebhookTools);
  registry.registerComponent('integrations.DeliveryTools', DeliveryTools);
  if (i18n !== undefined) addMessages(i18n, 'integrations', messages);
  return registry;
}

export { messages as integrationsMessages };
