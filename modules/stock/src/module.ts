/**
 * The data layer of Stockroom (RFC 0021): warehouses, a tree of locations, what is in them (quants), and the
 * **Transfer** — one document for receipts, deliveries and internal moves — with its lines and the reservations that
 * hold stock for them. Quantities are exact: a line may be in any unit of its product's unit category and is converted
 * with Shutro's `Quantity`; quants are kept in the product's unit. Stock never goes below zero: a transfer out of an
 * internal location is validated only when all of it is reserved, and reservations take only what is available.
 * Quants and reservations are written only here, in audited superuser scopes, never by users.
 */
import { contactsShutro } from '@kosh/contacts';
import { messagingShutro } from '@kosh/messaging';
import { productShutro } from '@kosh/product';
import { installationSetting } from '@kosh/server';
import { type Decimal, type Id, orm } from '@kosh/server/orm';
import {
  check,
  compute,
  defineModel,
  defineModule,
  type Env,
  extendModel,
  f,
  method,
  onchange,
  record,
  records,
} from './.kosh/bindings.js';

const READ = ['read'] as const;
const ALL = ['read', 'write', 'create', 'unlink'] as const;
const zero = orm.toDecimal(0);

interface UomRow {
  readonly id: number;
  readonly name?: unknown;
  readonly category: string;
  readonly ratio: Decimal;
  readonly rounding: Decimal;
}
const asUom = (u: UomRow) =>
  orm.defineUom({
    id: u.id,
    name: typeof u.name === 'string' ? u.name : String(u.id),
    category: u.category,
    ratio: u.ratio,
    rounding: u.rounding,
  });

/**
 * `quantity` of `unit` in `productUnit`, exactly (a dozen is 12 units). The same unit, or a product without a unit,
 * keeps the quantity. @throws {IncompatibleUomCategoryError} across categories (refused earlier by the line's check).
 */
export function inProductUnit(
  quantity: Decimal,
  unit: UomRow | null,
  productUnit: UomRow | null,
): Decimal {
  if (unit === null || productUnit === null || unit.id === productUnit.id) return quantity;
  return orm.Quantity.of(quantity, asUom(unit)).to(asUom(productUnit)).value;
}

/** Whether transfers reserve when they are confirmed (App settings › Stockroom). */
export async function reserveOnConfirm(env: Env): Promise<boolean> {
  return (await installationSetting(env, 'stock.reserveOnConfirm', true)) !== false;
}

/**
 * The default locations of a kind of transfer in the company's first warehouse: a receipt comes from the vendors
 * into stock, a delivery goes from stock to the customers, an internal move stays in stock.
 */
export async function defaultLocations(
  env: Env,
  kind: string,
  warehouse?: Id<'stock.warehouse'> | null,
  /** The document's company (an order's), else the user's current one. */
  forCompany?: Id<'res.company'>,
): Promise<{
  warehouse: Id<'stock.warehouse'> | null;
  source: Id<'stock.location'> | null;
  destination: Id<'stock.location'> | null;
}> {
  const company = forCompany ?? (env.companyId as Id<'res.company'>);
  const wh =
    warehouse ??
    (await env.model('stock.warehouse').search({ where: { company }, limit: 1 })).ids[0] ??
    null;
  const stock =
    wh === null
      ? null
      : ((
          await env.model('stock.location').search({
            where: { warehouse: wh, usage: 'internal', parent: { isNull: true } },
            limit: 1,
          })
        ).ids[0] ?? null);
  const shared = async (usage: 'vendor' | 'customer') =>
    (await env.model('stock.location').search({ where: { usage }, limit: 1 })).ids[0] ?? null;
  if (kind === 'receipt')
    return { warehouse: wh, source: await shared('vendor'), destination: stock };
  if (kind === 'delivery')
    return { warehouse: wh, source: stock, destination: await shared('customer') };
  return { warehouse: wh, source: stock, destination: stock };
}

export const StockWarehouse = defineModel('stock.warehouse', {
  label: 'Warehouse',
  recName: 'name',
  order: ['name asc'],
  archivable: true,
  companyScoped: { required: true },
  access: { 'stock.user': READ, 'stock.manager': [...ALL, 'export'] },
  fields: {
    name: f.char({ required: true }),
    /** The short code that starts its locations' names (`WH/Stock`). */
    code: f.char({ required: true, label: 'Short code' }),
    locations: f.one2many('stock.location', 'warehouse'),
    address: f.many2one('res.partner', { ondelete: 'set null' }),
  },
  sqlConstraints: {
    oneCode: { unique: ['company', 'code'], message: 'Another warehouse has this short code.' },
  },
});

export const StockLocation = defineModel('stock.location', {
  label: 'Location',
  recName: 'fullName',
  order: ['fullName asc'],
  archivable: true,
  // Vendors, customers and the adjustment location are shared by the companies.
  companyScoped: { required: false },
  hierarchy: { parent: 'parent', path: 'parentPath' },
  access: { 'stock.user': READ, 'stock.manager': [...ALL, 'export', 'import'] },
  fields: {
    name: f.char({ required: true, translate: true }),
    parent: f.many2one('stock.location', { ondelete: 'restrict', label: 'Inside' }),
    parentPath: f.char({ readonly: true, index: true }),
    children: f.one2many('stock.location', 'parent'),
    warehouse: f.many2one('stock.warehouse', { ondelete: 'cascade' }),
    usage: f.selection(
      {
        internal: 'Internal (holds stock)',
        vendor: 'Vendors',
        customer: 'Customers',
        adjustment: 'Inventory adjustment',
        production: 'Production',
        transit: 'In transit',
      },
      { required: true, default: 'internal' },
    ),
    /**
     * `WH/Stock/Shelf 1`: the warehouse code and the names from the top (four levels by name; deeper ones start
     * with `…`). Shutro refuses a computed field that depends on itself, so it reads the stored names.
     */
    fullName: f.char({
      store: true,
      label: 'Location',
      ...compute(
        'stock.location',
        'fullName',
        [
          'name',
          'warehouse.code',
          'parent.name',
          'parent.parent.name',
          'parent.parent.parent.name',
          'parent.parent.parent.parent',
        ],
        (locations) => {
          for (const l of locations) {
            const names = [l.name];
            let up = l.parent;
            for (let depth = 0; up !== null && depth < 3; depth += 1) {
              names.unshift(up.name);
              up = up.parent;
            }
            const top = up !== null ? '…' : l.warehouse !== null ? l.warehouse.code : null;
            l.fullName = [...(top === null ? [] : [top]), ...names].join('/');
          }
        },
      ),
    }),
  },
  constraints: {
    // Stock is held in a warehouse's internal locations; a child stays in its parent's warehouse.
    internalInWarehouse: {
      ...check('stock.location', ['usage', 'warehouse', 'parent'], async (locations) =>
        (await locations.load({ warehouse: true, parent: { warehouse: true } }))
          .filter(
            (l) =>
              (l.usage === 'internal' && l.warehouse === null) ||
              (l.parent !== null && l.parent.warehouse?.id !== l.warehouse?.id),
          )
          .map((l) => l.id),
      ),
      message:
        'An internal location belongs to a warehouse, the same as the location it is inside.',
    },
  },
});

