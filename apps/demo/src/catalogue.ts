/** The demo's catalogue: every framework app and business app, with the bridges the planner proposes. */
import { accounting } from '@kosh/accounting';
import { automation } from '@kosh/automation';
import { calendarApp } from '@kosh/calendar';
import { contacts } from '@kosh/contacts';
import { l10nBd } from '@kosh/l10n_bd';
import { mail } from '@kosh/mail';
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
import { todo } from '@kosh/todo';

/** What the demo installs; the bridges come as proposals of the plan. */
export const DEMO_APPS: readonly string[] = [
  'settings',
  'realtime',
  'notify',
  'mail',
  'automation',
  'sales',
  'purchase',
  'accounting',
  'project',
  'todo',
  'calendar',
  'l10n_bd',
];

export function demoCatalogue(): KoshModule[] {
  return [
    base,
    settings,
    realtime,
    notify,
    mail,
    automation,
    permissions,
    reporting,
    messaging,
    contacts,
    product,
    sales,
    purchase,
    accounting,
    project,
    todo,
    calendarApp,
    saleAccount,
    purchaseAccount,
    saleProject,
    l10nBd,
  ];
}
