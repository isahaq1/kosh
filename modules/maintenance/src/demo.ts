/**
 * Asset Care's demo data (RFC 0008 §5.8): a diesel generator with its hour meter, a 250-hour service plan with its
 * checklist and a monthly inspection, a reading that makes the service due, and a forklift with a breakdown reported.
 */
import type { DemoContext } from '@kosh/modules-sdk';
import type { Env } from './.kosh/bindings.js';
import { runPlans } from './module.js';

const DINA = { login: 'dina', name: 'Dina Rahman', groups: ['maintenance.manager'] } as const;

export async function maintenanceDemo(ctx: DemoContext): Promise<string> {
  await ctx.as(DINA, async (raw) => {
    const env = raw as Env;
    const [generator, forklift] = (
      await env.model('maintenance.equipment').create([
        {
          name: 'Diesel generator 250 kVA',
          code: 'GEN-01',
          category: 'machine',
          location: 'Plant room',
          warrantyUntil: ctx.date(400),
          meters: { create: [{ name: 'Running hours', unit: 'h' }] },
        },
        { name: 'Forklift', code: 'FL-02', category: 'vehicle', location: 'Warehouse' },
      ])
    ).ids;
    if (generator === undefined || forklift === undefined) return;
    const [meter] = (
      await env.model('maintenance.meter').search({ where: { equipment: generator } })
    ).ids;
    if (meter === undefined) return;
    await env.model('maintenance.plan').create([
      {
        name: '250-hour service',
        equipment: generator,
        trigger: 'meter',
        meter,
        intervalValue: '250',
        tasks: {
          create: [
            { name: 'Change the engine oil and filter' },
            { name: 'Check the coolant level' },
            { name: 'Inspect the belts' },
          ],
        },
      },
      {
        name: 'Monthly inspection',
        equipment: generator,
        trigger: 'time',
        intervalDays: 30,
        startDate: ctx.date(3),
        tasks: {
          create: [{ name: 'Run under load for 30 minutes' }, { name: 'Check the battery' }],
        },
      },
    ]);
    await env.model('maintenance.meter.reading').create([{ meter, value: '262' }]);
    await env.model('maintenance.request').create([
      {
        equipment: forklift,
        kind: 'breakdown',
        priority: 'high',
        description: 'Hydraulic leak on the lift cylinder.',
      },
    ]);
    await runPlans(env);
  });
  return 'Asset Care: a generator with its service plans due, a forklift broken down.';
}
