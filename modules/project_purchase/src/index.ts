/**
 * @packageDocumentation
 * `@kosh/project_purchase`: the bridge between Projects and Purchase (RFC 0026 step 4). Proposed whenever both apps
 * (and Accounting) are installed. Purchase orders on a project's cost centre, confirmed and not billed yet, are its
 * committed costs against its budget.
 */
import { defineModule } from '@kosh/modules-sdk';
import { project } from '@kosh/project';
import { projectAccount } from '@kosh/project_account';
import { purchase } from '@kosh/purchase';
import { purchaseAccount } from '@kosh/purchase_account';
import { projectPurchaseShutro } from './module.js';

export { ProjectCommitted, projectPurchaseShutro } from './module.js';

export const projectPurchase: ReturnType<typeof defineModule> = defineModule({
  shutro: projectPurchaseShutro,
  kosh: '^0.1.0',
  depends: [project, projectAccount, purchase, purchaseAccount],
  bridge: [project, purchase],
  accessLevels: {
    user: { label: 'Projects with their purchases', groups: ['project_purchase.user'] },
  },
});
