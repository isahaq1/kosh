/**
 * The data layer of the Approvals app (RFC 0025): the models are the engine's (`approval.policy`, `approval.level`,
 * `approval.request`, `approval.vote` in `@kosh/permissions`); this module adds the app around them.
 */
import { permissionsShutro } from '@kosh/permissions';
import { defineModule } from './.kosh/bindings.js';

export const approvalsShutro = defineModule({
  name: 'approvals',
  version: '0.1.0',
  depends: [permissionsShutro],
  models: [],
});
