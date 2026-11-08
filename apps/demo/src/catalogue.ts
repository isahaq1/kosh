/** The demo's catalogue: every framework app and business app, with the bridges the planner proposes. */
import { accountAsset } from '@kosh/account_asset';
import { accountBudget } from '@kosh/account_budget';
import { accounting } from '@kosh/accounting';
import { approvals } from '@kosh/approvals';
import { approvalsPurchase } from '@kosh/approvals_purchase';
import { attendance } from '@kosh/attendance';
import { automation } from '@kosh/automation';
import { calendarApp } from '@kosh/calendar';
import { contacts } from '@kosh/contacts';
import { crm } from '@kosh/crm';
import { documents } from '@kosh/documents';
import { event } from '@kosh/event';
import { eventAccount } from '@kosh/event_account';
import { expense } from '@kosh/expense';
import { expenseAccount } from '@kosh/expense_account';
import { helpdesk } from '@kosh/helpdesk';
import { hr } from '@kosh/hr';
import { indent } from '@kosh/indent';
import { l10nBd } from '@kosh/l10n_bd';
import { l10nBdPayroll } from '@kosh/l10n_bd_payroll';
import { l10nBdPos } from '@kosh/l10n_bd_pos';
import { mail } from '@kosh/mail';
import { maintenance } from '@kosh/maintenance';
import { maintenanceStock } from '@kosh/maintenance_stock';
import { messaging } from '@kosh/messaging';
import type { KoshModule } from '@kosh/modules-sdk';
import { mrp } from '@kosh/mrp';
import { mrpAccount } from '@kosh/mrp_account';
import { notify } from '@kosh/notify';
import { payroll } from '@kosh/payroll';
import { payrollAccount } from '@kosh/payroll_account';
import { permissions } from '@kosh/permissions';
import { pos } from '@kosh/pos';
import { posStock } from '@kosh/pos_stock';
import { product } from '@kosh/product';
import { project } from '@kosh/project';
import { projectAccount } from '@kosh/project_account';
import { projectPurchase } from '@kosh/project_purchase';
import { purchase } from '@kosh/purchase';
import { purchaseAccount } from '@kosh/purchase_account';
import { purchaseStock } from '@kosh/purchase_stock';
import { purchaseStockAccount } from '@kosh/purchase_stock_account';
import { realtime } from '@kosh/realtime';
import { recruitment } from '@kosh/recruitment';
import { reporting } from '@kosh/reporting';
import { saleAccount } from '@kosh/sale_account';
import { saleCrm } from '@kosh/sale_crm';
import { saleProject } from '@kosh/sale_project';
import { saleStock } from '@kosh/sale_stock';
import { sales } from '@kosh/sales';
import { base } from '@kosh/server';
import { settings } from '@kosh/settings';
import { sign } from '@kosh/sign';
import { stock } from '@kosh/stock';
import { stockAccount } from '@kosh/stock_account';
import { todo } from '@kosh/todo';
import { tradeFinance } from '@kosh/trade_finance';
import { tradeFinanceAccount } from '@kosh/trade_finance_account';
import { tradeFinancePurchase } from '@kosh/trade_finance_purchase';
import { tradeFinanceSale } from '@kosh/trade_finance_sale';
import { website } from '@kosh/website';
import { websiteCrm } from '@kosh/website_crm';
import { websiteSale } from '@kosh/website_sale';
import { websiteSaleStock } from '@kosh/website_sale_stock';

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
  'trade_finance',
  'event',
  'website',
  'pos',
  'expense',
  'indent',
  'attendance',
  'payroll',
  'helpdesk',
  'documents',
  'sign',
  'approvals',
  'account_asset',
  'account_budget',
  'website_sale',
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
    tradeFinance,
    event,
    website,
    pos,
    expense,
    indent,
    attendance,
    payroll,
    helpdesk,
    documents,
    sign,
    approvals,
    accountAsset,
    saleAccount,
    purchaseAccount,
    accountBudget,
    saleProject,
    projectAccount,
    projectPurchase,
    approvalsPurchase,
    saleStock,
    purchaseStock,
    stockAccount,
    purchaseStockAccount,
    mrpAccount,
    maintenanceStock,
    tradeFinanceAccount,
    tradeFinancePurchase,
    tradeFinanceSale,
    eventAccount,
    websiteCrm,
    saleCrm,
    websiteSale,
    websiteSaleStock,
    posStock,
    expenseAccount,
    payrollAccount,
    l10nBd,
    l10nBdPayroll,
    l10nBdPos,
  ];
}
