/**
 * The data layer of Fleet (RFC 0038, step 2): **vehicles** with their driver, **papers** that expire —
 * registration, fitness, tax token, insurance —, **fuel** and **service** logs, and **trips**. A vehicle's
 * figures are kept by the server from its logs: the odometer (the highest reading), what it cost in fuel and
 * service, the distance covered, kilometres per litre by full tanks (`consumption.ts`), the cost per kilometre
 * and the next service due.
 *
 * A reading never goes back: a fill or a service below a reading of an earlier day is refused. A paper's status
 * follows the calendar — the server looks every day — and the day it starts to expire an event is emitted, once.
 */

import { contactsShutro } from '@kosh/contacts';
import { messagingShutro } from '@kosh/messaging';
import { emitting } from '@kosh/server';
import { type Decimal, orm } from '@kosh/server/orm';
import {
  check,
  compute,
  defineModel,
  defineModule,
  type Env,
  f,
  records,
} from './.kosh/bindings.js';
import { type Fill, kmPerLitre } from './consumption.js';

const READ = ['read'] as const;
const ALL = ['read', 'write', 'create', 'unlink'] as const;
/** Fields the server maintains: written by its own code and by Administrators only. */
const SYSTEM = ['base.admin'] as const;
const zero = orm.toDecimal(0);

/** A date as `YYYY-MM-DD` (date-only values from PostgreSQL are local midnights: their local parts). */
export const iso = (v: unknown): string => {
  if (!(v instanceof Date)) return String(v ?? '').slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
};
const addDays = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
/** A decimal of kilometres or litres as whole thousandths (metres, millilitres). */
const thousandths = (v: Decimal | null | undefined): number =>
  v === null || v === undefined ? 0 : Number(v.times(1000).toDecimalPlaces(0).toString());

const FUELS = {
  petrol: 'Petrol',
  octane: 'Octane',
  diesel: 'Diesel',
  cng: 'CNG',
  lpg: 'LPG',
  electric: 'Electric',
  hybrid: 'Hybrid',
} as const;

const LOGS = [
  'fuelLogs.odometer',
  'serviceLogs.odometer',
  'trips.odometerStart',
  'trips.odometerEnd',
  'trips.state',
] as const;

/** Every reading a vehicle has, in kilometres. */
const readings = (v: {
  initialOdometer: Decimal | null;
  fuelLogs: Iterable<{ odometer: Decimal | null }>;
  serviceLogs: Iterable<{ odometer: Decimal | null }>;
  trips: Iterable<{ odometerStart: Decimal | null; odometerEnd: Decimal | null; state: string }>;
}): Decimal[] => {
  const out: Decimal[] = [];
  if (v.initialOdometer !== null) out.push(v.initialOdometer);
  for (const l of v.fuelLogs) if (l.odometer !== null) out.push(l.odometer);
  for (const l of v.serviceLogs) if (l.odometer !== null) out.push(l.odometer);
  for (const t of v.trips) {
    if (t.state === 'cancel') continue;
    if (t.odometerStart !== null) out.push(t.odometerStart);
    if (t.odometerEnd !== null) out.push(t.odometerEnd);
  }
  return out;
};
const highest = (values: readonly Decimal[]): Decimal | null =>
  values.length === 0 ? null : values.reduce((a, b) => (b.gt(a) ? b : a));
const lowest = (values: readonly Decimal[]): Decimal | null =>
  values.length === 0 ? null : values.reduce((a, b) => (b.lt(a) ? b : a));

