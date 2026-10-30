/** The demo's catalogue: every framework app and business app, with the bridges the planner proposes. */
import { accounting } from '@kosh/accounting';
import { automation } from '@kosh/automation';
import { calendarApp } from '@kosh/calendar';
import { contacts } from '@kosh/contacts';
import { crm } from '@kosh/crm';
import { hr } from '@kosh/hr';
import { l10nBd } from '@kosh/l10n_bd';
import { mail } from '@kosh/mail';
import { maintenance } from '@kosh/maintenance';
import { messaging } from '@kosh/messaging';
import type { KoshModule } from '@kosh/modules-sdk';
import { mrp } from '@kosh/mrp';
import { mrpAccount } from '@kosh/mrp_account';
import { notify } from '@kosh/notify';
import { permissions } from '@kosh/permissions';
import { product } from '@kosh/product';
import { project } from '@kosh/project';
import { purchase } from '@kosh/purchase';
import { purchaseAccount } from '@kosh/purchase_account';
import { purchaseStock } from '@kosh/purchase_stock';
import { purchaseStockAccount } from '@kosh/purchase_stock_account';
import { realtime } from '@kosh/realtime';
import { recruitment } from '@kosh/recruitment';
import { reporting } from '@kosh/reporting';
import { saleAccount } from '@kosh/sale_account';
import { saleProject } from '@kosh/sale_project';
import { saleStock } from '@kosh/sale_stock';
import { sales } from '@kosh/sales';
import { base } from '@kosh/server';
import { settings } from '@kosh/settings';
import { stock } from '@kosh/stock';
import { stockAccount } from '@kosh/stock_account';
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
  'crm',
  'hr',
  'recruitment',
  'stock',
  'mrp',
  'maintenance',
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
    crm,
    hr,
    recruitment,
    stock,
    mrp,
    maintenance,
    saleAccount,
    purchaseAccount,
    saleProject,
    saleStock,
    purchaseStock,
    stockAccount,
    purchaseStockAccount,
    mrpAccount,
    l10nBd,
  ];
}
