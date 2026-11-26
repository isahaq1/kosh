/**
 * @packageDocumentation
 * `@kosh/fleet` (RFC 0038, step 2): the **Fleet** app. Vehicles with their driver and the papers that expire —
 * registration, fitness, tax token, insurance —, fuel and service logs with kilometres per litre and the cost per
 * kilometre, the next service due, and trips with their distance.
 *
 * - `POST /api/v1/fleet/papers/refresh`   managers: bring the papers' statuses up to today and announce the
 *   ones that start to expire (the server does it every day)
 */
import { contacts } from '@kosh/contacts';
import { messaging } from '@kosh/messaging';
import { defineModule } from '@kosh/modules-sdk';
import { reporting } from '@kosh/reporting';
import { HttpProblem, type ModuleContext } from '@kosh/server';
import { action, calendar, form, list, search } from '@kosh/views';
import type { Env } from './.kosh/bindings.js';
import { fleetDemo } from './demo.js';
import {
  FleetDocument,
  FleetFuel,
  FleetService,
  FleetTrip,
  FleetVehicle,
  fleetShutro,
  refreshPapers,
} from './module.js';

export { type Fill, kmPerLitre, measured } from './consumption.js';
export {
  DOCUMENT_KINDS,
  FleetDocument,
  FleetFuel,
  FleetService,
  FleetTrip,
  FleetVehicle,
  fleetShutro,
  paperStatus,
  refreshPapers,
} from './module.js';

function registerFleetRoutes(context: ModuleContext): void {
  const { app } = context;
  app.post('/api/v1/fleet/papers/refresh', async (request) =>
    request.env(
      async (raw) => {
        const env = raw as unknown as Env;
        if (!env.administrator && !env.groups.has('fleet.manager'))
          throw new HttpProblem(
            403,
            'access',
            'Managers only',
            'Bringing the papers up to date needs the Fleet manager access.',
          );
        return { announced: await refreshPapers(env) };
      },
      { write: true },
    ),
  );

  // Every six hours, company by company (off in the CLI and the tests that drive it): a paper's status follows
  // the calendar, and the ones that start to expire are announced once.
  if (process.env['KOSH_SCHEDULES'] === 'off') return;
  const run = async () => {
    try {
      const companies = await context.shutro.bootstrap(
        { reason: 'vehicle papers' },
        async (env) => (await (env as unknown as Env).model('res.company').search({})).ids,
      );
      for (const company of companies)
        await context.shutro.bootstrap({ reason: 'vehicle papers', company }, (env) =>
          refreshPapers(env as unknown as Env),
        );
    } catch (error) {
      app.log.error({ err: error }, 'vehicle papers');
    }
  };
  const timer = setInterval(() => void run(), 6 * 3_600_000);
  timer.unref();
  const first = setTimeout(() => void run(), 4 * 60_000);
  first.unref();
  app.addHook('onClose', async () => {
    clearInterval(timer);
    clearTimeout(first);
  });
}

