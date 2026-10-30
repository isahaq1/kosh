/**
 * @packageDocumentation
 * `@kosh/maintenance` (RFC 0021): the **Asset Care** app. Equipment with meters and warranty, preventive plans by
 * time or by meter whose orders are made when due, maintenance orders with checklists, labour and downtime, and the
 * equipment's reliability.
 *
 * - `POST /api/v1/assetcare/plans/run`                           managers: make the orders of the plans now due
 * - `GET  /api/v1/assetcare/reliability?from=YYYY-MM-DD&to=…`     failures, downtime, MTTR, MTBF, availability
 */
import { contacts } from '@kosh/contacts';
import { messaging } from '@kosh/messaging';
import { defineModule } from '@kosh/modules-sdk';
import { HttpProblem, type ModuleContext } from '@kosh/server';
import { orm } from '@kosh/server/orm';
import { action, calendar, form, kanban, list, search } from '@kosh/views';
import type { Env } from './.kosh/bindings.js';
import { maintenanceDemo } from './demo.js';
import {
  MaintenanceEquipment,
  MaintenanceMeterReading,
  MaintenancePlan,
  MaintenanceRequest,
  maintenanceShutro,
  runPlans,
} from './module.js';

export {
  hoursBetween,
  leadDays,
  MaintenanceEquipment,
  MaintenanceMeter,
  MaintenanceMeterReading,
  MaintenancePlan,
  MaintenancePlanTask,
  MaintenanceRequest,
  MaintenanceRequestTask,
  maintenanceShutro,
  runPlans,
} from './module.js';

const zero = orm.toDecimal(0);
const date = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

function registerAssetCareRoutes(context: ModuleContext): void {
  const { app } = context;
  app.post('/api/v1/assetcare/plans/run', async (request) =>
    request.env(
      async (raw) => {
        const env = raw as Env;
        if (!env.administrator && !env.groups.has('maintenance.manager'))
          throw new HttpProblem(
            403,
            'access',
            'Managers only',
            'Running the plans needs the Asset Care manager access.',
          );
        return { made: await runPlans(env) };
      },
      { write: true },
    ),
  );

  app.get('/api/v1/assetcare/reliability', async (request) => {
    const q = request.query as { from?: unknown; to?: unknown };
    if (!date(q.from) || !date(q.to) || String(q.from) > String(q.to))
      throw new HttpProblem(
        400,
        'invalid-period',
        'Invalid period',
        'from and to as YYYY-MM-DD, from first.',
      );
    const start = new Date(`${String(q.from)}T00:00:00`);
    const end = new Date(`${String(q.to)}T00:00:00`);
    end.setDate(end.getDate() + 1);
    const periodHours = orm.toDecimal(end.getTime() - start.getTime()).div(3_600_000);
    return request.env(async (raw) => {
      const env = raw as Env;
      const equipment = await (await env.model('maintenance.equipment').search({})).load(['name']);
      const breakdowns = await (
        await env.model('maintenance.request').search({
          where: { kind: 'breakdown', state: 'done', reportedAt: { gte: start, lt: end } },
        })
      ).load({ equipment: true });
      return {
        from: q.from,
        to: q.to,
        equipment: [...equipment].map((e) => {
          const mine = [...breakdowns].filter((r) => r.equipment.id === e.id);
          const failures = mine.length;
          const down = mine.reduce((s, r) => s.plus(r.downtimeHours ?? zero), zero);
          const operating = periodHours.minus(down);
          return {
            id: e.id,
            name: e.name,
            failures,
            downtimeHours: down.toFixed(2),
            mttrHours: failures === 0 ? null : down.div(failures).toFixed(2),
            mtbfHours: failures === 0 ? null : operating.div(failures).toFixed(2),
            availability: operating.div(periodHours).times(100).toFixed(2),
          };
        }),
      };
    });
  });

  // Plans are run hourly, company by company (off in the CLI and the tests that drive them).
  if (process.env['KOSH_SCHEDULES'] === 'off') return;
  const run = async () => {
    try {
      const companies = await context.shutro.bootstrap(
        { reason: 'asset care plans' },
        async (env) => (await (env as unknown as Env).model('res.company').search({})).ids,
      );
      for (const company of companies)
        await context.shutro.bootstrap({ reason: 'asset care plans', company }, (env) =>
          runPlans(env as unknown as Env),
        );
    } catch (error) {
      app.log.error({ err: error }, 'asset care plans');
    }
  };
  const timer = setInterval(() => void run(), 3_600_000);
  timer.unref();
  context.app.addHook('onClose', async () => clearInterval(timer));
}

