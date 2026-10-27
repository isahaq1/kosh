/**
 * @packageDocumentation
 * The back-office contribution of `@kosh/portal` (RFC 0015): "Portal access" on the contact form
 * (`portal.Access`) and its messages.
 */
import { addMessages, type Registry } from '@kosh/ui';
import type { i18n } from 'i18next';
import { messages } from './messages.js';
import { PortalAccess } from './PortalAccess.js';

export { PortalAccess } from './PortalAccess.js';

/** Registers "Portal access" (and the messages in `i18n`, when given). */
export function registerPortalWeb(registry: Registry, i18n?: i18n): Registry {
  registry.registerComponent('portal.Access', PortalAccess);
  if (i18n !== undefined) addMessages(i18n, 'portal', messages);
  return registry;
}

export { messages as portalMessages };
