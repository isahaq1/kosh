/**
 * Duplicate (RFC 0023 R1, §3.2): a copy of a record made **as the user** (ACL, record rules and field groups decide)
 * from the model's metadata — Shutro has no `copy()` yet (docs/shutro-requests.md #32):
 * - stored, writable fields are copied; many2one kept, many2many as the same set;
 * - states, sequences and computed fields start again (they are read-only, so not copied);
 * - a field in a unique constraint (beside the company) is left out, or for a required text gets " (copy)";
 * - one2many lines are copied with the record, each line by the same rules, without the link back.
 */
import type { Env } from '../orm.js';
import type { ApiField, ApiModel } from './metadata.js';

type Row = Record<string, unknown>;
type Records = {
  readonly length: number;
  load(spec: unknown): Promise<Records>;
  read(keys: readonly string[]): Row[];
};
const ref = (env: Env, name: string) =>
  env.model(name as never) as unknown as {
    browse(ids: readonly number[]): Records;
    create(rows: readonly Row[]): Promise<{ readonly ids: readonly number[] }>;
  };

/** Whether a field's value is copied as such. */
const copied = (env: Env, model: ApiModel, f: ApiField): boolean =>
  f.stored &&
  !f.readonly &&
  f.kind !== 'one2many' &&
  f.kind !== 'binary' &&
  env.access.canField(model.name as never, f.key, 'read') &&
  env.access.canField(model.name as never, f.key, 'write');

/** The fields of the model's unique constraints, the company aside. */
const uniqueKeys = (model: ApiModel): Set<string> =>
  new Set(model.unique.flat().filter((k) => k !== 'company'));

async function valuesOf(
  env: Env,
  model: ApiModel,
  id: number,
  skip: string | null,
  rename: boolean,
): Promise<Row> {
  const fields = model.fields.filter((f) => copied(env, model, f) && f.key !== skip);
  const scalar = fields.filter((f) => f.kind !== 'many2many').map((f) => f.key);
  const sets = fields.filter((f) => f.kind === 'many2many').map((f) => f.key);
  let loaded = await ref(env, model.name)
    .browse([id])
    .load(['id', ...scalar]);
  if (sets.length > 0) loaded = await loaded.load(Object.fromEntries(sets.map((k) => [k, true])));
  const [row] = loaded.read(['id', ...fields.map((f) => f.key)]);
  if (row === undefined) return {};
  const unique = uniqueKeys(model);
  const out: Row = {};
  for (const f of fields) {
    const value = row[f.key];
    if (value === null || value === undefined) continue;
    if (unique.has(f.key)) {
      if (
        rename &&
        f.required &&
        (f.kind === 'char' || f.kind === 'text') &&
        typeof value === 'string'
      )
        out[f.key] = `${value} (copy)`;
      continue;
    }
    if (f.kind === 'many2one')
      out[f.key] = typeof value === 'object' ? (value as { id?: unknown }).id : value;
    else if (f.kind === 'many2many')
      out[f.key] = {
        set: (value as unknown[]).map((v) =>
          typeof v === 'object' && v !== null ? (v as { id?: unknown }).id : v,
        ),
      };
    else out[f.key] = value;
  }
  return out;
}

/** The record's copy (as the API takes values), with its lines. */
export async function duplicateValues(
  env: Env,
  models: ReadonlyMap<string, ApiModel>,
  model: ApiModel,
  id: number,
): Promise<Row> {
  const values = await valuesOf(env, model, id, null, true);
  for (const f of model.fields) {
    if (f.kind !== 'one2many' || f.readonly || f.target === null) continue;
    if (!env.access.canField(model.name as never, f.key, 'write')) continue;
    const lines = models.get(f.target);
    if (lines === undefined || !env.access.can(f.target as never, 'create')) continue;
    // The lines' link back: their many2one to this model that is required.
    const back = lines.fields.find(
      (x) => x.kind === 'many2one' && x.target === model.name && x.required,
    );
    if (back === undefined) continue;
    const [parent] = (
      await ref(env, model.name)
        .browse([id])
        .load({ [f.key]: true })
    ).read([f.key]);
    const lineIds = ((parent?.[f.key] as unknown[] | undefined) ?? []).map((v) =>
      typeof v === 'object' && v !== null ? Number((v as { id?: unknown }).id) : Number(v),
    );
    if (lineIds.length === 0) continue;
    const create: Row[] = [];
    for (const lineId of lineIds) create.push(await valuesOf(env, lines, lineId, back.key, false));
    values[f.key] = { create };
  }
  return values;
}