export const FleetVehicle = defineModel('fleet.vehicle', {
  label: 'Vehicle',
  recName: 'name',
  order: ['name asc'],
  archivable: true,
  companyScoped: { required: true },
  access: { 'fleet.user': READ, 'fleet.manager': [...ALL, 'export', 'import'] },
  fields: {
    name: f.char({
      required: true,
      label: 'Name',
      help: 'What people call it: the plate with the model — “DM-GA 12-3456 Hiace”.',
    }),
    plate: f.char({ size: 40, required: true, label: 'Plate number' }),
    make: f.char({ label: 'Make' }),
    series: f.char({ label: 'Model' }),
    year: f.integer({ label: 'Year' }),
    kind: f.selection(
      {
        car: 'Car',
        pickup: 'Pickup',
        truck: 'Truck',
        bus: 'Bus',
        motorcycle: 'Motorcycle',
        other: 'Other',
      },
      { required: true, default: 'car', label: 'Type', help: 'What sort of vehicle it is.' },
    ),
    fuel: f.selection(FUELS, {
      required: true,
      default: 'diesel',
      label: 'Fuel',
      help: 'What it runs on.',
    }),
    driver: f.many2one('res.partner', { ondelete: 'set null', index: true, label: 'Driver' }),
    status: f.selection(
      { available: 'Available', workshop: 'In the workshop', retired: 'Retired' },
      {
        required: true,
        default: 'available',
        label: 'Status',
        help: 'A retired vehicle takes no trip; one in the workshop is told apart on the list.',
      },
    ),
    acquiredOn: f.date({ label: 'Bought on' }),
    purchaseValue: f.decimal({ scale: 2, label: 'Bought for' }),
    initialOdometer: f.decimal({
      scale: 1,
      label: 'Odometer when it came (km)',
      help: 'The reading when the vehicle entered the fleet: distances are counted from it.',
    }),
    note: f.text(),
    documents: f.one2many('fleet.document', 'vehicle', { label: 'Papers' }),
    fuelLogs: f.one2many('fleet.fuel', 'vehicle', { label: 'Fuel' }),
    serviceLogs: f.one2many('fleet.service', 'vehicle', { label: 'Services' }),
    trips: f.one2many('fleet.trip', 'vehicle', { label: 'Trips' }),
    odometer: f.decimal({
      scale: 1,
      store: true,
      label: 'Odometer (km)',
      help: 'The highest reading of its fills, services and trips.',
      ...compute('fleet.vehicle', 'odometer', ['initialOdometer', ...LOGS], (vehicles) => {
        for (const v of vehicles) v.odometer = highest(readings(v));
      }),
    }),
    distance: f.decimal({
      scale: 1,
      store: true,
      label: 'Distance covered (km)',
      help: 'From its first reading — the one it came with — to the highest.',
      ...compute('fleet.vehicle', 'distance', ['initialOdometer', ...LOGS], (vehicles) => {
        for (const v of vehicles) {
          const all = readings(v);
          const from = v.initialOdometer ?? lowest(all);
          const to = highest(all);
          v.distance = from === null || to === null ? zero : to.minus(from);
        }
      }),
    }),
    fuelCost: f.decimal({
      scale: 2,
      store: true,
      label: 'Fuel cost',
      help: 'What its fills cost.',
      ...compute('fleet.vehicle', 'fuelCost', ['fuelLogs.amount'], (vehicles) => {
        for (const v of vehicles)
          v.fuelCost = [...v.fuelLogs].reduce((s, l) => s.plus(l.amount ?? zero), zero);
      }),
    }),
    serviceCost: f.decimal({
      scale: 2,
      store: true,
      label: 'Service cost',
      help: 'What its services and repairs cost.',
      ...compute('fleet.vehicle', 'serviceCost', ['serviceLogs.amount'], (vehicles) => {
        for (const v of vehicles)
          v.serviceCost = [...v.serviceLogs].reduce((s, l) => s.plus(l.amount ?? zero), zero);
      }),
    }),
    kmPerLitre: f.decimal({
      scale: 2,
      store: true,
      label: 'Kilometres per litre',
      help: 'Between full tanks: the distance from the first fill that filled the tank to the last, over the fuel put in since the first. Empty until two full tanks.',
      ...compute(
        'fleet.vehicle',
        'kmPerLitre',
        ['fuelLogs.odometer', 'fuelLogs.litres', 'fuelLogs.fullTank'],
        (vehicles) => {
          for (const v of vehicles) {
            const fills: Fill[] = [...v.fuelLogs].map((l) => ({
              odometer: thousandths(l.odometer),
              volume: thousandths(l.litres),
              full: l.fullTank === true,
            }));
            const rate = kmPerLitre(fills);
            v.kmPerLitre = rate === null ? null : orm.toDecimal(rate);
          }
        },
      ),
    }),
    costPerKm: f.decimal({
      scale: 2,
      store: true,
      label: 'Cost per kilometre',
      help: 'Fuel and service costs over the distance covered. Empty until the vehicle has covered some.',
      ...compute(
        'fleet.vehicle',
        'costPerKm',
        ['fuelCost', 'serviceCost', 'distance'],
        (vehicles) => {
          for (const v of vehicles) {
            const distance = v.distance ?? zero;
            v.costPerKm = distance.gt(0)
              ? (v.fuelCost ?? zero)
                  .plus(v.serviceCost ?? zero)
                  .div(distance)
                  .toDecimalPlaces(2)
              : null;
          }
        },
      ),
    }),
    serviceDueOn: f.date({
      store: true,
      label: 'Next service on',
      help: 'From its latest service that says when the next is due.',
      ...compute(
        'fleet.vehicle',
        'serviceDueOn',
        ['serviceLogs.date', 'serviceLogs.nextDueOn'],
        (vehicles) => {
          for (const v of vehicles)
            v.serviceDueOn =
              latestWith(v.serviceLogs, (l) => l.nextDueOn !== null)?.nextDueOn ?? null;
        },
      ),
    }),
    serviceDueAt: f.decimal({
      scale: 1,
      store: true,
      label: 'Next service at (km)',
      help: 'From its latest service that says at which reading the next is due.',
      ...compute(
        'fleet.vehicle',
        'serviceDueAt',
        ['serviceLogs.date', 'serviceLogs.nextDueAt'],
        (vehicles) => {
          for (const v of vehicles)
            v.serviceDueAt =
              latestWith(v.serviceLogs, (l) => l.nextDueAt !== null)?.nextDueAt ?? null;
        },
      ),
    }),
  },
  sqlConstraints: {
    plate: { unique: ['company', 'plate'], message: 'Another vehicle has this plate number.' },
    sane: {
      check: orm.sql`(initial_odometer IS NULL OR initial_odometer >= 0)
        AND (purchase_value IS NULL OR purchase_value >= 0)
        AND (year IS NULL OR year BETWEEN 1900 AND 2200)`,
      message: 'The odometer and the price are not negative, and the year is a year.',
    },
  },
});

