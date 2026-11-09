/**
 * @packageDocumentation
 * `@kosh/production` (RFC 0021): the **Production** app. Bills of materials with versions and effective dates, work
 * centres, and production orders that show what is short and what they cost before they start, moving stock through
 * Stockroom (components to Production, the product back into stock). Their work orders are scheduled at the work
 * centres and shown on a Gantt.
 *
 * - `GET /api/v1/production/capacity?from=YYYY-MM-DD&to=YYYY-MM-DD`   each centre's planned hours and load, by day
 */
import { contacts } from '@kosh/contacts';
import { messaging } from '@kosh/messaging';
import { defineModule } from '@kosh/modules-sdk';
import { permissions } from '@kosh/permissions';
import { product } from '@kosh/product';
import { reporting } from '@kosh/reporting';
import { HttpProblem, type ModuleContext } from '@kosh/server';
import { stock } from '@kosh/stock';
import { action, form, gantt, kanban, list, search } from '@kosh/views';
import type { Env } from './.kosh/bindings.js';
import { productionDemo } from './demo.js';
import {
  ProductionBomEligibility,
  ProductionProductSpec,
  ProductionShift,
  ProductionSpecParameter,
} from './depth.js';
import {
  DAY_STARTS_AT,
  ProductionBom,
  ProductionBomLine,
  ProductionOrder,
  ProductionOrderComponent,
  ProductionWorkcenter,
  ProductionWorkorder,
  productionShutro,
} from './module.js';
import { ProductionPlan, ProductionPlanLine } from './plan.js';

export {
  BOM_KINDS,
  bomsNeedApproval,
  CompanyProduction,
  ineligible,
  ProductionBomCost,
  ProductionBomEligibility,
  ProductionBomSpec,
  ProductionProductSpec,
  ProductionShift,
  ProductionSpecParameter,
  reachedValues,
} from './depth.js';
export {
  ProductionBom,
  ProductionBomByproduct,
  ProductionBomLine,
  ProductionBomOperation,
  ProductionOrder,
  ProductionOrderComponent,
  ProductionWorkcenter,
  ProductionWorkorder,
  productionShutro,
  ReorderMake,
  reviseBom,
  ScrapProduction,
  schedule,
  validBom,
} from './module.js';
export {
  generateForecast,
  ProductionPlan,
  ProductionPlanLine,
  ProductionPlanMaterial,
  procureShortages,
  scheduleOrders,
} from './plan.js';

/** Each work centre's planned hours by day (the overlap of its work orders with the day) against its hours. */
function registerCapacityRoutes({ app }: ModuleContext): void {
  app.get('/api/v1/production/capacity', async (request) => {
    const q = request.query as { from?: unknown; to?: unknown };
    const valid = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
    if (!valid(q.from) || !valid(q.to) || String(q.from) > String(q.to))
      throw new HttpProblem(
        400,
        'invalid-period',
        'Invalid period',
        'from and to as YYYY-MM-DD, from first.',
      );
    const days: string[] = [];
    for (let d = new Date(`${String(q.from)}T00:00:00`); ; d = new Date(d.getTime() + 86_400_000)) {
      const pad = (n: number) => String(n).padStart(2, '0');
      const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      if (day > String(q.to) || days.length > 92) break;
      days.push(day);
    }
    return request.env(async (raw) => {
      const env = raw as Env;
      const centres = await (await env.model('production.workcenter').search({})).load([
        'name',
        'hoursPerDay',
      ]);
      const orders = await (
        await env
          .model('production.workorder')
          .search({ where: { state: { in: ['ready', 'progress'] } } })
      ).load({ workcenter: true });
      return {
        days,
        workcenters: [...centres].map((c) => ({
          id: c.id,
          name: c.name,
          hoursPerDay: c.hoursPerDay.toString(),
          days: days.map((day) => {
            // The centre's working window that day: the work planned outside it (the night) does not count.
            const from = new Date(
              `${day}T${String(DAY_STARTS_AT).padStart(2, '0')}:00:00`,
            ).getTime();
            const to = from + Number(c.hoursPerDay) * 3_600_000;
            let ms = 0;
            for (const w of orders) {
              if (
                w.workcenter.id !== c.id ||
                !(w.plannedStart instanceof Date) ||
                !(w.plannedStop instanceof Date)
              )
                continue;
              ms += Math.max(
                0,
                Math.min(to, w.plannedStop.getTime()) - Math.max(from, w.plannedStart.getTime()),
              );
            }
            const hours = ms / 3_600_000;
            const capacity = Number(c.hoursPerDay);
            return {
              day,
              plannedHours: hours.toFixed(2),
              load: capacity > 0 ? Math.round((hours / capacity) * 100) : 0,
            };
          }),
        })),
      };
    });
  });
}

