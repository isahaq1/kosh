/**
 * The data layer of Asset Care (RFC 0021): equipment with its meters and warranty, preventive plans by time or by
 * meter with their checklists, and maintenance orders — preventive or breakdown — whose checklist is ticked before
 * they are done, with labour hours and the downtime from report to finish.
 */
import { contactsShutro } from '@kosh/contacts';
import { messagingShutro } from '@kosh/messaging';
import { installationSetting } from '@kosh/server';
import { type Decimal, type Id, orm } from '@kosh/server/orm';
import {
  check,
  compute,
  defineModel,
  defineModule,
  type Env,
  f,
  records,
} from './.kosh/bindings.js';

const READ = ['read'] as const;
const ALL = ['read', 'write', 'create', 'unlink'] as const;
const zero = orm.toDecimal(0);
const OPEN = ['new', 'progress'] as const;

/** A date as `YYYY-MM-DD` (date-only values from PostgreSQL are local midnights: their local parts). */
export const iso = (v: unknown): string => {
  if (!(v instanceof Date)) return String(v ?? '').slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
};
const addDays = (date: string, days: number): string => {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + days);
  return iso(d);
};
/** Hours between two instants, from whole milliseconds (no fractional JS numbers into decimals). */
export const hoursBetween = (from: Date, to: Date): Decimal =>
  orm.toDecimal(Math.max(0, to.getTime() - from.getTime())).div(3_600_000);

/** How many days before a plan is due its order is made (App settings › Asset Care). */
export async function leadDays(env: Env): Promise<number> {
  const value = Number(await installationSetting(env, 'maintenance.leadDays', 7));
  return Number.isInteger(value) && value >= 0 ? value : 7;
}

export const MaintenanceEquipment = defineModel('maintenance.equipment', {
  label: 'Equipment',
  recName: 'name',
  order: ['name asc'],
  archivable: true,
  companyScoped: { required: true },
  tracking: ['location', 'responsible', 'warrantyUntil'],
  access: {
    'maintenance.user': READ,
    'maintenance.manager': [...ALL, 'export', 'import'],
  },
  fields: {
    name: f.char({ required: true }),
    /** The asset tag or serial number. */
    code: f.char({ label: 'Asset tag' }),
    category: f.selection(
      {
        machine: 'Machine',
        vehicle: 'Vehicle',
        it: 'IT equipment',
        building: 'Building and facilities',
        tool: 'Tool',
        other: 'Other',
      },
      { required: true, default: 'machine' },
    ),
    location: f.char({ label: 'Where it is' }),
    vendor: f.many2one('res.partner', { ondelete: 'set null' }),
    purchaseDate: f.date({ label: 'Bought on' }),
    warrantyUntil: f.date({ label: 'Warranty until' }),
    responsible: f.many2one('res.users', { ondelete: 'set null' }),
    meters: f.one2many('maintenance.meter', 'equipment'),
    plans: f.one2many('maintenance.plan', 'equipment'),
    requests: f.one2many('maintenance.request', 'equipment', { label: 'Maintenance orders' }),
    /** Operational, Down while a breakdown is open, Retired when archived. */
    status: f.selection(
      { operational: 'Operational', down: 'Down', retired: 'Retired' },
      {
        store: true,
        label: 'Status',
        ...compute(
          'maintenance.equipment',
          'status',
          ['active', 'requests.state', 'requests.kind'],
          (equipment) => {
            for (const e of equipment)
              e.status = !e.active
                ? 'retired'
                : [...e.requests].some(
                      (r) =>
                        r.kind === 'breakdown' && (r.state === 'new' || r.state === 'progress'),
                    )
                  ? 'down'
                  : 'operational';
          },
        ),
      },
    ),
    note: f.text(),
  },
  sqlConstraints: {
    oneTag: {
      unique: ['company', 'code'],
      message: 'Another piece of equipment has this asset tag.',
    },
  },
});