/** The latest service, by its date, that says what is asked of it. */
function latestWith<T extends { date: unknown; id: number }>(
  logs: Iterable<T>,
  says: (log: T) => boolean,
): T | null {
  let found: T | null = null;
  for (const l of logs) {
    if (!says(l)) continue;
    if (
      found === null ||
      iso(l.date) > iso(found.date) ||
      (iso(l.date) === iso(found.date) && l.id > found.id)
    )
      found = l;
  }
  return found;
}

export const DOCUMENT_KINDS = {
  registration: 'Registration',
  fitness: 'Fitness certificate',
  tax_token: 'Tax token',
  insurance: 'Insurance',
  route_permit: 'Route permit',
  other: 'Other',
} as const;

/** What a paper is on a day: valid, about to expire (within its reminder days), or expired. */
export function paperStatus(
  expiresOn: string,
  remindDays: number,
  today: string,
): 'valid' | 'expiring' | 'expired' {
  if (expiresOn < today) return 'expired';
  return addDays(today, Math.max(0, remindDays)) >= expiresOn ? 'expiring' : 'valid';
}

export const FleetDocument = defineModel('fleet.document', {
  label: 'Vehicle paper',
  recName: 'name',
  order: ['expiresOn asc', 'id asc'],
  archivable: true,
  companyScoped: { required: true },
  access: { 'fleet.user': READ, 'fleet.manager': [...ALL, 'export', 'import'] },
  fields: {
    name: f.char({ required: true, label: 'Number', help: 'The paper’s own number.' }),
    vehicle: f.many2one('fleet.vehicle', { required: true, ondelete: 'cascade', index: true }),
    kind: f.selection(DOCUMENT_KINDS, {
      required: true,
      default: 'registration',
      label: 'Paper',
      help: 'Which paper it is.',
    }),
    issuedOn: f.date({ label: 'Issued on' }),
    expiresOn: f.date({ required: true, label: 'Expires on' }),
    issuer: f.many2one('res.partner', { ondelete: 'set null', label: 'Issued by' }),
    cost: f.decimal({ scale: 2, label: 'Cost' }),
    remindDays: f.integer({
      required: true,
      default: 30,
      label: 'Remind (days before)',
      help: 'The paper is *expiring* from this many days before its last day.',
    }),
    /** The day the server last looked at the paper: its status follows the calendar. */
    checkedOn: f.date({ groups: { write: [...SYSTEM] } }),
    /** The expiry the people were told of: a renewed paper is told of again. */
    remindedFor: f.date({ groups: { write: [...SYSTEM] } }),
    status: f.selection(
      { valid: 'Valid', expiring: 'Expiring', expired: 'Expired' },
      {
        store: true,
        label: 'Status',
        help: 'By the calendar: expiring from its reminder days before the last day, expired after it.',
        ...compute(
          'fleet.document',
          'status',
          ['expiresOn', 'remindDays', 'checkedOn'],
          (documents) => {
            const today = iso(documents.env.today());
            for (const d of documents)
              d.status =
                d.expiresOn === null
                  ? 'valid'
                  : paperStatus(iso(d.expiresOn), d.remindDays ?? 0, today);
          },
        ),
      },
    ),
    note: f.char(),
  },
  sqlConstraints: {
    ordered: {
      check: orm.sql`issued_on IS NULL OR expires_on >= issued_on`,
      message: 'A paper expires on or after the day it was issued.',
    },
    sane: {
      check: orm.sql`remind_days >= 0 AND (cost IS NULL OR cost >= 0)`,
      message: 'The reminder days and the cost are not negative.',
    },
  },
});

