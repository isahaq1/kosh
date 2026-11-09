/**
 * @packageDocumentation
 * `@kosh/mrp` (RFC 0021): the **Production** app. Bills of materials with versions and effective dates, work
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
import { mrpDemo } from './demo.js';
import { MrpBomEligibility, MrpProductSpec, MrpShift, MrpSpecParameter } from './depth.js';
import {
  DAY_STARTS_AT,
  MrpBom,
  MrpBomLine,
  MrpProduction,
  MrpProductionComponent,
  MrpWorkcenter,
  MrpWorkorder,
  mrpShutro,
} from './module.js';

export {
  BOM_KINDS,
  bomsNeedApproval,
  CompanyMrp,
  ineligible,
  MrpBomCost,
  MrpBomEligibility,
  MrpBomSpec,
  MrpProductSpec,
  MrpShift,
  MrpSpecParameter,
  reachedValues,
} from './depth.js';
export {
  MrpBom,
  MrpBomByproduct,
  MrpBomLine,
  MrpBomOperation,
  MrpProduction,
  MrpProductionComponent,
  MrpWorkcenter,
  MrpWorkorder,
  mrpShutro,
  ReorderMake,
  reviseBom,
  ScrapProduction,
  schedule,
  validBom,
} from './module.js';

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
      const centres = await (await env.model('mrp.workcenter').search({})).load([
        'name',
        'hoursPerDay',
      ]);
      const orders = await (
        await env.model('mrp.workorder').search({ where: { state: { in: ['ready', 'progress'] } } })
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

export const mrp: ReturnType<typeof defineModule> = defineModule({
  shutro: mrpShutro,
  kosh: '^0.1.0',
  hooks: { demo: mrpDemo },
  // Exceptions to the module standard (RFC 0023), each with its reason.
  standard: {
    waive: [
      { rule: 'I1', model: 'mrp.bom.spec', reason: 'Imports with its bill (the bills template).' },
      {
        rule: 'I1',
        model: 'mrp.bom.cost',
        reason: 'Written by the system when a bill is activated.',
      },
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
        editors: ['mrp.manager'],
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
      name: 'Bill of materials approvals',
      model: 'mrp.bom',
      onApproved: 'approve',
      onRejected: 'reject',
      levels: [{ name: 'Production manager', condition: {}, approverRole: 'mrp.manager' }],
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
      key: 'mrp_bom',
      name: 'Bill of materials',
      model: 'mrp.bom',
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
      model: 'mrp.production',
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
      key: 'mrp_spec_parameters',
      model: 'mrp.spec.parameter',
      label: 'Specification parameters',
      columns: [
        { header: 'Name', field: 'name' },
        { header: 'Unit', field: 'unit' },
      ],
    },
    {
      key: 'mrp_product_specs',
      model: 'mrp.product.spec',
      label: 'Product specifications',
      columns: [
        { header: 'Product', field: 'product' },
        { header: 'Parameter', field: 'parameter' },
        { header: 'Value', field: 'value' },
      ],
    },
    {
      key: 'mrp_eligibility',
      model: 'mrp.bom.eligibility',
      label: 'Component eligibility',
      columns: [
        { header: 'Kind of bill', field: 'kind' },
        { header: 'Allowed component categories', field: 'categories' },
      ],
    },
    {
      key: 'mrp_shifts',
      model: 'mrp.shift',
      label: 'Shifts',
      columns: [
        { header: 'Name', field: 'name' },
        { header: 'Start', field: 'start' },
        { header: 'End', field: 'end' },
      ],
    },
    {
      key: 'mrp_workcenter',
      model: 'mrp.workcenter',
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
      key: 'mrp_bom',
      model: 'mrp.bom',
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
      key: 'mrp_production',
      model: 'mrp.production',
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
      topic: 'mrp.production.confirmed',
      model: 'mrp.production',
      label: 'Production order confirmed',
    },
    { topic: 'mrp.production.done', model: 'mrp.production', label: 'Production order done' },
    {
      topic: 'mrp.bom.submitted',
      model: 'mrp.bom',
      label: 'Bill of materials submitted for review',
    },
    { topic: 'mrp.bom.activated', model: 'mrp.bom', label: 'Bill of materials activated' },
    { topic: 'mrp.bom.revised', model: 'mrp.bom', label: 'Bill of materials revised' },
  ],
  // Bangla for the labels it serves (RFC 0023 §3.1; `pnpm i18n:extract`).
  i18n: { bn: () => import('./i18n/bn.js') },
  accessLevels: {
    user: { label: 'User (production orders)', groups: ['mrp.user'] },
    manager: {
      label: 'Manager (bills of materials, work centres, everything)',
      groups: ['mrp.manager'],
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
        model: 'mrp.production',
        measure: 'count',
        filter: { state: 'confirmed' },
        w: 3,
      },
      {
        id: 'done_month',
        title: 'Made this month',
        kind: 'kpi',
        model: 'mrp.production',
        measure: 'count',
        filter: { state: 'done' },
        comparison: { field: 'createdAt', mode: 'previous' },
        w: 3,
      },
      {
        id: 'work_in_progress',
        title: 'Work orders in progress',
        kind: 'kpi',
        model: 'mrp.workorder',
        measure: 'count',
        filter: { state: 'progress' },
        w: 3,
      },
      {
        id: 'workcenters',
        title: 'Work centres',
        kind: 'kpi',
        model: 'mrp.workcenter',
        measure: 'count',
        w: 3,
      },
      {
        id: 'by_state',
        title: 'Orders by state',
        kind: 'chart',
        model: 'mrp.production',
        measure: 'count',
        groupBy: 'state',
        chart: 'bar',
        w: 6,
      },
      {
        id: 'made_by_product',
        title: 'Made, by product',
        kind: 'pivot',
        model: 'mrp.production',
        measure: 'sum:quantity',
        groupBy: 'product',
        filter: { state: 'done' },
        w: 6,
      },
      {
        id: 'load_by_workcenter',
        title: 'Work waiting by work centre',
        kind: 'pivot',
        model: 'mrp.workorder',
        measure: 'count',
        groupBy: 'workcenter',
        filter: { state: { in: ['ready', 'progress'] } },
        w: 6,
      },
      {
        id: 'biggest_open',
        title: 'Biggest open orders',
        kind: 'list',
        model: 'mrp.production',
        measure: 'sum:quantity',
        filter: { state: 'confirmed' },
        w: 6,
      },
    ],
  },
  actions: {
    'production.action_orders': action(MrpProduction, {
      label: 'Production orders',
      views: ['list', 'kanban', 'form'],
      defaultFilters: ['open'],
    }),
    'production.action_workorders': action(MrpWorkorder, {
      label: 'Work orders',
      views: ['gantt', 'list', 'form'],
      defaultFilters: ['open'],
    }),
    'production.action_boms': action(MrpBom, {
      label: 'Bills of materials',
      views: ['list', 'form'],
    }),
    'production.action_spec_parameters': action(MrpSpecParameter, {
      label: 'Specification parameters',
      views: ['list', 'form'],
    }),
    'production.action_product_specs': action(MrpProductSpec, {
      label: 'Product specifications',
      views: ['list', 'form'],
    }),
    'production.action_eligibility': action(MrpBomEligibility, {
      label: 'Component eligibility',
      views: ['list', 'form'],
    }),
    'production.action_shifts': action(MrpShift, {
      label: 'Shifts',
      views: ['list', 'form'],
    }),
    'production.action_workcenters': action(MrpWorkcenter, {
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
    'mrp.production.list': list(MrpProduction, {
      columns: [
        'name',
        'product',
        'quantity',
        'date',
        { field: 'totalCost', sum: true },
        { field: 'status', widget: 'badge' },
      ],
    }),
    'mrp.production.kanban': kanban(MrpProduction, {
      groupBy: 'status',
      card: { title: 'name', subtitle: 'product', footer: ['quantity', 'date'] },
    }),
    'mrp.production.form': form(MrpProduction, (k) => ({
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
    'mrp.workorder.gantt': gantt(MrpWorkorder, {
      dateStart: 'plannedStart',
      dateStop: 'plannedStop',
      title: 'name',
      groupBy: 'workcenter',
      scale: 'day',
    }),
    'mrp.workorder.list': list(MrpWorkorder, {
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
    'mrp.workorder.form': form(MrpWorkorder, (k) => ({
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
    'mrp.bom.list': list(MrpBom, {
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
    'mrp.bom.form': form(MrpBom, (k) => ({
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
    'mrp.workcenter.list': list(MrpWorkcenter, {
      columns: ['name', 'code', 'hoursPerDay', 'costPerHour', 'batchMin', 'batchMax', 'oeeTarget'],
    }),
    'mrp.workcenter.form': form(MrpWorkcenter, (k) => ({
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
    'mrp.spec.parameter.list': list(MrpSpecParameter, {
      columns: ['name', 'unit'],
      inlineEdit: ['name', 'unit'],
    }),
    'mrp.spec.parameter.form': form(MrpSpecParameter, (k) => ({
      header: { buttons: [] },
      sheet: [k.group('main', ['name', 'unit']), k.group('about', ['note'], { columns: 1 })],
    })),
    'mrp.product.spec.list': list(MrpProductSpec, {
      columns: ['product', 'parameter', 'value'],
      inlineEdit: ['value'],
    }),
    'mrp.product.spec.form': form(MrpProductSpec, (k) => ({
      header: { buttons: [] },
      sheet: [k.group('main', ['product', 'parameter', 'value'])],
    })),
    'mrp.bom.eligibility.list': list(MrpBomEligibility, {
      columns: ['kind', { field: 'categories', widget: 'tags' }],
    }),
    'mrp.bom.eligibility.form': form(MrpBomEligibility, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.group('main', ['kind', { field: 'categories', widget: 'tags' }], {
          description:
            'Lines of this kind of bill may only use products of these categories; others are refused with the reason.',
        }),
        k.group('about', ['note'], { columns: 1 }),
      ],
    })),
    'mrp.shift.list': list(MrpShift, {
      columns: ['name', 'start', 'end', 'hours'],
      inlineEdit: ['name', 'start', 'end'],
    }),
    'mrp.shift.form': form(MrpShift, (k) => ({
      header: { buttons: [] },
      sheet: [k.group('main', ['name', 'start', 'end', 'hours'])],
    })),
    'mrp.bom.line.list': list(MrpBomLine, { columns: ['bom', 'product', 'quantity', 'uom'] }),
    'mrp.production.component.list': list(MrpProductionComponent, {
      columns: ['production', 'product', 'required', 'available', 'short'],
    }),
  },
  search: {
    'mrp.production': search(MrpProduction, {
      fields: ['name', 'product.name'],
      filters: {
        open: { label: 'To do', domain: { state: { in: ['draft', 'confirmed'] } }, group: 'state' },
        waiting: { label: 'Short', domain: { status: 'waiting' }, group: 'state' },
        ready: { label: 'Ready', domain: { status: 'ready' }, group: 'state' },
        done: { label: 'Done', domain: { state: 'done' }, group: 'state' },
      },
      groupBy: ['product', 'status', 'date'],
    }),
    'mrp.bom': search(MrpBom, {
      fields: ['product.name', 'version'],
      filters: {
        active: { label: 'Active', domain: { state: 'active' }, group: 'state' },
        review: { label: 'Under review', domain: { state: 'review' }, group: 'state' },
        formula: { label: 'Formulas', domain: { kind: 'formula' }, group: 'kind' },
        packaging: { label: 'Packaging', domain: { kind: 'packaging' }, group: 'kind' },
      },
      groupBy: ['product', 'kind', 'state'],
    }),
    'mrp.spec.parameter': search(MrpSpecParameter, { fields: ['name'] }),
    'mrp.product.spec': search(MrpProductSpec, {
      fields: ['product.name', 'parameter.name'],
      groupBy: ['product', 'parameter'],
    }),
    'mrp.bom.eligibility': search(MrpBomEligibility, { fields: ['kind'], groupBy: ['kind'] }),
    'mrp.shift': search(MrpShift, { fields: ['name'] }),
    'mrp.workcenter': search(MrpWorkcenter, { fields: ['name', 'code'] }),
    'mrp.workorder': search(MrpWorkorder, {
      fields: ['name', 'production.name', 'workcenter.name'],
      filters: {
        open: { label: 'To do', domain: { state: { in: ['ready', 'progress'] } } },
      },
      groupBy: ['workcenter', 'production'],
    }),
    'mrp.bom.line': search(MrpBomLine, { fields: ['product.name'] }),
    'mrp.production.component': search(MrpProductionComponent, { fields: ['product.name'] }),
  },
});
