/**
 * Fleet's demo data (RFC 0008 §5.8): a delivery van with its papers — one about to expire —, three fills that
 * give its kilometres per litre, a service with the next one due, and a trip on the road.
 */
import type { DemoContext } from '@kosh/modules-sdk';
import type { Env } from './.kosh/bindings.js';
import { refreshPapers } from './module.js';

const FARID = { login: 'farid', name: 'Farid Hossain', groups: ['fleet.manager'] } as const;

export async function fleetDemo(ctx: DemoContext): Promise<string> {
  await ctx.as(FARID, async (raw) => {
    const env = raw as Env;
    const [van, bike] = (
      await env.model('fleet.vehicle').create([
        {
          name: 'DM-MA 51-2040 Hiace',
          plate: 'DM-MA 51-2040',
          make: 'Toyota',
          series: 'Hiace',
          year: 2022,
          kind: 'pickup',
          fuel: 'diesel',
          initialOdometer: '41000',
        },
        {
          name: 'DM-HA 33-1187 Pulsar',
          plate: 'DM-HA 33-1187',
          make: 'Bajaj',
          series: 'Pulsar 150',
          year: 2023,
          kind: 'motorcycle',
          fuel: 'octane',
        },
      ])
    ).ids;
    if (van === undefined || bike === undefined) return;
    await env.model('fleet.document').create([
      { vehicle: van, kind: 'registration', name: 'REG-2040', expiresOn: ctx.date(400) },
      { vehicle: van, kind: 'fitness', name: 'FIT-88213', expiresOn: ctx.date(12) },
      { vehicle: van, kind: 'insurance', name: 'INS-55-0091', expiresOn: ctx.date(190) },
      { vehicle: bike, kind: 'tax_token', name: 'TT-7781', expiresOn: ctx.date(-5) },
    ]);
    await env.model('fleet.fuel').create([
      { vehicle: van, date: ctx.date(-20), odometer: '41200', litres: '48', amount: '5184' },
      { vehicle: van, date: ctx.date(-12), odometer: '41680', litres: '45', amount: '4860' },
      { vehicle: van, date: ctx.date(-4), odometer: '42150', litres: '44', amount: '4752' },
    ]);
    await env.model('fleet.service').create([
      {
        vehicle: van,
        date: ctx.date(-15),
        odometer: '41400',
        kind: 'service',
        description: 'Engine oil and filters',
        amount: '6500',
        nextDueOn: ctx.date(75),
        nextDueAt: '46400',
      },
    ]);
    const trip = await env.model('fleet.trip').create([
      {
        vehicle: van,
        date: ctx.date(0),
        origin: 'Head office',
        destination: 'Gazipur depot',
        purpose: 'Delivery of the week',
      },
    ]);
    await trip.start();
    await refreshPapers(env);
  });
  return 'Fleet: a van with its papers, fills and a trip on the road; a motorcycle with an expired tax token.';
}