/**
 * The papers of the company brought up to today (RFC 0038, Fleet): each paper the server has not looked at
 * today is looked at — its status follows —, and the day a paper starts to expire `fleet.document.expiring` is
 * emitted, once per paper and expiry. Returns how many papers were announced.
 */
export async function refreshPapers(env: Env, today: string = iso(env.today())): Promise<number> {
  return env.asSuperuser({ reason: 'vehicle papers by the calendar' }, async (su) => {
    const stale = await su.model('fleet.document').search({
      where: { or: [{ checkedOn: { isNull: true } }, { checkedOn: { lt: today } }] } as never,
    });
    if (stale.length > 0) {
      await stale.write({ checkedOn: today } as never);
      await su.flush();
    }
    let announced = 0;
    for (const d of await su.model('fleet.document').search({
      where: { status: { in: ['expiring', 'expired'] } } as never,
    })) {
      if (d.remindedFor !== null && iso(d.remindedFor) === iso(d.expiresOn)) continue;
      await su
        .model('fleet.document')
        .browse([d.id])
        .write({ remindedFor: iso(d.expiresOn) } as never);
      await su.emit('fleet.document.expiring', { id: d.id });
      announced += 1;
    }
    await su.flush();
    return announced;
  });
}

/** The logs among `rows` whose reading is below one of an earlier day, or above one of a later day. */
async function backwards(
  env: Env,
  rows: Iterable<{ id: number; vehicle: { id: number }; date: unknown; odometer: Decimal | null }>,
  own: 'fleet.fuel' | 'fleet.service',
): Promise<number[]> {
  return env.asSuperuser({ reason: 'odometer readings in order' }, async (su) => {
    const failing: number[] = [];
    for (const r of rows) {
      if (r.odometer === null) continue;
      const date = iso(r.date);
      let wrong = false;
      for (const model of ['fleet.fuel', 'fleet.service'] as const) {
        const self = model === own ? { id: { ne: r.id } } : {};
        const before = await su.model(model).search({
          where: {
            vehicle: r.vehicle.id,
            date: { lt: date },
            odometer: { gt: r.odometer.toString() },
            ...self,
          } as never,
          limit: 1,
        });
        const after = await su.model(model).search({
          where: {
            vehicle: r.vehicle.id,
            date: { gt: date },
            odometer: { lt: r.odometer.toString() },
            ...self,
          } as never,
          limit: 1,
        });
        if (before.length > 0 || after.length > 0) wrong = true;
      }
      if (wrong) failing.push(r.id);
    }
    return failing;
  });
}

const BACKWARDS =
  'The odometer does not go back: another fill or service of this vehicle has a higher reading on an earlier day, or a lower one on a later day.';

