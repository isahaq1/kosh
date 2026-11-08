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
import type { ModuleContext } from '@kosh/server';
import { action, calendar, form, kanban, list, pivot, search, stat } from '@kosh/views';
import { PurchaseComparison, PurchaseTechnicalComparison } from './comparison.js';
import { purchaseDemo } from './demo.js';
import { PurchaseOrder, purchaseShutro } from './module.js';
import { PurchaseRequest, PurchaseRequestLine } from './request.js';
import { PurchaseTender, PurchaseTenderResponse, registerTenderRoutes } from './tender.js';
import { ProductVendorPrice } from './vendorprice.js';

export {
  confirmComparison,
  PurchaseComparison,
  PurchaseComparisonLine,
  PurchaseTechnicalComparison,
  PurchaseTechnicalComparisonLine,
} from './comparison.js';
export { PurchaseOrder, PurchaseOrderLine, purchaseShutro } from './module.js';
export { createRfqs, createTender, PurchaseRequest, PurchaseRequestLine } from './request.js';
export {
  configurePurchaseMails,
  PurchaseTender,
  PurchaseTenderLine,
  PurchaseTenderResponse,
  PurchaseTenderResponseLine,
} from './tender.js';
export { ProductVendorPrice, type VendorChoice, vendorPriceFor } from './vendorprice.js';

