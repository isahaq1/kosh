/**
 * @packageDocumentation
 * `@kosh/purchase` (RFC 0008): the Purchase app. Requests for quotation and purchase orders, prices from the
 * product cost, totals in the order's currency, and amount-based approvals (a manager above 100,000, a director
 * above 1,000,000 by default; administrators change the thresholds in the approval policy).
 */
import { contacts } from '@kosh/contacts';
import { messaging } from '@kosh/messaging';
import { defineModule } from '@kosh/modules-sdk';
import { permissions } from '@kosh/permissions';
import { product } from '@kosh/product';
import { reporting } from '@kosh/reporting';
import { action, calendar, form, kanban, list, pivot, search, stat } from '@kosh/views';
import { purchaseDemo } from './demo.js';
import { PurchaseOrder, purchaseShutro } from './module.js';
import { PurchaseRequest, PurchaseRequestLine } from './request.js';
import { ProductVendorPrice } from './vendorprice.js';

export { PurchaseOrder, PurchaseOrderLine, purchaseShutro } from './module.js';
export { createRfqs, PurchaseRequest, PurchaseRequestLine } from './request.js';
export { ProductVendorPrice, type VendorChoice, vendorPriceFor } from './vendorprice.js';

export const purchase: ReturnType<typeof defineModule> = defineModule({
  shutro: purchaseShutro,
  kosh: '^0.1.0',
  hooks: { demo: purchaseDemo },
  depends: [contacts, product, messaging, permissions, reporting],
  // Exceptions to the module standard (RFC 0023), each with its reason.
  standard: {
    waive: [
      {
        rule: 'I1',
        model: 'purchase.request.line',
        reason: 'Lines import with their request (the purchase requests template).',
      },
    ],
  },
  events: [
    {
      topic: 'purchase.request.submitted',
      model: 'purchase.request',
      label: 'Purchase request submitted',
    },
    {
      topic: 'purchase.request.approved',
      model: 'purchase.request',
      label: 'Purchase request approved',
    },
    {
      topic: 'purchase.request.rfq',
      model: 'purchase.request',
      label: 'Requests for quotation made from a purchase request',
    },
    {
      topic: 'purchase.order.confirmed',
      model: 'purchase.order',
      label: 'Purchase order confirmed',
    },
  ],
  app: {
    code: 'purchase',
    label: 'Purchase',
    icon: 'purchase',
    sequence: 40,
    category: 'Inventory',
    summary: 'Requests for quotation, purchase orders and their approvals',
  },
  // Requests for quotation and purchase orders sent by email with their PDF (RFC 0029 §3.3).
  mailTemplates: [
    {
      key: 'purchase_order',
      name: 'Purchase order',
      model: 'purchase.order',
      document: 'purchase.purchase_order',
      subject: '{{company.name}}: {{name}}',
      body: 'Dear {{partner.name}},\n\nPlease find attached {{name}} of {{amountTotal}}, expected on {{datePlanned}}. Kindly confirm the order and the delivery date.\n\n{{company.name}}',
      translations: {
        bn_BD: {
          subject: '{{company.name}}: {{name}}',
          body: 'প্রিয় {{partner.name}},\n\n{{amountTotal}}-এর {{name}} সংযুক্ত করা হলো, প্রত্যাশিত তারিখ {{datePlanned}}। অনুগ্রহ করে অর্ডার ও সরবরাহের তারিখ নিশ্চিত করুন।\n\n{{company.name}}',
        },
      },
    },
  ],
  sendable: [{ model: 'purchase.order', template: 'purchase.purchase_order', partner: 'partner' }],
  documents: [
    {
      key: 'purchase_request',
      name: 'Purchase request',
      model: 'purchase.request',
      layout: {
        paper: 'A4',
        header: '{{company.name}}',
        footer: 'Page {{page}} of {{pages}}',
        blocks: [
          { kind: 'heading', id: 'title', text: 'Purchase request {{name}}', level: 1 },
          {
            kind: 'fields',
            id: 'who',
            items: [
              { label: 'Requested by', bind: 'requester.name' },
              { label: 'Request date', bind: 'date' },
              { label: 'Needed by', bind: 'dateRequired' },
              { label: 'Priority', bind: 'priority' },
              { label: 'Preferred vendor', bind: 'vendor.name' },
              { label: 'Status', bind: 'state' },
            ],
          },
          {
            kind: 'table',
            id: 'lines',
            bind: 'lines',
            columns: [
              { label: 'Product', bind: 'product.name' },
              { label: 'Description', bind: 'name' },
              { label: 'Unit', bind: 'uom.name' },
              { label: 'Requested', bind: 'quantity' },
              { label: 'Approved', bind: 'qtyApproved' },
              { label: 'Ordered', bind: 'qtyOrdered' },
            ],
          },
          { kind: 'text', id: 'purpose', text: '{{purpose}}' },
          { kind: 'qr', id: 'qr', bind: 'name', size: 24, label: 'Request reference' },
        ],
      },
    },
    {
      key: 'purchase_order',
      name: 'Purchase order',
      model: 'purchase.order',
      layout: {
        paper: 'A4',
        header: '{{company.name}}',
        footer: 'Page {{page}} of {{pages}}',
        blocks: [
          { kind: 'heading', id: 'title', text: 'Purchase order {{name}}', level: 1 },
          {
            kind: 'fields',
            id: 'vendor',
            items: [
              { label: 'Vendor', bind: 'partner.name' },
              { label: 'Vendor reference', bind: 'partnerReference' },
              { label: 'Order date', bind: 'dateOrder' },
              { label: 'Expected', bind: 'datePlanned' },
              { label: 'Buyer', bind: 'user.name' },
              { label: 'Currency', bind: 'currency.name' },
              { label: 'Status', bind: 'state' },
            ],
          },
          {
            kind: 'table',
            id: 'lines',
            bind: 'lines',
            columns: [
              { label: 'Product', bind: 'product.name' },
              { label: 'Description', bind: 'name' },
              { label: 'Quantity', bind: 'quantity' },
              { label: 'Unit', bind: 'uom.name' },
              { label: 'Unit price', bind: 'priceUnit' },
              { label: 'Amount', bind: 'subtotal' },
            ],
          },
          {
            kind: 'fields',
            id: 'totals',
            items: [
              { label: 'Untaxed', bind: 'amountUntaxed' },
              { label: 'Taxes', bind: 'amountTax' },
              { label: 'Total', bind: 'amountTotal' },
            ],
          },
          { kind: 'text', id: 'note', text: '{{note}}' },
          { kind: 'signature', id: 'sign', labels: ['Ordered by', 'Approved by'] },
        ],
      },
    },
  ],
  importTemplates: [
    {
      key: 'purchase_requests',
      model: 'purchase.request',
      label: 'Purchase requests',
      columns: [
        { header: 'Requested by', field: 'requester' },
        { header: 'Needed by', field: 'dateRequired' },
        { header: 'Priority', field: 'priority' },
        { header: 'Preferred vendor', field: 'vendor' },
        { header: 'Purpose', field: 'purpose' },
        { header: 'Lines › Product', field: 'lines.product' },
        { header: 'Lines › Quantity', field: 'lines.quantity' },
      ],
    },
    {
      key: 'vendor_prices',
      model: 'product.vendor.price',
      label: 'Vendor prices',
      columns: [
        { header: 'Vendor', field: 'vendor' },
        { header: 'Product', field: 'product' },
        { header: 'Category', field: 'category' },
        { header: 'Vendor code', field: 'vendorCode' },
        { header: 'Vendor name', field: 'vendorName' },
        { header: 'Currency', field: 'currency' },
        { header: 'From quantity', field: 'minQuantity' },
        { header: 'Price', field: 'price' },
        { header: 'Valid from', field: 'dateFrom' },
        { header: 'Valid until', field: 'dateTo' },
        { header: 'Lead days', field: 'leadDays' },
        { header: 'Preferred', field: 'preferred' },
      ],
    },
    {
      key: 'purchase_order',
      model: 'purchase.order',
      label: 'Purchase order',
      columns: [
        { header: 'Buyer', field: 'user' },
        { header: 'Vendor', field: 'partner' },
        { header: 'Vendor reference', field: 'partnerReference' },
        { header: 'Currency', field: 'currency' },
        { header: 'Order date', field: 'dateOrder' },
        { header: 'Expected arrival', field: 'datePlanned' },
        { header: 'Source document', field: 'origin' },
        { header: 'Terms and conditions', field: 'note' },
        { header: 'Lines › Product', field: 'lines.product' },
        { header: 'Lines › Description', field: 'lines.name' },
        { header: 'Lines › Quantity', field: 'lines.quantity' },
        { header: 'Lines › Unit', field: 'lines.uom' },
        { header: 'Lines › Unit price', field: 'lines.priceUnit' },
      ],
    },
  ],
  // Bangla for the labels it serves (RFC 0023 §3.1; `pnpm i18n:extract`).
  i18n: { bn: () => import('./i18n/bn.js') },
  accessLevels: {
    requester: { label: 'Requester (own purchase requests)', groups: ['purchase.requester'] },
    user: {
      label: 'Buyer (own orders, every request)',
      groups: ['purchase.user'],
      implies: ['requester'],
    },
    manager: { label: 'Manager (all orders)', groups: ['purchase.manager'], implies: ['user'] },
    director: { label: 'Director', groups: ['purchase.director'], implies: ['manager'] },
  },
  // Settings › App settings › Purchase (RFC 0020): per company, changed by purchase managers.
  settings: {
    sections: [
      {
        key: 'orders',
        label: 'Purchase orders',
        description: 'The terms new requests for quotation and purchase orders start with.',
        keywords: 'purchase order rfq terms conditions vendor',
        scope: 'company',
        editors: ['purchase.manager'],
        fields: [
          { key: 'purchaseTerms', help: 'Filled in on new orders; each can still be changed.' },
        ],
      },
    ],
  },
  approvals: [
    {
      name: 'Purchase request approvals',
      model: 'purchase.request',
      onApproved: 'approve',
      onRejected: 'reject',
      levels: [
        {
          name: 'Department head',
          condition: {},
          approver: 'department_head',
          approverRole: 'purchase.manager',
        },
        {
          name: 'Purchase manager',
          condition: { amountEstimate: { gt: '100000' } },
          approverRole: 'purchase.manager',
        },
      ],
    },
    {
      name: 'Purchase approvals',
      model: 'purchase.order',
      onApproved: 'confirm',
      onRejected: 'reject',
      levels: [
        {
          name: 'Purchase manager',
          condition: { amountTotal: { gt: '100000' } },
          approverRole: 'purchase.manager',
        },
        {
          name: 'Purchase director',
          condition: { amountTotal: { gt: '1000000' } },
          approverRole: 'purchase.director',
        },
      ],
    },
  ],
  // The Overview (RFC 0022 step 2): spend against last month, what waits, who we buy from.
  overview: {
    cards: [
      {
        id: 'spend_month',
        title: 'Purchases this month',
        kind: 'kpi',
        model: 'purchase.order',
        measure: 'sum:amountTotal',
        filter: { state: { in: ['purchase', 'done'] } },
        comparison: { field: 'dateOrder', mode: 'previous' },
        w: 3,
      },
      {
        id: 'orders_month',
        title: 'Orders this month',
        kind: 'kpi',
        model: 'purchase.order',
        measure: 'count',
        filter: { state: { in: ['purchase', 'done'] } },
        comparison: { field: 'dateOrder', mode: 'previous' },
        w: 3,
      },
      {
        id: 'open_rfqs',
        title: 'Open requests',
        kind: 'kpi',
        model: 'purchase.order',
        measure: 'count',
        filter: { state: { in: ['draft', 'sent'] } },
        w: 3,
      },
      {
        id: 'to_approve',
        title: 'Waiting approval',
        kind: 'kpi',
        model: 'purchase.order',
        measure: 'count',
        filter: { state: 'to_approve' },
        w: 3,
      },
      {
        id: 'spend_by_month',
        title: 'Purchases by month',
        kind: 'chart',
        model: 'purchase.order',
        measure: 'sum:amountTotal',
        groupBy: 'dateOrder:month',
        filter: { state: { in: ['purchase', 'done'] } },
        chart: 'bar',
        w: 6,
      },
      {
        id: 'top_vendors',
        title: 'Top vendors',
        kind: 'pivot',
        model: 'purchase.order',
        measure: 'sum:amountTotal',
        groupBy: 'partner',
        filter: { state: { in: ['purchase', 'done'] } },
        w: 6,
      },
      {
        id: 'by_buyer',
        title: 'By buyer',
        kind: 'chart',
        model: 'purchase.order',
        measure: 'sum:amountTotal',
        groupBy: 'user',
        filter: { state: { in: ['purchase', 'done'] } },
        chart: 'pie',
        w: 6,
      },
      {
        id: 'biggest_open',
        title: 'Biggest open requests',
        kind: 'list',
        model: 'purchase.order',
        measure: 'sum:amountTotal',
        filter: { state: { in: ['draft', 'sent', 'to_approve'] } },
        w: 6,
      },
    ],
  },
  viewExtensions: [
    {
      view: 'product.product.form',
      operations: [
        {
          append: 'related',
          nodes: [
            stat({
              id: 'product_bought',
              label: 'Bought',
              model: 'purchase.order.line',
              where: { product: { $record: 'id' }, 'order.state': { in: ['purchase', 'done'] } },
              measure: { sum: 'quantity' },
            }),
            stat({
              id: 'product_vendor_prices',
              label: 'Vendor prices',
              model: ProductVendorPrice,
              where: { product: { $record: 'id' } },
              action: 'purchase.action_vendor_prices',
            }),
          ],
        },
      ],
    },
    {
      view: 'res.partner.form',
      operations: [
        {
          append: 'related',
          nodes: [
            stat({
              id: 'purchase_orders',
              label: 'Purchase orders',
              model: PurchaseOrder,
              where: { partner: { $record: 'id' }, state: { in: ['purchase', 'done'] } },
              action: 'purchase.action_orders',
            }),
            stat({
              id: 'purchase_spend',
              label: 'Purchases',
              model: PurchaseOrder,
              where: { partner: { $record: 'id' }, state: { in: ['purchase', 'done'] } },
              measure: { sum: 'amountTotal' },
              action: 'purchase.action_orders',
            }),
            stat({
              id: 'vendor_prices',
              label: 'Vendor prices',
              model: ProductVendorPrice,
              where: { vendor: { $record: 'id' } },
              action: 'purchase.action_vendor_prices',
            }),
          ],
        },
      ],
    },
  ],
  actions: {
    'purchase.action_requests': action(PurchaseRequest, {
      label: 'Purchase requests',
      views: ['list', 'kanban', 'form'],
    }),
    'purchase.action_request_lines': action(PurchaseRequestLine, {
      label: 'Request lines',
      views: ['list', 'pivot'],
      defaultFilters: ['open'],
    }),
    'purchase.action_rfqs': action(PurchaseOrder, {
      label: 'Requests for quotation',
      views: ['list', 'kanban', 'form'],
      defaultFilters: ['rfqs'],
    }),
    'purchase.action_orders': action(PurchaseOrder, {
      label: 'Purchase orders',
      views: ['list', 'kanban', 'calendar', 'form'],
      defaultFilters: ['orders'],
    }),
    'purchase.action_to_approve': action(PurchaseOrder, {
      label: 'To approve',
      views: ['list', 'form'],
      domain: { state: 'to_approve' },
      visibleTo: ['purchase.manager'],
    }),
    'purchase.action_vendor_prices': action(ProductVendorPrice, {
      label: 'Vendor prices',
      views: ['list', 'form'],
    }),
    'purchase.action_vendors': {
      model: 'res.partner',
      label: 'Vendors',
      views: ['list', 'form'],
      domain: { isVendor: true },
    },
  },
  menus: [
    { id: 'purchase.root', label: 'Purchase', app: 'purchase' },
    {
      id: 'purchase.requests',
      parent: 'purchase.root',
      label: 'Purchase requests',
      action: 'purchase.action_requests',
      sequence: 0,
    },
    {
      id: 'purchase.request_lines',
      parent: 'purchase.root',
      label: 'Request lines',
      action: 'purchase.action_request_lines',
      sequence: 6,
      visibleTo: ['purchase.user'],
    },
    {
      id: 'purchase.rfqs',
      parent: 'purchase.root',
      label: 'Requests for quotation',
      action: 'purchase.action_rfqs',
      sequence: 1,
    },
    {
      id: 'purchase.orders',
      parent: 'purchase.root',
      label: 'Purchase orders',
      action: 'purchase.action_orders',
      sequence: 2,
    },
    {
      id: 'purchase.to_approve',
      parent: 'purchase.root',
      label: 'To approve',
      action: 'purchase.action_to_approve',
      sequence: 3,
      visibleTo: ['purchase.manager'],
    },
    {
      id: 'purchase.vendors',
      parent: 'purchase.root',
      label: 'Vendors',
      action: 'purchase.action_vendors',
      sequence: 4,
    },
    {
      id: 'purchase.vendor_prices',
      parent: 'purchase.root',
      label: 'Vendor prices',
      action: 'purchase.action_vendor_prices',
      sequence: 5,
    },
  ],
  views: {
    'purchase.request.list': list(PurchaseRequest, {
      columns: [
        'name',
        'requester',
        'date',
        'dateRequired',
        { field: 'priority', widget: 'priority' },
        'amountEstimate',
        'state',
      ],
      decorations: { danger: { priority: 'critical' }, warning: { priority: 'urgent' } },
    }),
    'purchase.request.kanban': kanban(PurchaseRequest, {
      groupBy: 'state',
      card: {
        title: 'name',
        subtitle: 'requester',
        footer: ['dateRequired', { field: 'priority', widget: 'priority' }],
      },
    }),
    'purchase.request.form': form(PurchaseRequest, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('submit', { primary: true, label: 'Submit for approval' }),
          k.button('rfq', { primary: true, label: 'Make requests for quotation' }),
          k.button('close', { label: 'Close' }),
          k.button('redraft', { label: 'Set to draft' }),
          k.button('cancel', { label: 'Cancel', confirm: 'Cancel this request?' }),
        ],
      },
      sheet: [
        k.stats('related', [
          {
            id: 'request_orders',
            label: 'Requests for quotation and orders',
            model: PurchaseOrder,
            where: { origin: { $record: 'name' } },
            action: 'purchase.action_orders',
          },
        ]),
        k.group('main', ['name', 'requester', 'date', 'purpose']),
        k.group('when', [
          'dateRequired',
          { field: 'priority', widget: 'priority' },
          'vendor',
          'amountEstimate',
        ]),
        k.component('approvals', 'approvals.Panel'),
        k.lines('lines', [
          'product',
          { field: 'name', id: 'line_name' },
          'uom',
          'quantity',
          'qtyApproved',
          'qtyOnRfq',
          'qtyOrdered',
          'qtyRemaining',
          { field: 'buyers', id: 'line_buyers', widget: 'tags' },
          { field: 'status', id: 'line_status', widget: 'badge' },
        ]),
        k.group('after', ['rejectReason'], { label: 'Decision' }),
      ],
      chatter: true,
    })),
    // The line tracker (RFC 0032 §3.4): every request line through the chain.
    'purchase.request.line.list': list(PurchaseRequestLine, {
      columns: [
        'request',
        'product',
        'uom',
        'quantity',
        'qtyApproved',
        'qtyOnRfq',
        'qtyOrdered',
        'qtyRemaining',
        'dateRequired',
        { field: 'buyers', widget: 'tags' },
        { field: 'status', widget: 'badge' },
      ],
      inlineEdit: ['buyers'],
    }),
    'purchase.request.line.pivot': pivot(PurchaseRequestLine, {
      rows: ['product'],
      cols: ['status'],
      measures: [{ sum: 'qtyApproved' }, { sum: 'qtyOrdered' }],
    }),
    'purchase.order.list': list(PurchaseOrder, {
      columns: [
        'name',
        'dateOrder',
        'partner',
        'user',
        'datePlanned',
        { field: 'amountTotal', sum: true },
        { field: 'state', widget: 'badge' },
      ],
      defaultOrder: ['dateOrder desc'],
    }),
    'purchase.order.kanban': kanban(PurchaseOrder, {
      groupBy: 'state',
      card: { title: 'partner', subtitle: 'name', footer: ['amountTotal', 'datePlanned'] },
    }),
    'purchase.order.form': form(PurchaseOrder, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('send', { label: 'Mark as sent' }),
          k.button('submit', { primary: true, label: 'Submit for approval' }),
          k.button('confirm', { primary: true, label: 'Confirm order' }),
          k.button('lock', { label: 'Lock' }),
          k.button('unlock', { label: 'Unlock' }),
          k.button('cancel', { label: 'Cancel', confirm: 'Cancel this order?' }),
          k.button('redraft', { label: 'Set to draft' }),
        ],
      },
      sheet: [
        // Bills and receipts: the bridges append their tiles (RFC 0022 §3.1).
        k.stats('related', []),
        k.group('vendor', ['partner', 'partnerReference', 'currency']),
        k.group('dates', ['name', 'dateOrder', 'datePlanned', 'user', 'origin']),
        k.lines(
          'lines',
          [
            'product',
            { field: 'name', id: 'line_name' },
            'quantity',
            'uom',
            'priceUnit',
            { field: 'vendorCode', id: 'line_vendor_code' },
            { field: 'priceReason', id: 'line_price_reason' },
            'taxes',
            { field: 'datePlanned', id: 'line_date_planned' },
            'subtotal',
          ],
          { readonlyWhen: { state: { notIn: ['draft', 'sent'] } } },
        ),
        k.group('totals', ['amountUntaxed', 'amountTax', 'amountTotal'], { label: 'Totals' }),
        k.component('approvals', 'approvals.Panel'),
        k.group('terms', ['note'], { columns: 1 }),
      ],
      readonlyWhen: { state: { in: ['done', 'cancel'] } },
      chatter: true,
    })),
    'product.vendor.price.list': list(ProductVendorPrice, {
      columns: [
        'vendor',
        'product',
        'category',
        'vendorCode',
        'minQuantity',
        'price',
        'currency',
        'leadDays',
        'preferred',
        'dateTo',
      ],
      inlineEdit: ['minQuantity', 'price', 'leadDays', 'preferred', 'dateTo'],
    }),
    'product.vendor.price.form': form(ProductVendorPrice, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.group('what', ['vendor', 'product', 'category', 'vendorCode', 'vendorName'], {
          description:
            'Purchase lines take the price of the order’s vendor for their quantity; Replenishment picks the preferred vendor, else the cheapest that arrives in time.',
        }),
        k.group('pricing', ['minQuantity', 'price', 'currency', 'leadDays', 'preferred'], {
          label: 'Price',
        }),
        k.group('when', ['dateFrom', 'dateTo', 'company', 'sequence'], { label: 'Valid' }),
      ],
    })),
    'purchase.order.calendar': calendar(PurchaseOrder, {
      dateStart: 'datePlanned',
      title: 'name',
      color: 'state',
      mode: 'month',
    }),
  },
  search: {
    'purchase.request': search(PurchaseRequest, {
      fields: ['name', 'purpose', 'requester.name', 'lines.product.name'],
      filters: {
        mine: { label: 'Mine', domain: { requester: { $env: 'uid' } }, group: 'who' },
        waiting: { label: 'Waiting for approval', domain: { state: 'to_approve' }, group: 'state' },
        approved: { label: 'Approved', domain: { state: 'approved' }, group: 'state' },
        urgent: {
          label: 'Urgent',
          domain: { priority: { in: ['urgent', 'critical'] } },
          group: 'priority',
        },
      },
      groupBy: ['requester', 'state', 'dateRequired:month'],
    }),
    'purchase.request.line': search(PurchaseRequestLine, {
      fields: ['product.name', 'request.name'],
      filters: {
        open: {
          label: 'Approved, to buy',
          domain: { status: { in: ['approved', 'rfq'] } },
          group: 'status',
        },
        assigned_me: {
          label: 'Assigned to me',
          domain: { buyers: { any: { id: { $env: 'uid' } } } },
          group: 'who',
        },
        unassigned: {
          label: 'Not assigned',
          domain: { buyers: { none: { id: { gt: 0 } } } },
          group: 'who',
        },
        rfq: { label: 'RFQ made', domain: { status: 'rfq' }, group: 'status' },
        ordered: { label: 'Ordered', domain: { status: 'ordered' }, group: 'status' },
        cancelled: { label: 'Cancelled', domain: { status: 'cancelled' }, group: 'status' },
      },
      groupBy: ['request', 'product', 'status'],
    }),
    'product.vendor.price': search(ProductVendorPrice, {
      fields: ['vendor.name', 'product.name', 'vendorCode'],
      filters: {
        preferred: { label: 'Preferred', domain: { preferred: true } },
      },
      groupBy: ['vendor', 'product', 'category'],
    }),
    'purchase.order': search(PurchaseOrder, {
      fields: ['name', 'partner.name', 'partnerReference', 'origin'],
      filters: {
        rfqs: { label: 'RFQs', domain: { state: { in: ['draft', 'sent'] } }, group: 'stage' },
        waiting: { label: 'Waiting approval', domain: { state: 'to_approve' }, group: 'stage' },
        orders: {
          label: 'Purchase orders',
          domain: { state: { in: ['purchase', 'done'] } },
          group: 'stage',
        },
        mine: { label: 'My orders', domain: { user: { $env: 'uid' } } },
      },
      groupBy: ['state', 'partner', 'user', 'dateOrder:month'],
    }),
  },
});
