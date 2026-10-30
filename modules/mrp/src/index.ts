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
import { product } from '@kosh/product';
import { HttpProblem, type ModuleContext } from '@kosh/server';
import { stock } from '@kosh/stock';
import { action, form, gantt, kanban, list, search } from '@kosh/views';
import type { Env } from './.kosh/bindings.js';
import { mrpDemo } from './demo.js';
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
  MrpBom,
  MrpBomByproduct,
  MrpBomLine,
  MrpBomOperation,
  MrpProduction,
  MrpProductionComponent,
  MrpWorkcenter,
  MrpWorkorder,
  mrpShutro,
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
  depends: [product, stock, contacts, messaging],
  app: {
    code: 'production',
    label: 'Production',
    icon: 'production',
    sequence: 13,
    category: 'Operations',
    summary: 'Bills of materials with versions, orders that show what is short and what they cost',
  },
  routes: (context: ModuleContext) => registerCapacityRoutes(context),
  accessLevels: {
    user: { label: 'User (production orders)', groups: ['mrp.user'] },
    manager: {
      label: 'Manager (bills of materials, work centres, everything)',
      groups: ['mrp.manager'],
      implies: ['user'],
    },
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
      columns: ['product', 'version', 'quantity', 'validFrom', 'validTo'],
    }),
    'mrp.bom.form': form(MrpBom, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.group('main', ['product', 'quantity', 'version', 'validFrom', 'validTo']),
        k.lines('lines', [
          { field: 'product', id: 'bom_line_product' },
          { field: 'quantity', id: 'bom_line_quantity' },
          { field: 'uom', id: 'bom_line_uom' },
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
      columns: ['name', 'code', 'hoursPerDay', 'costPerHour'],
    }),
    'mrp.workcenter.form': form(MrpWorkcenter, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.group('main', ['name', 'code', 'hoursPerDay', 'costPerHour']),
        k.group('about', ['note'], { columns: 1 }),
      ],
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
    'mrp.bom': search(MrpBom, { fields: ['product.name', 'version'], groupBy: ['product'] }),
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