export const FleetFuel = defineModel('fleet.fuel', {
  label: 'Fuel log',
  order: ['date desc', 'id desc'],
  companyScoped: { required: true },
  access: {
    'fleet.user': ['read', 'write', 'create'],
    'fleet.manager': [...ALL, 'export', 'import'],
  },
  fields: {
    vehicle: f.many2one('fleet.vehicle', { required: true, ondelete: 'cascade', index: true }),
    date: f.date({ required: true, default: (env: Env) => env.today() }),
    odometer: f.decimal({ scale: 1, required: true, label: 'Odometer (km)' }),
    litres: f.decimal({ scale: 3, required: true, label: 'Litres' }),
    amount: f.decimal({ scale: 2, required: true, label: 'Amount' }),
    pricePerLitre: f.decimal({
      scale: 2,
      store: true,
      label: 'Per litre',
      help: 'The amount over the litres.',
      ...compute('fleet.fuel', 'pricePerLitre', ['amount', 'litres'], (logs) => {
        for (const l of logs)
          l.pricePerLitre =
            l.litres?.gt(0) === true && l.amount !== null
              ? l.amount.div(l.litres).toDecimalPlaces(2)
              : null;
      }),
    }),
    fullTank: f.boolean({
      default: true,
      label: 'Tank filled',
      help: 'Kilometres per litre are measured between fills that filled the tank.',
    }),
    station: f.many2one('res.partner', { ondelete: 'set null', label: 'Station' }),
    driver: f.many2one('res.partner', { ondelete: 'set null', label: 'Driver' }),
    note: f.char(),
  },
  sqlConstraints: {
    positive: {
      check: orm.sql`litres > 0 AND amount >= 0 AND odometer >= 0`,
      message: 'A fill has litres, and its amount and reading are not negative.',
    },
  },
  constraints: {
    inOrder: {
      ...check('fleet.fuel', ['vehicle', 'date', 'odometer'], async (logs) =>
        backwards(logs.env as unknown as Env, await logs.load({ vehicle: true }), 'fleet.fuel'),
      ),
      message: BACKWARDS,
    },
  },
});

export const FleetService = defineModel('fleet.service', {
  label: 'Service log',
  order: ['date desc', 'id desc'],
  companyScoped: { required: true },
  access: {
    'fleet.user': ['read', 'write', 'create'],
    'fleet.manager': [...ALL, 'export', 'import'],
  },
  fields: {
    vehicle: f.many2one('fleet.vehicle', { required: true, ondelete: 'cascade', index: true }),
    date: f.date({ required: true, default: (env: Env) => env.today() }),
    odometer: f.decimal({ scale: 1, label: 'Odometer (km)' }),
    kind: f.selection(
      {
        service: 'Service',
        repair: 'Repair',
        tyres: 'Tyres',
        battery: 'Battery',
        accident: 'Accident repair',
        other: 'Other',
      },
      { required: true, default: 'service', label: 'What', help: 'What was done to the vehicle.' },
    ),
    description: f.char({ required: true, label: 'Work done' }),
    vendor: f.many2one('res.partner', { ondelete: 'set null', label: 'Workshop' }),
    amount: f.decimal({ scale: 2, required: true, default: '0', label: 'Amount' }),
    nextDueOn: f.date({ label: 'Next due on' }),
    nextDueAt: f.decimal({ scale: 1, label: 'Next due at (km)' }),
    note: f.char(),
  },
  sqlConstraints: {
    positive: {
      check: orm.sql`amount >= 0 AND (odometer IS NULL OR odometer >= 0)`,
      message: 'The amount and the reading are not negative.',
    },
    nextLater: {
      check: orm.sql`(next_due_on IS NULL OR next_due_on >= date)
        AND (next_due_at IS NULL OR odometer IS NULL OR next_due_at >= odometer)`,
      message: 'The next service is due after this one.',
    },
  },
  constraints: {
    inOrder: {
      ...check('fleet.service', ['vehicle', 'date', 'odometer'], async (logs) =>
        backwards(logs.env as unknown as Env, await logs.load({ vehicle: true }), 'fleet.service'),
      ),
      message: BACKWARDS,
    },
  },
});

