/**
 * The variant grid (RFC 0030 §3.4, part 2): a template's variants laid out as rows × columns — the last attribute
 * across, the others down —, served to the order forms so quantities are typed into a size × colour matrix and
 * one line is added per variant. Combinations with no active variant (excluded, or not generated) are empty cells.
 */
import { HttpProblem, type ModuleContext } from '@kosh/server';
import type { Env } from './.kosh/bindings.js';

export interface GridVariant {
  readonly id: number;
  readonly name: string;
  readonly listPrice: string;
}

export interface Grid {
  readonly template: { readonly id: number; readonly name: string };
  /** The attributes, in the lines' order; the last one is the columns. */
  readonly attributes: readonly string[];
  /** One row per combination of the first attributes' values (`key`: their ids). */
  readonly rows: readonly { readonly key: string; readonly label: string }[];
  /** The last attribute's values; empty for a single attribute (then one column, `0`). */
  readonly columns: readonly { readonly id: number; readonly name: string }[];
  /** `${row.key}|${column.id}` → the variant, or `null` when the combination does not exist. */
  readonly cells: Readonly<Record<string, GridVariant | null>>;
}

type ValueRow = { id: number; name: string };

function combinations(lines: ValueRow[][]): ValueRow[][] {
  return lines.reduce<ValueRow[][]>(
    (acc, values) => acc.flatMap((combo) => values.map((v) => [...combo, v])),
    [[]],
  );
}

const keyOf = (ids: readonly number[]): string => [...ids].sort((a, b) => a - b).join(',');

/** The template's grid: rows of the first attributes' values, columns of the last, a variant in each cell. */
export async function templateGrid(env: Env, id: number): Promise<Grid> {
  const [t] = await env
    .model('product.template')
    .browse([id as never])
    .load({ lines: { attribute: true, values: true }, variants: { attributeValues: true } });
  if (t === undefined)
    throw new HttpProblem(
      404,
      'unknown-template',
      'Unknown template',
      `No product template ${id}.`,
    );
  const lines = [...t.lines]
    .sort(
      (a, b) =>
        a.sequence - b.sequence || a.attribute.sequence - b.attribute.sequence || a.id - b.id,
    )
    .map((l) => ({
      attribute: l.attribute.name,
      values: [...l.values]
        .filter((v) => v.active)
        .sort((a, b) => a.sequence - b.sequence || a.id - b.id)
        .map((v) => ({ id: v.id as number, name: v.name })),
    }))
    .filter((l) => l.values.length > 0);
  const byKey = new Map<string, GridVariant>();
  for (const v of t.variants)
    if (v.active)
      byKey.set(keyOf([...v.attributeValues].map((x) => x.id as number)), {
        id: v.id as number,
        name: v.name,
        listPrice: v.listPrice.toString(),
      });
  const down = lines.length >= 2 ? lines.slice(0, -1) : lines;
  const across = lines.length >= 2 ? (lines[lines.length - 1]?.values ?? []) : [];
  const rows = combinations(down.map((l) => l.values)).map((combo) => ({
    key: combo.map((v) => v.id).join(','),
    label: combo.map((v) => v.name).join(' / '),
  }));
  const cells: Record<string, GridVariant | null> = {};
  for (const row of rows) {
    const rowIds = row.key === '' ? [] : row.key.split(',').map(Number);
    if (across.length === 0) cells[`${row.key}|0`] = byKey.get(keyOf(rowIds)) ?? null;
    else
      for (const c of across)
        cells[`${row.key}|${c.id}`] = byKey.get(keyOf([...rowIds, c.id])) ?? null;
  }
  return {
    template: { id: t.id as number, name: t.name },
    attributes: lines.map((l) => l.attribute),
    rows,
    columns: across,
    cells,
  };
}

export function registerGridRoutes({ app }: ModuleContext): void {
  app.get('/api/v1/product/templates/:id/grid', async (request) => {
    const id = Number((request.params as { id?: unknown }).id);
    if (!Number.isSafeInteger(id) || id <= 0)
      throw new HttpProblem(
        400,
        'invalid-id',
        'Invalid id',
        'The template id must be a positive integer.',
      );
    return request.env((env) => templateGrid(env as never, id));
  });
}