export const maintenance: ReturnType<typeof defineModule> = defineModule({
  shutro: maintenanceShutro,
  kosh: '^0.1.0',
  hooks: { demo: maintenanceDemo },
  depends: [contacts, messaging],
  app: {
    code: 'assetcare',
    label: 'Asset Care',
    icon: 'assetcare',
    sequence: 14,
    category: 'Operations',
    summary: 'Equipment, preventive plans by time or meter, maintenance orders, reliability',
  },
  accessLevels: {
    user: { label: 'Technician (orders, readings, breakdowns)', groups: ['maintenance.user'] },
    manager: {
      label: 'Manager (equipment, plans, everything)',
      groups: ['maintenance.manager'],
      implies: ['user'],
    },
  },
  routes: (context: ModuleContext) => registerAssetCareRoutes(context),
  settings: {
    sections: [
      {
        key: 'plans',
        label: 'Preventive plans',
        description: 'How early the orders of preventive plans are made.',
        keywords: 'preventive plan maintenance lead time days due',
        scope: 'installation',
        editors: ['maintenance.manager'],
        fields: [
          {
            key: 'leadDays',
            type: 'integer',
            label: 'Days before a plan is due',
            default: 7,
            min: 0,
            max: 90,
            help: 'A plan by time gets its order this many days before it is due.',
          },
        ],
      },
    ],
  },
  actions: {
    'assetcare.action_requests': action(MaintenanceRequest, {
      label: 'Maintenance orders',
      views: ['kanban', 'list', 'calendar', 'form'],
      defaultFilters: ['open'],
    }),
    'assetcare.action_equipment': action(MaintenanceEquipment, {
      label: 'Equipment',
      views: ['kanban', 'list', 'form'],
    }),
    'assetcare.action_plans': action(MaintenancePlan, {
      label: 'Preventive plans',
      views: ['list', 'form'],
    }),
    'assetcare.action_readings': action(MaintenanceMeterReading, {
      label: 'Meter readings',
      views: ['list', 'form'],
    }),
  },
  menus: [
    { id: 'assetcare.root', label: 'Asset Care', app: 'assetcare' },
    {
      id: 'assetcare.requests',
      parent: 'assetcare.root',
      label: 'Maintenance orders',
      action: 'assetcare.action_requests',
      sequence: 1,
    },
    {
      id: 'assetcare.equipment',
      parent: 'assetcare.root',
      label: 'Equipment',
      action: 'assetcare.action_equipment',
      sequence: 2,
    },
    {
      id: 'assetcare.plans',
      parent: 'assetcare.root',
      label: 'Preventive plans',
      action: 'assetcare.action_plans',
      sequence: 3,
    },
    {
      id: 'assetcare.readings',
      parent: 'assetcare.root',
      label: 'Meter readings',
      action: 'assetcare.action_readings',
      sequence: 4,
    },
  ],
  views: {
    'maintenance.request.kanban': kanban(MaintenanceRequest, {
      groupBy: 'state',
      card: {
        title: 'name',
        subtitle: 'equipment',
        footer: ['scheduledDate', 'assignedTo'],
        badges: [
          { field: 'kind', widget: 'badge' },
          { field: 'priority', widget: 'badge' },
        ],
      },
    }),
    'maintenance.request.list': list(MaintenanceRequest, {
      columns: [
        'name',
        'equipment',
        'kind',
        'priority',
        'scheduledDate',
        'assignedTo',
        'downtimeHours',
        { field: 'state', widget: 'badge' },
      ],
    }),
    'maintenance.request.calendar': calendar(MaintenanceRequest, {
      dateStart: 'scheduledDate',
      title: 'name',
      mode: 'month',
    }),
    'maintenance.request.form': form(MaintenanceRequest, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('start', { primary: true, label: 'Start' }),
          k.button('finish', { primary: true, label: 'Finish' }),
          k.button('cancel', { label: 'Cancel' }),
        ],
      },
      sheet: [
        k.group('main', ['equipment', 'kind', 'plan', 'priority', 'assignedTo', 'scheduledDate']),
        k.group('times', [
          'reportedAt',
          'startedAt',
          'finishedAt',
          'downtime',
          'downtimeHours',
          'labourHours',
        ]),
        k.group('what', ['description'], { columns: 1 }),
        k.lines('tasks', [
          { field: 'name', id: 'request_task_name' },
          { field: 'done', id: 'request_task_done' },
        ]),
        k.group('about', ['note'], { columns: 1 }),
      ],
      chatter: true,
    })),
    'maintenance.equipment.kanban': kanban(MaintenanceEquipment, {
      groupBy: 'status',
      card: {
        title: 'name',
        subtitle: 'location',
        footer: ['code', 'warrantyUntil'],
        badges: [{ field: 'category', widget: 'badge' }],
      },
    }),
    'maintenance.equipment.list': list(MaintenanceEquipment, {
      columns: [
        'name',
        'code',
        'category',
        'location',
        'warrantyUntil',
        'responsible',
        { field: 'status', widget: 'badge' },
      ],
    }),
    'maintenance.equipment.form': form(MaintenanceEquipment, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.group('main', ['name', 'code', 'category', 'location', 'responsible', 'status']),
        k.group('purchase', ['vendor', 'purchaseDate', 'warrantyUntil']),
        k.lines('meters', [
          { field: 'name', id: 'meter_name' },
          { field: 'unit', id: 'meter_unit' },
          { field: 'value', id: 'meter_value' },
        ]),
        k.lines('plans', [
          { field: 'name', id: 'equipment_plan_name' },
          { field: 'trigger', id: 'equipment_plan_trigger' },
          { field: 'nextDate', id: 'equipment_plan_next' },
        ]),
        k.group('about', ['note'], { columns: 1 }),
      ],
      chatter: true,
    })),
    'maintenance.plan.list': list(MaintenancePlan, {
      columns: [
        'name',
        'equipment',
        'trigger',
        'intervalDays',
        'intervalValue',
        'nextDate',
        'lastDoneDate',
      ],
    }),
    'maintenance.plan.form': form(MaintenancePlan, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.group('main', ['name', 'equipment', 'trigger', 'hours']),
        k.group('by_time', ['intervalDays', 'startDate', 'nextDate', 'lastDoneDate']),
        k.group('by_meter', ['meter', 'intervalValue', 'lastDoneValue']),
        k.lines('tasks', [{ field: 'name', id: 'plan_task_name' }]),
      ],
    })),
    'maintenance.meter.reading.list': list(MaintenanceMeterReading, {
      columns: ['meter', 'date', 'value'],
    }),
    'maintenance.meter.reading.form': form(MaintenanceMeterReading, (k) => ({
      header: { buttons: [] },
      sheet: [k.group('main', ['meter', 'date', 'value'])],
    })),
  },
  search: {
    'maintenance.request': search(MaintenanceRequest, {
      fields: ['name', 'equipment.name', 'description'],
      filters: {
        open: { label: 'To do', domain: { state: { in: ['new', 'progress'] } }, group: 'state' },
        breakdowns: { label: 'Breakdowns', domain: { kind: 'breakdown' }, group: 'kind' },
        preventive: { label: 'Preventive', domain: { kind: 'preventive' }, group: 'kind' },
        mine: { label: 'Mine', domain: { assignedTo: { $env: 'uid' } } },
      },
      groupBy: ['equipment', 'kind', 'assignedTo', 'state'],
    }),
    'maintenance.equipment': search(MaintenanceEquipment, {
      fields: ['name', 'code', 'location'],
      filters: { down: { label: 'Down', domain: { status: 'down' } } },
      groupBy: ['category', 'status', 'responsible'],
    }),
    'maintenance.plan': search(MaintenancePlan, {
      fields: ['name', 'equipment.name'],
      groupBy: ['equipment', 'trigger'],
    }),
    'maintenance.meter.reading': search(MaintenanceMeterReading, {
      fields: ['meter.name'],
      groupBy: ['meter'],
    }),
  },
});