export const StockLot = defineModel('stock.lot', {
  label: 'Lot / serial number',
  recName: 'name',
  order: ['expiryDate asc', 'name asc'],
  companyScoped: { required: true },
  access: {
    'stock.user': ['read', 'write', 'create'],
    'stock.manager': [...ALL, 'export', 'import'],
  },
  fields: {
    name: f.char({ required: true, label: 'Lot / serial number' }),
    product: f.many2one('product.product', { required: true, ondelete: 'restrict' }),
    /** Reservations take the lots that expire first. */
    expiryDate: f.date({ label: 'Expires on' }),
    quants: f.one2many('stock.quant', 'lot'),
    qtyOnHand: f.decimal({
      scale: 4,
      store: true,
      label: 'On hand',
      ...compute('stock.lot', 'qtyOnHand', ['quants.quantity'], (lots) => {
        for (const l of lots)
          l.qtyOnHand = [...l.quants].reduce((s, q) => s.plus(q.quantity), zero);
      }),
    }),
    /** Every transfer that moved it: where it came from and where it went. */
    history: f.one2many('stock.lot.line', 'lot'),
    note: f.text(),
  },
  sqlConstraints: {
    onePerName: {
      unique: ['company', 'product', 'name'],
      message: 'This product already has a lot or serial number with this name.',
    },
  },
});

export const StockQuant = defineModel('stock.quant', {
  label: 'Stock',
  order: ['id asc'],
  companyScoped: { required: true },
  // Read-only to everyone: quantities change only through validated transfers.
  access: { 'stock.user': READ, 'stock.manager': ['read', 'export'] },
  fields: {
    product: f.many2one('product.product', { required: true, ondelete: 'restrict' }),
    location: f.many2one('stock.location', { required: true, ondelete: 'restrict' }),
    /** The lot or serial number, for a tracked product. */
    lot: f.many2one('stock.lot', { ondelete: 'restrict' }),
    /** On hand, in the product's unit. */
    quantity: f.decimal({ scale: 4, required: true, default: '0', label: 'On hand' }),
    reservations: f.one2many('stock.reservation', 'quant'),
    reserved: f.decimal({
      scale: 4,
      store: true,
      label: 'Reserved',
      ...compute('stock.quant', 'reserved', ['reservations.quantity'], (quants) => {
        for (const q of quants)
          q.reserved = [...q.reservations].reduce((s, r) => s.plus(r.quantity), zero);
      }),
    }),
    available: f.decimal({
      scale: 4,
      store: true,
      label: 'Available',
      ...compute('stock.quant', 'available', ['quantity', 'reserved'], (quants) => {
        for (const q of quants) q.available = q.quantity.minus(q.reserved ?? zero);
      }),
    }),
  },
  sqlConstraints: {
    onePerPlace: {
      unique: ['product', 'location'],
      where: orm.sql`lot_id IS NULL`,
      message: 'A product has one stock line per location.',
    },
    onePerLot: {
      unique: ['product', 'location', 'lot'],
      where: orm.sql`lot_id IS NOT NULL`,
      message: 'A lot has one stock line per location.',
    },
    notNegative: {
      check: orm.sql`quantity >= 0`,
      message: 'Stock cannot go below zero.',
    },
  },
});

export const StockReservation = defineModel('stock.reservation', {
  label: 'Reservation',
  recName: 'label',
  order: ['id asc'],
  access: { 'stock.user': READ, 'stock.manager': READ },
  fields: {
    move: f.many2one('stock.move', { required: true, ondelete: 'cascade' }),
    quant: f.many2one('stock.quant', { required: true, ondelete: 'cascade' }),
    quantity: f.decimal({ scale: 4, required: true }),
    /** "2 Units reserved for TR/2026/00042 (SO/2026/00017)"; "1 Units of SN-0042 reserved for …" with a lot. */
    label: f.char({
      store: true,
      label: 'Reserved for',
      ...compute(
        'stock.reservation',
        'label',
        [
          'quantity',
          'move.picking.name',
          'move.picking.origin',
          'quant.product.uom.name',
          'quant.lot.name',
        ],
        (reservations) => {
          for (const r of reservations) {
            const p = r.move.picking;
            const unit = r.quant.product.uom?.name ?? '';
            const lot = r.quant.lot?.name;
            r.label = `${r.quantity.toString()}${unit === '' ? '' : ` ${unit}`}${
              lot ? ` of ${lot}` : ''
            } reserved for ${p.name}${p.origin ? ` (${p.origin})` : ''}`;
          }
        },
      ),
    }),
  },
  sqlConstraints: {
    positive: { check: orm.sql`quantity > 0`, message: 'A reservation holds a positive quantity.' },
  },
});

