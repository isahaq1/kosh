/**
 * Field service's demo data (RFC 0008 §5.8): three visits in Dhaka tomorrow for one technician — a route to
 * follow —, each with its checklist.
 */
import type { DemoContext } from '@kosh/modules-sdk';
import type { Env } from './.kosh/bindings.js';

const FAHIM = {
  login: 'fahim',
  name: 'Fahim Chowdhury',
  groups: ['field_service.manager'],
} as const;

export async function fieldServiceDemo(ctx: DemoContext): Promise<string> {
  await ctx.as(FAHIM, async (raw) => {
    const env = raw as Env;
    const customers = (
      await env.model('res.partner').create([
        {
          name: 'Gulshan Clinic',
          street: 'Road 11',
          city: 'Dhaka',
          latitude: '23.7925',
          longitude: '90.4078',
          isCustomer: true,
        },
        {
          name: 'Banani Tower',
          street: 'Road 17',
          city: 'Dhaka',
          latitude: '23.7937',
          longitude: '90.4066',
          isCustomer: true,
        },
        {
          name: 'Motijheel Bank Branch',
          street: 'Dilkusha',
          city: 'Dhaka',
          latitude: '23.7330',
          longitude: '90.4172',
          isCustomer: true,
        },
      ] as never)
    ).ids;
    const day = ctx.date(1);
    const at = (hour: number) => new Date(`${day}T${String(hour).padStart(2, '0')}:00:00Z`);
    const [clinic, tower, bank] = customers;
    if (clinic === undefined || tower === undefined || bank === undefined) return;
    const checks = (items: string[]) => ({
      create: items.map((name, i) => ({ name, sequence: i + 1 })),
    });
    await env.model('field.visit').create([
      {
        partner: bank,
        address: 'Dilkusha, Dhaka',
        latitude: '23.7330',
        longitude: '90.4172',
        technician: env.uid,
        plannedStart: at(3),
        problem: 'The air conditioner of the server room drips water.',
        checks: checks(['Clean the drain', 'Check the gas pressure', 'Test for an hour']),
      },
      {
        partner: clinic,
        address: 'Road 11, Dhaka',
        latitude: '23.7925',
        longitude: '90.4078',
        technician: env.uid,
        plannedStart: at(5),
        problem: 'Yearly service of the generator.',
        checks: checks(['Change the oil', 'Change the filters', 'Run under load']),
      },
      {
        partner: tower,
        address: 'Road 17, Dhaka',
        latitude: '23.7937',
        longitude: '90.4066',
        technician: env.uid,
        plannedStart: at(7),
        problem: 'The lift stops between the 4th and 5th floors.',
        checks: checks(['Inspect the door sensors', 'Test every floor']),
      },
    ] as never);
  });
  return 'Field service: three visits in Dhaka tomorrow for one technician, each with its checklist';
}
