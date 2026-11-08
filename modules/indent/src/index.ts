/**
 * @packageDocumentation
 * `@kosh/indent` (RFC 0032 §3.1): the **Requests** app. A section asks its store for goods by an indent; the
 * department head and the approvers of the products' groups decide it through the approval engine, lowering
 * quantities when needed; the store issues what was approved by Stockroom transfers — partly or at once — and the
 * requester acknowledges what arrived. What each line still owes is always on screen.
 */
import { hr } from '@kosh/hr';
import { defineModule } from '@kosh/modules-sdk';
import { permissions } from '@kosh/permissions';
import { product } from '@kosh/product';
import { reporting } from '@kosh/reporting';
import { stock } from '@kosh/stock';
import { action, field, form, kanban, list, pivot, search } from '@kosh/views';
import { indentDemo } from './demo.js';
import { IndentProductGroup, IndentRequest, IndentRequestLine, indentShutro } from './module.js';

export { IndentProductGroup, IndentRequest, IndentRequestLine, indentShutro } from './module.js';

export const indent: ReturnType<typeof defineModule> = defineModule({
  shutro: indentShutro,
  kosh: '^0.1.0',
  hooks: { demo: indentDemo },
  depends: [hr, product, stock, permissions, reporting],
  standard: {
    waive: [
      {
        rule: 'I1',
        model: 'indent.request.line',
        reason: 'Lines import with their indent (the indents template).',
      },
    ],
  },
  app: {
    code: 'requests',
    label: 'Requests',
    icon: 'requests',
    sequence: 24,
    category: 'Supply chain',
    summary: 'Indents to the store: approved, issued and acknowledged',
  },
  i18n: { bn: () => import('./i18n/bn.js') },
  accessLevels: {
    user: { label: 'Requester (own indents; decides those named for)', groups: ['indent.user'] },
    store: {
      label: 'Store keeper (issues indents)',
      groups: ['indent.store'],
      implies: ['user'],
    },
    manager: {
      label: 'Requests manager (product groups, everything)',
      groups: ['indent.manager'],
      implies: ['store'],
    },
  },
  // Stockroom's transfers say which indent and which note they are.
  viewExtensions: [
    {
      view: 'stock.picking.form',
      operations: [
        {
          append: 'when',
          nodes: [
            field({ field: 'indent', id: 'indent' }),
            field({ field: 'noteKind', id: 'indent_note' }),
          ],
        },
      ],
    },
  ],
  approvals: [
    {
      name: 'Indent approvals',
      model: 'indent.request',
      onApproved: 'approve',
      onRejected: 'reject',
      levels: [
        {
          name: 'Department head',
          condition: {},
          approver: 'department_head',
          approverRole: 'indent.manager',
        },
        {
          name: 'Product group approvers',
          condition: {},
          approver: { record: 'groups' },
          approverRole: 'indent.manager',
        },
      ],
    },
  ],
  events: [
    { topic: 'indent.request.submitted', model: 'indent.request', label: 'Indent submitted' },
    { topic: 'indent.request.approved', model: 'indent.request', label: 'Indent approved' },
    { topic: 'indent.request.issued', model: 'indent.request', label: 'Indent issued' },
    {
      topic: 'indent.request.shipped',
      model: 'indent.request',
      label: 'Transfer shipped into transit',
    },
    {
      topic: 'indent.request.acknowledged',
      model: 'indent.request',
      label: 'Indent acknowledged',
    },
  ],
  documents: [
    {
      key: 'indent',
      name: 'Indent',
      model: 'indent.request',
      layout: {
        paper: 'A4',
        header: '{{company.name}}',
        footer: 'Page {{page}} of {{pages}}',
        blocks: [
          { kind: 'heading', id: 'title', text: 'Indent {{name}}', level: 1 },
          {
            kind: 'fields',
            id: 'who',
            items: [
              { label: 'Requested by', bind: 'requester.name' },
              { label: 'Department', bind: 'department.name' },
              { label: 'Request', bind: 'kind' },
              { label: 'Store', bind: 'warehouse.name' },
              { label: 'Goes to', bind: 'destination.name' },
              { label: 'Needed by', bind: 'dateRequired' },
              { label: 'Priority', bind: 'priority' },
              { label: 'Status', bind: 'state' },
            ],
          },
          {
            kind: 'table',
            id: 'lines',
            bind: 'lines',
            columns: [
              { label: 'Product', bind: 'product.name' },
              { label: 'Group', bind: 'group.name' },
              { label: 'Unit', bind: 'uom.name' },
              { label: 'Requested', bind: 'quantity' },
              { label: 'Approved', bind: 'qtyApproved' },
              { label: 'Shipped', bind: 'qtyShipped' },
              { label: 'Issued', bind: 'qtyIssued' },
              { label: 'Short', bind: 'qtyShort' },
            ],
          },
          { kind: 'text', id: 'purpose', text: '{{purpose}}' },
          {
            kind: 'text',
            id: 'signatures',
            text: 'Requested by: ____________   Approved by: ____________   Issued by: ____________   Received by: ____________',
          },
          { kind: 'qr', id: 'qr', bind: 'name', size: 24, label: 'Indent reference' },
        ],
      },
    },
  ],
  importTemplates: [
    {
      key: 'indents',
      model: 'indent.request',
      label: 'Indents',
      columns: [
        { header: 'Requested by', field: 'requester' },
        { header: 'Store', field: 'warehouse' },
        { header: 'Request', field: 'kind' },
        { header: 'Goes to', field: 'destination' },
        { header: 'Needed by', field: 'dateRequired' },
        { header: 'Priority', field: 'priority' },
        { header: 'Purpose', field: 'purpose' },
        { header: 'Lines › Product', field: 'lines.product' },
        { header: 'Lines › Quantity', field: 'lines.quantity' },
      ],
    },
    {
      key: 'product_groups',
      model: 'indent.product.group',
      label: 'Product groups',
      columns: [
        { header: 'Name', field: 'name' },
        { header: 'Product categories', field: 'categories' },
        { header: 'Approvers', field: 'approvalUsers' },
      ],
    },
  ],
  overview: {
    cards: [
      {
        id: 'waiting',
        title: 'Waiting for approval',
        kind: 'kpi',
        model: 'indent.request',
        measure: 'count',
        filter: { state: 'to_approve' },
        w: 3,
      },
      {
        id: 'to_issue',
        title: 'Approved, to issue',
        kind: 'kpi',
        model: 'indent.request',
        measure: 'count',
        filter: { state: 'approved', issueStatus: { ne: 'full' } },
        w: 3,
      },
      {
        id: 'to_acknowledge',
        title: 'Issued, to acknowledge',
        kind: 'kpi',
        model: 'indent.request',
        measure: 'count',
        filter: { state: 'approved', issueStatus: 'full' },
        w: 3,
      },
      {
        id: 'this_month',
        title: 'Indents this month',
        kind: 'kpi',
        model: 'indent.request',
        measure: 'count',
        comparison: { field: 'dateRequired', mode: 'previous' },
        w: 3,
      },
      {
        id: 'by_department',
        title: 'By department',
        kind: 'chart',
        model: 'indent.request',
        measure: 'count',
        groupBy: 'department',
        chart: 'bar',
        w: 6,
      },
      {
        id: 'by_state',
        title: 'By status',
        kind: 'chart',
        model: 'indent.request',
        measure: 'count',
        groupBy: 'state',
        chart: 'pie',
        w: 6,
      },
      {
        id: 'owed',
        title: 'Still owed by product',
        kind: 'pivot',
        model: 'indent.request.line',
        measure: 'sum:qtyRemaining',
        groupBy: 'product',
        filter: { qtyRemaining: { gt: '0' } },
        w: 12,
      },
    ],
  },
  actions: {
    'requests.action_indents': action(IndentRequest, {
      label: 'Indents',
      views: ['list', 'kanban', 'form'],
    }),
    'requests.action_to_issue': action(IndentRequest, {
      label: 'To issue',
      views: ['list', 'form'],
      domain: { state: 'approved', issueStatus: { ne: 'full' } },
    }),
    'requests.action_lines': action(IndentRequestLine, {
      label: 'Indent lines',
      views: ['list', 'pivot'],
    }),
    'requests.action_groups': action(IndentProductGroup, {
      label: 'Product groups',
      views: ['list', 'form'],
    }),
  },
  menus: [
    { id: 'requests.root', label: 'Requests', app: 'requests' },
    {
      id: 'requests.indents',
      parent: 'requests.root',
      label: 'Indents',
      action: 'requests.action_indents',
      sequence: 1,
    },
    {
      id: 'requests.to_issue',
      parent: 'requests.root',
      label: 'To issue',
      action: 'requests.action_to_issue',
      sequence: 2,
      visibleTo: ['indent.store'],
    },
    {
      id: 'requests.lines',
      parent: 'requests.root',
      label: 'Indent lines',
      action: 'requests.action_lines',
      sequence: 3,
    },
    { id: 'requests.configuration', parent: 'requests.root', label: 'Configuration', sequence: 9 },
    {
      id: 'requests.groups',
      parent: 'requests.configuration',
      label: 'Product groups',
      action: 'requests.action_groups',
      sequence: 1,
    },
  ],
  views: {
    'indent.request.list': list(IndentRequest, {
      columns: [
        'name',
        'kind',
        'requester',
        'department',
        'warehouse',
        'dateRequired',
        { field: 'priority', widget: 'priority' },
        'issueStatus',
        'state',
      ],
      decorations: { danger: { priority: 'critical' }, warning: { priority: 'urgent' } },
    }),
    'indent.request.kanban': kanban(IndentRequest, {
      groupBy: 'state',
      card: {
        title: 'name',
        subtitle: 'requester',
        footer: ['warehouse', { field: 'priority', widget: 'priority' }],
      },
    }),
    'indent.request.form': form(IndentRequest, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('submit', { primary: true, label: 'Submit for approval' }),
          k.button('issue', { primary: true, label: 'Issue' }),
          k.button('shortage', {
            label: 'Write off the shortage',
            confirm: 'Write off what is still in transit for this indent?',
          }),
          k.button('acknowledge', { primary: true, label: 'Acknowledge receipt' }),
          k.button('redraft', { label: 'Set to draft' }),
          k.button('cancel', { label: 'Cancel', confirm: 'Cancel this indent?' }),
        ],
      },
      sheet: [
        k.group('main', ['name', 'kind', 'requester', 'employee', 'department', 'purpose']),
        k.group('store', [
          'warehouse',
          'destination',
          'dateRequired',
          { field: 'priority', widget: 'priority' },
          'issueStatus',
        ]),
        k.component('approvals', 'approvals.Panel'),
        k.lines('lines', [
          'product',
          'group',
          'uom',
          'quantity',
          'qtyApproved',
          'qtyShipped',
          'inTransit',
          'qtyIssued',
          'qtyShort',
          'qtyRemaining',
          'onHand',
          'note',
        ]),
        k.lines('pickings', [
          { field: 'name', id: 'picking_name' },
          { field: 'noteKind', id: 'picking_note' },
          { field: 'scheduledDate', id: 'picking_date' },
          { field: 'state', id: 'picking_state' },
        ]),
        k.group('after', ['rejectReason', 'shortageReason', 'acknowledgedOn'], {
          label: 'Decision and receipt',
        }),
      ],
      chatter: true,
    })),
    'indent.request.line.list': list(IndentRequestLine, {
      columns: [
        'request',
        'product',
        'group',
        'uom',
        'quantity',
        'qtyApproved',
        'qtyIssued',
        'qtyRemaining',
      ],
    }),
    'indent.request.line.pivot': pivot(IndentRequestLine, {
      rows: ['product'],
      cols: ['group'],
      measures: [{ sum: 'qtyApproved' }, { sum: 'qtyIssued' }],
    }),
    'indent.product.group.list': list(IndentProductGroup, {
      columns: ['name', 'categories', 'approvalUsers'],
    }),
    'indent.product.group.form': form(IndentProductGroup, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.group('main', ['name', 'categories', 'approvalUsers'], {
          description:
            'Indents for products of these categories are approved by these people after the department head.',
        }),
        k.group('guidance', ['note'], { label: 'Guidance for requesters' }),
      ],
    })),
  },
  search: {
    'indent.request': search(IndentRequest, {
      fields: ['name', 'purpose', 'requester.name', 'lines.product.name'],
      filters: {
        mine: { label: 'Mine', domain: { requester: { $env: 'uid' } }, group: 'who' },
        waiting: { label: 'Waiting for approval', domain: { state: 'to_approve' }, group: 'state' },
        to_issue: {
          label: 'To issue',
          domain: { state: 'approved', issueStatus: { ne: 'full' } },
          group: 'state',
        },
        to_acknowledge: {
          label: 'To acknowledge',
          domain: { state: 'approved', issueStatus: 'full' },
          group: 'state',
        },
        transfers: { label: 'Transfers', domain: { kind: 'transfer' }, group: 'kind' },
        in_transit: {
          label: 'In transit',
          domain: { pickings: { any: { noteKind: 'srn', state: 'confirmed' } } },
          group: 'state',
        },
        urgent: {
          label: 'Urgent',
          domain: { priority: { in: ['urgent', 'critical'] } },
          group: 'priority',
        },
      },
      groupBy: ['kind', 'department', 'warehouse', 'state', 'dateRequired:month'],
    }),
    'indent.request.line': search(IndentRequestLine, {
      fields: ['product.name', 'request.name'],
      filters: {
        owed: { label: 'Still owed', domain: { qtyRemaining: { gt: '0' } }, group: 'state' },
      },
      groupBy: ['product', 'group', 'request'],
    }),
    'indent.product.group': search(IndentProductGroup, { fields: ['name'] }),
  },
});