export const StockMove = defineModel('stock.move', {
  label: 'Transfer line',
  order: ['id asc'],
  access: {
    'stock.user': ['read', 'write', 'create', 'unlink'],
    'stock.manager': [...ALL, 'export'],
  },
  fields: {
    picking: f.many2one('stock.picking', {
      required: true,
      ondelete: 'cascade',
      label: 'Transfer',
    }),
    product: f.many2one('product.product', { required: true, ondelete: 'restrict' }),
    name: f.char({ label: 'Description' }),
    quantity: f.decimal({ scale: 4, required: true, default: '1', label: 'Quantity' }),
    uom: f.many2one('uom.uom', { label: 'Unit' }),
    /** The quantity in the product's unit (what quants count). */
    productQty: f.decimal({
      scale: 4,
      store: true,
      label: 'In the product’s unit',
      ...compute(
        'stock.move',
        'productQty',
        [
          'quantity',
          'uom.name',
          'uom.ratio',
          'uom.category',
          'uom.rounding',
          'product.uom.name',
          'product.uom.ratio',
          'product.uom.category',
          'product.uom.rounding',
        ],
        (moves) => {
          for (const m of moves) {
            const unit = m.uom ?? null;
            const productUnit = m.product.uom ?? null;
            m.productQty =
              unit !== null && productUnit !== null && unit.category !== productUnit.category
                ? m.quantity // refused by `sameUnitCategory`
                : inProductUnit(m.quantity, unit, productUnit);
          }
        },
      ),
    }),
    /**
     * What is actually moved, in the line's unit, set while the transfer waits (empty: all of it). Less than the
     * quantity validates part of the line; the rest goes to a backorder.
     */
    quantityDone: f.decimal({ scale: 4, label: 'Done' }),
    /** The done quantity in the product's unit. */
    doneQty: f.decimal({
      scale: 4,
      store: true,
      label: 'Done in the product’s unit',
      ...compute(
        'stock.move',
        'doneQty',
        [
          'quantity',
          'quantityDone',
          'uom.name',
          'uom.ratio',
          'uom.category',
          'uom.rounding',
          'product.uom.name',
          'product.uom.ratio',
          'product.uom.category',
          'product.uom.rounding',
        ],
        (moves) => {
          for (const m of moves) {
            const done = m.quantityDone ?? m.quantity;
            const unit = m.uom ?? null;
            const productUnit = m.product.uom ?? null;
            m.doneQty =
              unit !== null && productUnit !== null && unit.category !== productUnit.category
                ? done
                : inProductUnit(done, unit, productUnit);
          }
        },
      ),
    }),
    /** Take this lot only (a customer's batch, a count's loss); otherwise the lots that expire first. */
    restrictLot: f.many2one('stock.lot', { ondelete: 'set null', label: 'Lot to take' }),
    reservations: f.one2many('stock.reservation', 'move'),
    reserved: f.decimal({
      scale: 4,
      store: true,
      label: 'Reserved',
      ...compute('stock.move', 'reserved', ['reservations.quantity'], (moves) => {
        for (const m of moves)
          m.reserved = [...m.reservations].reduce((s, r) => s.plus(r.quantity), zero);
      }),
    }),
  },
  methods: {
    /**
     * What a backorder's line copies from each of these lines: the product, description and unit. A bridge adds
     * its link by overriding it (`sale_stock`: the order line), so the rest of a line stays tied to its origin.
     */
    backorderValues: method('stock.move', async function (): Promise<
      Map<number, Record<string, unknown>>
    > {
      const out = new Map<number, Record<string, unknown>>();
      for (const m of await this.load({}))
        out.set(m.id, {
          product: m.product.id,
          name: m.name,
          uom: m.uom?.id ?? null,
          restrictLot: m.restrictLot?.id ?? null,
        });
      return out;
    }),
  },
  onchange: {
    // The product's unit and name by default.
    product: onchange('stock.move', async (d) => {
      const p = await d.record('product');
      if (p === null || p === undefined) return;
      if (p.uom) d.set('uom', p.uom.id);
      if ((d.get('name') ?? '') === '') d.set('name', p.name);
    }),
  },
  constraints: {
    positiveQuantity: {
      ...check('stock.move', ['quantity'], async (moves) =>
        [...moves].filter((m) => m.quantity.lte(0)).map((m) => m.id),
      ),
      message: 'A line moves a positive quantity.',
    },
    doneNotNegative: {
      ...check('stock.move', ['quantityDone'], async (moves) =>
        [...moves].filter((m) => m.quantityDone?.lt(0) === true).map((m) => m.id),
      ),
      message: 'A done quantity cannot be negative.',
    },
    goodsOnly: {
      ...check('stock.move', ['product'], async (moves) =>
        (await moves.load({ product: true }))
          .filter((m) => m.product.kind !== 'goods')
          .map((m) => m.id),
      ),
      message: 'Services are not kept in stock: only goods are transferred.',
    },
    sameUnitCategory: {
      ...check('stock.move', ['uom', 'product'], async (moves) =>
        (await moves.load({ uom: true, product: { uom: true } }))
          .filter(
            (m) =>
              m.uom !== null && m.product.uom !== null && m.uom.category !== m.product.uom.category,
          )
          .map((m) => m.id),
      ),
      message:
        'The line’s unit must measure the same thing as the product’s unit (a dozen of units, grams of kg).',
    },
    // Lines change while the transfer is a draft (reservations would no longer match).
    draftOnly: {
      ...check('stock.move', ['product', 'quantity', 'uom', 'picking'], async (moves) =>
        (await moves.load({ picking: true }))
          .filter((m) => m.picking.state !== 'draft')
          .map((m) => m.id),
      ),
      message:
        'Lines change while the transfer is a draft: cancel it and set it back to draft first.',
    },
  },
});

/** Holds what is available in the transfers' source locations (and inside them) for their lines. */
async function reserve(ids: readonly Id<'stock.picking'>[], env: Env): Promise<void> {
  await env.asSuperuser({ reason: 'stock reservation' }, async (su) => {
    const pickings = await su
      .model('stock.picking')
      .browse(ids)
      .load({ source: true, moves: { product: true } });
    const taken = new Map<Id<'stock.quant'>, Decimal>();
    for (const p of pickings) {
      if (p.source.usage !== 'internal') continue;
      for (const m of p.moves) {
        let need = (m.productQty ?? zero).minus(m.reserved ?? zero);
        if (need.lte(0)) continue;
        const found = await (
          await su.model('stock.quant').search({
            where: {
              product: m.product.id,
              location: { childOf: p.source.id },
              ...(m.restrictLot === null ? {} : { lot: m.restrictLot.id }),
            },
          })
        ).load({ lot: true });
        // First expiry first out; lots without a date last; then the oldest stock.
        const expiry = (d: unknown) =>
          d instanceof Date
            ? d.getTime()
            : typeof d === 'string' && d !== ''
              ? Date.parse(d)
              : Number.POSITIVE_INFINITY;
        const quants = [...found].sort(
          (a, b) => expiry(a.lot?.expiryDate) - expiry(b.lot?.expiryDate) || a.id - b.id,
        );
        for (const q of quants) {
          const free = q.quantity.minus(q.reserved ?? zero).minus(taken.get(q.id) ?? zero);
          if (free.lte(0)) continue;
          const take = free.lt(need) ? free : need;
          await su.model('stock.reservation').create([{ move: m.id, quant: q.id, quantity: take }]);
          taken.set(q.id, (taken.get(q.id) ?? zero).plus(take));
          need = need.minus(take);
          if (need.lte(0)) break;
        }
      }
    }
  });
}

