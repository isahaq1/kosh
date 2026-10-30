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

export const StockQuant = defineModel('stock.quant', {
  label: 'Stock',
  order: ['id asc'],
  companyScoped: { required: true },
  // Read-only to everyone: quantities change only through validated transfers.
  access: { 'stock.user': READ, 'stock.manager': ['read', 'export'] },
  fields: {
    product: f.many2one('product.product', { required: true, ondelete: 'restrict' }),
    location: f.many2one('stock.location', { required: true, ondelete: 'restrict' }),
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
      message: 'A product has one stock line per location.',
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
    /** "2 Units reserved for TR/2026/00042 (SO/2026/00017)". */
    label: f.char({
      store: true,
      label: 'Reserved for',
      ...compute(
        'stock.reservation',
        'label',
        ['quantity', 'move.picking.name', 'move.picking.origin', 'quant.product.uom.name'],
        (reservations) => {
          for (const r of reservations) {
            const p = r.move.picking;
            const unit = r.quant.product.uom?.name ?? '';
            r.label = `${r.quantity.toString()}${unit === '' ? '' : ` ${unit}`} reserved for ${p.name}${
              p.origin ? ` (${p.origin})` : ''
            }`;
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
        out.set(m.id, { product: m.product.id, name: m.name, uom: m.uom?.id ?? null });
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
        [...moves].filter((m) => m.quantityDone !== null && m.quantityDone.lt(0)).map((m) => m.id),
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
        const quants = await (
          await su.model('stock.quant').search({
            where: { product: m.product.id, location: { childOf: p.source.id } },
          })
        ).load(['quantity', 'reserved']);
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
 * reservations and enters the destination's quant; the reservations are released. Lines done in part leave the
 * rest to a backorder — a new transfer with the same partner, places and source document, and every other field
 * of its transfer and lines that `backorderValues` gives (a bridge's order and order lines too) — confirmed at once.
 */
async function applyMoves(ids: readonly Id<'stock.picking'>[], env: Env): Promise<void> {
  await env.asSuperuser({ reason: 'stock transfer validated' }, async (su) => {
    const pickings = await su
      .model('stock.picking')
      .browse(ids)
      .load({ source: true, destination: true, company: true, moves: { reservations: true } });
    const out = new Map<Id<'stock.quant'>, Decimal>();
    const into = new Map<
      string,
      {
        product: Id<'product.product'>;
        location: Id<'stock.location'>;
        company: Id<'res.company'>;
        quantity: Decimal;
      }
    >();
    const used: Id<'stock.reservation'>[] = [];
    const backorders: { picking: Id<'stock.picking'>; rest: Map<Id<'stock.move'>, Decimal> }[] = [];
    for (const p of pickings) {
      const rest = new Map<Id<'stock.move'>, Decimal>();
      for (const m of p.moves) {
        const done = m.doneQty ?? zero;
        if (p.source.usage === 'internal') {
          let left = done;
          for (const r of m.reservations) {
            const take = left.lt(r.quantity) ? left : r.quantity;
            if (take.gt(0)) out.set(r.quant.id, (out.get(r.quant.id) ?? zero).plus(take));
            left = left.minus(take);
            used.push(r.id);
          }
        }
        if (p.destination.usage === 'internal' && done.gt(0)) {
          const key = `${m.product.id}:${p.destination.id}`;
          const before = into.get(key)?.quantity ?? zero;
          into.set(key, {
            product: m.product.id,
            location: p.destination.id,
            company: p.company.id,
            quantity: before.plus(done),
          });
        }
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
    for (const { product, location, company, quantity } of into.values()) {
      const found = await su
        .model('stock.quant')
        .search({ where: { product, location }, limit: 1 });
      const [q] = await found.load(['quantity']);
      if (q !== undefined) await q.write({ quantity: q.quantity.plus(quantity) });
      else await su.model('stock.quant').create([{ product, location, company, quantity }]);
    }
    await su.model('stock.picking').browse(ids).write({ doneDate: su.today() });
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
      { receipt: 'Receipt', delivery: 'Delivery', internal: 'Internal move' },
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
                (p.source.usage !== 'internal' || p.destination.usage !== 'internal')),
          )
          .map((p) => p.id),
      ),
      message:
        'A transfer goes between two places: a receipt into stock, a delivery out of stock, an internal move between stock locations.',
    },
  },
});

/** What a product has in stock, across the internal locations. */
export const ProductStock = extendModel('product.product', {
  fields: {
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

const shared = (id: string, name: string, usage: 'vendor' | 'customer' | 'adjustment') =>
  record('stock.location', id, { name, usage, company: null }, { noupdate: true });

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
  ],
  models: [StockWarehouse, StockLocation, StockQuant, StockReservation, StockMove, StockPicking],
  extensions: [ProductStock],
  data: [
    shared('location_vendors', 'Vendors', 'vendor'),
    shared('location_customers', 'Customers', 'customer'),
    shared('location_adjustment', 'Inventory adjustment', 'adjustment'),
  ],
});