export const production: ReturnType<typeof defineModule> = defineModule({
  shutro: productionShutro,
  kosh: '^0.1.0',
  hooks: { demo: productionDemo },
  // Exceptions to the module standard (RFC 0023), each with its reason.
  standard: {
    waive: [
      {
        rule: 'I1',
        model: 'production.bom.spec',
        reason: 'Imports with its bill (the bills template).',
      },
      {
        rule: 'I1',
        model: 'production.bom.cost',
        reason: 'Written by the system when a bill is activated.',
      },
      {
        rule: 'I1',
        model: 'production.plan.line',
        reason: 'Lines import with their plan (the plans template).',
      },
      { rule: 'I1', model: 'production.plan.material', reason: 'Written by the forecast.' },
    ],
  },
  // Settings › App settings › Production (RFC 0020): per company.
  settings: {
    sections: [
      {
        key: 'bills',
        label: 'Bills of materials',
        description: 'Whether bills are approved before they make products.',
        keywords: 'bill of materials bom approval formula',
        scope: 'company',
        editors: ['production.manager'],
        fields: [
          {
            key: 'bomApproval',
            help: 'On, a bill is submitted for review and approved before an order may use it; off, a draft bill is used at once.',
          },
        ],
      },
    ],
  },
  approvals: [
    {
      name: 'Production plan approvals',
      model: 'production.plan',
      onApproved: 'approve',
      onRejected: 'reject',
      levels: [{ name: 'Production manager', condition: {}, approverRole: 'production.manager' }],
    },
    {
      name: 'Bill of materials approvals',
      model: 'production.bom',
      onApproved: 'approve',
      onRejected: 'reject',
      levels: [{ name: 'Production manager', condition: {}, approverRole: 'production.manager' }],
    },
  ],
  depends: [product, stock, contacts, messaging, reporting, permissions],
  app: {
    code: 'production',
    label: 'Production',
    icon: 'production',
    sequence: 13,
    category: 'Operations',
    summary: 'Bills of materials with versions, orders that show what is short and what they cost',
  },
  routes: (context: ModuleContext) => registerCapacityRoutes(context),
  documents: [
    {
      key: 'production_plan',
      name: 'Production plan',
      model: 'production.plan',
      layout: {
        paper: 'A4',
        orientation: 'landscape',
        header: '{{company.name}}',
        footer: 'Page {{page}} of {{pages}}',
        blocks: [
          { kind: 'heading', id: 'title', text: 'Production plan {{name}}', level: 1 },
          {
            kind: 'fields',
            id: 'about',
            items: [
              { label: 'Plan', bind: 'title' },
              { label: 'From', bind: 'dateFrom' },
              { label: 'To', bind: 'dateTo' },
              { label: 'Warehouse', bind: 'warehouse.name' },
              { label: 'Status', bind: 'state' },
            ],
          },
          {
            kind: 'table',
            id: 'lines',
            bind: 'lines',
            columns: [
              { label: 'Product', bind: 'product.name' },
              { label: 'Bill of materials', bind: 'bom.label' },
              { label: 'Quantity', bind: 'quantity' },
              { label: 'Work centre', bind: 'workcenter.name' },
              { label: 'Start', bind: 'start' },
              { label: 'End', bind: 'end' },
              { label: 'Minutes needed', bind: 'minutes' },
            ],
          },
          {
            kind: 'table',
            id: 'materials',
            bind: 'materials',
            columns: [
              { label: 'Material', bind: 'product.name' },
              { label: 'Required', bind: 'required' },
              { label: 'On hand', bind: 'onHand' },
              { label: 'On order', bind: 'onOrder' },
              { label: 'Shortage', bind: 'shortage' },
              { label: 'Ordered by', bind: 'document' },
            ],
          },
          { kind: 'text', id: 'note', text: '{{note}}' },
          { kind: 'qr', id: 'qr', bind: 'name', size: 24, label: 'Plan reference' },
        ],
      },
    },
    {
      key: 'production_bom',
      name: 'Bill of materials',
      model: 'production.bom',
      layout: {
        paper: 'A4',
        header: '{{company.name}}',
        footer: 'Page {{page}} of {{pages}}',
        blocks: [
          { kind: 'heading', id: 'title', text: 'Bill of materials {{label}}', level: 1 },
          {
            kind: 'fields',
            id: 'about',
            items: [
              { label: 'Product', bind: 'product.name' },
              { label: 'Kind', bind: 'kind' },
              { label: 'Makes', bind: 'quantity' },
              { label: 'Version', bind: 'version' },
              { label: 'Unit cost', bind: 'unitCost' },
              { label: 'Status', bind: 'state' },
            ],
          },
          {
            kind: 'table',
            id: 'lines',
            bind: 'lines',
            columns: [
              { label: 'Component', bind: 'product.name' },
              { label: 'Quantity', bind: 'quantity' },
              { label: 'Unit', bind: 'uom.name' },
              { label: 'Ratio (%)', bind: 'ratio' },
              { label: 'Loss (%)', bind: 'loss' },
              { label: 'Gross quantity', bind: 'grossQuantity' },
            ],
          },
          {
            kind: 'table',
            id: 'operations',
            bind: 'operations',
            columns: [
              { label: 'Operation', bind: 'name' },
              { label: 'Work centre', bind: 'workcenter.name' },
              { label: 'Minutes', bind: 'minutes' },
            ],
          },
          { kind: 'text', id: 'note', text: '{{note}}' },
          { kind: 'qr', id: 'qr', bind: 'label', size: 24, label: 'Bill reference' },
        ],
      },
    },
    {
      key: 'production_order',
      name: 'Production order',
      model: 'production.order',
      layout: {
        paper: 'A4',
        header: '{{company.name}}',
        footer: 'Page {{page}} of {{pages}}',
        blocks: [
          { kind: 'heading', id: 'title', text: 'Production order {{name}}', level: 1 },
          {
            kind: 'fields',
            id: 'order',
            items: [
              { label: 'Product', bind: 'product.name' },
              { label: 'Quantity', bind: 'quantity' },
              { label: 'Bill of materials', bind: 'bom.displayName' },
              { label: 'Date', bind: 'date' },
              { label: 'Warehouse', bind: 'warehouse.name' },
              { label: 'Status', bind: 'state' },
            ],
          },
          {
            kind: 'fields',
            id: 'cost',
            items: [
              { label: 'Materials', bind: 'materialCost' },
              { label: 'Operations', bind: 'operationCost' },
              { label: 'Total', bind: 'totalCost' },
              { label: 'Per unit', bind: 'unitCost' },
            ],
          },
          { kind: 'text', id: 'note', text: '{{note}}' },
          { kind: 'signature', id: 'sign', labels: ['Produced by', 'Checked by'] },
        ],
      },
    },
  ],
  importTemplates: [
    {
      key: 'production_plans',
      model: 'production.plan',
      label: 'Production plans',
      columns: [
        { header: 'Plan', field: 'title' },
        { header: 'From', field: 'dateFrom' },
        { header: 'To', field: 'dateTo' },
        { header: 'Warehouse', field: 'warehouse' },
        { header: 'Lines › Product', field: 'lines.product' },
        { header: 'Lines › Quantity', field: 'lines.quantity' },
        { header: 'Lines › Work centre', field: 'lines.workcenter' },
        { header: 'Lines › Start', field: 'lines.start' },
        { header: 'Lines › End', field: 'lines.end' },
      ],
    },
    {
      key: 'production_spec_parameters',
      model: 'production.spec.parameter',
      label: 'Specification parameters',
      columns: [
        { header: 'Name', field: 'name' },
        { header: 'Unit', field: 'unit' },
      ],
    },
    {
      key: 'production_product_specs',
      model: 'production.product.spec',
      label: 'Product specifications',
      columns: [
        { header: 'Product', field: 'product' },
        { header: 'Parameter', field: 'parameter' },
        { header: 'Value', field: 'value' },
      ],
    },
    {
      key: 'production_eligibility',
      model: 'production.bom.eligibility',
      label: 'Component eligibility',
      columns: [
        { header: 'Kind of bill', field: 'kind' },
        { header: 'Allowed component categories', field: 'categories' },
      ],
    },
    {
      key: 'production_shifts',
      model: 'production.shift',
      label: 'Shifts',
      columns: [
        { header: 'Name', field: 'name' },
        { header: 'Start', field: 'start' },
        { header: 'End', field: 'end' },
      ],
    },
    {
      key: 'production_workcenter',
      model: 'production.workcenter',
      label: 'Work centre',
      columns: [
        { header: 'Name', field: 'name' },
        { header: 'Code', field: 'code' },
        { header: 'Hours a day', field: 'hoursPerDay' },
        { header: 'Cost per hour', field: 'costPerHour' },
        { header: 'Note', field: 'note' },
      ],
    },
    {
      key: 'production_bom',
      model: 'production.bom',
      label: 'Bill of materials',
      columns: [
        { header: 'Product', field: 'product' },
        { header: 'Makes', field: 'quantity' },
        { header: 'Version', field: 'version' },
        { header: 'Valid from', field: 'validFrom' },
        { header: 'Valid until', field: 'validTo' },
        { header: 'Note', field: 'note' },
        { header: 'Components › Product', field: 'lines.product' },
        { header: 'Components › Quantity', field: 'lines.quantity' },
        { header: 'Components › Unit', field: 'lines.uom' },
      ],
    },
    {
      key: 'production_order',
      model: 'production.order',
      label: 'Production order',
      columns: [
        { header: 'Product', field: 'product' },
        { header: 'Quantity', field: 'quantity' },
        { header: 'Bill of materials', field: 'bom' },
        { header: 'Planned for', field: 'date' },
        { header: 'Warehouse', field: 'warehouse' },
        { header: 'Note', field: 'note' },
      ],
    },
  ],
  events: [
    {
      topic: 'production.order.confirmed',
      model: 'production.order',
      label: 'Production order confirmed',
    },
    { topic: 'production.order.done', model: 'production.order', label: 'Production order done' },
    {
      topic: 'production.bom.submitted',
      model: 'production.bom',
      label: 'Bill of materials submitted for review',
    },
    {
      topic: 'production.bom.activated',
      model: 'production.bom',
      label: 'Bill of materials activated',
    },
    {
      topic: 'production.bom.revised',
      model: 'production.bom',
      label: 'Bill of materials revised',
    },
    {
      topic: 'production.plan.submitted',
      model: 'production.plan',
      label: 'Production plan submitted',
    },
    {
      topic: 'production.plan.approved',
      model: 'production.plan',
      label: 'Production plan approved',
    },
    {
      topic: 'production.plan.scheduled',
      model: 'production.plan',
      label: 'Production plan scheduled into orders',
    },
  ],
  // Bangla for the labels it serves (RFC 0023 §3.1; `pnpm i18n:extract`).
  i18n: { bn: () => import('./i18n/bn.js') },
  accessLevels: {
    user: { label: 'User (production orders)', groups: ['production.user'] },
    manager: {
      label: 'Manager (bills of materials, work centres, everything)',
      groups: ['production.manager'],
      implies: ['user'],
    },
  },
  // The Overview (RFC 0022 step 2).
  overview: {
    cards: [
      {
        id: 'confirmed',
        title: 'Orders confirmed',
        kind: 'kpi',
        model: 'production.order',
        measure: 'count',
        filter: { state: 'confirmed' },
        w: 3,
      },
      {
        id: 'done_month',
        title: 'Made this month',
        kind: 'kpi',
        model: 'production.order',
        measure: 'count',
        filter: { state: 'done' },
        comparison: { field: 'createdAt', mode: 'previous' },
        w: 3,
      },
      {
        id: 'work_in_progress',
        title: 'Work orders in progress',
        kind: 'kpi',
        model: 'production.workorder',
        measure: 'count',
        filter: { state: 'progress' },
        w: 3,
      },
      {
        id: 'workcenters',
        title: 'Work centres',
        kind: 'kpi',
        model: 'production.workcenter',
        measure: 'count',
        w: 3,
      },
      {
        id: 'by_state',
        title: 'Orders by state',
        kind: 'chart',
        model: 'production.order',
        measure: 'count',
        groupBy: 'state',
        chart: 'bar',
        w: 6,
      },
      {
        id: 'made_by_product',
        title: 'Made, by product',
        kind: 'pivot',
        model: 'production.order',
        measure: 'sum:quantity',
        groupBy: 'product',
        filter: { state: 'done' },
        w: 6,
      },
      {
        id: 'load_by_workcenter',
        title: 'Work waiting by work centre',
        kind: 'pivot',
        model: 'production.workorder',
        measure: 'count',
        groupBy: 'workcenter',
        filter: { state: { in: ['ready', 'progress'] } },
        w: 6,
      },
      {
        id: 'biggest_open',
        title: 'Biggest open orders',
        kind: 'list',
        model: 'production.order',
        measure: 'sum:quantity',
        filter: { state: 'confirmed' },
        w: 6,
      },
    ],
  },
  actions: {
    'production.action_orders': action(ProductionOrder, {
      label: 'Production orders',
      views: ['list', 'kanban', 'form'],
      defaultFilters: ['open'],
    }),
    'production.action_plans': action(ProductionPlan, {
      label: 'Production plans',
      views: ['list', 'kanban', 'form'],
    }),
    'production.action_plan_lines': action(ProductionPlanLine, {
      label: 'Plan schedule',
      views: ['gantt', 'list'],
    }),
    'production.action_workorders': action(ProductionWorkorder, {
      label: 'Work orders',
      views: ['gantt', 'list', 'form'],
      defaultFilters: ['open'],
    }),
    'production.action_boms': action(ProductionBom, {
      label: 'Bills of materials',
      views: ['list', 'form'],
    }),
    'production.action_spec_parameters': action(ProductionSpecParameter, {
      label: 'Specification parameters',
      views: ['list', 'form'],
    }),
    'production.action_product_specs': action(ProductionProductSpec, {
      label: 'Product specifications',
      views: ['list', 'form'],
    }),
    'production.action_eligibility': action(ProductionBomEligibility, {
      label: 'Component eligibility',
      views: ['list', 'form'],
    }),
    'production.action_shifts': action(ProductionShift, {
      label: 'Shifts',
      views: ['list', 'form'],
    }),
    'production.action_workcenters': action(ProductionWorkcenter, {
      label: 'Work centres',
      views: ['list', 'form'],
    }),
  },
  menus: [
    { id: 'production.root', label: 'Production', app: 'production' },
    {
      id: 'production.orders',
      parent: 'production.root',
      label: 'Production orders',
      action: 'production.action_orders',
      sequence: 1,
    },
    {
      id: 'production.plans',
      parent: 'production.root',
      label: 'Production plans',
      action: 'production.action_plans',
      sequence: 2,
    },
    {
      id: 'production.plan_lines',
      parent: 'production.root',
      label: 'Plan schedule',
      action: 'production.action_plan_lines',
      sequence: 3,
    },
    {
      id: 'production.workorders',
      parent: 'production.root',
      label: 'Work orders',
      action: 'production.action_workorders',
      sequence: 2,
    },
    {
      id: 'production.boms',
      parent: 'production.root',
      label: 'Bills of materials',
      action: 'production.action_boms',
      sequence: 2,
    },
    {
      id: 'production.configuration',
      parent: 'production.root',
      label: 'Configuration',
      sequence: 9,
    },
    {
      id: 'production.spec_parameters',
      parent: 'production.configuration',
      label: 'Specification parameters',
      action: 'production.action_spec_parameters',
      sequence: 2,
    },
    {
      id: 'production.product_specs',
      parent: 'production.configuration',
      label: 'Product specifications',
      action: 'production.action_product_specs',
      sequence: 3,
    },
    {
      id: 'production.eligibility',
      parent: 'production.configuration',
      label: 'Component eligibility',
      action: 'production.action_eligibility',
      sequence: 4,
    },
    {
      id: 'production.shifts',
      parent: 'production.configuration',
      label: 'Shifts',
      action: 'production.action_shifts',
      sequence: 5,
    },
    {
      id: 'production.workcenters',
      parent: 'production.configuration',
      label: 'Work centres',
      action: 'production.action_workcenters',
      sequence: 1,
    },
  ],
  views: {
    'production.order.list': list(ProductionOrder, {
      columns: [
        'name',
        'product',
        'quantity',
        'date',
        { field: 'totalCost', sum: true },
        { field: 'status', widget: 'badge' },
      ],
    }),
    'production.order.kanban': kanban(ProductionOrder, {
      groupBy: 'status',
      card: { title: 'name', subtitle: 'product', footer: ['quantity', 'date'] },
    }),
    'production.order.form': form(ProductionOrder, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('check', { label: 'Check components' }),
          k.button('confirm', { primary: true, label: 'Confirm' }),
          k.button('reserve', { label: 'Check availability' }),
          k.button('produce', {
            primary: true,
            label: 'Produce',
            confirm: 'Produce? The components are consumed and the product enters stock.',
          }),
          k.button('cancel', { label: 'Cancel' }),
          k.button('redraft', { label: 'Back to draft' }),
        ],
      },
      sheet: [
        k.group('main', ['product', 'quantity', 'bom', 'date', 'warehouse']),
        k.group('cost', ['materialCost', 'operationCost', 'totalCost', 'unitCost', 'status'], {
          label: 'Cost',
        }),
        k.lines('components', [
          { field: 'product', id: 'component_product' },
          { field: 'required', id: 'component_required' },
          { field: 'available', id: 'component_available' },
          { field: 'short', id: 'component_short' },
          { field: 'cost', id: 'component_cost' },
        ]),
        k.lines('scraps', [
          { field: 'product', id: 'scrap_product' },
          { field: 'quantity', id: 'scrap_quantity' },
          { field: 'reason', id: 'scrap_reason' },
          { field: 'state', id: 'scrap_state' },
        ]),
        k.lines('workorders', [
          { field: 'name', id: 'workorder_name' },
          { field: 'workcenter', id: 'workorder_workcenter' },
          { field: 'plannedStart', id: 'workorder_start' },
          { field: 'plannedStop', id: 'workorder_stop' },
          { field: 'state', id: 'workorder_state' },
        ]),
        k.group('transfers', ['consumption', 'output']),
        k.group('about', ['note'], { columns: 1 }),
      ],
      chatter: true,
    })),
    'production.plan.list': list(ProductionPlan, {
      columns: ['name', 'title', 'dateFrom', 'dateTo', 'warehouse', 'shortageCount', 'state'],
    }),
    'production.plan.kanban': kanban(ProductionPlan, {
      groupBy: 'state',
      card: { title: 'name', subtitle: 'title', footer: ['dateFrom', 'shortageCount'] },
    }),
    'production.plan.form': form(ProductionPlan, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('forecast', { primary: true, label: 'Generate forecast' }),
          k.button('procure', { label: 'Procure the shortages' }),
          k.button('submit', { primary: true, label: 'Submit for approval' }),
          k.button('schedule', { primary: true, label: 'Schedule the orders' }),
          k.button('redraft', { label: 'Set to draft' }),
          k.button('cancel', { label: 'Cancel', confirm: 'Cancel this plan?' }),
        ],
      },
      sheet: [
        k.stats('related', [
          {
            id: 'plan_orders',
            label: 'Production orders',
            model: ProductionOrder,
            where: { plan: { $record: 'id' } },
            action: 'production.action_orders',
          },
        ]),
        k.group('main', ['name', 'title', 'dateFrom', 'dateTo', 'warehouse']),
        k.group('where', [{ field: 'workcenters', widget: 'tags' }, 'shortageCount'], {
          label: 'Work centres',
        }),
        k.component('approvals', 'approvals.Panel'),
        k.lines('lines', [
          { field: 'product', id: 'plan_line_product' },
          { field: 'bom', id: 'plan_line_bom' },
          { field: 'packagingBom', id: 'plan_line_packaging' },
          { field: 'quantity', id: 'plan_line_quantity' },
          { field: 'workcenter', id: 'plan_line_workcenter' },
          { field: 'start', id: 'plan_line_start' },
          { field: 'end', id: 'plan_line_end' },
          { field: 'minutes', id: 'plan_line_minutes' },
          { field: 'capacityNote', id: 'plan_line_capacity' },
          { field: 'order', id: 'plan_line_order' },
        ]),
        k.lines(
          'materials',
          [
            { field: 'product', id: 'plan_material_product' },
            { field: 'required', id: 'plan_material_required' },
            { field: 'onHand', id: 'plan_material_on_hand' },
            { field: 'onOrder', id: 'plan_material_on_order' },
            { field: 'shortage', id: 'plan_material_shortage' },
            { field: 'procured', id: 'plan_material_procured' },
            { field: 'document', id: 'plan_material_document' },
            { field: 'note', id: 'plan_material_note' },
          ],
          { readonlyWhen: {} },
        ),
        k.group('about', ['note'], { columns: 1 }),
      ],
      chatter: true,
    })),
    'production.plan.line.gantt': gantt(ProductionPlanLine, {
      dateStart: 'start',
      dateStop: 'end',
      title: 'label',
      groupBy: 'workcenter',
      scale: 'day',
    }),
    'production.plan.line.list': list(ProductionPlanLine, {
      columns: [
        'plan',
        'product',
        'quantity',
        'workcenter',
        'start',
        'end',
        'minutes',
        'capacityNote',
        'order',
      ],
    }),
    'production.workorder.gantt': gantt(ProductionWorkorder, {
      dateStart: 'plannedStart',
      dateStop: 'plannedStop',
      title: 'name',
      groupBy: 'workcenter',
      scale: 'day',
    }),
    'production.workorder.list': list(ProductionWorkorder, {
      columns: [
        'production',
        'name',
        'workcenter',
        'plannedStart',
        'plannedStop',
        'plannedMinutes',
        'actualMinutes',
        { field: 'state', widget: 'badge' },
      ],
    }),
    'production.workorder.form': form(ProductionWorkorder, (k) => ({
      chatter: true,
      header: {
        statusbar: 'state',
        buttons: [
          k.button('start', { primary: true, label: 'Start' }),
          k.button('finish', { primary: true, label: 'Finish' }),
        ],
      },
      sheet: [
        k.group('main', ['production', 'name', 'workcenter']),
        k.group('plan', ['plannedStart', 'plannedStop', 'plannedMinutes']),
        k.group('actual', ['startedAt', 'finishedAt', 'actualMinutes']),
      ],
    })),
    'production.bom.list': list(ProductionBom, {
      columns: [
        'product',
        'version',
        'kind',
        'quantity',
        'unitCost',
        'validFrom',
        'validTo',
        'state',
      ],
    }),
    'production.bom.form': form(ProductionBom, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('submit', { primary: true, label: 'Submit for review' }),
          k.button('approve', { primary: true, label: 'Approve' }),
          k.button('reject', { label: 'Send back' }),
          k.button('revise', { label: 'Create revision' }),
          k.button('deactivate', { label: 'Set inactive' }),
          k.button('reactivate', { label: 'Set active' }),
        ],
      },
      sheet: [
        k.group('main', ['product', 'kind', 'quantity', 'version', 'validFrom', 'validTo']),
        k.group('batch', ['packSize', 'expectedLoss', 'tolerance', 'unitCost'], {
          label: 'Batch',
          description:
            'A formula’s lines are shares of the batch; a packaging bill packs the product; losses are covered by the gross quantities.',
        }),
        k.component('approvals', 'approvals.Panel'),
        k.lines('lines', [
          { field: 'product', id: 'bom_line_product' },
          { field: 'quantity', id: 'bom_line_quantity' },
          { field: 'uom', id: 'bom_line_uom' },
          { field: 'ratio', id: 'bom_line_ratio' },
          { field: 'loss', id: 'bom_line_loss' },
          { field: 'netQuantity', id: 'bom_line_net' },
          { field: 'grossQuantity', id: 'bom_line_gross' },
        ]),
        k.lines('specs', [
          { field: 'parameter', id: 'bom_spec_parameter' },
          { field: 'minimum', id: 'bom_spec_min' },
          { field: 'maximum', id: 'bom_spec_max' },
          { field: 'value', id: 'bom_spec_value' },
          { field: 'within', id: 'bom_spec_within' },
        ]),
        k.lines('costs', [
          { field: 'date', id: 'bom_cost_date' },
          { field: 'unitCost', id: 'bom_cost_unit' },
          { field: 'note', id: 'bom_cost_note' },
        ]),
        k.lines('operations', [
          { field: 'name', id: 'bom_operation_name' },
          { field: 'workcenter', id: 'bom_operation_workcenter' },
          { field: 'minutes', id: 'bom_operation_minutes' },
        ]),
        k.lines('byproducts', [
          { field: 'product', id: 'bom_byproduct_product' },
          { field: 'quantity', id: 'bom_byproduct_quantity' },
          { field: 'uom', id: 'bom_byproduct_uom' },
          { field: 'costShare', id: 'bom_byproduct_share' },
        ]),
        k.group('about', ['note'], { columns: 1 }),
      ],
      chatter: true,
    })),
    'production.workcenter.list': list(ProductionWorkcenter, {
      columns: ['name', 'code', 'hoursPerDay', 'costPerHour', 'batchMin', 'batchMax', 'oeeTarget'],
    }),
    'production.workcenter.form': form(ProductionWorkcenter, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.group('main', ['name', 'code', 'hoursPerDay', 'costPerHour']),
        k.group(
          'batches',
          ['batchMin', 'batchMax', 'setupMinutes', 'cleanupMinutes', 'oeeTarget'],
          {
            label: 'Batches and effectiveness',
          },
        ),
        k.group('alternative_centres', [{ field: 'alternatives', widget: 'tags' }], {
          label: 'Alternatives',
        }),
        k.group('about', ['note'], { columns: 1 }),
      ],
    })),
    'production.spec.parameter.list': list(ProductionSpecParameter, {
      columns: ['name', 'unit'],
      inlineEdit: ['name', 'unit'],
    }),
    'production.spec.parameter.form': form(ProductionSpecParameter, (k) => ({
      header: { buttons: [] },
      sheet: [k.group('main', ['name', 'unit']), k.group('about', ['note'], { columns: 1 })],
    })),
    'production.product.spec.list': list(ProductionProductSpec, {
      columns: ['product', 'parameter', 'value'],
      inlineEdit: ['value'],
    }),
    'production.product.spec.form': form(ProductionProductSpec, (k) => ({
      header: { buttons: [] },
      sheet: [k.group('main', ['product', 'parameter', 'value'])],
    })),
    'production.bom.eligibility.list': list(ProductionBomEligibility, {
      columns: ['kind', { field: 'categories', widget: 'tags' }],
    }),
    'production.bom.eligibility.form': form(ProductionBomEligibility, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.group('main', ['kind', { field: 'categories', widget: 'tags' }], {
          description:
            'Lines of this kind of bill may only use products of these categories; others are refused with the reason.',
        }),
        k.group('about', ['note'], { columns: 1 }),
      ],
    })),
    'production.shift.list': list(ProductionShift, {
      columns: ['name', 'start', 'end', 'hours'],
      inlineEdit: ['name', 'start', 'end'],
    }),
    'production.shift.form': form(ProductionShift, (k) => ({
      header: { buttons: [] },
      sheet: [k.group('main', ['name', 'start', 'end', 'hours'])],
    })),
    'production.bom.line.list': list(ProductionBomLine, {
      columns: ['bom', 'product', 'quantity', 'uom'],
    }),
    'production.order.component.list': list(ProductionOrderComponent, {
      columns: ['production', 'product', 'required', 'available', 'short'],
    }),
  },
  search: {
    'production.order': search(ProductionOrder, {
      fields: ['name', 'product.name'],
      filters: {
        open: { label: 'To do', domain: { state: { in: ['draft', 'confirmed'] } }, group: 'state' },
        waiting: { label: 'Short', domain: { status: 'waiting' }, group: 'state' },
        ready: { label: 'Ready', domain: { status: 'ready' }, group: 'state' },
        done: { label: 'Done', domain: { state: 'done' }, group: 'state' },
      },
      groupBy: ['product', 'status', 'date'],
    }),
    'production.bom': search(ProductionBom, {
      fields: ['product.name', 'version'],
      filters: {
        active: { label: 'Active', domain: { state: 'active' }, group: 'state' },
        review: { label: 'Under review', domain: { state: 'review' }, group: 'state' },
        formula: { label: 'Formulas', domain: { kind: 'formula' }, group: 'kind' },
        packaging: { label: 'Packaging', domain: { kind: 'packaging' }, group: 'kind' },
      },
      groupBy: ['product', 'kind', 'state'],
    }),
    'production.plan': search(ProductionPlan, {
      fields: ['name', 'title', 'lines.product.name'],
      filters: {
        open: {
          label: 'Open',
          domain: { state: { in: ['draft', 'forecast', 'to_approve', 'approved'] } },
          group: 'state',
        },
        short: { label: 'With shortages', domain: { shortageCount: { gt: 0 } }, group: 'state' },
      },
      groupBy: ['warehouse', 'state', 'dateFrom:month'],
    }),
    'production.plan.line': search(ProductionPlanLine, {
      fields: ['product.name', 'plan.name'],
      filters: {
        unfit: { label: 'Beyond capacity', domain: { capacityNote: { ne: '' } }, group: 'state' },
      },
      groupBy: ['workcenter', 'plan'],
    }),
    'production.spec.parameter': search(ProductionSpecParameter, { fields: ['name'] }),
    'production.product.spec': search(ProductionProductSpec, {
      fields: ['product.name', 'parameter.name'],
      groupBy: ['product', 'parameter'],
    }),
    'production.bom.eligibility': search(ProductionBomEligibility, {
      fields: ['kind'],
      groupBy: ['kind'],
    }),
    'production.shift': search(ProductionShift, { fields: ['name'] }),
    'production.workcenter': search(ProductionWorkcenter, { fields: ['name', 'code'] }),
    'production.workorder': search(ProductionWorkorder, {
      fields: ['name', 'production.name', 'workcenter.name'],
      filters: {
        open: { label: 'To do', domain: { state: { in: ['ready', 'progress'] } } },
      },
      groupBy: ['workcenter', 'production'],
    }),
    'production.bom.line': search(ProductionBomLine, { fields: ['product.name'] }),
    'production.order.component': search(ProductionOrderComponent, { fields: ['product.name'] }),
  },
});
