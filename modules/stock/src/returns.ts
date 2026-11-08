/**
 * Returns (RFC 0030 §3.2). A done delivery or receipt can be returned, in part: each line up to what was done and
 * not returned yet (returns in progress count), with a reason. The return is a transfer of the other way — a
 * customer's goods back in, goods back to the vendor —, linked to the original (`returnOf`) and line by line, with
 * the original's links carried (an order's, through `backorderValues`), and lots taken back from the original's.
 * It is confirmed, and validated like any transfer; `stock_account` values it at the original cost.
 */
import { HttpProblem } from '@kosh/server';
import { type Decimal, orm } from '@kosh/server/orm';
import { defineModel, type Env, f } from './.kosh/bindings.js';

const ALL = ['read', 'write', 'create', 'unlink', 'export', 'import'] as const;
const zero = orm.toDecimal('0');

/** Why goods come back: reported by product and partner. */
export const StockReturnReason = defineModel('stock.return.reason', {
  label: 'Return reason',
  archivable: true,
  order: ['sequence asc', 'id asc'],
  access: { 'stock.user': ['read'], 'stock.manager': ALL },
  fields: {
    name: f.char({ required: true, translate: true, label: 'Reason' }),
    sequence: f.integer({ default: 10 }),
    code: f.char({ index: 'unique', label: 'Code' }),
  },
});

/** The reasons a database starts with. */
export const DEFAULT_RETURN_REASONS = [
  { code: 'damaged', en: 'Damaged', bn: 'ক্ষতিগ্রস্ত' },
  { code: 'wrong_item', en: 'Wrong item', bn: 'ভুল পণ্য' },
  { code: 'not_as_ordered', en: 'Not as ordered', bn: 'অর্ডার অনুযায়ী নয়' },
  { code: 'surplus', en: 'Surplus', bn: 'অতিরিক্ত' },
  { code: 'quality', en: 'Quality', bn: 'মানের সমস্যা' },
] as const;

export async function installReturnReasons(env: Env): Promise<number> {
  let made = 0;
  const model = env.withFlags({ activeTest: false }).model('stock.return.reason');
  for (const [i, r] of DEFAULT_RETURN_REASONS.entries()) {
    if ((await model.search({ where: { code: r.code } as never })).ids.length > 0) continue;
    await model.create([
      { code: r.code, name: { en_US: r.en, bn_BD: r.bn }, sequence: (i + 1) * 10 } as never,
    ]);
    made++;
  }
  return made;
}

/** What each line of a done transfer can still return. */
export interface Returnable {
  readonly move: number;
  readonly product: number;
  readonly name: string;
  readonly done: string;
  readonly returned: string;
  readonly returnable: string;
}

const OTHER_WAY: Readonly<Record<string, 'receipt' | 'delivery'>> = {
  delivery: 'receipt',
  receipt: 'delivery',
};

async function loadDone(env: Env, pickingId: number) {
  const [picking] = await env
    .model('stock.picking')
    .browse([pickingId as never])
    .load({
      moves: { product: true, returns: { picking: true } },
      source: true,
      destination: true,
    });
  if (picking === undefined)
    throw new HttpProblem(404, 'missing-record', 'Not found', 'No such transfer.');
  if (picking.state !== 'done')
    throw new HttpProblem(409, 'not-done', 'Not done', 'Only a done transfer can be returned.');
  if (OTHER_WAY[picking.kind] === undefined)
    throw new HttpProblem(
      409,
      'not-returnable',
      'Not returnable',
      'Deliveries and receipts are returned; other transfers are moved back by hand.',
    );
  return picking;
}

/** The lines of a done delivery or receipt with what is left to return (in the product's unit). */
export async function returnableLines(env: Env, pickingId: number): Promise<Returnable[]> {
  const picking = await loadDone(env, pickingId);
  return [...picking.moves].map((m) => {
    const done: Decimal = m.doneQty ?? zero;
    const returned = [...m.returns]
      .filter((r) => r.picking.state !== 'cancel')
      .reduce((s, r) => s.plus(r.quantity), zero);
    const left = done.minus(returned);
    return {
      move: m.id as number,
      product: m.product.id as number,
      name: String(m.name ?? m.product.name),
      done: done.toString(),
      returned: returned.toString(),
      returnable: (left.gt(0) ? left : zero).toString(),
    };
  });
}