/** Releases what the transfers hold. */
async function unreserve(ids: readonly Id<'stock.picking'>[], env: Env): Promise<void> {
  await env.asSuperuser({ reason: 'stock unreservation' }, async (su) => {
    const moves = await su.model('stock.move').search({ where: { picking: { in: [...ids] } } });
    if (moves.length === 0) return;
    const held = await su
      .model('stock.reservation')
      .search({ where: { move: { in: [...moves.ids] } } });
    if (held.length > 0) await held.unlink();
  });
}

/**
 * Moves the stock of validated transfers: what each line has done (all of it unless less is set) leaves its
 * reservations and enters the destination's quant; the reservations are released. Lots travel with the stock: out of
 * stock, the reserved quants' lots move and are recorded on the transfer (what left, which lot); into stock from
 * outside (receipts, adjustment gains), a tracked product's lots and serial numbers are listed on the transfer — as
 * many as are done, one per serial number, a serial number never received twice — and new ones are made. Lines done
 * in part leave the rest to a backorder — a new transfer with the same partner, places and source document, and every
 * other field of its transfer and lines that `backorderValues` gives (a bridge's order and order lines too) —
 * confirmed at once.
 */
async function applyMoves(ids: readonly Id<'stock.picking'>[], env: Env): Promise<void> {
  await env.asSuperuser({ reason: 'stock transfer validated' }, async (su) => {
    const pickings = await su
      .model('stock.picking')
      .browse(ids)
      .load({
        source: true,
        destination: true,
        company: true,
        moves: { product: true, reservations: { quant: true } },
        lotLines: { lot: true, product: true },
      });
    const out = new Map<Id<'stock.quant'>, Decimal>();
    type Place = {
      product: Id<'product.product'>;
      location: Id<'stock.location'>;
      company: Id<'res.company'>;
      lot: Id<'stock.lot'> | null;
      quantity: Decimal;
    };
    const into = new Map<string, Place>();
    const add = (place: Place) => {
      const key = `${place.product}:${place.location}:${place.lot ?? ''}`;
      into.set(key, { ...place, quantity: (into.get(key)?.quantity ?? zero).plus(place.quantity) });
    };
    const used: Id<'stock.reservation'>[] = [];
    const shipped: {
      picking: Id<'stock.picking'>;
      product: Id<'product.product'>;
      lot: Id<'stock.lot'>;
      quantity: Decimal;
    }[] = [];
    const backorders: { picking: Id<'stock.picking'>; rest: Map<Id<'stock.move'>, Decimal> }[] = [];
    const refuse = (problem: string, hint: string): never => {
      throw new orm.ValidationError('stock.picking', ['lotLines'], problem, hint);
    };
    for (const p of pickings) {
      const rest = new Map<Id<'stock.move'>, Decimal>();
      const company = p.company.id;
      if (p.source.usage === 'internal') {
        for (const m of p.moves) {
          let left = m.doneQty ?? zero;
          for (const r of m.reservations) {
            const take = left.lt(r.quantity) ? left : r.quantity;
            used.push(r.id);
            left = left.minus(take);
            if (take.lte(0)) continue;
            out.set(r.quant.id, (out.get(r.quant.id) ?? zero).plus(take));
            const lot = r.quant.lot?.id ?? null;
            if (p.destination.usage === 'internal')
              add({
                product: m.product.id,
                location: p.destination.id,
                company,
                lot,
                quantity: take,
              });
            if (lot !== null)
              shipped.push({ picking: p.id, product: m.product.id, lot, quantity: take });
          }
        }
      } else if (p.destination.usage === 'internal') {
        const tracked = new Map<number, { name: string; serial: boolean; done: Decimal }>();
        for (const m of p.moves) {
          const done = m.doneQty ?? zero;
          if (m.product.tracking === 'none' || m.product.tracking === null) {
            if (done.gt(0))
              add({
                product: m.product.id,
                location: p.destination.id,
                company,
                lot: null,
                quantity: done,
              });
            continue;
          }
          const t = tracked.get(m.product.id);
          tracked.set(m.product.id, {
            name: m.product.name,
            serial: m.product.tracking === 'serial',
            done: (t?.done ?? zero).plus(done),
          });
        }
        for (const [product, t] of tracked) {
          const lines = [...p.lotLines].filter((l) => l.product.id === product);
          const given = lines.reduce((s, l) => s.plus(l.quantity), zero);
          if (!given.eq(t.done))
            refuse(
              `${t.name}: ${given.toString()} of ${t.done.toString()} have a lot or serial number.`,
              'List them in Lots and serial numbers: one line per lot, one per serial number.',
            );
          const names = new Set<string>();
          for (const l of lines) {
            const name = (l.lot?.name ?? l.lotName ?? '').trim();
            if (t.serial && !l.quantity.eq(1))
              refuse(
                `${t.name} is tracked by serial number: one line per unit.`,
                `${name} has ${l.quantity.toString()}.`,
              );
            if (t.serial && names.has(name))
              refuse(
                `${t.name}: the serial number ${name} is listed twice.`,
                'Each unit has its own serial number.',
              );
            names.add(name);
            let lot = l.lot?.id ?? null;
            if (lot === null) {
              const existing = await su.model('stock.lot').search({
                where: { company, product: orm.asId(product, 'product.product'), name },
                limit: 1,
              });
              lot =
                existing.ids[0] ??
                ((
                  await su
                    .model('stock.lot')
                    .create([{ company, product: orm.asId(product, 'product.product'), name }])
                ).ids[0] as Id<'stock.lot'>);
              await l.write({ lot });
            }
            if (t.serial) {
              const [held] = await su.model('stock.lot').browse([lot]).load(['qtyOnHand']);
              if ((held?.qtyOnHand ?? zero).gt(0))
                refuse(
                  `${t.name}: the serial number ${name} is already in stock.`,
                  'A serial number is received once.',
                );
            }
            add({
              product: orm.asId(product, 'product.product'),
              location: p.destination.id,
              company,
              lot,
              quantity: l.quantity,
            });
          }
        }
      }
      for (const m of p.moves) {
        const lineDone = m.quantityDone ?? m.quantity;
        if (lineDone.lt(m.quantity)) rest.set(m.id, m.quantity.minus(lineDone));
        if (m.quantityDone === null) await m.write({ quantityDone: m.quantity });
      }
      if (rest.size > 0) backorders.push({ picking: p.id, rest });
    }
    if (used.length > 0) await su.model('stock.reservation').browse(used).unlink();
    for (const [quant, quantity] of out) {
      const [q] = await su.model('stock.quant').browse([quant]).load(['quantity']);
      if (q !== undefined) await q.write({ quantity: q.quantity.minus(quantity) });
    }
    for (const { product, location, company, lot, quantity } of into.values()) {
      const found = await su.model('stock.quant').search({
        where: { product, location, lot: lot === null ? { isNull: true } : lot },
        limit: 1,
      });
      const [q] = await found.load(['quantity']);
      if (q !== undefined) await q.write({ quantity: q.quantity.plus(quantity) });
      else await su.model('stock.quant').create([{ product, location, company, lot, quantity }]);
    }
    // What left, lot by lot (what was listed on an outgoing transfer is replaced by what actually moved).
    const outgoing = [...pickings].filter((p) => p.source.usage === 'internal').map((p) => p.id);
    if (outgoing.length > 0) {
      const listed = await su
        .model('stock.lot.line')
        .search({ where: { picking: { in: outgoing } } });
      if (listed.length > 0) await listed.unlink();
    }
    if (shipped.length > 0) await su.model('stock.lot.line').create(shipped);
    await su.model('stock.picking').browse(ids).write({ doneDate: su.today() });
    // What follows a validation in other apps (`stock_account` values the stock).
    await su.model('stock.picking').browse(ids).validated();
    type Raw = { create(rows: readonly Record<string, unknown>[]): Promise<{ ids: number[] }> };
    for (const { picking, rest } of backorders) {
      const from = (await su.model('stock.picking').browse([picking]).backorderValues()).get(
        picking,
      );
      const lines = await su
        .model('stock.move')
        .browse([...rest.keys()])
        .backorderValues();
      const made = await (su.model('stock.picking' as never) as unknown as Raw).create([
        {
          ...from,
          backorderOf: picking,
          moves: {
            create: [...rest].map(([id, quantity]) => ({ ...lines.get(id), quantity })),
          },
        },
      ]);
      await su
        .model('stock.picking')
        .browse(made.ids as Id<'stock.picking'>[])
        .confirm();
    }
  });
}

