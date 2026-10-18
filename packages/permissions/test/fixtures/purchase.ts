/**
 * A small "purchase" app for permission tests: orders with a state machine wired to multi-level approvals, an
 * action permission (cancel), record rules (requesters see their own orders, approvers all), and default approval
 * policies in the manifest (department head above 50 000, finance director above 500 000).
 */
import { defineModule as defineKoshModule } from '@kosh/modules-sdk';
import { baseShutro } from '@kosh/server';
import { orm } from '@kosh/server/orm';
import {
  approvalGuard,
  permissions,
  permissionsShutro,
  requestApprovals,
} from '../../src/index.js';

const { defineGroup, defineModel, defineModule, definePermission, f } = orm;

const PurchaseOrder = defineModel('purchase.order', {
  companyScoped: { required: true },
  access: {
    'purchase.user': ['read', 'write', 'create'],
    'purchase.manager': ['read', 'write', 'create', 'unlink', 'export', 'import'],
  },
  rules: {
    own: {
      groups: ['purchase.user'],
      perms: ['read', 'write'],
      domain: { createdBy: { $env: 'uid' } },
    },
    all: { groups: ['purchase.approver'], perms: ['read', 'write'], domain: {} },
  },
  fields: {
    name: f.char({ required: true }),
    vendor: f.char(),
    amountTotal: f.decimal({ scale: 2, required: true, default: '0' }),
    internalNote: f.char(),
    state: f.state({
      states: {
        draft: 'Draft',
        submitted: 'Submitted',
        approved: 'Approved',
        rejected: 'Rejected',
        cancelled: 'Cancelled',
      },
      initial: 'draft',
      transitions: {
        submit: {
          from: ['draft', 'rejected'],
          to: 'submitted',
          after: (orders: never) => requestApprovals(orders),
        },
        approve: {
          from: ['submitted'],
          to: 'approved',
          guard: (orders: never) => approvalGuard(orders),
          message: 'Waiting for approvals.',
        },
        reject: { from: ['submitted'], to: 'rejected' },
        cancel: {
          from: ['draft', 'submitted', 'approved'],
          to: 'cancelled',
          requires: 'purchase.cancel',
        },
      },
    }),
  },
});

const purchaseShutro = defineModule({
  name: 'purchase',
  version: '0.1.0',
  depends: [baseShutro, permissionsShutro],
  groups: [
    defineGroup({ code: 'purchase.user', label: 'Requester', implies: ['base.user'] }),
    defineGroup({ code: 'purchase.approver', label: 'Approver', implies: ['purchase.user'] }),
    defineGroup({ code: 'purchase.manager', label: 'Manager', implies: ['purchase.approver'] }),
  ],
  permissions: [
    definePermission({
      code: 'purchase.cancel',
      label: 'Cancel purchase orders',
      groups: ['purchase.manager'],
    }),
  ],
  models: [PurchaseOrder],
});

export const purchase = defineKoshModule({
  shutro: purchaseShutro,
  kosh: '^0.1.0',
  depends: [permissions],
  app: { code: 'purchase', label: 'Purchase', icon: 'cart' },
  accessLevels: {
    user: { label: 'Requester', groups: ['purchase.user'] },
    approver: { label: 'Approver', groups: ['purchase.approver'], implies: ['user'] },
    manager: { label: 'Manager', groups: ['purchase.manager'], implies: ['approver'] },
  },
  actions: {
    'purchase.action_orders': { model: 'purchase.order' },
    'purchase.action_settings': { model: 'purchase.order', visibleTo: ['purchase.manager'] },
  },
  menus: [
    { id: 'purchase.root', label: 'Purchase', app: 'purchase' },
    {
      id: 'purchase.orders',
      parent: 'purchase.root',
      label: 'Orders',
      action: 'purchase.action_orders',
    },
    {
      id: 'purchase.settings',
      parent: 'purchase.root',
      label: 'Settings',
      action: 'purchase.action_settings',
    },
  ],
  approvals: [
    {
      name: 'Purchase approvals',
      model: 'purchase.order',
      onApproved: 'approve',
      onRejected: 'reject',
      levels: [
        {
          name: 'Department head',
          condition: { amountTotal: { gt: '50000' } },
          approverRole: 'purchase.approver',
        },
        {
          name: 'Finance director',
          condition: { amountTotal: { gt: '500000' } },
          approverRole: 'company.finance_director',
        },
      ],
    },
  ],
});
