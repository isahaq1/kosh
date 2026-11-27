/**
 * Repairs' demo data (RFC 0008 §5.8): a printer quoted and waiting for its owner's word, a fridge under warranty
 * in repair, and a phone just handed in.
 */
import type { DemoContext } from '@kosh/modules-sdk';
import type { Env } from './.kosh/bindings.js';

const TAREK = { login: 'tarek', name: 'Tarek Aziz', groups: ['repair.manager'] } as const;

export async function repairDemo(ctx: DemoContext): Promise<string> {
  await ctx.as(TAREK, async (raw) => {
    const env = raw as Env;
    const [office, home] = (
      await env.model('res.partner').create([
        { name: 'Shapla Printers Ltd', email: 'service@shapla.example', isCustomer: true },
        { name: 'Rehana Begum', phone: '+8801711000045', isCustomer: true },
      ] as never)
    ).ids;
    if (office === undefined || home === undefined) return;
    const [printer, fridge] = (
      await env.model('repair.order').create([
        {
          partner: office,
          itemName: 'HP LaserJet 1020',
          serial: 'CNB9K41276',
          accessories: 'Power cable',
          problem: 'Prints with grey streaks down the page.',
          diagnosis: 'The fuser film is torn; the pickup roller is worn.',
          dueDate: ctx.date(3),
          lines: {
            create: [
              { kind: 'labour', name: 'Fuser film replaced, rollers cleaned', priceUnit: '800' },
              { kind: 'labour', name: 'Pickup roller fitted', priceUnit: '400' },
            ],
          },
        },
        {
          partner: home,
          itemName: 'Walton fridge WFC-3D8',
          serial: 'WFC3D8-2291-0457',
          problem: 'Does not cool; the compressor clicks and stops.',
          diagnosis: 'The start relay has failed.',
          warranty: true,
          dueDate: ctx.date(1),
        },
        {
          partner: home,
          itemName: 'Samsung Galaxy A15',
          serial: 'R58W30QZ1KD',
          accessories: 'Charger, back cover',
          problem: 'The screen stays black after a fall.',
        },
      ] as never)
    ).ids;
    if (printer !== undefined) {
      await env.model('repair.order').browse([printer]).diagnose();
      await env.model('repair.order').browse([printer]).quote();
    }
    if (fridge !== undefined) {
      await env.model('repair.order').browse([fridge]).diagnose();
      await env.model('repair.order').browse([fridge]).begin();
    }
  });
  return 'Repairs: a printer quoted, a fridge under warranty in repair, a phone just handed in';
}
