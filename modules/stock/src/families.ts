/**
 * Variant stock by family (RFC 0030 §3.4): the Stockroom's reports fold the variants of a template into one row —
 * the family — and a family's stock is read as a matrix, the last attribute across and the others down, like the
 * grid quantities are typed into on an order. A product that is nobody's variant stays a row of its own.
 */
import { templateGrid } from '@kosh/product';
import { type Decimal, orm } from '@kosh/server/orm';
import type { Env } from './.kosh/bindings.js';
import {
  type Figure,
  IN_TYPES,
  type LedgerRow,
  type LedgerScope,
  OUT_TYPES,
  type StockRow,
  stockReport,
} from './ledger.js';

const zero: Decimal = orm.toDecimal(0);

export interface Family {
  readonly id: number;
  readonly name: string;
}

/** The template each of these products is a variant of; products of no template are left out. */
export async function familiesOf(
  env: Env,
  products: readonly number[],
): Promise<Map<number, Family>> {
  const out = new Map<number, Family>();
  const ids = [...new Set(products)];
  if (ids.length === 0) return out;
  for (const p of await env
    .withFlags({ activeTest: false })
    .model('product.product')
    .browse(ids as never)
    .load({ template: true }))
    if (p.template !== null)
      out.set(p.id as number, { id: p.template.id as number, name: p.template.name });
  return out;
}

const sum = (a: Figure, b: Figure): Figure => ({
  qty: a.qty.plus(b.qty),
  value: a.value.plus(b.value),
});

/** A family's row stands for its variants: it says which family, and how many of them have something to show. */
const familyProduct = <P extends { readonly uom: string }>(
  family: Family,
  first: P,
  variants: number,
) => ({
  id: 0,
  name: family.name,
  uom: first.uom,
  family: family.id,
  variants,
});

/**
 * The stock report by family: the rows of a template's variants at a location become one, their quantities
 * added. Rows of products without a template are kept as they are. Sorted like the report.
 */
export function foldStock(
  rows: readonly StockRow[],
  families: ReadonlyMap<number, Family>,
): StockRow[] {
  const folded = new Map<string, { row: StockRow; variants: Set<number> }>();
  const out: StockRow[] = [];
  for (const r of rows) {
    const family = families.get(r.product.id);
    if (family === undefined) {
      out.push(r);
      continue;
    }
    const key = `${family.id}:${r.location.id}`;
    const have = folded.get(key);
    if (have === undefined) folded.set(key, { row: r, variants: new Set([r.product.id]) });
    else {
      have.variants.add(r.product.id);
      have.row = {
        ...have.row,
        onHand: have.row.onHand.plus(r.onHand),
        reserved: have.row.reserved.plus(r.reserved),
        available: have.row.available.plus(r.available),
        incoming: have.row.incoming.plus(r.incoming),
        outgoing: have.row.outgoing.plus(r.outgoing),
      };
    }
  }
  for (const [key, { row, variants }] of folded) {
    const family = families.get(row.product.id) as Family;
    void key;
    out.push({ ...row, product: familyProduct(family, row.product, variants.size) });
  }
  return out.sort(
    (a, b) =>
      a.product.name.localeCompare(b.product.name) ||
      a.location.name.localeCompare(b.location.name),
  );
}

/** The ledger's summary by family: a template's variants in one row, every figure added. */
export function foldLedger(
  rows: readonly LedgerRow[],
  families: ReadonlyMap<number, Family>,
): LedgerRow[] {
  const folded = new Map<number, { row: LedgerRow; variants: number; family: Family }>();
  const out: LedgerRow[] = [];
  for (const r of rows) {
    const family = families.get(r.product.id);
    if (family === undefined) {
      out.push(r);
      continue;
    }
    const have = folded.get(family.id);
    if (have === undefined) folded.set(family.id, { row: r, variants: 1, family });
    else {
      have.variants += 1;
      have.row = {
        ...have.row,
        opening: sum(have.row.opening, r.opening),
        in: Object.fromEntries(
          IN_TYPES.map((t) => [t, sum(have.row.in[t], r.in[t])]),
        ) as LedgerRow['in'],
        out: Object.fromEntries(
          OUT_TYPES.map((t) => [t, sum(have.row.out[t], r.out[t])]),
        ) as LedgerRow['out'],
        totalIn: sum(have.row.totalIn, r.totalIn),
        totalOut: sum(have.row.totalOut, r.totalOut),
        closing: sum(have.row.closing, r.closing),
      };
    }
  }
  for (const { row, variants, family } of folded.values())
    out.push({ ...row, product: familyProduct(family, row.product, variants) });
  return out.sort((a, b) => a.product.name.localeCompare(b.product.name));
}

/** A variant's stock in the scope: every location added. */
export interface MatrixCell {
  readonly variant: { readonly id: number; readonly name: string };
  readonly onHand: Decimal;
  readonly reserved: Decimal;
  readonly available: Decimal;
  readonly incoming: Decimal;
  readonly outgoing: Decimal;
}

export interface StockMatrix {
  readonly template: Family;
  readonly attributes: readonly string[];
  readonly rows: readonly { readonly key: string; readonly label: string }[];
  readonly columns: readonly { readonly id: number; readonly name: string }[];
  /** `${row.key}|${column.id}` → the variant's stock, or `null` where the combination does not exist. */
  readonly cells: Readonly<Record<string, MatrixCell | null>>;
  /** Every variant of the family together. */
  readonly total: Omit<MatrixCell, 'variant'>;
}

/**
 * A family's stock as a matrix (RFC 0030 §3.4): the template's grid — the last attribute across, the others
 * down — with, in each cell, what the scope holds of that variant. Read as the caller: the template and the
 * stock they may see.
 */
export async function stockMatrix(
  env: Env,
  scope: LedgerScope,
  template: number,
): Promise<StockMatrix> {
  const grid = await templateGrid(env as never, template);
  const variants = Object.values(grid.cells)
    .filter((c) => c !== null)
    .map((c) => (c as { id: number }).id);
  const stock = new Map<number, Omit<MatrixCell, 'variant'>>();
  const nothing = { onHand: zero, reserved: zero, available: zero, incoming: zero, outgoing: zero };
  if (variants.length > 0)
    for (const r of await stockReport(env, { ...scope, categories: [], products: variants })) {
      const have = stock.get(r.product.id) ?? nothing;
      stock.set(r.product.id, {
        onHand: have.onHand.plus(r.onHand),
        reserved: have.reserved.plus(r.reserved),
        available: have.available.plus(r.available),
        incoming: have.incoming.plus(r.incoming),
        outgoing: have.outgoing.plus(r.outgoing),
      });
    }
  const cells: Record<string, MatrixCell | null> = {};
  let total = nothing;
  for (const [key, cell] of Object.entries(grid.cells)) {
    if (cell === null) {
      cells[key] = null;
      continue;
    }
    const have = stock.get(cell.id) ?? nothing;
    cells[key] = { variant: { id: cell.id, name: cell.name }, ...have };
    total = {
      onHand: total.onHand.plus(have.onHand),
      reserved: total.reserved.plus(have.reserved),
      available: total.available.plus(have.available),
      incoming: total.incoming.plus(have.incoming),
      outgoing: total.outgoing.plus(have.outgoing),
    };
  }
  return {
    template: grid.template,
    attributes: grid.attributes,
    rows: grid.rows,
    columns: grid.columns,
    cells,
    total,
  };
}
