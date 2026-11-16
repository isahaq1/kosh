/**
 * Stock on hand at the cut-off, and its proof (RFC 0034 §2.3, step 3 part 2b): Odoo's quants in its internal
 * locations become Stockroom stock — one validated inventory adjustment per location, from Kosh's adjustment location,
 * each lot on its line — so every unit arrives the way stock always arrives in Kosh, with its transfer, its lot history
 * and its place in the stock ledger.
 *
 * With stock valuation (`stock_account`), each line comes in at Odoo's value (its unit cost to six places) and the
 * adjustment is dated the cut-off in the books; the opening entry then takes what these entries posted into account,
 * so every account still ends at Odoo's balance.
 *
 * The checks compare Kosh with Odoo afterwards, in the same transaction: the quantity of each product, lot and
 * location; with valuation, each product's value.
 */
import type { Env } from '@kosh/server/orm';
import { orm } from '@kosh/server/orm';
import type { Check } from './opening.js';
import { idOf, type OdooClient, type OdooValue, textOf } from './rpc.js';

type Decimal = ReturnType<typeof orm.toDecimal>;
const ZERO = orm.toDecimal(0);
/** An Odoo float as an exact decimal, rounded to `scale` places. */
const dec = (v: OdooValue | undefined, scale: number): Decimal =>
  orm.toDecimal(typeof v === 'number' ? v.toFixed(scale) : '0');
const nameOf = (v: OdooValue | undefined): string =>
  Array.isArray(v) ? textOf(v[1] as OdooValue) : textOf(v);

export interface OdooQuant {
  readonly product: number;
  readonly location: number;
  readonly lot: number | null;
  readonly quantity: Decimal;
  /** Odoo's value of the quant (null when its Odoo does not value stock). */
  readonly value: Decimal | null;
  readonly label: string;
}

/** What is read from Odoo for the stock on hand. */
export interface OdooStock {
  readonly cutoff: string;
  readonly quants: readonly OdooQuant[];
}

/** Odoo's stock in its company's internal locations, as it is now (run with no stock moved after the cut-off). */
export async function readStock(
  client: OdooClient,
  company: number,
  cutoff: string,
): Promise<OdooStock | null> {
  const fields = await client.fields('stock.quant');
  if (fields === null) return null;
  const rows = await client.readAll(
    'stock.quant',
    ['product_id', 'location_id', 'lot_id', 'quantity', 'value'].filter(
      (f) => fields[f] !== undefined,
    ),
    {
      domain: [
        ['location_id.usage', '=', 'internal'],
        ['company_id', '=', company],
      ],
    },
  );
  return {
    cutoff,
    quants: rows.map((r) => ({
      product: idOf(r['product_id']) ?? 0,
      location: idOf(r['location_id']) ?? 0,
      lot: idOf(r['lot_id']),
      quantity: dec(r['quantity'], 4),
      value: fields['value'] === undefined ? null : dec(r['value'], 2),
      label: [nameOf(r['product_id']), nameOf(r['location_id']), nameOf(r['lot_id'])]
        .filter((t) => t !== '')
        .join(' · '),
    })),
  };
}

export interface StockResult {
  /** `skipped`: this stock was imported before (each adjustment found by its external id). */
  readonly status: 'done' | 'skipped';
  readonly adjustments: number;
  readonly lines: number;
  readonly failed: readonly { readonly what: string; readonly error: string }[];
}

type Recs = {
  readonly ids: readonly number[];
  readonly length: number;
  confirm(): Promise<void>;
  validate(): Promise<void>;
};
interface Model {
  search(q: unknown): Promise<Recs>;
  create(values: unknown): Promise<Recs>;
}
const model = (env: Env, name: string): Model => env.model(name as never) as unknown as Model;

const xmlIdOf = (cutoff: string, location: number): string =>
  `odoo.stock_opening_${cutoff.replaceAll('-', '')}_${location}`;

