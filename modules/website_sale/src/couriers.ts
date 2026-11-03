/**
 * Couriers (RFC 0024 §2.7): what the Shop asks of a courier — book a parcel (with the cash to collect on delivery),
 * say where it is, cancel it — behind one adapter per courier, so Pathao, Steadfast or RedX can be switched without
 * changing the Shop. Credentials are never in records: an adapter reads them from the environment. The test courier
 * moves no parcel: tests (and the demo) move it along with `advance`.
 */
import { randomBytes } from 'node:crypto';

/** Where a parcel is, in the Shop's words. */
export type ParcelStatus =
  | 'booked'
  | 'picked'
  | 'in_transit'
  | 'delivered'
  | 'returned'
  | 'cancelled';

export interface Parcel {
  /** The shipment's reference on our side (`SHP/2026/00007`). */
  readonly reference: string;
  readonly recipient: {
    readonly name: string;
    readonly phone: string;
    readonly address: string;
    readonly city: string;
  };
  /** The cash the courier collects on delivery (`0.00`: paid already), in the company's currency. */
  readonly cod: string;
  readonly weightKg: string;
  readonly note: string;
}

export interface Booked {
  /** The courier's consignment id. */
  readonly trackingRef: string;
  readonly labelUrl?: string;
}

export interface Tracking {
  readonly status: ParcelStatus;
  /** What the courier says happened, oldest first. */
  readonly events: readonly {
    readonly at: string;
    readonly status: ParcelStatus;
    readonly note: string;
  }[];
  /** Delivered with the cash collected. */
  readonly codCollected: boolean;
}

export interface CourierAdapter {
  readonly code: string;
  /** Whether this server has the courier's credentials. */
  configured(): boolean;
  book(parcel: Parcel): Promise<Booked>;
  track(trackingRef: string): Promise<Tracking>;
  cancel(trackingRef: string): Promise<void>;
}

interface FakeParcel {
  readonly parcel: Parcel;
  status: ParcelStatus;
  events: { at: string; status: ParcelStatus; note: string }[];
}

/** The test courier: parcels in memory, moved along by `advance`. */
export interface FakeCourier extends CourierAdapter {
  /** Moves a parcel to `status` (delivered collects its cash). */
  advance(trackingRef: string, status: ParcelStatus, note?: string): void;
}

export function fakeCourier(): FakeCourier {
  const parcels = new Map<string, FakeParcel>();
  const step = (p: FakeParcel, status: ParcelStatus, note: string) => {
    p.status = status;
    p.events.push({ at: new Date().toISOString(), status, note });
  };
  const known = (ref: string): FakeParcel => {
    const p = parcels.get(ref);
    if (p === undefined) throw new Error(`The test courier has no parcel ${ref}.`);
    return p;
  };
  return {
    code: 'fake',
    configured: () => true,
    book: async (parcel) => {
      const trackingRef = `FAKE-${randomBytes(5).toString('hex').toUpperCase()}`;
      parcels.set(trackingRef, {
        parcel,
        status: 'booked',
        events: [{ at: new Date().toISOString(), status: 'booked', note: 'Booked' }],
      });
      return { trackingRef, labelUrl: `https://courier.test/labels/${trackingRef}.pdf` };
    },
    track: async (ref) => {
      const p = known(ref);
      return {
        status: p.status,
        events: p.events.map((e) => ({ ...e })),
        codCollected: p.status === 'delivered' && Number(p.parcel.cod) > 0,
      };
    },
    cancel: async (ref) => {
      const p = known(ref);
      if (p.status !== 'booked') throw new Error('The courier has picked the parcel up already.');
      step(p, 'cancelled', 'Cancelled');
    },
    advance: (ref, status, note) => step(known(ref), status, note ?? status),
  };
}

/** The test courier every server has (the demo's and the tests'). */
export const testCourier: FakeCourier = fakeCourier();

/** The couriers of the running server, by code (Pathao, Steadfast and RedX come with their sandbox credentials). */
let couriers: ReadonlyMap<string, CourierAdapter> = new Map([['fake', testCourier]]);

export function setCouriers(next: ReadonlyMap<string, CourierAdapter>): void {
  couriers = next;
}

export function courierOf(code: string): CourierAdapter | null {
  const c = couriers.get(code);
  return c?.configured() ? c : null;
}