export const MaintenanceMeter = defineModel('maintenance.meter', {
  label: 'Meter',
  recName: 'name',
  order: ['id asc'],
  access: { 'maintenance.user': READ, 'maintenance.manager': ALL },
  fields: {
    equipment: f.many2one('maintenance.equipment', { required: true, ondelete: 'cascade' }),
    name: f.char({ required: true }),
    unit: f.char({ required: true, default: 'h' }),
    readings: f.one2many('maintenance.meter.reading', 'meter'),
    /** The latest reading. */
    value: f.decimal({
      scale: 2,
      store: true,
      label: 'Reading',
      ...compute('maintenance.meter', 'value', ['readings.value', 'readings.date'], (meters) => {
        for (const m of meters) {
          const latest = [...m.readings].sort(
            (a, b) => b.date.getTime() - a.date.getTime() || b.id - a.id,
          )[0];
          m.value = latest?.value ?? zero;
        }
      }),
    }),
  },
});

export const MaintenanceMeterReading = defineModel('maintenance.meter.reading', {
  label: 'Meter reading',
  order: ['date desc', 'id desc'],
  access: {
    'maintenance.user': ['read', 'create'],
    'maintenance.manager': ALL,
  },
  fields: {
    meter: f.many2one('maintenance.meter', { required: true, ondelete: 'cascade' }),
    date: f.datetime({ required: true, default: () => new Date(), label: 'Read at' }),
    value: f.decimal({ scale: 2, required: true }),
  },
  constraints: {
    // A meter counts up: a reading is never below an earlier one, nor above a later one.
    neverBackwards: {
      ...check('maintenance.meter.reading', ['value', 'date', 'meter'], async (readings) =>
        readings.env.asSuperuser({ reason: 'meter readings' }, async (su) => {
          const failing: number[] = [];
          for (const r of readings) {
            const earlierHigher = await su.model('maintenance.meter.reading').search({
              where: {
                meter: r.meter.id,
                date: { lt: r.date },
                value: { gt: r.value },
                id: { ne: r.id },
              },
              limit: 1,
            });
            const laterLower = await su.model('maintenance.meter.reading').search({
              where: {
                meter: r.meter.id,
                date: { gt: r.date },
                value: { lt: r.value },
                id: { ne: r.id },
              },
              limit: 1,
            });
            if (earlierHigher.length > 0 || laterLower.length > 0) failing.push(r.id);
          }
          return failing;
        }),
      ),
      message: 'A meter counts up: a reading cannot be below an earlier one.',
    },
  },
});

export const MaintenancePlan = defineModel('maintenance.plan', {
  label: 'Preventive plan',
  recName: 'name',
  order: ['nextDate asc', 'id asc'],
  archivable: true,
  companyScoped: { required: true },
  tracking: ['lastDoneDate', 'lastDoneValue'],
  access: { 'maintenance.user': READ, 'maintenance.manager': [...ALL, 'export'] },
  fields: {
    name: f.char({ required: true }),
    equipment: f.many2one('maintenance.equipment', { required: true, ondelete: 'cascade' }),
    trigger: f.selection(
      { time: 'Every so many days', meter: 'Every so much on a meter' },
      { required: true, default: 'time', label: 'When' },
    ),
    intervalDays: f.integer({ label: 'Every (days)' }),
    startDate: f.date({ required: true, default: (env: Env) => env.today(), label: 'From' }),
    meter: f.many2one('maintenance.meter', { ondelete: 'restrict' }),
    intervalValue: f.decimal({ scale: 2, label: 'Every (on the meter)' }),
    lastDoneDate: f.date({ label: 'Last done' }),
    lastDoneValue: f.decimal({ scale: 2, label: 'Last done at (meter)' }),
    /** By time: when it is next due. */
    nextDate: f.date({
      store: true,
      label: 'Next due',
      ...compute(
        'maintenance.plan',
        'nextDate',
        ['trigger', 'intervalDays', 'startDate', 'lastDoneDate'],
        (plans) => {
          for (const p of plans)
            p.nextDate =
              p.trigger !== 'time' || p.intervalDays === null
                ? null
                : p.lastDoneDate === null
                  ? p.startDate
                  : (addDays(iso(p.lastDoneDate), p.intervalDays) as never);
        },
      ),
    }),
    tasks: f.one2many('maintenance.plan.task', 'plan', { label: 'Checklist' }),
    hours: f.decimal({ scale: 2, default: '1', label: 'Planned hours' }),
  },
  constraints: {
    complete: {
      ...check(
        'maintenance.plan',
        ['trigger', 'intervalDays', 'meter', 'intervalValue', 'equipment'],
        async (plans) =>
          (await plans.load({ meter: true }))
            .filter((p) =>
              p.trigger === 'time'
                ? p.intervalDays === null || p.intervalDays <= 0
                : p.meter === null ||
                  p.intervalValue === null ||
                  p.intervalValue.lte(0) ||
                  p.meter.equipment.id !== p.equipment.id,
            )
            .map((p) => p.id),
      ),
      message:
        'A plan by time repeats every so many days; by meter, every so much on one of the equipment’s meters.',
    },
  },
});

