/**
 * @packageDocumentation
 * The web contribution of `@kosh/permissions` (RFC 0007 §5): register it in the app's registry.
 */
import type { Registry } from '@kosh/ui';
import { ApprovalPanel } from './ApprovalPanel.js';

export { ApprovalPanel };

/** Registers `approvals.Panel`. */
export function registerPermissionsWeb(registry: Registry): Registry {
  return registry.registerComponent('approvals.Panel', ApprovalPanel);
}
