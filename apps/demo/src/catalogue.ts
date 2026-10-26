/** The demo's catalogue: every framework app and business app, with the bridges the planner proposes. */
import { accounting } from '@kosh/accounting';
import { contacts } from '@kosh/contacts';
import { messaging } from '@kosh/messaging';
import type { KoshModule } from '@kosh/modules-sdk';
import { notify } from '@kosh/notify';
import { permissions } from '@kosh/permissions';
import { product } from '@kosh/product';
import { project } from '@kosh/project';
import { purchase } from '@kosh/purchase';
import { purchaseAccount } from '@kosh/purchase_account';
import { realtime } from '@kosh/realtime';
import { reporting } from '@kosh/reporting';
import { saleAccount } from '@kosh/sale_account';
import { saleProject } from '@kosh/sale_project';
import { sales } from '@kosh/sales';
import { base } from '@kosh/server';
import { settings } from '@kosh/settings';

/** What the demo installs; the bridges come as proposals of the plan. */
export const DEMO_APPS: readonly string[] = [
  'settings',
  'realtime',
  'notify',
  'sales',
  'purchase',
  'accounting',
  'project',
];

export function demoCatalogue(): KoshModule[] {
  return [
    base,
    settings,
    realtime,
    notify,
    permissions,
    reporting,
    messaging,
    contacts,
    product,
    sales,
    purchase,
    accounting,
    project,
    saleAccount,
    purchaseAccount,
    saleProject,
  ];
}