/**
 * The lots and serial numbers of a transfer: listed by hand on what comes into stock (an existing lot, or the name of
 * a new one), recorded by the validation on what leaves it. The lot's history.
 */
export const StockLotLine = defineModel('stock.lot.line', {
  label: 'Lot line',
  order: ['id asc'],
  access: {
    'stock.user': ['read', 'write', 'create', 'unlink'],
    'stock.manager': [...ALL, 'export', 'import'],
  },
  fields: {
    picking: f.many2one('stock.picking', {
      required: true,
      ondelete: 'cascade',
      label: 'Transfer',
    }),
    product: f.many2one('product.product', { required: true, ondelete: 'restrict' }),
    lot: f.many2one('stock.lot', { ondelete: 'restrict', label: 'Lot / serial number' }),
    /** A new lot or serial number, made when the transfer is validated. */
    lotName: f.char({ label: 'New lot / serial number' }),
    quantity: f.decimal({ scale: 4, required: true, default: '1' }),
  },
  sqlConstraints: {
    positive: { check: orm.sql`quantity > 0`, message: 'A lot line has a positive quantity.' },
  },
  constraints: {
    lotGiven: {
      ...check('stock.lot.line', ['lot', 'lotName'], async (lines) =>
        [...lines]
          .filter((l) => l.lot === null && (l.lotName ?? '').trim() === '')
          .map((l) => l.id),
      ),
      message: 'Give the lot or serial number: an existing one, or the name of a new one.',
    },
    sameProduct: {
      ...check('stock.lot.line', ['lot', 'product'], async (lines) =>
        (await lines.load({ lot: true }))
          .filter((l) => l.lot !== null && l.lot.product.id !== l.product.id)
          .map((l) => l.id),
      ),
      message: 'This lot or serial number belongs to another product.',
    },
  },
});