export const FleetTrip = defineModel('fleet.trip', {
  label: 'Trip',
  recName: 'name',
  order: ['date desc', 'id desc'],
  companyScoped: { required: true },
  tracking: ['state', 'vehicle', 'driver', 'odometerStart', 'odometerEnd'],
  access: {
    'fleet.user': ['read', 'write', 'create'],
    'fleet.manager': [...ALL, 'export', 'import'],
  },
  fields: {
    name: f.char({ required: true, sequence: 'fleet.trip', label: 'Reference' }),
    vehicle: f.many2one('fleet.vehicle', { required: true, ondelete: 'restrict', index: true }),
    driver: f.many2one('res.partner', { ondelete: 'set null', label: 'Driver' }),
    date: f.date({ required: true, default: (env: Env) => env.today() }),
    origin: f.char({ required: true, label: 'From' }),
    destination: f.char({ required: true, label: 'To' }),
    purpose: f.char({ label: 'Why' }),
    odometerStart: f.decimal({ scale: 1, label: 'Odometer at the start (km)' }),
    odometerEnd: f.decimal({ scale: 1, label: 'Odometer at the end (km)' }),
    distance: f.decimal({
      scale: 1,
      store: true,
      label: 'Distance (km)',
      help: 'The reading at the end less the reading at the start.',
      ...compute('fleet.trip', 'distance', ['odometerStart', 'odometerEnd'], (trips) => {
        for (const t of trips)
          t.distance =
            t.odometerStart !== null && t.odometerEnd !== null
              ? t.odometerEnd.minus(t.odometerStart)
              : null;
      }),
    }),
    note: f.text(),
    state: f.state({
      states: { planned: 'Planned', started: 'On the road', done: 'Done', cancel: 'Cancelled' },
      initial: 'planned',
      help: 'Started with the odometer’s reading, done with the reading at the end: the distance is theirs.',
      transitions: {
        start: emitting('fleet.trip.started', {
          from: ['planned'],
          to: 'started',
          // Without a reading typed in, the trip starts at the vehicle's.
          before: records('fleet.trip', async (trips): Promise<void> => {
            const env = trips.env as unknown as Env;
            for (const t of await env.model('fleet.trip').browse(trips.ids).load({ vehicle: true }))
              if (t.odometerStart === null && t.vehicle.odometer !== null)
                await env
                  .model('fleet.trip')
                  .browse([t.id])
                  .write({ odometerStart: t.vehicle.odometer.toString() } as never);
          }),
        }),
        finish: emitting('fleet.trip.done', {
          from: ['started'],
          to: 'done',
          guard: records('fleet.trip', async (trips) =>
            [...(await trips.load(['odometerStart', 'odometerEnd']))]
              .filter(
                (t) =>
                  t.odometerEnd === null ||
                  (t.odometerStart !== null && t.odometerEnd.lt(t.odometerStart)),
              )
              .map((t) => t.id),
          ),
          message:
            'Write the odometer at the end of the trip: at least the reading it started with.',
        }),
        cancel: { from: ['planned', 'started'], to: 'cancel' },
        replan: { from: ['cancel'], to: 'planned' },
      },
    }),
  },
  sqlConstraints: {
    readings: {
      check: orm.sql`(odometer_start IS NULL OR odometer_start >= 0)
        AND (odometer_end IS NULL OR odometer_start IS NULL OR odometer_end >= odometer_start)`,
      message: 'A trip ends at a reading that is at least the one it started with.',
    },
  },
  constraints: {
    // One trip on the road per vehicle, and none for a retired one.
    free: {
      ...check('fleet.trip', ['vehicle', 'state'], async (trips) =>
        trips.env.asSuperuser({ reason: 'a vehicle on one trip' }, async (su) => {
          const failing: number[] = [];
          for (const t of await su
            .model('fleet.trip')
            .browse(trips.ids as never)
            .load({ vehicle: true })) {
            if (t.state !== 'planned' && t.state !== 'started') continue;
            if (t.vehicle.status === 'retired') {
              failing.push(t.id as number);
              continue;
            }
            if (t.state !== 'started') continue;
            const other = await su.model('fleet.trip').search({
              where: { vehicle: t.vehicle.id, state: 'started', id: { ne: t.id } } as never,
              limit: 1,
            });
            if (other.length > 0) failing.push(t.id as number);
          }
          return failing;
        }),
      ),
      message: 'This vehicle is retired, or already on the road for another trip.',
    },
  },
});

export const fleetShutro = defineModule({
  name: 'fleet',
  version: '0.1.0',
  depends: [contactsShutro, messagingShutro],
  groups: [
    orm.defineGroup({ code: 'fleet.user', label: 'Fleet: logs and trips', implies: [] }),
    orm.defineGroup({ code: 'fleet.manager', label: 'Fleet manager', implies: ['fleet.user'] }),
  ],
  sequences: [
    orm.defineSequence({ code: 'fleet.trip', prefix: 'TRIP/{year}/', padding: 5, reset: 'yearly' }),
  ],
  models: [FleetVehicle, FleetDocument, FleetFuel, FleetService, FleetTrip],
});
