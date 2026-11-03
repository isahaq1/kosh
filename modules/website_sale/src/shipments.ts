/**
 * Shipments of shop orders (RFC 0024 §2.7): a draft for each confirmed shop order whose delivery method has a
 * courier — once — with the customer's name, phone and address, the weight of its goods and, paid on delivery, the
 * cash to collect; and tracking: what the courier says of each open shipment becomes its events and moves it along
 * (picked, in transit, delivered — the cash collected — or returned).
 */
import { orm } from '@kosh/server/orm';
import type { Env } from './.kosh/bindings.js';
import { courierOf, type ParcelStatus } from './couriers.js';

const zero = orm.toDecimal(0);
const OPEN = ['booked', 'picked', 'in_transit'];
/** The transitions that bring a shipment to what the courier says. */
const TO: Partial<Record<ParcelStatus, readonly string[]>> = {
  picked: ['pick'],
  in_transit: ['transit'],
  delivered: ['deliver'],
  returned: ['bounce'],
};

/** Makes the draft shipment of each confirmed shop order of `ids` sent with a courier, once; returns how many. */
export async function draftShipments(env: Env, ids: readonly number[]): Promise<number> {
  let made = 0;
  for (const o of await env
    .model('sale.order')
    .browse(ids as never)
    .load({ carrier: true, partner: true, lines: { product: true }, company: true })) {
    if (o.website === null || o.carrier === null || o.carrier.courier === 'none') continue;
    if (o.state !== 'sale' && o.state !== 'done') continue;
    const existing = await env
      .model('delivery.shipment')
      .search({ where: { order: o.id, state: { ne: 'cancel' } }, limit: 1 });
    if (existing.length > 0) continue;
    const weight = [...o.lines]
      .filter((l) => !l.isDelivery)
      .reduce((s, l) => s.plus((l.product.weight ?? zero).times(l.quantity)), zero);
    await env.model('delivery.shipment').create([
      {
        order: o.id,
        carrier: o.carrier.id,
        courier: o.carrier.courier,
        company: o.company.id,
        recipient: o.partner.name,
        phone: o.partner.phone ?? o.partner.mobile ?? '-',
        address: o.partner.street ?? '-',
        city: o.partner.city ?? '-',
        cod: o.shopPayment === 'cod' ? (o.amountTotal?.amount ?? zero) : zero,
        weight,
        note: o.shopNote,
      },
    ] as never);
    made += 1;
  }
  await env.flush();
  return made;
}

/** Asks the couriers about the open shipments (those of `ids`, or all); returns how many moved. */
export async function refreshShipments(env: Env, ids?: readonly number[]): Promise<number> {
  const found = await env.model('delivery.shipment').search({
    where: {
      state: { in: OPEN },
      trackingRef: { isNull: false },
      ...(ids === undefined ? {} : { id: { in: ids } }),
    } as never,
  });
  let moved = 0;
  for (const s of await found.load({ events: true })) {
    const courier = courierOf(s.courier);
    if (courier === null || s.trackingRef === null) continue;
    let tracking: Awaited<ReturnType<typeof courier.track>>;
    try {
      tracking = await courier.track(s.trackingRef);
    } catch {
      continue; // asked again next time
    }
    const known = s.events.length;
    const fresh = tracking.events.slice(known);
    if (fresh.length > 0)
      await env.model('delivery.shipment.event').create(
        fresh.map((e) => ({
          shipment: s.id,
          at: new Date(e.at),
          status: e.status,
          note: e.note,
        })),
      );
    const steps = TO[tracking.status];
    if (steps !== undefined && tracking.status !== s.state) {
      const one = env.model('delivery.shipment').browse([s.id]);
      for (const step of steps)
        await (one as unknown as Record<string, () => Promise<void>>)[step]?.();
      moved += 1;
    }
  }
  await env.flush();
  return moved;
}

/** A placed order's shipments as its customer may follow them. */
export async function trackingOf(
  env: Env,
  order: number,
): Promise<
  {
    name: string;
    state: string;
    trackingRef: string | null;
    events: { at: string; status: string; note: string | null }[];
  }[]
> {
  const found = await (
    await env
      .model('delivery.shipment')
      .search({ where: { order: order as never, state: { ne: 'cancel' } } })
  ).load({ events: true });
  return [...found].map((s) => ({
    name: s.name,
    state: s.state,
    trackingRef: s.trackingRef,
    events: [...s.events].map((e) => ({
      at: e.at instanceof Date ? e.at.toISOString() : String(e.at),
      status: e.status,
      note: e.note,
    })),
  }));
}