/** Each Odoo location's stock as one validated adjustment into the Kosh location it was imported as. */
export async function writeStock(
  env: Env,
  data: OdooStock,
  ref: (model: string, id: number | null) => number | null,
  errorText: (e: unknown) => string,
  /** Kosh's fields of a model (null: not installed). */
  fieldsOf: (model: string) => ReadonlySet<string> | null,
): Promise<StockResult> {
  const failed: { what: string; error: string }[] = [];
  const valued = fieldsOf('stock.move')?.has('unitCost') === true;
  const dated = fieldsOf('stock.picking')?.has('accountingDate') === true;
  const adjustment = (
    await model(env, 'stock.location').search({
      where: { usage: 'adjustment', name: 'Inventory adjustment' },
      limit: 1,
    })
  ).ids[0];
  if (adjustment === undefined)
    return {
      status: 'done',
      adjustments: 0,
      lines: 0,
      failed: [{ what: 'the stock', error: 'Kosh has no inventory adjustment location' }],
    };

  const byLocation = new Map<number, OdooQuant[]>();
  for (const q of data.quants) {
    if (q.quantity.isZero()) continue;
    if (q.quantity.isNegative()) {
      failed.push({
        what: q.label,
        error: `${q.quantity.toString()} in Odoo: Kosh never holds stock below zero (count it in Odoo first)`,
      });
      continue;
    }
    byLocation.set(q.location, [...(byLocation.get(q.location) ?? []), q]);
  }

  let adjustments = 0;
  let lines = 0;
  let found = 0;
  for (const [odooLocation, quants] of byLocation) {
    const xmlId = xmlIdOf(data.cutoff, odooLocation);
    try {
      await env.refId('stock.picking' as never, xmlId);
      found += 1;
      continue;
    } catch {
      // not imported yet
    }
    const destination = ref('stock.location', odooLocation);
    if (destination === null) {
      failed.push({
        what: quants[0]?.label ?? `location #${odooLocation}`,
        error: 'its location was not imported',
      });
      continue;
    }
    // One line per product, at the value of all its quants here; each lot on the lot lines.
    const moves = new Map<number, { quantity: Decimal; value: Decimal | null }>();
    const lotLines: { product: number; lot: number; quantity: string }[] = [];
    let refused = false;
    for (const q of quants) {
      const product = ref('product.product', q.product);
      const lot = q.lot === null ? null : ref('stock.lot', q.lot);
      if (product === null || (q.lot !== null && lot === null)) {
        failed.push({
          what: q.label,
          error: product === null ? 'its product was not imported' : 'its lot was not imported',
        });
        refused = true;
        continue;
      }
      const m = moves.get(product);
      moves.set(product, {
        quantity: (m?.quantity ?? ZERO).plus(q.quantity),
        value: q.value === null ? null : (m?.value ?? ZERO).plus(q.value),
      });
      if (lot !== null) lotLines.push({ product, lot, quantity: q.quantity.toString() });
    }
    if (refused || moves.size === 0) continue;
    try {
      await env.transaction(async (tx) => {
        const made = await model(tx, 'stock.picking').create([
          {
            kind: 'adjustment',
            company: env.companyId,
            source: adjustment,
            destination,
            origin: `Odoo stock at ${data.cutoff}`,
            ...(dated ? { accountingDate: data.cutoff } : {}),
            moves: {
              create: [...moves].map(([product, m]) => ({
                product,
                quantity: m.quantity.toString(),
                ...(valued && m.value !== null
                  ? { unitCost: m.value.div(m.quantity).toDecimalPlaces(6).toString() }
                  : {}),
              })),
            },
            lotLines: { create: lotLines },
          },
        ]);
        await made.confirm();
        await made.validate();
        await tx.setExternalId('stock.picking' as never, made.ids[0] as number, xmlId);
      });
      adjustments += 1;
      lines += moves.size;
    } catch (error) {
      failed.push({
        what: quants[0]?.label ?? `location #${odooLocation}`,
        error: errorText(error),
      });
    }
  }
  return {
    status: adjustments === 0 && found > 0 && failed.length === 0 ? 'skipped' : 'done',
    adjustments,
    lines,
    failed,
  };
}