export const StockPicking = defineModel('stock.picking', {
  label: 'Transfer',
  recName: 'name',
  order: ['scheduledDate desc', 'id desc'],
  companyScoped: { required: true },
  tracking: ['state', 'partner', 'scheduledDate'],
  access: {
    'stock.user': ['read', 'write', 'create'],
    'stock.manager': [...ALL, 'export', 'import'],
  },
  fields: {
    name: f.char({
      required: true,
      readonly: true,
      sequence: { code: 'stock.picking', dateField: 'scheduledDate' },
      label: 'Reference',
    }),
    kind: f.selection(
      {
        receipt: 'Receipt',
        delivery: 'Delivery',
        internal: 'Internal move',
        adjustment: 'Inventory adjustment',
        production: 'Production',
      },
      { required: true, default: 'receipt', label: 'Type' },
    ),
    partner: f.many2one('res.partner', { ondelete: 'set null', label: 'Contact' }),
    warehouse: f.many2one('stock.warehouse', { ondelete: 'restrict' }),
    source: f.many2one('stock.location', { required: true, ondelete: 'restrict', label: 'From' }),
    destination: f.many2one('stock.location', {
      required: true,
      ondelete: 'restrict',
      label: 'To',
    }),
    scheduledDate: f.date({
      required: true,
      default: (env: Env) => env.today(),
      label: 'Scheduled',
    }),
    doneDate: f.date({ label: 'Done on' }),
    /** The document it comes from (`SO/2026/00017`). */
    origin: f.char({ label: 'Source document' }),
    note: f.text(),
    moves: f.one2many('stock.move', 'picking', { label: 'Lines' }),
    lotLines: f.one2many('stock.lot.line', 'picking', { label: 'Lots and serial numbers' }),
    /** The count this adjustment applies. */
    count: f.many2one('stock.count', { ondelete: 'set null', label: 'Count' }),
    /** The transfer this one takes the rest of. */
    backorderOf: f.many2one('stock.picking', { ondelete: 'set null', label: 'Backorder of' }),
    backorders: f.one2many('stock.picking', 'backorderOf'),
    /** How much of what leaves an internal location is reserved; receipts are always ready. */
    availability: f.selection(
      { none: 'Nothing reserved', partial: 'Partly reserved', full: 'Everything reserved' },
      {
        store: true,
        label: 'Availability',
        ...compute(
          'stock.picking',
          'availability',
          ['source.usage', 'moves.productQty', 'moves.reserved'],
          (pickings) => {
            for (const p of pickings) {
              const moves = [...p.moves];
              if (p.source.usage !== 'internal' || moves.length === 0) {
                p.availability = 'full';
                continue;
              }
              const full = moves.every((m) => (m.reserved ?? zero).gte(m.productQty ?? zero));
              const some = moves.some((m) => (m.reserved ?? zero).gt(0));
              p.availability = full ? 'full' : some ? 'partial' : 'none';
            }
          },
        ),
      },
    ),
    /** The one chip: Draft, Waiting, Ready, Done or Cancelled. */
    status: f.selection(
      { draft: 'Draft', waiting: 'Waiting', ready: 'Ready', done: 'Done', cancelled: 'Cancelled' },
      {
        store: true,
        label: 'Status',
        ...compute('stock.picking', 'status', ['state', 'availability'], (pickings) => {
          for (const p of pickings)
            p.status =
              p.state === 'confirmed'
                ? p.availability === 'full'
                  ? 'ready'
                  : 'waiting'
                : p.state === 'cancel'
                  ? 'cancelled'
                  : p.state;
        }),
      },
    ),
    state: f.state({
      states: { draft: 'Draft', confirmed: 'Confirmed', done: 'Done', cancel: 'Cancelled' },
      initial: 'draft',
      transitions: {
        confirm: {
          from: ['draft'],
          to: 'confirmed',
          guard: records('stock.picking', async (pickings) => {
            const loaded = await pickings.load({ moves: true });
            return loaded.filter((p) => p.moves.length === 0);
          }),
          message: 'Add at least one line before confirming the transfer.',
          // The lines' checks run while the transfer is still a draft (created and confirmed at once).
          before: records('stock.picking', async (pickings): Promise<void> => {
            await pickings.env.flush();
          }),
          after: records('stock.picking', async (pickings) => {
            if (await reserveOnConfirm(pickings.env)) await reserve(pickings.ids, pickings.env);
          }),
        },
        /** "Check availability": reserve what has come in since. */
        reserve: {
          from: ['confirmed'],
          to: 'confirmed',
          after: records('stock.picking', async (pickings): Promise<void> => {
            await reserve(pickings.ids, pickings.env);
          }),
        },
        unreserve: {
          from: ['confirmed'],
          to: 'confirmed',
          after: records('stock.picking', async (pickings): Promise<void> => {
            await unreserve(pickings.ids, pickings.env);
          }),
        },
        validate: {
          from: ['confirmed'],
          to: 'done',
          // What is done must be reserved (out of stock), and something must be done.
          guard: records('stock.picking', async (pickings) => {
            const loaded = await pickings.load({ source: true, moves: true });
            return loaded.filter(
              (p) =>
                [...p.moves].every((m) => (m.doneQty ?? zero).lte(0)) ||
                (p.source.usage === 'internal' &&
                  [...p.moves].some((m) => (m.reserved ?? zero).lt(m.doneQty ?? zero))),
            );
          }),
          message:
            'Not everything done is reserved: check availability, wait for the stock, or lower the done quantities.',
          before: records('stock.picking', async (pickings): Promise<void> => {
            await applyMoves(pickings.ids, pickings.env);
          }),
        },
        cancel: {
          from: ['draft', 'confirmed'],
          to: 'cancel',
          after: records('stock.picking', async (pickings): Promise<void> => {
            await unreserve(pickings.ids, pickings.env);
          }),
        },
        redraft: { from: ['cancel'], to: 'draft' },
      },
      extensible: true,
    }),
  },
  methods: {
    /**
     * Runs once these transfers are validated — their stock moved, their done quantities written — in the
     * validation's audited superuser scope, before any backorder is made. Nothing here; a bridge overrides it
     * (`stock_account`: the stock's value posted to Accounting).
     */
    validated: method('stock.picking', async (): Promise<void> => undefined),
    /**
     * What a backorder copies from each of these transfers: the type, contact, places, company, source document,
     * date and note. A bridge adds its link by overriding it (`sale_stock`: the sales order).
     */
    backorderValues: method('stock.picking', async function (): Promise<
      Map<number, Record<string, unknown>>
    > {
      const out = new Map<number, Record<string, unknown>>();
      for (const p of await this.load({}))
        out.set(p.id, {
          kind: p.kind,
          partner: p.partner?.id ?? null,
          warehouse: p.warehouse?.id ?? null,
          source: p.source.id,
          destination: p.destination.id,
          company: p.company.id,
          origin: p.origin,
          scheduledDate: p.scheduledDate,
          note: p.note,
        });
      return out;
    }),
  },
  onchange: {
    // A new type or warehouse proposes its locations.
    kind: onchange('stock.picking', async (d, env) => {
      const wh = d.get('warehouse') as Id<'stock.warehouse'> | null | undefined;
      const l = await defaultLocations(env, String(d.get('kind')), wh ?? null);
      d.set('warehouse', l.warehouse);
      d.set('source', l.source);
      d.set('destination', l.destination);
    }),
    warehouse: onchange('stock.picking', async (d, env) => {
      const wh = d.get('warehouse') as Id<'stock.warehouse'> | null | undefined;
      const l = await defaultLocations(env, String(d.get('kind')), wh ?? null);
      d.set('source', l.source);
      d.set('destination', l.destination);
    }),
  },
  constraints: {
    differentPlaces: {
      ...check('stock.picking', ['source', 'destination', 'kind'], async (pickings) =>
        (await pickings.load({ source: true, destination: true }))
          .filter(
            (p) =>
              p.source.id === p.destination.id ||
              (p.kind === 'receipt' && p.destination.usage !== 'internal') ||
              (p.kind === 'delivery' && p.source.usage !== 'internal') ||
              (p.kind === 'internal' &&
                (p.source.usage !== 'internal' || p.destination.usage !== 'internal')) ||
              (p.kind === 'adjustment' &&
                !(
                  (p.source.usage === 'adjustment' && p.destination.usage === 'internal') ||
                  (p.source.usage === 'internal' && p.destination.usage === 'adjustment')
                )) ||
              (p.kind === 'production' &&
                !(
                  (p.source.usage === 'production' && p.destination.usage === 'internal') ||
                  (p.source.usage === 'internal' && p.destination.usage === 'production')
                )),
          )
          .map((p) => p.id),
      ),
      message:
        'A transfer goes between two places: a receipt into stock, a delivery out of stock, an internal move between stock locations, an adjustment between stock and the adjustment location.',
    },
  },
});

