/**
 * @packageDocumentation
 * `@kosh/project_account`: the bridge between Projects and Accounting (RFC 0026 step 4). Proposed whenever both apps
 * are installed. Each project gets its cost centre; the costs booked on it are the project's actual costs, next to
 * labour from timesheets, against its budget.
 */
import { accounting } from '@kosh/accounting';
import { defineModule } from '@kosh/modules-sdk';
import { project } from '@kosh/project';
import { field } from '@kosh/views';
import { projectAccountShutro } from './module.js';

export { ProjectCostCentre, projectAccountShutro } from './module.js';

export const projectAccount: ReturnType<typeof defineModule> = defineModule({
  shutro: projectAccountShutro,
  kosh: '^0.1.0',
  depends: [project, accounting],
  bridge: [project, accounting],
  // Bangla for the labels it serves (RFC 0023 §3.1; `pnpm i18n:extract`).
  i18n: { bn: () => import('./i18n/bn.js') },
  accessLevels: {
    user: { label: 'Projects with their costs', groups: ['project_account.user'] },
  },
  viewExtensions: [
    {
      view: 'project.project.form',
      operations: [{ append: 'money', nodes: [field({ field: 'analytic', id: 'cost_centre' })] }],
    },
  ],
});