export const MaintenancePlanTask = defineModel('maintenance.plan.task', {
  label: 'Checklist item',
  order: ['id asc'],
  access: { 'maintenance.user': READ, 'maintenance.manager': ALL },
  fields: {
    plan: f.many2one('maintenance.plan', { required: true, ondelete: 'cascade' }),
    name: f.char({ required: true }),
  },
});

export const MaintenanceRequestTask = defineModel('maintenance.request.task', {
  label: 'Checklist item',
  order: ['id asc'],
  access: {
    'maintenance.user': ['read', 'write', 'create'],
    'maintenance.manager': ALL,
  },
  fields: {
    request: f.many2one('maintenance.request', { required: true, ondelete: 'cascade' }),
    name: f.char({ required: true }),
    done: f.boolean({ default: false }),
  },
});

export const MaintenanceRequest = defineModel('maintenance.request', {
  label: 'Maintenance order',
  recName: 'name',
  order: ['scheduledDate asc', 'id desc'],
  companyScoped: { required: true },
  tracking: ['state', 'assignedTo', 'scheduledDate'],
  access: {
    'maintenance.user': ['read', 'write', 'create'],
    'maintenance.manager': [...ALL, 'export', 'import'],
  },
  fields: {
    name: f.char({
      required: true,
      readonly: true,
      sequence: { code: 'maintenance.request', dateField: 'scheduledDate' },
      label: 'Reference',
    }),
    equipment: f.many2one('maintenance.equipment', { required: true, ondelete: 'restrict' }),
    kind: f.selection(
      { preventive: 'Preventive', breakdown: 'Breakdown' },
      { required: true, default: 'breakdown', label: 'Type' },
    ),
    plan: f.many2one('maintenance.plan', { ondelete: 'set null' }),
    description: f.text({ label: 'What is wrong / what to do' }),
    priority: f.selection(
      { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' },
      { required: true, default: 'normal' },
    ),
    scheduledDate: f.date({
      required: true,
      default: (env: Env) => env.today(),
      label: 'Planned for',
    }),
    assignedTo: f.many2one('res.users', { ondelete: 'set null', label: 'Technician' }),
    reportedAt: f.datetime({ required: true, default: () => new Date(), label: 'Reported' }),
    startedAt: f.datetime({ label: 'Started' }),
    finishedAt: f.datetime({ label: 'Finished' }),
    /** The equipment stood still from the report to the finish (breakdowns by default). */
    downtime: f.boolean({ default: true, label: 'Equipment stopped' }),
    downtimeHours: f.decimal({
      scale: 2,
      store: true,
      label: 'Downtime (hours)',
      ...compute(
        'maintenance.request',
        'downtimeHours',
        ['downtime', 'reportedAt', 'finishedAt'],
        (requests) => {
          for (const r of requests)
            r.downtimeHours =
              r.downtime && r.finishedAt !== null
                ? hoursBetween(r.reportedAt, r.finishedAt).toDecimalPlaces(2)
                : zero;
        },
      ),
    }),
    labourHours: f.decimal({ scale: 2, default: '0', label: 'Labour (hours)' }),
    tasks: f.one2many('maintenance.request.task', 'request', { label: 'Checklist' }),
    note: f.text(),
    state: f.state({
      states: { new: 'New', progress: 'In progress', done: 'Done', cancel: 'Cancelled' },
      initial: 'new',
      transitions: {
        start: {
          from: ['new'],
          to: 'progress',
          after: records('maintenance.request', async (requests): Promise<void> => {
            await requests.write({ startedAt: new Date() } as never);
          }),
        },
        finish: {
          from: ['progress'],
          to: 'done',
          guard: records('maintenance.request', async (requests) =>
            (await requests.load({ tasks: true })).filter((r) => [...r.tasks].some((t) => !t.done)),
          ),
          message: 'Tick every item of the checklist first.',
          // Done: when, and a preventive order moves its plan on.
          after: records('maintenance.request', async (requests): Promise<void> => {
            const env = requests.env as unknown as Env;
            await requests.write({ finishedAt: new Date() } as never);
            await env.asSuperuser({ reason: 'preventive plan done' }, async (su) => {
              for (const r of await su
                .model('maintenance.request')
                .browse(requests.ids)
                .load({ plan: { meter: true } })) {
                if (r.plan === null) continue;
                await su
                  .model('maintenance.plan')
                  .browse([r.plan.id])
                  .write({ lastDoneDate: su.today(), lastDoneValue: r.plan.meter?.value ?? null });
              }
            });
          }),
        },
        cancel: { from: ['new', 'progress'], to: 'cancel' },
      },
    }),
  },
});

/**
 * Makes the maintenance order of every active plan that is due (by time within the lead time, by meter once the
 * meter passed its interval) and has no open order, with its checklist. Returns how many were made.
 */
export async function runPlans(env: Env): Promise<number> {
  const lead = await leadDays(env);
  return env.asSuperuser({ reason: 'preventive plans' }, async (su) => {
    const today = iso(su.today());
    let made = 0;
    const plans = await (await su.model('maintenance.plan').search({})).load({
      meter: true,
      tasks: true,
      equipment: true,
    });
    for (const p of plans) {
      if (!p.equipment.active) continue;
      const open = await su.model('maintenance.request').search({
        where: { plan: p.id, state: { in: [...OPEN] } },
        limit: 1,
      });
      if (open.length > 0) continue;
      let due: string | null = null;
      if (p.trigger === 'time' && p.nextDate !== null) {
        const next = iso(p.nextDate);
        if (next <= addDays(today, lead)) due = next < today ? today : next;
      } else if (p.trigger === 'meter' && p.meter !== null && p.intervalValue !== null) {
        if ((p.meter.value ?? zero).gte((p.lastDoneValue ?? zero).plus(p.intervalValue)))
          due = today;
      }
      if (due === null) continue;
      await su.model('maintenance.request').create([
        {
          equipment: p.equipment.id,
          company: p.company.id,
          kind: 'preventive',
          plan: p.id,
          description: p.name,
          scheduledDate: due,
          downtime: false,
          assignedTo: p.equipment.responsible?.id ?? null,
          tasks: { create: [...p.tasks].map((t) => ({ name: t.name })) },
        },
      ] as never);
      made += 1;
    }
    await su.flush();
    return made;
  });
}

export const maintenanceShutro = defineModule({
  name: 'maintenance',
  version: '0.1.0',
  depends: [contactsShutro, messagingShutro],
  groups: [
    orm.defineGroup({ code: 'maintenance.user', label: 'Technician', implies: ['base.user'] }),
    orm.defineGroup({
      code: 'maintenance.manager',
      label: 'Asset Care manager',
      implies: ['maintenance.user'],
    }),
  ],
  sequences: [
    orm.defineSequence({
      code: 'maintenance.request',
      prefix: 'MT/{year}/',
      padding: 5,
      reset: 'yearly',
    }),
  ],
  models: [
    MaintenanceEquipment,
    MaintenanceMeter,
    MaintenanceMeterReading,
    MaintenancePlan,
    MaintenancePlanTask,
    MaintenanceRequest,
    MaintenanceRequestTask,
  ],
});

export type { Id };