export const fleet: ReturnType<typeof defineModule> = defineModule({
  shutro: fleetShutro,
  kosh: '^0.1.0',
  hooks: { demo: fleetDemo },
  depends: [contacts, messaging, reporting],
  app: {
    code: 'fleet',
    label: 'Fleet',
    icon: 'fleet',
    sequence: 16,
    category: 'Operations',
    summary: 'Vehicles, papers that expire, fuel and service with the cost per kilometre, trips',
  },
  // Bangla for the labels it serves (RFC 0023 §3.1; `pnpm i18n:extract`).
  i18n: { bn: () => import('./i18n/bn.js') },
  accessLevels: {
    user: { label: 'Driver or clerk (fuel, services, trips)', groups: ['fleet.user'] },
    manager: {
      label: 'Fleet manager (vehicles and papers)',
      groups: ['fleet.manager'],
      implies: ['user'],
    },
  },
  routes: (context: ModuleContext) => registerFleetRoutes(context),
  events: [
    { topic: 'fleet.trip.started', model: 'fleet.trip', label: 'Trip started' },
    { topic: 'fleet.trip.done', model: 'fleet.trip', label: 'Trip done' },
    {
      topic: 'fleet.document.expiring',
      model: 'fleet.document',
      label: 'Vehicle paper about to expire',
    },
  ],
  documents: [
    {
      key: 'fleet_trip',
      name: 'Trip sheet',
      model: 'fleet.trip',
      layout: {
        paper: 'A4',
        header: '{{company.name}}',
        footer: 'Page {{page}} of {{pages}}',
        blocks: [
          { kind: 'heading', id: 'title', text: 'Trip sheet {{name}}', level: 1 },
          {
            kind: 'fields',
            id: 'trip',
            items: [
              { label: 'Vehicle', bind: 'vehicle.name' },
              { label: 'Driver', bind: 'driver.name' },
              { label: 'Date', bind: 'date' },
              { label: 'From', bind: 'origin' },
              { label: 'To', bind: 'destination' },
              { label: 'Why', bind: 'purpose' },
              { label: 'Odometer at the start (km)', bind: 'odometerStart' },
              { label: 'Odometer at the end (km)', bind: 'odometerEnd' },
              { label: 'Distance (km)', bind: 'distance' },
            ],
          },
          { kind: 'text', id: 'note', text: '{{note}}' },
          {
            kind: 'text',
            id: 'sign',
            text: 'Driver: ______________   Authorised by: ______________',
          },
        ],
      },
    },
  ],
  importTemplates: [
    {
      key: 'fleet_vehicles',
      model: 'fleet.vehicle',
      label: 'Vehicles',
      columns: [
        { header: 'Name', field: 'name' },
        { header: 'Plate number', field: 'plate' },
        { header: 'Make', field: 'make' },
        { header: 'Model', field: 'series' },
        { header: 'Year', field: 'year' },
        { header: 'Type', field: 'kind' },
        { header: 'Fuel', field: 'fuel' },
        { header: 'Driver', field: 'driver' },
        { header: 'Bought on', field: 'acquiredOn' },
        { header: 'Bought for', field: 'purchaseValue' },
        { header: 'Odometer when it came (km)', field: 'initialOdometer' },
      ],
    },
    {
      key: 'fleet_papers',
      model: 'fleet.document',
      label: 'Vehicle papers',
      columns: [
        { header: 'Vehicle', field: 'vehicle' },
        { header: 'Paper', field: 'kind' },
        { header: 'Number', field: 'name' },
        { header: 'Issued on', field: 'issuedOn' },
        { header: 'Expires on', field: 'expiresOn' },
        { header: 'Issued by', field: 'issuer' },
        { header: 'Cost', field: 'cost' },
        { header: 'Remind (days before)', field: 'remindDays' },
      ],
    },
    {
      key: 'fleet_fuel',
      model: 'fleet.fuel',
      label: 'Fuel logs',
      columns: [
        { header: 'Vehicle', field: 'vehicle' },
        { header: 'Date', field: 'date' },
        { header: 'Odometer (km)', field: 'odometer' },
        { header: 'Litres', field: 'litres' },
        { header: 'Amount', field: 'amount' },
        { header: 'Tank filled', field: 'fullTank' },
        { header: 'Station', field: 'station' },
      ],
    },
    {
      key: 'fleet_services',
      model: 'fleet.service',
      label: 'Service logs',
      columns: [
        { header: 'Vehicle', field: 'vehicle' },
        { header: 'Date', field: 'date' },
        { header: 'Odometer (km)', field: 'odometer' },
        { header: 'What', field: 'kind' },
        { header: 'Work done', field: 'description' },
        { header: 'Workshop', field: 'vendor' },
        { header: 'Amount', field: 'amount' },
        { header: 'Next due on', field: 'nextDueOn' },
        { header: 'Next due at (km)', field: 'nextDueAt' },
      ],
    },
    {
      key: 'fleet_trips',
      model: 'fleet.trip',
      label: 'Trips',
      columns: [
        { header: 'Vehicle', field: 'vehicle' },
        { header: 'Driver', field: 'driver' },
        { header: 'Date', field: 'date' },
        { header: 'From', field: 'origin' },
        { header: 'To', field: 'destination' },
        { header: 'Why', field: 'purpose' },
      ],
    },
  ],
  overview: {
    cards: [
      {
        id: 'vehicles',
        title: 'Vehicles',
        kind: 'kpi',
        model: 'fleet.vehicle',
        measure: 'count',
        filter: { status: { ne: 'retired' } },
        w: 3,
      },
      {
        id: 'papers',
        title: 'Papers expiring or expired',
        kind: 'kpi',
        model: 'fleet.document',
        measure: 'count',
        filter: { status: { in: ['expiring', 'expired'] } },
        w: 3,
      },
      {
        id: 'on_the_road',
        title: 'On the road',
        kind: 'kpi',
        model: 'fleet.trip',
        measure: 'count',
        filter: { state: 'started' },
        w: 3,
      },
      {
        id: 'fuel_month',
        title: 'Fuel this month',
        kind: 'kpi',
        model: 'fleet.fuel',
        measure: 'sum:amount',
        comparison: { field: 'date', mode: 'previous' },
        w: 3,
      },
      {
        id: 'fuel_by_vehicle',
        title: 'Fuel cost by vehicle',
        kind: 'pivot',
        model: 'fleet.fuel',
        measure: 'sum:amount',
        groupBy: 'vehicle',
        w: 6,
      },
      {
        id: 'service_by_kind',
        title: 'Service cost by what was done',
        kind: 'chart',
        model: 'fleet.service',
        measure: 'sum:amount',
        groupBy: 'kind',
        chart: 'pie',
        w: 6,
      },
      {
        id: 'fuel_by_month',
        title: 'Fuel cost by month',
        kind: 'chart',
        model: 'fleet.fuel',
        measure: 'sum:amount',
        groupBy: 'date:month',
        chart: 'bar',
        w: 6,
      },
      {
        id: 'papers_by_status',
        title: 'Papers by status',
        kind: 'chart',
        model: 'fleet.document',
        measure: 'count',
        groupBy: 'status',
        chart: 'pie',
        w: 6,
      },
    ],
  },
  actions: {
    'fleet.action_vehicles': action(FleetVehicle, { label: 'Vehicles', views: ['list', 'form'] }),
    'fleet.action_papers': action(FleetDocument, {
      label: 'Papers',
      views: ['list', 'calendar', 'form'],
    }),
    'fleet.action_fuel': action(FleetFuel, { label: 'Fuel', views: ['list', 'form'] }),
    'fleet.action_services': action(FleetService, { label: 'Services', views: ['list', 'form'] }),
    'fleet.action_trips': action(FleetTrip, {
      label: 'Trips',
      views: ['list', 'calendar', 'form'],
    }),
  },
  menus: [
    { id: 'fleet.root', label: 'Fleet', app: 'fleet' },
    {
      id: 'fleet.vehicles',
      parent: 'fleet.root',
      label: 'Vehicles',
      action: 'fleet.action_vehicles',
      sequence: 1,
    },
    {
      id: 'fleet.trips',
      parent: 'fleet.root',
      label: 'Trips',
      action: 'fleet.action_trips',
      sequence: 2,
    },
    {
      id: 'fleet.fuel',
      parent: 'fleet.root',
      label: 'Fuel',
      action: 'fleet.action_fuel',
      sequence: 3,
    },
    {
      id: 'fleet.services',
      parent: 'fleet.root',
      label: 'Services',
      action: 'fleet.action_services',
      sequence: 4,
    },
    {
      id: 'fleet.papers',
      parent: 'fleet.root',
      label: 'Papers',
      action: 'fleet.action_papers',
      sequence: 5,
    },
  ],
  views: {
    'fleet.vehicle.list': list(FleetVehicle, {
      columns: [
        'name',
        'plate',
        'kind',
        'driver',
        { field: 'status', widget: 'badge' },
        'odometer',
        'kmPerLitre',
        'costPerKm',
        { field: 'serviceDueOn', widget: 'daysLeft' },
      ],
      decorations: { warning: { status: 'workshop' }, neutral: { status: 'retired' } },
    }),
    'fleet.vehicle.form': form(FleetVehicle, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.stats('related', [
          {
            id: 'vehicle_trips',
            label: 'Trips',
            model: FleetTrip,
            where: { vehicle: { $record: 'id' } },
            action: 'fleet.action_trips',
          },
          {
            id: 'vehicle_fuel',
            label: 'Fills',
            model: FleetFuel,
            where: { vehicle: { $record: 'id' } },
            action: 'fleet.action_fuel',
          },
          {
            id: 'vehicle_services',
            label: 'Services',
            model: FleetService,
            where: { vehicle: { $record: 'id' } },
            action: 'fleet.action_services',
          },
        ]),
        k.group('main', ['name', 'plate', 'kind', 'fuel', 'driver', 'status']),
        k.group(
          'about',
          ['make', 'series', 'year', 'acquiredOn', 'purchaseValue', 'initialOdometer'],
          {
            label: 'The vehicle',
          },
        ),
        k.group(
          'figures',
          ['odometer', 'distance', 'fuelCost', 'serviceCost', 'kmPerLitre', 'costPerKm'],
          {
            label: 'Figures',
            description:
              'Kept by the server from the fills, services and trips. Kilometres per litre are measured between fills that filled the tank.',
          },
        ),
        k.group('service', ['serviceDueOn', 'serviceDueAt'], { label: 'Next service' }),
        k.lines('documents', [
          { field: 'kind', id: 'paper_kind' },
          { field: 'name', id: 'paper_number' },
          'expiresOn',
          { field: 'status', id: 'paper_status' },
        ]),
        k.group('notes', ['note'], { columns: 1 }),
      ],
    })),
    'fleet.document.list': list(FleetDocument, {
      columns: [
        'vehicle',
        'kind',
        'name',
        { field: 'expiresOn', widget: 'daysLeft' },
        { field: 'status', widget: 'badge' },
        'issuer',
        'cost',
      ],
      defaultOrder: ['expiresOn asc'],
      decorations: { danger: { status: 'expired' }, warning: { status: 'expiring' } },
    }),
    'fleet.document.calendar': calendar(FleetDocument, {
      dateStart: 'expiresOn',
      title: 'vehicle',
      color: 'kind',
      mode: 'month',
    }),
    'fleet.document.form': form(FleetDocument, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.group('main', ['vehicle', 'kind', 'name', 'issuer']),
        k.group('dates', ['issuedOn', 'expiresOn', 'remindDays', 'status'], {
          label: 'Validity',
          description:
            'The status follows the calendar: expiring from the reminder days before the last day, expired after it. A renewed paper is a new one; archive the old.',
        }),
        k.group('money', ['cost', 'note']),
      ],
    })),
    'fleet.fuel.list': list(FleetFuel, {
      columns: [
        'date',
        'vehicle',
        'odometer',
        'litres',
        { field: 'amount', sum: true },
        'pricePerLitre',
        'fullTank',
        'station',
      ],
      defaultOrder: ['date desc'],
    }),
    'fleet.fuel.form': form(FleetFuel, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.group('main', ['vehicle', 'date', 'odometer', 'driver']),
        k.group('fuel', ['litres', 'amount', 'pricePerLitre', 'fullTank', 'station', 'note'], {
          label: 'The fill',
        }),
      ],
    })),
    'fleet.service.list': list(FleetService, {
      columns: [
        'date',
        'vehicle',
        'kind',
        'description',
        'vendor',
        'odometer',
        { field: 'amount', sum: true },
        { field: 'nextDueOn', widget: 'daysLeft' },
      ],
      defaultOrder: ['date desc'],
    }),
    'fleet.service.form': form(FleetService, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.group('main', ['vehicle', 'date', 'odometer', 'kind', 'description']),
        k.group('cost', ['vendor', 'amount', 'note'], { label: 'Workshop and cost' }),
        k.group('next', ['nextDueOn', 'nextDueAt'], {
          label: 'Next service',
          description: 'A date, a reading, or both: the vehicle shows the latest.',
        }),
      ],
    })),
    'fleet.trip.list': list(FleetTrip, {
      columns: [
        'name',
        'date',
        'vehicle',
        'driver',
        'origin',
        'destination',
        { field: 'distance', sum: true },
        { field: 'state', widget: 'badge' },
      ],
      defaultOrder: ['date desc'],
      decorations: {
        info: { state: 'started' },
        success: { state: 'done' },
        neutral: { state: 'cancel' },
      },
    }),
    'fleet.trip.calendar': calendar(FleetTrip, {
      dateStart: 'date',
      title: 'vehicle',
      color: 'state',
      mode: 'month',
    }),
    'fleet.trip.form': form(FleetTrip, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [
          k.button('start', { primary: true, label: 'Start' }),
          k.button('finish', { primary: true, label: 'Finish' }),
          k.button('cancel', { label: 'Cancel' }),
          k.button('replan', { label: 'Plan again' }),
        ],
      },
      readonlyWhen: { state: { in: ['done', 'cancel'] } },
      sheet: [
        k.group('main', ['name', 'vehicle', 'driver', 'date']),
        k.group('route', ['origin', 'destination', 'purpose'], { label: 'Route' }),
        k.group('readings', ['odometerStart', 'odometerEnd', 'distance'], {
          label: 'Odometer',
          description:
            'Left empty, the trip starts at the vehicle’s reading. Write the reading at the end, then Finish.',
        }),
        k.group('notes', ['note'], { columns: 1 }),
      ],
      chatter: true,
    })),
  },
  search: {
    'fleet.vehicle': search(FleetVehicle, {
      fields: ['name', 'plate', 'driver.name', 'make', 'series'],
      filters: {
        available: { label: 'Available', domain: { status: 'available' }, group: 'status' },
        workshop: { label: 'In the workshop', domain: { status: 'workshop' }, group: 'status' },
        retired: { label: 'Retired', domain: { status: 'retired' }, group: 'status' },
      },
      groupBy: ['kind', 'fuel', 'status', 'driver'],
    }),
    'fleet.document': search(FleetDocument, {
      fields: ['name', 'vehicle.name', 'vehicle.plate'],
      filters: {
        expiring: { label: 'Expiring', domain: { status: 'expiring' }, group: 'status' },
        expired: { label: 'Expired', domain: { status: 'expired' }, group: 'status' },
      },
      groupBy: ['kind', 'status', 'vehicle'],
    }),
    'fleet.fuel': search(FleetFuel, {
      fields: ['vehicle.name', 'vehicle.plate', 'station.name'],
      groupBy: ['vehicle', 'station', 'date:month'],
    }),
    'fleet.service': search(FleetService, {
      fields: ['vehicle.name', 'vehicle.plate', 'description', 'vendor.name'],
      groupBy: ['vehicle', 'kind', 'vendor', 'date:month'],
    }),
    'fleet.trip': search(FleetTrip, {
      fields: ['name', 'vehicle.name', 'driver.name', 'origin', 'destination'],
      filters: {
        planned: { label: 'Planned', domain: { state: 'planned' }, group: 'state' },
        started: { label: 'On the road', domain: { state: 'started' }, group: 'state' },
        done: { label: 'Done', domain: { state: 'done' }, group: 'state' },
      },
      groupBy: ['vehicle', 'driver', 'state', 'date:month'],
    }),
  },
});