/**
 * Makes and confirms the return of `lines` (move and quantity, in the product's unit) with a reason; `location`
 * receives it instead of where the goods came from (a damaged-goods location). Returns the new transfer.
 */
export async function createReturn(
  env: Env,
  pickingId: number,
  input: {
    readonly lines: readonly { readonly move: number; readonly quantity: string }[];
    readonly reason: number;
    readonly note?: string | null;
    readonly location?: number | null;
  },
): Promise<{ picking: number; name: string }> {
  const picking = await loadDone(env, pickingId);
  const left = new Map((await returnableLines(env, pickingId)).map((l) => [l.move, l]));
  const wanted = input.lines
    .map((l) => ({ move: l.move, quantity: orm.toDecimal(l.quantity || '0') }))
    .filter((l) => l.quantity.gt(0));
  if (wanted.length === 0)
    throw new HttpProblem(400, 'invalid-body', 'Nothing to return', 'Give a quantity to return.');
  for (const w of wanted) {
    const l = left.get(w.move);
    if (l === undefined)
      throw new HttpProblem(400, 'invalid-body', 'Unknown line', 'A line of this transfer.');
    if (w.quantity.gt(orm.toDecimal(l.returnable)))
      throw new HttpProblem(
        409,
        'too-much',
        'More than can be returned',
        `${l.name}: ${l.returnable} can still be returned.`,
      );
  }
  const [reason] = await env
    .model('stock.return.reason')
    .browse([input.reason as never])
    .load(['name']);
  if (reason === undefined)
    throw new HttpProblem(400, 'invalid-body', 'Reason required', 'Give the reason of the return.');

  // The original's links (an order's) carried, the way reversed.
  const base =
    (
      await env
        .model('stock.picking')
        .browse([pickingId as never])
        .backorderValues()
    ).get(pickingId) ?? {};
  const moveValues = await env
    .model('stock.move')
    .browse(wanted.map((w) => w.move) as never)
    .backorderValues();
  const made = await env.model('stock.picking').create([
    {
      ...base,
      kind: OTHER_WAY[picking.kind],
      source: picking.destination.id,
      destination: input.location ?? picking.source.id,
      origin: `Return of ${picking.name}`,
      scheduledDate: env.today(),
      next: null,
      returnOf: picking.id,
      returnReason: input.reason,
      ...(input.note == null || input.note.trim() === '' ? {} : { note: input.note.trim() }),
      moves: {
        create: wanted.map((w) => ({
          ...(moveValues.get(w.move) ?? {}),
          // In the product's unit: what was done is counted that way.
          uom: [...picking.moves].find((m) => m.id === w.move)?.product.uom?.id ?? null,
          quantity: w.quantity.toString(),
          returnOf: w.move,
        })),
      },
    } as never,
  ]);
  const id = made.ids[0] as number;
  // The lots taken back are the original's, as far as the quantities go.
  const lots = await (
    await env.model('stock.lot.line').search({ where: { picking: pickingId } as never })
  ).load({ product: true, lot: true });
  const rows: Record<string, unknown>[] = [];
  for (const w of wanted) {
    const product = [...picking.moves].find((m) => m.id === w.move)?.product.id;
    let rest = w.quantity;
    for (const l of lots) {
      if (rest.lte(0) || l.product.id !== product || l.lot === null) continue;
      const take = rest.lt(l.quantity) ? rest : l.quantity;
      rows.push({ picking: id, product, lot: l.lot.id, quantity: take.toString() });
      rest = rest.minus(take);
    }
  }
  if (rows.length > 0) await env.model('stock.lot.line').create(rows as never);
  await made.confirm();
  const [row] = await made.load(['name']);
  return { picking: id, name: String(row?.name ?? '') };
}
