/**
 * Rental's demo data (RFC 0008 §5.8): a generator rented by the day and a projector by the hour, one order
 * reserved for next week and a quotation.
 */
import type { DemoContext } from '@kosh/modules-sdk';
import type { Env } from './.kosh/bindings.js';

const RUMA = {
  login: 'ruma',
  name: 'Ruma Khatun',
  groups: ['rental.manager', 'product.manager'],
} as const;

export async function rentalDemo(ctx: DemoContext): Promise<string> {
  await ctx.as(RUMA, async (raw) => {
    const env = raw as Env;
    const [generator, projector] = (
      await env.model('product.product').create([
        {
          name: 'Generator 5 kVA',
          rentable: true,
          rentUnit: 'day',
          rentPrice: '2500',
          rentDeposit: '10000',
          rentLateFee: '3000',
          rentQuantity: '3',
        },
        {
          name: 'Projector',
          rentable: true,
          rentUnit: 'hour',
          rentPrice: '300',
          rentDeposit: '5000',
          rentLateFee: '400',
          rentQuantity: '2',
        },
      ] as never)
    ).ids;
    const [customer] = (
      await env
        .model('res.partner')
        .create([
          { name: 'Sonali Events', email: 'bookings@sonali.example', isCustomer: true },
        ] as never)
    ).ids;
    if (generator === undefined || projector === undefined || customer === undefined) return;
    // Datetimes are Dates on the server's side (a string is a client's).
    const at = (days: number, hour: number) =>
      new Date(`${ctx.date(days)}T${String(hour).padStart(2, '0')}:00:00Z`);
    const [wedding] = (
      await env.model('rental.order').create([
        {
          partner: customer,
          start: at(7, 4),
          stop: at(9, 4),
          lines: { create: [{ product: generator, quantity: '2' }] },
        },
        {
          partner: customer,
          start: at(3, 9),
          stop: at(3, 13),
          lines: { create: [{ product: projector, quantity: '1' }] },
        },
      ] as never)
    ).ids;
    if (wedding !== undefined) await env.model('rental.order').browse([wedding]).confirm();
  });
  return 'Rental: a generator by the day and a projector by the hour, an order reserved and a quotation';
}