export const purchase: ReturnType<typeof defineModule> = defineModule({
  shutro: purchaseShutro,
  kosh: '^0.1.0',
  hooks: { demo: purchaseDemo },
  routes: (context: ModuleContext) => {
    registerTenderRoutes(context);
  },
  depends: [contacts, product, messaging, permissions, reporting],
  // Exceptions to the module standard (RFC 0023), each with its reason.
  standard: {
    waive: [
      {
        rule: 'I1',
        model: 'purchase.request.line',
        reason: 'Lines import with their request (the purchase requests template).',
      },
      {
        rule: 'I1',
        model: 'purchase.tender.line',
        reason: 'Lines import with their RFQ (the RFQs to vendors template).',
      },
      {
        rule: 'I1',
        model: 'purchase.tender.response',
        reason: 'Made by the system when an RFQ is sent, one per vendor.',
      },
      {
        rule: 'I1',
        model: 'purchase.tender.response.line',
        reason: 'Made with its response from the RFQ’s lines.',
      },
      {
        rule: 'I1',
        model: 'purchase.comparison',
        reason: 'Drawn up from an RFQ’s responses on screen; nothing to import.',
      },
      {
        rule: 'I1',
        model: 'purchase.comparison.line',
        reason: 'Made with its statement from the responses.',
      },
      {
        rule: 'I1',
        model: 'purchase.technical.comparison',
        reason: 'Drawn up from an RFQ’s responses on screen; nothing to import.',
      },
      {
        rule: 'I1',
        model: 'purchase.technical.comparison.line',
        reason: 'Made with its comparison from the responses.',
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
    { topic: 'purchase.tender.sent', model: 'purchase.tender', label: 'RFQ sent to its vendors' },
    {
      topic: 'purchase.tender.response_submitted',
      model: 'purchase.tender.response',
      label: 'A vendor submitted their quotation',
    },
    {
      topic: 'purchase.comparison.submitted',
      model: 'purchase.comparison',
      label: 'Comparative statement submitted',
    },
    {
      topic: 'purchase.comparison.confirmed',
      model: 'purchase.comparison',
      label: 'Comparative statement confirmed into orders',
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
      key: 'purchase_comparison',
      name: 'Comparative statement',
      model: 'purchase.comparison',
      layout: {
        paper: 'A4',
        orientation: 'landscape',
        header: '{{company.name}}',
        footer: 'Page {{page}} of {{pages}}',
        blocks: [
          { kind: 'heading', id: 'title', text: 'Comparative statement {{name}}', level: 1 },
          {
            kind: 'fields',
            id: 'about',
            items: [
              { label: 'RFQ', bind: 'tender.name' },
              { label: 'CS date', bind: 'date' },
              { label: 'Expiry date', bind: 'expiryDate' },
              { label: 'Delivery date', bind: 'dateDelivery' },
              { label: 'Awarded total', bind: 'amountTotal' },
              { label: 'Status', bind: 'state' },
            ],
          },
          {
            kind: 'table',
            id: 'lines',
            bind: 'lines',
            columns: [
              { label: 'Product', bind: 'tenderLine.product.name' },
              { label: 'Vendor', bind: 'response.vendor.name' },
              { label: 'CS qty', bind: 'csQty' },
              { label: 'Quote', bind: 'quote' },
              { label: 'Nego 1', bind: 'nego1' },
              { label: 'Nego 2', bind: 'nego2' },
              { label: 'Final', bind: 'finalPrice' },
              { label: 'Total', bind: 'total' },
              { label: 'Selected', bind: 'selected' },
            ],
          },
          { kind: 'text', id: 'note', text: '{{note}}' },
          { kind: 'qr', id: 'qr', bind: 'name', size: 24, label: 'CS reference' },
        ],
      },
    },
    {
      key: 'purchase_technical_comparison',
      name: 'Technical comparison',
      model: 'purchase.technical.comparison',
      layout: {
        paper: 'A4',
        header: '{{company.name}}',
        blocks: [
          { kind: 'heading', id: 'title', text: 'Technical comparison {{name}}', level: 1 },
          {
            kind: 'fields',
            id: 'about',
            items: [
              { label: 'RFQ', bind: 'tender.name' },
              { label: 'Assigned engineer', bind: 'engineer.name' },
              { label: 'CS type', bind: 'kind' },
              { label: 'Date', bind: 'date' },
              { label: 'Status', bind: 'state' },
            ],
          },
          {
            kind: 'table',
            id: 'lines',
            bind: 'lines',
            columns: [
              { label: 'Vendor response', bind: 'response.name' },
              { label: 'Score', bind: 'score' },
              { label: 'Meets the specifications', bind: 'meetsSpecifications' },
              { label: 'Note', bind: 'note' },
            ],
          },
          { kind: 'text', id: 'remarks', text: '{{remarks}}' },
          { kind: 'qr', id: 'qr', bind: 'name', size: 24, label: 'TCS reference' },
        ],
      },
    },
    {
      key: 'purchase_tender',
      name: 'RFQ to vendors',
      model: 'purchase.tender',
      layout: {
        paper: 'A4',
        header: '{{company.name}}',
        footer: 'Page {{page}} of {{pages}}',
        blocks: [
          { kind: 'heading', id: 'title', text: 'Request for quotation {{name}}', level: 1 },
          {
            kind: 'fields',
            id: 'terms',
            items: [
              { label: 'Topic', bind: 'topic' },
              { label: 'Response deadline', bind: 'deadline' },
              { label: 'Delivery date', bind: 'dateDelivery' },
              { label: 'Payment terms', bind: 'paymentTerms' },
              { label: 'Sourcing', bind: 'sourcing' },
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
              { label: 'Quantity', bind: 'quantity' },
            ],
          },
          { kind: 'text', id: 'note', text: '{{note}}' },
          { kind: 'qr', id: 'qr', bind: 'name', size: 24, label: 'RFQ reference' },
        ],
      },
    },
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
      key: 'purchase_tenders',
      model: 'purchase.tender',
      label: 'RFQs to vendors',
      columns: [
        { header: 'Topic', field: 'topic' },
        { header: 'Response deadline', field: 'deadline' },
        { header: 'Delivery date', field: 'dateDelivery' },
        { header: 'Sourcing', field: 'sourcing' },
        { header: 'Vendors', field: 'vendors' },
        { header: 'Payment terms', field: 'paymentTerms' },
        { header: 'Lines › Product', field: 'lines.product' },
        { header: 'Lines › Quantity', field: 'lines.quantity' },
      ],
    },
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
      name: 'Comparative statement approvals',
      model: 'purchase.comparison',
      onApproved: 'approve',
      onRejected: 'reject',
      levels: [
        { name: 'Purchase manager', condition: {}, approverRole: 'purchase.manager' },
        {
          name: 'Purchase director',
          condition: { amountTotal: { gt: '1000000' } },
          approverRole: 'purchase.director',
        },
      ],
    },
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
      // The RFQ dashboard (RFC 0032 §3.4): RFQs to vendors by state.
      {
        id: 'tenders_sent',
        title: 'RFQs waiting for responses',
        kind: 'kpi',
        model: 'purchase.tender',
        measure: 'count',
        filter: { state: 'sent' },
        w: 3,
      },
      {
        id: 'tenders_received',
        title: 'RFQs with responses',
        kind: 'kpi',
        model: 'purchase.tender',
        measure: 'count',
        filter: { state: { in: ['received', 'comparing'] } },
        w: 3,
      },
      {
        id: 'comparisons_waiting',
        title: 'Comparative statements waiting',
        kind: 'kpi',
        model: 'purchase.comparison',
        measure: 'count',
        filter: { state: 'submitted' },
        w: 3,
      },
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
    'purchase.action_tenders': action(PurchaseTender, {
      label: 'RFQs to vendors',
      views: ['list', 'kanban', 'form'],
    }),
    'purchase.action_responses': action(PurchaseTenderResponse, {
      label: 'Vendor responses',
      views: ['list', 'form'],
    }),
    'purchase.action_comparisons': action(PurchaseComparison, {
      label: 'Comparative statements',
      views: ['list', 'kanban', 'form'],
    }),
    'purchase.action_technical_comparisons': action(PurchaseTechnicalComparison, {
      label: 'Technical comparisons',
      views: ['list', 'form'],
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
      id: 'purchase.tenders',
      parent: 'purchase.root',
      label: 'RFQs to vendors',
      action: 'purchase.action_tenders',
      sequence: 7,
      visibleTo: ['purchase.user'],
    },
    {
      id: 'purchase.responses',
      parent: 'purchase.root',
      label: 'Vendor responses',
      action: 'purchase.action_responses',
      sequence: 8,
      visibleTo: ['purchase.user'],
    },
    {
      id: 'purchase.comparisons',
      parent: 'purchase.root',
      label: 'Comparative statements',
      action: 'purchase.action_comparisons',
      sequence: 9,
      visibleTo: ['purchase.user'],
    },
    {
      id: 'purchase.technical_comparisons',
      parent: 'purchase.root',
      label: 'Technical comparisons',
      action: 'purchase.action_technical_comparisons',
      sequence: 10,
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
          k.button('tender', { label: 'Ask several vendors' }),
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
    'purchase.tender.list': list(PurchaseTender, {
      columns: ['name', 'topic', 'buyer', 'date', 'deadline', 'sourcing', 'responseCount', 'state'],
    }),
    'purchase.tender.kanban': kanban(PurchaseTender, {
      groupBy: 'state',
      card: { title: 'name', subtitle: 'topic', footer: ['deadline', 'responseCount'] },
    }),
    'purchase.tender.form': form(PurchaseTender, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('send', { primary: true, label: 'Send to the vendors' }),
          k.button('close', { label: 'Close the responses' }),
          k.button('compare', { label: 'Draw up the comparison' }),
          k.button('redraft', { label: 'Set to draft' }),
          k.button('cancel', { label: 'Cancel', confirm: 'Cancel this RFQ?' }),
        ],
      },
      sheet: [
        k.group('main', ['name', 'topic', 'buyer', 'request', 'sourcing', 'technical']),
        k.group('terms', ['date', 'deadline', 'dateDelivery', 'currency', 'paymentTerms'], {
          label: 'Terms',
        }),
        k.group('who', [{ field: 'vendors', widget: 'tags' }], {
          label: 'Vendors',
          description:
            'Each vendor gets a response of their own and a quote link by email; a buyer may also type their quotation.',
        }),
        k.lines('lines', [
          'product',
          { field: 'name', id: 'line_name' },
          'uom',
          'quantity',
          { field: 'requestLine', id: 'line_request' },
        ]),
        k.lines('responses', [
          { field: 'name', id: 'response_name' },
          { field: 'vendor', id: 'response_vendor' },
          { field: 'amountTotal', id: 'response_total' },
          { field: 'dateDelivery', id: 'response_delivery' },
          { field: 'state', id: 'response_state' },
        ]),
        k.group('about', ['note'], { columns: 1 }),
      ],
      chatter: true,
    })),
    'purchase.comparison.list': list(PurchaseComparison, {
      columns: ['name', 'tender', 'date', 'expiryDate', 'multiVendor', 'amountTotal', 'state'],
    }),
    'purchase.comparison.kanban': kanban(PurchaseComparison, {
      groupBy: 'state',
      card: { title: 'name', subtitle: 'tender', footer: ['amountTotal'] },
    }),
    'purchase.comparison.form': form(PurchaseComparison, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('fill', { label: 'Fill from the RFQ' }),
          k.button('submit', { primary: true, label: 'Submit for approval' }),
          k.button('confirm', { primary: true, label: 'Confirm: make the orders' }),
          k.button('redraft', { label: 'Set to draft' }),
          k.button('cancel', { label: 'Cancel', confirm: 'Cancel this statement?' }),
        ],
      },
      sheet: [
        k.group('main', ['name', 'tender', 'date', 'expiryDate', 'dateDelivery', 'multiVendor'], {
          description:
            'Fill from the RFQ: every line against every vendor who quoted. Negotiate in two rounds, set the final price, select the lines to award.',
        }),
        k.component('approvals', 'approvals.Panel'),
        k.lines('lines', [
          { field: 'tenderLine', id: 'cs_line' },
          { field: 'response', id: 'cs_response' },
          { field: 'csQty', id: 'cs_qty' },
          { field: 'quote', id: 'cs_quote' },
          { field: 'nego1', id: 'cs_nego1' },
          { field: 'nego2', id: 'cs_nego2' },
          { field: 'finalPrice', id: 'cs_final' },
          { field: 'total', id: 'cs_total' },
          { field: 'lowest', id: 'cs_lowest' },
          { field: 'selected', id: 'cs_selected' },
        ]),
        k.group('totals', ['amountTotal'], { label: 'Awarded' }),
        k.group('about', ['note'], { columns: 1 }),
      ],
      chatter: true,
    })),
    'purchase.technical.comparison.list': list(PurchaseTechnicalComparison, {
      columns: ['name', 'tender', 'engineer', 'kind', 'date', 'state'],
    }),
    'purchase.technical.comparison.form': form(PurchaseTechnicalComparison, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('fill', { label: 'Fill from the RFQ' }),
          k.button('submit', { primary: true, label: 'Submit' }),
          k.button('approve', { primary: true, label: 'Approve' }),
          k.button('confirm', { primary: true, label: 'Confirm' }),
          k.button('redraft', { label: 'Set to draft' }),
          k.button('cancel', { label: 'Cancel', confirm: 'Cancel this comparison?' }),
        ],
      },
      sheet: [
        k.group('main', ['name', 'tender', 'engineer', 'kind', 'date'], {
          description: 'Fill from the RFQ: every vendor who quoted; score each out of 100.',
        }),
        k.lines('lines', [
          { field: 'response', id: 'tcs_response' },
          { field: 'score', id: 'tcs_score' },
          { field: 'meetsSpecifications', id: 'tcs_meets' },
          { field: 'note', id: 'tcs_note' },
        ]),
        k.group('about', ['remarks'], { columns: 1 }),
      ],
      chatter: true,
    })),
    'purchase.tender.response.list': list(PurchaseTenderResponse, {
      columns: ['name', 'tender', 'vendor', 'responseDate', 'amountTotal', 'dateDelivery', 'state'],
    }),
    'purchase.tender.response.form': form(PurchaseTenderResponse, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('submit', { primary: true, label: 'Submit the quotation' }),
          k.button('unanswered', { label: 'Did not respond' }),
          k.button('reject', { label: 'Reject', confirm: 'Reject this quotation?' }),
          k.button('reopen', { label: 'Reopen' }),
        ],
      },
      sheet: [
        k.group('main', ['name', 'tender', 'vendor', 'responseDate', 'technicalRank']),
        k.group('terms', ['dateDelivery', 'paymentTerms', 'advancePercent', 'tokenExpiresAt'], {
          label: 'Terms',
          description:
            'What the vendor offers; the quote link is valid until the date shown (a new one is made on request).',
        }),
        k.lines('lines', [
          { field: 'product', id: 'quote_product' },
          { field: 'quantity', id: 'quote_quantity' },
          { field: 'priceUnit', id: 'quote_price' },
          { field: 'subtotal', id: 'quote_subtotal' },
          { field: 'note', id: 'quote_note' },
        ]),
        k.group('totals', ['amountTotal'], { label: 'Total' }),
        k.group('remarks', ['remark'], { columns: 1 }),
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
    'purchase.tender': search(PurchaseTender, {
      fields: ['name', 'topic', 'vendors.name', 'lines.product.name'],
      filters: {
        mine: { label: 'Mine', domain: { buyer: { $env: 'uid' } }, group: 'who' },
        open: {
          label: 'Waiting for responses',
          domain: { state: 'sent' },
          group: 'state',
        },
        received: { label: 'Responses received', domain: { state: 'received' }, group: 'state' },
        import: { label: 'Import', domain: { sourcing: 'import' }, group: 'sourcing' },
      },
      groupBy: ['buyer', 'state', 'sourcing', 'deadline:month'],
    }),
    'purchase.comparison': search(PurchaseComparison, {
      fields: ['name', 'tender.name'],
      filters: {
        waiting: { label: 'Waiting for approval', domain: { state: 'submitted' }, group: 'state' },
        approved: { label: 'Approved', domain: { state: 'approved' }, group: 'state' },
      },
      groupBy: ['tender', 'state'],
    }),
    'purchase.technical.comparison': search(PurchaseTechnicalComparison, {
      fields: ['name', 'tender.name', 'engineer.name'],
      filters: {
        mine: { label: 'Mine', domain: { engineer: { $env: 'uid' } }, group: 'who' },
        open: {
          label: 'Not confirmed',
          domain: { state: { in: ['draft', 'submitted', 'approved'] } },
          group: 'state',
        },
      },
      groupBy: ['engineer', 'state'],
    }),
    'purchase.tender.response': search(PurchaseTenderResponse, {
      fields: ['name', 'tender.name', 'vendor.name'],
      filters: {
        submitted: { label: 'Submitted', domain: { state: 'submitted' }, group: 'state' },
        waiting: {
          label: 'Waiting for the vendor',
          domain: { state: { in: ['invited', 'quoted'] } },
          group: 'state',
        },
      },
      groupBy: ['tender', 'vendor', 'state'],
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