/** Kosh's stock against Odoo's: each product, lot and location's quantity; with valuation, each product's value. */
export async function reconcileStock(
  env: Env,
  data: OdooStock,
  ref: (model: string, id: number | null) => number | null,
  valued: boolean,
): Promise<Check[]> {
  const company = env.companyId as number;
  const key = (product: number | null, location: number | null, lot: number | null) =>
    `${product ?? '?'}:${location ?? '?'}:${lot ?? ''}`;
  const expected = new Map<string, { quantity: Decimal; label: string }>();
  const expectedValue = new Map<number, { value: Decimal; label: string }>();
  for (const q of data.quants) {
    if (q.quantity.isZero()) continue;
    const product = ref('product.product', q.product);
    const k = key(
      product,
      ref('stock.location', q.location),
      q.lot === null ? null : ref('stock.lot', q.lot),
    );
    const prev = expected.get(k);
    expected.set(k, { quantity: (prev?.quantity ?? ZERO).plus(q.quantity), label: q.label });
    if (q.value !== null && product !== null) {
      const v = expectedValue.get(product);
      expectedValue.set(product, {
        value: (v?.value ?? ZERO).plus(q.value),
        label: q.label.split(' · ')[0] ?? `#${q.product}`,
      });
    }
  }
  const rows = await env.sql<{
    product_id: number;
    location_id: number;
    lot_id: number | null;
    quantity: string;
  }>`
    SELECT q.product_id, q.location_id, q.lot_id, SUM(q.quantity)::text AS quantity
    FROM stock_quant q JOIN stock_location l ON l.id = q.location_id
    WHERE q.company_id = ${company} AND l.usage = 'internal' AND q.quantity <> 0
    GROUP BY q.product_id, q.location_id, q.lot_id`;
  const kosh = new Map(
    rows.map((r) => [key(r.product_id, r.location_id, r.lot_id), orm.toDecimal(r.quantity)]),
  );
  const quantityDiffs: Check['differences'][number][] = [];
  for (const k of new Set([...expected.keys(), ...kosh.keys()])) {
    const odoo = expected.get(k)?.quantity ?? ZERO;
    const here = kosh.get(k) ?? ZERO;
    if (!odoo.equals(here))
      quantityDiffs.push({
        what: expected.get(k)?.label ?? `Kosh stock ${k}`,
        odoo: odoo.toString(),
        kosh: here.toString(),
      });
  }
  const checks: Check[] = [
    {
      name: 'stock on hand',
      ok: quantityDiffs.length === 0,
      summary: `${expected.size} products, lots and locations${quantityDiffs.length === 0 ? ', every quantity equal' : `, ${quantityDiffs.length} different`}`,
      differences: quantityDiffs,
    },
  ];
  if (!valued || expectedValue.size === 0) return checks;

  const layers = await env.sql<{ product_id: number; value: string }>`
    SELECT product_id, SUM(value)::text AS value FROM stock_valuation_layer
    WHERE company_id = ${company} AND date <= ${data.cutoff}::date
    GROUP BY product_id`;
  const koshValue = new Map(layers.map((r) => [r.product_id, orm.toDecimal(r.value)]));
  const valueDiffs: Check['differences'][number][] = [];
  let total = ZERO;
  for (const product of new Set([...expectedValue.keys(), ...koshValue.keys()])) {
    const odoo = expectedValue.get(product)?.value ?? ZERO;
    const here = koshValue.get(product) ?? ZERO;
    total = total.plus(odoo);
    if (!odoo.toDecimalPlaces(2).equals(here.toDecimalPlaces(2)))
      valueDiffs.push({
        what: expectedValue.get(product)?.label ?? `Kosh product #${product}`,
        odoo: odoo.toFixed(2),
        kosh: here.toFixed(2),
      });
  }
  checks.push({
    name: 'stock value',
    ok: valueDiffs.length === 0,
    summary: `${expectedValue.size} products worth ${total.toFixed(2)}${valueDiffs.length === 0 ? ', every value equal' : `, ${valueDiffs.length} different`}`,
    differences: valueDiffs,
  });
  return checks;
}
