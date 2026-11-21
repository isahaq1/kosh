/**
 * Variant stock by family (RFC 0030 §3.4), without a database: the rows of a template's variants fold into one,
 * every figure added; what is nobody's variant stays as it is.
 */
import { orm } from '@kosh/server/orm';
import { expect, test } from 'vitest';
import { type Family, foldLedger, foldStock } from '../src/families.js';
import { IN_TYPES, type LedgerRow, OUT_TYPES, type StockRow } from '../src/ledger.js';

const d = (n: number) => orm.toDecimal(n);
const families = new Map<number, Family>([
  [1, { id: 10, name: 'T-shirt' }],
  [2, { id: 10, name: 'T-shirt' }],
  [3, { id: 11, name: 'Cap' }],
]);
const stock = (
  product: number,
  name: string,
  location: number,
  onHand: number,
  reserved = 0,
): StockRow => ({
  product: { id: product, name, uom: 'pc' },
  location: { id: location, name: `Loc ${location}` },
  onHand: d(onHand),
  reserved: d(reserved),
  available: d(onHand - reserved),
  incoming: d(1),
  outgoing: d(0),
});

test('the stock report by family: variants at a location are one row; other products stay', () => {
  const folded = foldStock(
    [
      stock(1, 'T-shirt (S)', 1, 5, 1),
      stock(2, 'T-shirt (M)', 1, 4),
      stock(2, 'T-shirt (M)', 2, 3),
      stock(3, 'Cap (Red)', 1, 2),
      stock(9, 'Steel beam', 1, 7),
    ],
    families,
  );
  expect(
    folded.map((r) => [
      r.product.name,
      r.product.family ?? null,
      r.product.variants ?? null,
      r.location.id,
      r.onHand.toNumber(),
      r.reserved.toNumber(),
      r.available.toNumber(),
      r.incoming.toNumber(),
    ]),
  ).toEqual([
    ['Cap', 11, 1, 1, 2, 0, 2, 1],
    ['Steel beam', null, null, 1, 7, 0, 7, 1],
    ['T-shirt', 10, 2, 1, 9, 1, 8, 2],
    ['T-shirt', 10, 1, 2, 3, 0, 3, 1],
  ]);
  // A family's row is not a product: its id says so.
  expect(
    folded.filter((r) => r.product.family !== undefined).every((r) => r.product.id === 0),
  ).toBe(true);
  expect(foldStock([], families)).toEqual([]);
});

test('the ledger by family: every figure of the variants added, quantities and values', () => {
  const figure = (qty: number, value = qty * 10) => ({ qty: d(qty), value: d(value) });
  const row = (
    product: number,
    name: string,
    opening: number,
    received: number,
    sold: number,
  ): LedgerRow => ({
    product: { id: product, name, uom: 'pc' },
    opening: figure(opening),
    in: Object.fromEntries(
      IN_TYPES.map((t) => [t, figure(t === 'purchase_receipt' ? received : 0)]),
    ) as LedgerRow['in'],
    out: Object.fromEntries(
      OUT_TYPES.map((t) => [t, figure(t === 'sales_delivery' ? sold : 0)]),
    ) as LedgerRow['out'],
    totalIn: figure(received),
    totalOut: figure(sold),
    closing: figure(opening + received - sold),
  });
  const folded = foldLedger(
    [row(1, 'T-shirt (S)', 2, 5, 1), row(2, 'T-shirt (M)', 0, 4, 3), row(9, 'Steel beam', 1, 0, 0)],
    families,
  );
  expect(folded.map((r) => r.product.name)).toEqual(['Steel beam', 'T-shirt']);
  const shirt = folded[1] as LedgerRow;
  expect(shirt.product).toMatchObject({ family: 10, variants: 2 });
  expect([
    shirt.opening.qty.toNumber(),
    shirt.in.purchase_receipt.qty.toNumber(),
    shirt.out.sales_delivery.qty.toNumber(),
    shirt.totalIn.value.toNumber(),
    shirt.closing.qty.toNumber(),
    shirt.closing.value.toNumber(),
  ]).toEqual([2, 9, 4, 90, 7, 70]);
  // The other types stay nothing, not undefined.
  expect(shirt.in.transfer_in.qty.toNumber()).toBe(0);
});
