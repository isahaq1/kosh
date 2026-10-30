/**
 * @packageDocumentation
 * `@kosh/mrp` (RFC 0021): the **Production** app. Bills of materials with versions and effective dates, work
 * centres, and production orders that show what is short and what they cost before they start, moving stock through
 * Stockroom (components to Production, the product back into stock).
 */
import { contacts } from '@kosh/contacts';
import { messaging } from '@kosh/messaging';
import { defineModule } from '@kosh/modules-sdk';
import { product } from '@kosh/product';
import { stock } from '@kosh/stock';
import { action, form, kanban, list, search } from '@kosh/views';
import { mrpDemo } from './demo.js';
import {
  MrpBom,
  MrpBomLine,
  MrpProduction,
  MrpProductionComponent,
  MrpWorkcenter,
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
  mrpShutro,
  ScrapProduction,
  validBom,
} from './module.js';

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
        k.group('transfers', ['consumption', 'output']),
        k.group('about', ['note'], { columns: 1 }),
      ],
      chatter: true,
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
    'mrp.bom.line': search(MrpBomLine, { fields: ['product.name'] }),
    'mrp.production.component': search(MrpProductionComponent, { fields: ['product.name'] }),
  },
});
