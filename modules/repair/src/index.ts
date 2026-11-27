/**
 * @packageDocumentation
 * `@kosh/repair`: Repairs (RFC 0038, step 4) — a customer's item taken in, diagnosed, quoted with its parts and
 * labour, accepted or declined, repaired and handed back; under warranty or charged.
 */
import { contacts } from '@kosh/contacts';
import { messaging } from '@kosh/messaging';
import { defineModule } from '@kosh/modules-sdk';
import { product } from '@kosh/product';
import { reporting } from '@kosh/reporting';
import { action, calendar, form, kanban, list, search, stat } from '@kosh/views';
import { repairDemo } from './demo.js';
import { RepairLine, RepairOrder, repairShutro } from './module.js';

export { OPEN_STATES, RepairLine, RepairOrder, repairShutro } from './module.js';

const OPEN = ['received', 'diagnosed', 'quoted', 'approved', 'repairing'];

export const repair: ReturnType<typeof defineModule> = defineModule({
  shutro: repairShutro,
  kosh: '^0.1.0',
  hooks: { demo: repairDemo },
  depends: [contacts, product, messaging, reporting],
  app: {
    code: 'repairs',
    label: 'Repairs',
    icon: 'repairs',
    sequence: 17,
    category: 'Operations',
    summary: 'Customers’ items taken in, diagnosed, quoted, repaired under warranty or charged',
  },
  // Bangla for the labels it serves (RFC 0023 §3.1; `pnpm i18n:extract`).
  i18n: { bn: () => import('./i18n/bn.js') },
  accessLevels: {
    user: { label: 'Technician (repair orders)', groups: ['repair.user'] },
    manager: {
      label: 'Repairs manager (deletes, imports, exports)',
      groups: ['repair.manager'],
      implies: ['user'],
    },
  },
  events: [
    { topic: 'repair.order.quoted', model: 'repair.order', label: 'Repair quoted' },
    { topic: 'repair.order.started', model: 'repair.order', label: 'Repair started' },
    { topic: 'repair.order.repaired', model: 'repair.order', label: 'Item repaired' },
    { topic: 'repair.order.returned', model: 'repair.order', label: 'Item handed back' },
  ],
  documents: [
    {
      key: 'repair_ticket',
      name: 'Repair ticket',
      model: 'repair.order',
      layout: {
        paper: 'A4',
        header: '{{company.name}}',
        footer: 'Page {{page}} of {{pages}}',
        blocks: [
          { kind: 'heading', id: 'title', text: 'Repair ticket {{name}}', level: 1 },
          {
            kind: 'fields',
            id: 'who',
            items: [
              { label: 'Customer', bind: 'partner.name' },
              { label: 'Received on', bind: 'receivedOn' },
              { label: 'Promised for', bind: 'dueDate' },
              { label: 'Item', bind: 'itemName' },
              { label: 'Serial number', bind: 'serial' },
              { label: 'Came with', bind: 'accessories' },
            ],
          },
          { kind: 'text', id: 'problem', text: '{{problem}}' },
          {
            kind: 'text',
            id: 'sign',
            text: 'Handed in by: ______________   Received by: ______________',
          },
        ],
      },
    },
    {
      key: 'repair_quotation',
      name: 'Repair quotation',
      model: 'repair.order',
      layout: {
        paper: 'A4',
        header: '{{company.name}}',
        footer: 'Page {{page}} of {{pages}}',
        blocks: [
          { kind: 'heading', id: 'title', text: 'Repair quotation {{name}}', level: 1 },
          {
            kind: 'fields',
            id: 'who',
            items: [
              { label: 'Customer', bind: 'partner.name' },
              { label: 'Item', bind: 'itemName' },
              { label: 'Serial number', bind: 'serial' },
            ],
          },
          { kind: 'text', id: 'diagnosis', text: '{{diagnosis}}' },
          {
            kind: 'table',
            id: 'lines',
            bind: 'lines',
            columns: [
              { label: 'What', bind: 'kind' },
              { label: 'Description', bind: 'name' },
              { label: 'Quantity', bind: 'quantity' },
              { label: 'Unit price', bind: 'priceUnit' },
              { label: 'Amount', bind: 'subtotal' },
            ],
          },
          {
            kind: 'fields',
            id: 'totals',
            items: [
              { label: 'Parts', bind: 'partsTotal' },
              { label: 'Labour', bind: 'labourTotal' },
              { label: 'To charge', bind: 'amountDue' },
            ],
          },
        ],
      },
    },
  ],
  importTemplates: [
    {
      key: 'repair_orders',
      model: 'repair.order',
      label: 'Repair orders',
      columns: [
        { header: 'Customer', field: 'partner' },
        { header: 'Item', field: 'itemName' },
        { header: 'Serial number', field: 'serial' },
        { header: 'Came with', field: 'accessories' },
        { header: 'Received on', field: 'receivedOn' },
        { header: 'Promised for', field: 'dueDate' },
        { header: 'What the customer says', field: 'problem' },
        { header: 'Under warranty', field: 'warranty' },
      ],
    },
  ],
  overview: {
    cards: [
      {
        id: 'in_workshop',
        title: 'In the workshop',
        kind: 'kpi',
        model: 'repair.order',
        measure: 'count',
        filter: { state: { in: OPEN } },
        w: 3,
      },
      {
        id: 'waiting_customer',
        title: 'Waiting for the customer',
        kind: 'kpi',
        model: 'repair.order',
        measure: 'count',
        filter: { state: 'quoted' },
        w: 3,
      },
      {
        id: 'to_hand_back',
        title: 'To hand back',
        kind: 'kpi',
        model: 'repair.order',
        measure: 'count',
        filter: { state: { in: ['repaired', 'declined'] } },
        w: 3,
      },
      {
        id: 'charged_month',
        title: 'Charged this month',
        kind: 'kpi',
        model: 'repair.order',
        measure: 'sum:amountDue',
        filter: { state: 'returned' },
        comparison: { field: 'returnedOn', mode: 'previous' },
        w: 3,
      },
      {
        id: 'by_state',
        title: 'Orders by state',
        kind: 'chart',
        model: 'repair.order',
        measure: 'count',
        groupBy: 'state',
        chart: 'bar',
        w: 6,
      },
      {
        id: 'by_technician',
        title: 'In the workshop by technician',
        kind: 'pivot',
        model: 'repair.order',
        measure: 'count',
        groupBy: 'technician',
        filter: { state: { in: OPEN } },
        w: 6,
      },
      {
        id: 'received_by_month',
        title: 'Items received by month',
        kind: 'chart',
        model: 'repair.order',
        measure: 'count',
        groupBy: 'receivedOn:month',
        chart: 'bar',
        w: 6,
      },
      {
        id: 'warranty_share',
        title: 'Under warranty or charged',
        kind: 'chart',
        model: 'repair.order',
        measure: 'count',
        groupBy: 'warranty',
        chart: 'pie',
        w: 6,
      },
    ],
  },
  actions: {
    'repair.action_orders': action(RepairOrder, {
      label: 'Repair orders',
      views: ['kanban', 'list', 'calendar', 'form'],
    }),
  },
  menus: [
    { id: 'repair.root', label: 'Repairs', app: 'repairs' },
    {
      id: 'repair.orders',
      parent: 'repair.root',
      label: 'Repair orders',
      action: 'repair.action_orders',
      sequence: 1,
    },
  ],
  viewExtensions: [
    {
      view: 'res.partner.form',
      operations: [
        {
          append: 'related',
          nodes: [
            stat({
              id: 'partner_repairs',
              label: 'Repairs',
              model: RepairOrder,
              where: { partner: { $record: 'id' } },
              action: 'repair.action_orders',
            }),
          ],
        },
      ],
    },
  ],
  views: {
    'repair.order.kanban': kanban(RepairOrder, {
      groupBy: 'state',
      card: {
        title: 'itemName',
        subtitle: 'partner',
        footer: ['name', 'serial', 'dueDate', 'technician'],
      },
    }),
    'repair.order.list': list(RepairOrder, {
      columns: [
        'name',
        'receivedOn',
        'partner',
        'itemName',
        'serial',
        'technician',
        { field: 'dueDate', widget: 'daysLeft' },
        'warranty',
        { field: 'amountDue', sum: true },
        { field: 'state', widget: 'badge' },
      ],
      decorations: {
        info: { state: { in: ['quoted', 'approved', 'repairing'] } },
        success: { state: { in: ['repaired', 'returned'] } },
        neutral: { state: { in: ['declined', 'cancel'] } },
      },
    }),
    'repair.order.calendar': calendar(RepairOrder, {
      dateStart: 'dueDate',
      title: 'itemName',
      color: 'state',
      mode: 'month',
    }),
    'repair.order.form': form(RepairOrder, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('diagnose', { primary: true, label: 'Diagnosed' }),
          k.button('quote', { primary: true, label: 'Quote to the customer' }),
          k.button('approve', { primary: true, label: 'Customer accepts' }),
          k.button('decline', { label: 'Customer declines' }),
          k.button('begin', { primary: true, label: 'Start the repair' }),
          k.button('finish', { primary: true, label: 'Repaired' }),
          k.button('deliver', { primary: true, label: 'Hand back' }),
          k.button('cancel', { label: 'Cancel' }),
        ],
      },
      readonlyWhen: { state: { in: ['returned', 'cancel'] } },
      sheet: [
        k.stats('related', [
          {
            id: 'customer_repairs',
            label: 'This customer’s repairs',
            model: RepairOrder,
            where: { partner: { $record: 'partner' } },
            action: 'repair.action_orders',
          },
        ]),
        k.group('main', ['name', 'partner', 'receivedOn', 'dueDate', 'technician', 'warranty']),
        k.group('item', ['itemName', 'product', 'serial', 'accessories'], {
          label: 'The item',
          description:
            'With its serial number an item is in repair once at a time, and its earlier repairs are found again.',
        }),
        k.group('fault', ['problem', 'diagnosis', 'declineReason'], {
          label: 'The fault',
          columns: 1,
        }),
        k.lines('lines', [
          { field: 'kind', id: 'line_kind' },
          { field: 'product', id: 'line_product' },
          { field: 'name', id: 'line_name' },
          { field: 'quantity', id: 'line_quantity' },
          { field: 'priceUnit', id: 'line_price' },
          { field: 'subtotal', id: 'line_subtotal' },
        ]),
        k.group('totals', ['partsTotal', 'labourTotal', 'amountTotal', 'amountDue'], {
          label: 'Amounts',
          description: 'Before taxes. Under warranty nothing is charged.',
        }),
        k.group('times', ['startedAt', 'repairedAt', 'returnedOn'], { label: 'When' }),
      ],
      chatter: true,
    })),
    'repair.line.list': list(RepairLine, {
      columns: ['order', 'kind', 'product', 'name', 'quantity', 'priceUnit', 'subtotal'],
    }),
    'repair.line.form': form(RepairLine, (k) => ({
      header: { buttons: [] },
      sheet: [k.group('main', ['order', 'kind', 'product', 'name', 'quantity', 'priceUnit'])],
    })),
  },
  search: {
    'repair.order': search(RepairOrder, {
      fields: ['name', 'itemName', 'serial', 'partner.name'],
      filters: {
        open: { label: 'In the workshop', domain: { state: { in: OPEN } }, group: 'state' },
        quoted: { label: 'Waiting for the customer', domain: { state: 'quoted' }, group: 'state' },
        repaired: { label: 'To hand back', domain: { state: 'repaired' }, group: 'state' },
        warranty: { label: 'Under warranty', domain: { warranty: true }, group: 'warranty' },
      },
      groupBy: ['state', 'technician', 'partner', 'warranty', 'receivedOn:month'],
    }),
    'repair.line': search(RepairLine, {
      fields: ['name', 'product.name', 'order.name'],
      groupBy: ['kind', 'product'],
    }),
  },
});