/**
 * What `product` has in `location` and the locations inside it, in the product's unit: all of it, or that of `lot`
 * (`null`: the stock without a lot).
 */
export async function onHandIn(
  env: Env,
  product: Id<'product.product'>,
  location: Id<'stock.location'>,
  lot?: Id<'stock.lot'> | null,
): Promise<Decimal> {
  const quants = await (
    await env.model('stock.quant').search({
      where: {
        product,
        location: { childOf: location },
        ...(lot === undefined ? {} : { lot: lot === null ? { isNull: true } : lot }),
      },
    })
  ).load(['quantity']);
  return [...quants].reduce((s, q) => s.plus(q.quantity), zero);
}

export const StockCountLine = defineModel('stock.count.line', {
  label: 'Count line',
  order: ['id asc'],
  access: {
    'stock.user': ['read', 'write', 'create', 'unlink'],
    'stock.manager': [...ALL, 'export', 'import'],
  },
  fields: {
    count: f.many2one('stock.count', { required: true, ondelete: 'cascade' }),
    product: f.many2one('product.product', { required: true, ondelete: 'restrict' }),
    /** The lot or serial number counted, for a tracked product. */
    lot: f.many2one('stock.lot', { ondelete: 'restrict', label: 'Lot / serial number' }),
    /** On hand when the count started, in the product's unit. */
    expected: f.decimal({ scale: 4, label: 'Expected' }),
    /** What was found (empty: not counted yet, left as it is). */
    counted: f.decimal({ scale: 4, label: 'Counted' }),
    difference: f.decimal({
      scale: 4,
      store: true,
      label: 'Difference',
      ...compute('stock.count.line', 'difference', ['expected', 'counted'], (lines) => {
        for (const l of lines)
          l.difference = l.counted === null ? null : l.counted.minus(l.expected ?? zero);
      }),
    }),
  },
  sqlConstraints: {
    onePerProduct: {
      unique: ['count', 'product'],
      where: orm.sql`lot_id IS NULL`,
      message: 'A product is counted once per count.',
    },
    onePerLot: {
      unique: ['count', 'product', 'lot'],
      where: orm.sql`lot_id IS NOT NULL`,
      message: 'A lot is counted once per count.',
    },
    notNegative: {
      check: orm.sql`counted IS NULL OR counted >= 0`,
      message: 'A counted quantity cannot be negative.',
    },
  },
  constraints: {
    goodsOnly: {
      ...check('stock.count.line', ['product'], async (lines) =>
        (await lines.load({ product: true }))
          .filter((l) => l.product.kind !== 'goods')
          .map((l) => l.id),
      ),
      message: 'Services are not counted: only goods are kept in stock.',
    },
  },
});

/**
 * Applies counts: what was found against what is on hand now, in one adjustment transfer for the gains (from the
 * adjustment location into the counted location) and one for the losses (out of it, reserved first), both validated.
 * Refused when a loss is held by other transfers' reservations (they are named).
 */
async function applyCounts(ids: readonly Id<'stock.count'>[], env: Env): Promise<void> {
  await env.asSuperuser({ reason: 'stock count applied' }, async (su) => {
    const counts = await su
      .model('stock.count')
      .browse(ids)
      .load({ location: true, company: true, lines: { product: true } });
    const adjustment = (
      await su.model('stock.location').search({ where: { usage: 'adjustment' }, limit: 1 })
    ).ids[0];
    if (adjustment === undefined)
      throw new orm.ValidationError(
        'stock.count',
        ['state'],
        'There is no inventory adjustment location.',
        'Upgrade the Stockroom app to restore it.',
      );
    for (const c of counts) {
      type Change = {
        product: Id<'product.product'>;
        lot: Id<'stock.lot'> | null;
        quantity: Decimal;
      };
      const gains: Change[] = [];
      const losses: Change[] = [];
      for (const l of c.lines) {
        if (l.counted === null) continue;
        const lot = l.lot?.id ?? null;
        const tracked = l.product.tracking !== 'none' && l.product.tracking !== null;
        const diff = l.counted.minus(await onHandIn(su, l.product.id, c.location.id, lot));
        if (diff.gt(0) && tracked && lot === null)
          throw new orm.ValidationError(
            'stock.count',
            ['lines'],
            `${l.product.name} is tracked: the stock found needs its lot or serial number.`,
            'Choose the lot on its line, or scan the lot or serial number.',
          );
        if (diff.gt(0)) gains.push({ product: l.product.id, lot, quantity: diff });
        if (diff.lt(0)) losses.push({ product: l.product.id, lot, quantity: diff.negated() });
      }
      for (const [lines, source, destination] of [
        [gains, adjustment, c.location.id],
        [losses, c.location.id, adjustment],
      ] as const) {
        if (lines.length === 0) continue;
        const made = await su.model('stock.picking').create([
          {
            kind: 'adjustment',
            company: c.company.id,
            source,
            destination,
            origin: c.name,
            count: c.id,
            moves: {
              create: lines.map((l) => ({
                product: l.product,
                quantity: l.quantity,
                restrictLot: source === adjustment ? null : l.lot,
              })),
            },
            // Found stock enters with its lot.
            lotLines: {
              create:
                source === adjustment
                  ? lines
                      .filter((l) => l.lot !== null)
                      .map((l) => ({ product: l.product, lot: l.lot, quantity: l.quantity }))
                  : [],
            },
          },
        ]);
        await made.confirm();
        if (source !== adjustment) await made.reserve();
        const [loaded] = await made.load(['availability']);
        if (loaded?.availability !== 'full') {
          const held = await (
            await su.model('stock.reservation').search({
              where: { 'quant.location': { childOf: c.location.id } },
              limit: 3,
            })
          ).load(['label']);
          throw new orm.ValidationError(
            'stock.count',
            ['state'],
            `Some of what is missing is reserved: ${[...held].map((r) => r.label).join('; ')}.`,
            'Unreserve or cancel those transfers, then apply the count again.',
          );
        }
        await made.validate();
      }
    }
  });
}

