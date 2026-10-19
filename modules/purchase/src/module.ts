/**
 * The data layer of Purchase (Shutro): requests for quotation and purchase orders to vendors. Numbered when created
 * (PO/2026/00001), amounts computed from the lines in the order's currency, prices defaulting to the product cost,
 * and multi-level approvals (RFC 0003 §5.3): submitting an order asks the approvers its amount needs; the last
 * approval confirms it, a rejection sends it back to draft. Buyers see their own orders; managers see all.
 */
import { contactsShutro } from '@kosh/contacts';
import { messagingShutro } from '@kosh/messaging';
import { approvalGuard, permissionsShutro, requestApprovals } from '@kosh/permissions';
import { productShutro } from '@kosh/product';
import { orm } from '@kosh/server/orm';
import {
  check,
  compute,
  defineModel,
  defineModule,
  type Env,
  f,
  onchange,
  records,
} from './.kosh/bindings.js';

const amounts = compute(
  'purchase.order',
  ['amountUntaxed', 'amountTax', 'amountTotal'],
  ['lines.subtotal', 'lines.taxAmount'],
  (orders) => {
    for (const o of orders) {
      const untaxed = o.lines.sum('subtotal', o.currency);
      const tax = o.lines.sum('taxAmount', o.currency);
      o.amountUntaxed = untaxed;
      o.amountTax = tax;
      o.amountTotal = untaxed.plus(tax);
    }
  },
);

export const PurchaseOrder = defineModel('purchase.order', {
  label: 'Purchase order',
  companyScoped: { required: true },
  order: ['dateOrder desc', 'id desc'],
  tracking: ['partner', 'amountTotal', 'state'],
  access: {
    'purchase.user': ['read', 'write', 'create'],
    'purchase.manager': ['read', 'write', 'create', 'unlink', 'export', 'import'],
  },
  rules: {
    own: { groups: ['purchase.user'], perms: ['read', 'write'], domain: { user: { $env: 'uid' } } },
    all: { groups: ['purchase.manager'], perms: ['read', 'write', 'create', 'unlink'], domain: {} },
  },
  fields: {
    name: f.char({
      required: true,
      readonly: true,
      sequence: { code: 'purchase.order', dateField: 'dateOrder' },
      label: 'Number',
    }),
    user: f.many2one('res.users', {
      required: true,
      default: (env: Env) => env.userId,
      label: 'Buyer',
    }),
    partner: f.many2one('res.partner', { required: true, checkCompany: true, label: 'Vendor' }),
    partnerReference: f.char({ label: 'Vendor reference' }),
    currency: f.many2one('res.currency', { required: true }),
    dateOrder: f.date({ required: true, default: (env: Env) => env.today(), label: 'Order date' }),
    datePlanned: f.date({ label: 'Expected arrival' }),
    origin: f.char({ label: 'Source document' }),
    note: f.text({ label: 'Terms and conditions' }),
    lines: f.one2many('purchase.order.line', 'order'),
    amountUntaxed: f.monetary({ currency: 'currency', store: true, label: 'Untaxed', ...amounts }),
    amountTax: f.monetary({ currency: 'currency', store: true, label: 'Taxes', ...amounts }),
    amountTotal: f.monetary({ currency: 'currency', store: true, label: 'Total', ...amounts }),
    state: f.state({
      states: {
        draft: 'RFQ',
        sent: 'RFQ sent',
        to_approve: 'Waiting approval',
        purchase: 'Purchase order',
        done: 'Locked',
        cancel: 'Cancelled',
      },
      initial: 'draft',
      transitions: {
        send: { from: ['draft'], to: 'sent' },
        submit: {
          from: ['draft', 'sent'],
          to: 'to_approve',
          guard: records('purchase.order', async (orders) => {
            const loaded = await orders.load({ lines: true });
            return loaded.filter((o) => o.lines.length === 0);
          }),
          message: 'Add at least one line before submitting the order.',
          after: records('purchase.order', (orders) => requestApprovals(orders)),
        },
        confirm: {
          from: ['to_approve'],
          to: 'purchase',
          guard: records('purchase.order', (orders) => approvalGuard(orders)),
          message: 'Waiting for approvals.',
        },
        reject: { from: ['to_approve'], to: 'draft' },
        lock: { from: ['purchase'], to: 'done' },
        unlock: { from: ['done'], to: 'purchase' },
        cancel: { from: ['draft', 'sent', 'to_approve', 'purchase'], to: 'cancel' },
        redraft: { from: ['cancel'], to: 'draft' },
      },
      extensible: true, // Accounting adds billing through its bridge
    }),
  },
  onchange: {
    // The vendor's currency, else the company's.
    partner: onchange('purchase.order', async (d, env) => {
      const p = await d.record('partner');
      if (p?.currency) {
        d.set('currency', p.currency.id);
        return;
      }
      const [company] = await env
        .model('res.company')
        .browse([env.companyId])
        .load({ currency: true });
      if (company !== undefined) d.set('currency', company.currency.id);
    }),
  },
});

