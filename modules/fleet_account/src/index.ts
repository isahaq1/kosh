/**
 * @packageDocumentation
 * `@kosh/fleet_account`: the bridge between Fleet and Accounting (RFC 0038 step 2). Proposed whenever both apps are
 * installed: each vehicle gets its cost centre; a fill, a service and a paper are booked on it — a posted entry
 * when paid from a cash or bank journal, a line on the vendor's draft bill otherwise — and taken out of the books
 * again.
 */
import { accounting } from '@kosh/accounting';
import { fleet } from '@kosh/fleet';
import { defineModule } from '@kosh/modules-sdk';
import { field } from '@kosh/views';
import { fleetAccountShutro } from './module.js';

export {
  costCentreOf,
  FLEET_ACCOUNTS,
  FLEET_ORIGIN,
  FuelBooked,
  fleetAccountShutro,
  fleetAccountsOf,
  LineOfFleet,
  PaperBooked,
  ServiceBooked,
  VehicleCostCentre,
} from './module.js';

/** The Book / Take out buttons and the booking fields, appended to a log's form and list. */
const booking = (model: string, prefix: string, group: string, after: string) => [
  {
    view: `${model}.form`,
    operations: [
      {
        append: 'header',
        nodes: [
          {
            kind: 'button' as const,
            id: `${prefix}_book`,
            transition: 'book',
            label: 'Book',
            primary: true,
            visibleWhen: { booking: 'open' },
          },
          {
            kind: 'button' as const,
            id: `${prefix}_unbook`,
            transition: 'unbook',
            label: 'Take out of the books',
            visibleWhen: { booking: 'booked' },
          },
        ],
      },
      {
        append: group,
        nodes: [
          field({ field: 'paymentJournal', id: `${prefix}_paid_from` }),
          field({ field: 'booking', id: `${prefix}_booking`, widget: 'badge' }),
          field({ field: 'entry', id: `${prefix}_entry` }),
        ],
      },
    ],
  },
  {
    view: `${model}.list`,
    operations: [
      {
        insertAfter: after,
        nodes: [field({ field: 'booking', id: `${prefix}_booking_col`, widget: 'badge' })],
      },
    ],
  },
];

export const fleetAccount: ReturnType<typeof defineModule> = defineModule({
  shutro: fleetAccountShutro,
  kosh: '^0.1.0',
  depends: [fleet, accounting],
  bridge: [fleet, accounting],
  // Bangla for the labels it serves (RFC 0023 §3.1; `pnpm i18n:extract`).
  i18n: { bn: () => import('./i18n/bn.js') },
  accessLevels: {
    user: { label: 'Fleet costs in the books', groups: ['fleet_account.user'] },
  },
  viewExtensions: [
    {
      view: 'fleet.vehicle.form',
      operations: [
        { append: 'figures', nodes: [field({ field: 'analytic', id: 'vehicle_cost_centre' })] },
      ],
    },
    ...booking('fleet.fuel', 'fuel', 'fuel', 'station'),
    ...booking('fleet.service', 'service', 'cost', 'amount'),
    ...booking('fleet.document', 'paper', 'money', 'cost'),
  ],
});