export const StockCount = defineModel('stock.count', {
  label: 'Count',
  recName: 'name',
  order: ['date desc', 'id desc'],
  companyScoped: { required: true },
  tracking: ['state'],
  access: {
    'stock.user': ['read', 'write', 'create'],
    'stock.manager': [...ALL, 'export'],
  },
  fields: {
    name: f.char({
      required: true,
      readonly: true,
      sequence: { code: 'stock.count', dateField: 'date' },
      label: 'Reference',
    }),
    location: f.many2one('stock.location', { required: true, ondelete: 'restrict' }),
    date: f.date({ required: true, default: (env: Env) => env.today() }),
    user: f.many2one('res.users', {
      default: (env: Env) => env.userId,
      label: 'Counted by',
    }),
    lines: f.one2many('stock.count.line', 'count'),
    adjustments: f.one2many('stock.picking', 'count'),
    note: f.text(),
    state: f.state({
      states: { draft: 'Draft', counting: 'Counting', done: 'Applied', cancel: 'Cancelled' },
      initial: 'draft',
      transitions: {
        /** Lists what the location holds (and inside it), with what is expected, for counting. */
        start: {
          from: ['draft'],
          to: 'counting',
          after: records('stock.count', async (counts): Promise<void> => {
            const env = counts.env;
            await env.asSuperuser({ reason: 'stock count started' }, async (su) => {
              for (const c of await su
                .model('stock.count')
                .browse(counts.ids)
                .load({ lines: true })) {
                // By product and lot. Indexed first: creating a line unloads the count's lines.
                const key = (product: number, lot: number | null) => `${product}:${lot ?? ''}`;
                const existing = new Map(
                  [...c.lines].map((l) => [key(l.product.id, l.lot?.id ?? null), l]),
                );
                const listed = new Map(
                  [...c.lines].map((l) => [
                    key(l.product.id, l.lot?.id ?? null),
                    { product: l.product.id, lot: l.lot?.id ?? null },
                  ]),
                );
                const quants = await (
                  await su
                    .model('stock.quant')
                    .search({ where: { location: { childOf: c.location.id } } })
                ).load({ product: true, lot: true });
                for (const q of quants)
                  listed.set(key(q.product.id, q.lot?.id ?? null), {
                    product: q.product.id,
                    lot: q.lot?.id ?? null,
                  });
                for (const [k, { product, lot }] of listed) {
                  const expected = await onHandIn(su, product, c.location.id, lot);
                  const line = existing.get(k);
                  if (line !== undefined) await line.write({ expected });
                  else
                    await su
                      .model('stock.count.line')
                      .create([{ count: c.id, product, lot, expected }]);
                }
              }
            });
          }),
        },
        apply: {
          from: ['counting'],
          to: 'done',
          requires: 'stock.count_apply',
          before: records('stock.count', async (counts): Promise<void> => {
            await applyCounts(counts.ids, counts.env);
          }),
        },
        cancel: { from: ['draft', 'counting'], to: 'cancel' },
        redraft: { from: ['cancel'], to: 'draft' },
      },
    }),
  },
  constraints: {
    internalLocation: {
      ...check('stock.count', ['location'], async (counts) =>
        (await counts.load({ location: true }))
          .filter((c) => c.location.usage !== 'internal')
          .map((c) => c.id),
      ),
      message: 'Stock is counted in an internal location.',
    },
  },
});

/** What a product has in stock, across the internal locations. */
export const ProductStock = extendModel('product.product', {
  fields: {
    /** By lot (a batch, an expiry date) or by serial number (one unit each); lots travel with the stock. */
    tracking: f.selection(
      { none: 'Not tracked', lot: 'By lot', serial: 'By serial number' },
      { required: true, default: 'none', label: 'Tracking' },
    ),
    lots: f.one2many('stock.lot', 'product'),
    quants: f.one2many('stock.quant', 'product'),
    qtyOnHand: f.decimal({
      scale: 4,
      store: true,
      label: 'On hand',
      ...compute('product.product', 'qtyOnHand', ['quants.quantity'], (products) => {
        for (const p of products)
          p.qtyOnHand = [...p.quants].reduce((s, q) => s.plus(q.quantity), zero);
      }),
    }),
    qtyReserved: f.decimal({
      scale: 4,
      store: true,
      label: 'Reserved',
      ...compute('product.product', 'qtyReserved', ['quants.reserved'], (products) => {
        for (const p of products)
          p.qtyReserved = [...p.quants].reduce((s, q) => s.plus(q.reserved ?? zero), zero);
      }),
    }),
    qtyAvailable: f.decimal({
      scale: 4,
      store: true,
      label: 'Available',
      ...compute('product.product', 'qtyAvailable', ['qtyOnHand', 'qtyReserved'], (products) => {
        for (const p of products)
          p.qtyAvailable = (p.qtyOnHand ?? zero).minus(p.qtyReserved ?? zero);
      }),
    }),
  },
});

const shared = (
  id: string,
  name: string,
  usage: 'vendor' | 'customer' | 'adjustment' | 'production',
) => record('stock.location', id, { name, usage, company: null }, { noupdate: true });

export const stockShutro = defineModule({
  name: 'stock',
  version: '0.1.0',
  depends: [productShutro, contactsShutro, messagingShutro],
  groups: [
    orm.defineGroup({ code: 'stock.user', label: 'Stockroom user', implies: ['product.user'] }),
    orm.defineGroup({ code: 'stock.manager', label: 'Stockroom manager', implies: ['stock.user'] }),
  ],
  sequences: [
    orm.defineSequence({
      code: 'stock.picking',
      prefix: 'TR/{year}/',
      padding: 5,
      reset: 'yearly',
    }),
    orm.defineSequence({
      code: 'stock.count',
      prefix: 'CNT/{year}/',
      padding: 5,
      reset: 'yearly',
    }),
  ],
  permissions: [
    orm.definePermission({
      code: 'stock.count_apply',
      label: 'Apply stock counts',
      groups: ['stock.manager'],
    }),
  ],
  models: [
    StockWarehouse,
    StockLocation,
    StockLot,
    StockQuant,
    StockReservation,
    StockMove,
    StockPicking,
    StockLotLine,
    StockCount,
    StockCountLine,
  ],
  extensions: [ProductStock],
  data: [
    shared('location_vendors', 'Vendors', 'vendor'),
    shared('location_customers', 'Customers', 'customer'),
    shared('location_adjustment', 'Inventory adjustment', 'adjustment'),
    shared('location_production', 'Production', 'production'),
  ],
});