export const PurchaseOrderLine = defineModel('purchase.order.line', {
  label: 'Purchase line',
  access: {
    'purchase.user': ['read', 'write', 'create', 'unlink'],
    'purchase.manager': ['read', 'write', 'create', 'unlink'],
  },
  fields: {
    order: f.many2one('purchase.order', { required: true, ondelete: 'cascade' }),
    product: f.many2one('product.product', { required: true }),
    name: f.char({ required: true, label: 'Description' }),
    quantity: f.decimal({ scale: 3, required: true, default: '1' }),
    uom: f.many2one('uom.uom', { label: 'Unit' }),
    priceUnit: f.decimal({ scale: 2, required: true, default: '0', label: 'Unit price' }),
    tax: f.many2one('account.tax'),
    datePlanned: f.date({ label: 'Expected arrival' }),
    currency: f.many2one('res.currency', {
      store: true,
      ...compute('purchase.order.line', 'currency', ['order.currency'], (lines) => {
        for (const l of lines) l.currency = l.order.currency.id;
      }),
    }),
    subtotal: f.monetary({
      currency: 'currency',
      store: true,
      ...compute('purchase.order.line', 'subtotal', ['quantity', 'priceUnit'], (lines) => {
        for (const l of lines) l.subtotal = l.quantity.times(l.priceUnit);
      }),
    }),
    taxAmount: f.monetary({
      currency: 'currency',
      store: true,
      label: 'Tax',
      ...compute('purchase.order.line', 'taxAmount', ['subtotal', 'tax.rate'], (lines) => {
        for (const l of lines)
          l.taxAmount = (l.subtotal?.amount ?? orm.toDecimal(0)).times(l.tax?.rate ?? 0);
      }),
    }),
  },
  onchange: {
    product: onchange('purchase.order.line', async (d) => {
      const p = await d.record('product');
      if (p === null) return;
      d.set('name', p.name);
      d.set('priceUnit', p.standardPrice);
      d.set('uom', p.uom?.id ?? null);
      d.set('tax', p.purchaseTax?.id ?? null);
    }),
  },
  constraints: {
    positiveQuantity: {
      ...check('purchase.order.line', ['quantity'], (lines) =>
        lines.filter((l) => l.quantity.lte(0)),
      ),
      message: 'Line quantities must be positive.',
    },
  },
});

export const purchaseShutro = defineModule({
  name: 'purchase',
  version: '0.1.0',
  depends: [contactsShutro, productShutro, messagingShutro, permissionsShutro],
  groups: [
    orm.defineGroup({
      code: 'purchase.user',
      label: 'Buyer',
      implies: ['contacts.user', 'product.user', 'messaging.user'],
    }),
    orm.defineGroup({
      code: 'purchase.manager',
      label: 'Purchase manager',
      implies: ['purchase.user'],
    }),
    orm.defineGroup({
      code: 'purchase.director',
      label: 'Purchase director',
      implies: ['purchase.manager'],
    }),
  ],
  sequences: [
    orm.defineSequence({
      code: 'purchase.order',
      prefix: 'PO/{year}/',
      padding: 5,
      reset: 'yearly',
    }),
  ],
  models: [PurchaseOrder, PurchaseOrderLine],
});
