/**
 * Duplicates and merging (RFC 0036 §2.3). A module declares how its records may be duplicates of one another
 * (`duplicates` in its manifest: the fields that, equal once normalized, suggest it); {@link findDuplicates} lists
 * the groups for a person to review, and {@link mergeRecords} merges the ones they choose:
 *
 * - every link to a duplicate is moved to the record kept — found from the installed models' own relations (each
 *   many-to-one to the model) and from records that refer by model and id (chatter, followers, activities,
 *   attachments), never from a hand-kept list;
 * - the duplicate is archived, never deleted;
 * - through the ORM, as the system: each move is audited and every constraint still applies, so a link that may not
 *   be changed (a posted entry's partner) refuses the merge, with the reason, and nothing is kept;
 * - what was moved is logged (`kosh.merge`), so {@link undoMerge} puts every link back and restores the duplicate,
 *   for {@link MERGE_UNDO_DAYS} days.
 */
import type { DuplicateSpec } from '@kosh/modules-sdk';
import type { ApiModel } from './api/metadata.js';
import { HttpProblem, problemOf } from './errors.js';
import type { Env } from './orm.js';

export const MERGE_UNDO_DAYS = 7;

type Row = Record<string, unknown>;
type Recs = {
  readonly ids: readonly number[];
  readonly length: number;
  load(keys: readonly string[]): Promise<Recs>;
  read(keys: readonly string[]): Row[];
  write(values: Row): Promise<void>;
};
interface Loose {
  search(q: unknown): Promise<Recs>;
  browse(ids: readonly number[]): Recs;
  create(values: unknown): Promise<Recs>;
}
const model = (env: Env, name: string): Loose => env.model(name as never) as unknown as Loose;
/** Archived records too: a link from an archived record is still a link. */
const everything = (env: Env): Env =>
  (env as unknown as { withFlags(flags: { activeTest: boolean }): Env }).withFlags({
    activeTest: false,
  });

export interface DuplicateGroup {
  readonly model: string;
  /** What they share: "Email". */
  readonly key: string;
  /** The shared value, as it was normalized. */
  readonly value: string;
  readonly records: readonly { readonly id: number; readonly name: string }[];
}

const normalized = (value: unknown, digits: boolean): string => {
  const text =
    typeof value === 'object' && value !== null
      ? String(Object.values(value as Row)[0] ?? '')
      : String(value ?? '');
  if (digits) {
    const only = text.replace(/[^0-9]/g, '');
    // A few digits are an extension or a mistake, not a number to match on.
    return only.length < 6 ? '' : only;
  }
  return text.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
};

/** The groups of active records of a model that share a declared key (as the caller: their rules apply). */
export async function findDuplicates(
  env: Env,
  models: ReadonlyMap<string, ApiModel>,
  spec: DuplicateSpec,
  limit = 200,
): Promise<DuplicateGroup[]> {
  const meta = models.get(spec.model);
  if (meta === undefined) return [];
  const keys = spec.keys.filter((k) => k.fields.every((f) => meta.byKey.get(f)?.stored === true));
  const name = meta.recName ?? 'id';
  const wanted = [...new Set([name, ...keys.flatMap((k) => k.fields)])].filter((f) => f !== 'id');
  const rows = (
    await (await model(env, spec.model).search({ where: {}, limit: 100_000 })).load(wanted)
  ).read(['id', ...wanted]);
  const groups: DuplicateGroup[] = [];
  for (const key of keys) {
    const by = new Map<string, Row[]>();
    for (const row of rows) {
      const parts = key.fields.map((f) => normalized(row[f], key.digits === true));
      if (parts.some((p) => p === '')) continue;
      const value = parts.join(' · ');
      by.set(value, [...(by.get(value) ?? []), row]);
    }
    for (const [value, same] of by) {
      if (same.length < 2) continue;
      groups.push({
        model: spec.model,
        key: key.label,
        value,
        records: same.map((r) => ({
          id: r['id'] as number,
          name: normalized(r[name], false) === '' ? `#${r['id']}` : String(nameOf(r[name])),
        })),
      });
      if (groups.length >= limit) return groups;
    }
  }
  return groups;
}
const nameOf = (value: unknown): unknown =>
  typeof value === 'object' && value !== null ? Object.values(value as Row)[0] : value;

/** A link that was moved: these records' `field` pointed at `from`. */
interface Moved {
  readonly model: string;
  readonly field: string;
  readonly from: number;
  readonly ids: readonly number[];
}

export interface MergeResult {
  readonly id: number;
  readonly model: string;
  readonly keep: number;
  readonly merged: readonly number[];
  /** Links moved to the record kept, by model. */
  readonly moved: Readonly<Record<string, number>>;
}

const refuse = (detail: string, hint?: string): never => {
  throw new HttpProblem(409, 'merge-refused', 'Cannot be merged', detail, hint);
};

/**
 * Merges `merge` into `keep`. Call it in an audited system scope (`env.asSuperuser`): the moves need rights no
 * single app's manager has. Everything happens in the caller's transaction: a refusal leaves nothing behind.
 */
export async function mergeRecords(
  su: Env,
  models: ReadonlyMap<string, ApiModel>,
  input: {
    readonly model: string;
    readonly keep: number;
    readonly merge: readonly number[];
    readonly user: number;
  },
): Promise<MergeResult> {
  const meta = models.get(input.model);
  if (meta === undefined)
    throw new HttpProblem(404, 'unknown-model', 'Unknown model', `No model ${input.model}.`);
  const merge = [...new Set(input.merge)].filter((id) => id !== input.keep);
  if (merge.length === 0)
    refuse('Choose the record to keep and at least one other to merge into it.');
  if (!meta.byKey.has('active'))
    refuse(
      `${meta.label} cannot be archived, so its duplicates cannot be merged away.`,
      'Only archivable records are merged: the duplicate is archived, never deleted.',
    );
  const all = everything(su);
  const present = await model(all, input.model).search({
    where: { id: { in: [input.keep, ...merge] } },
  });
  if (present.length !== merge.length + 1)
    refuse('One of the records does not exist (any more).', 'Look for the duplicates again.');

  const moved: Moved[] = [];
  const move = async (
    name: string,
    field: string,
    where: (from: number) => Row,
    label: string,
  ): Promise<void> => {
    for (const from of merge) {
      const found = await model(all, name).search({ where: where(from), limit: 100_000 });
      if (found.length === 0) continue;
      try {
        await su.transaction(async (tx) => {
          await model(everything(tx), name)
            .browse(found.ids)
            .write({ [field]: input.keep });
          await tx.flush();
        });
        moved.push({ model: name, field, from, ids: [...found.ids] });
      } catch (error) {
        if (field !== 'resId') {
          const p = problemOf(error);
          refuse(
            `${found.length} ${label} cannot be moved to the record kept: ${p.status >= 500 && error instanceof Error ? error.message : p.detail}`,
            'Records that may no longer be changed (posted entries) keep their link: archive the duplicate instead of merging it.',
          );
        }
        // Chatter, followers and attachments: one at a time, leaving what the record kept already has (it
        // follows itself once).
        const kept: number[] = [];
        for (const id of found.ids)
          try {
            await su.transaction(async (tx) => {
              await model(everything(tx), name).browse([id]).write({ resId: input.keep });
              await tx.flush();
            });
            kept.push(id);
          } catch {
            // stays with the archived duplicate
          }
        if (kept.length > 0) moved.push({ model: name, field, from, ids: kept });
      }
    }
  };

  for (const other of models.values()) {
    if (other.name === 'kosh.merge') continue;
    // Each stored many-to-one to the model.
    for (const f of other.fields)
      if (f.stored && f.kind === 'many2one' && f.target === input.model && !f.readonly)
        await move(other.name, f.key, (from) => ({ [f.key]: from }), `${other.label} (${f.label})`);
    // Records that refer by model and id: the chatter, followers, activities, attachments.
    if (other.byKey.get('resModel')?.stored === true && other.byKey.get('resId')?.stored === true)
      await move(
        other.name,
        'resId',
        (from) => ({ resModel: input.model, resId: from }),
        other.label,
      );
  }

  await model(all, input.model).browse(merge).write({ active: false });
  const log = await model(su, 'kosh.merge').create([
    { resModel: input.model, keep: input.keep, merged: merge, moved, user: input.user },
  ]);
  await su.flush();
  const counts: Record<string, number> = {};
  for (const m of moved) counts[m.model] = (counts[m.model] ?? 0) + m.ids.length;
  return {
    id: log.ids[0] as number,
    model: input.model,
    keep: input.keep,
    merged: merge,
    moved: counts,
  };
}

export interface MergeLog {
  readonly id: number;
  readonly model: string;
  readonly keep: number;
  readonly merged: readonly number[];
  readonly links: number;
  readonly user: number | null;
  readonly at: string;
  readonly undoneAt: string | null;
  /** Still within {@link MERGE_UNDO_DAYS} days, and not undone. */
  readonly canUndo: boolean;
}

const KEYS = ['resModel', 'keep', 'merged', 'moved', 'user', 'undoneAt', 'createdAt'];
const iso = (v: unknown): string | null =>
  v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v);
const logOf = (row: Row, now: Date): MergeLog => {
  const at = iso(row['createdAt']) ?? now.toISOString();
  const undoneAt = iso(row['undoneAt']);
  const user = row['user'];
  return {
    id: row['id'] as number,
    model: String(row['resModel']),
    keep: Number(row['keep']),
    merged: (row['merged'] as number[] | null) ?? [],
    links: ((row['moved'] as Moved[] | null) ?? []).reduce((n, m) => n + m.ids.length, 0),
    user:
      typeof user === 'number'
        ? user
        : typeof user === 'object' && user !== null
          ? Number((user as { id: unknown }).id)
          : null,
    at,
    undoneAt,
    canUndo:
      undoneAt === null &&
      now.getTime() - new Date(at).getTime() < MERGE_UNDO_DAYS * 24 * 60 * 60 * 1000,
  };
};

/** The latest merges, newest first. */
export async function listMerges(su: Env, limit = 50): Promise<MergeLog[]> {
  const rows = (
    await (
      await model(su, 'kosh.merge').search({ where: {}, order: ['id desc'], limit })
    ).load(KEYS)
  ).read(['id', ...KEYS]);
  const now = su.now();
  return rows.map((r) => logOf(r, now));
}

/** Undoes a merge: every link moved is put back (when it still points at the record kept), the duplicate restored. */
export async function undoMerge(su: Env, id: number, user: number): Promise<MergeLog> {
  const found = await model(su, 'kosh.merge').search({ where: { id }, limit: 1 });
  const [row] = (await found.load(KEYS)).read(['id', ...KEYS]);
  if (row === undefined)
    throw new HttpProblem(404, 'unknown-merge', 'Unknown merge', `There is no merge ${id}.`);
  const log = logOf(row, su.now());
  if (log.undoneAt !== null) refuse('This merge was undone already.');
  if (!log.canUndo)
    refuse(
      `A merge is undone within ${MERGE_UNDO_DAYS} days.`,
      'Restore the archived duplicate by hand and move what belongs to it.',
    );
  const all = everything(su);
  for (const m of (row['moved'] as Moved[] | null) ?? []) {
    // Only what still points at the record kept: what a person moved since stays where they put it.
    const still = await model(all, m.model).search({
      where: { id: { in: [...m.ids] }, [m.field]: log.keep },
      limit: 100_000,
    });
    if (still.length > 0)
      await model(all, m.model)
        .browse(still.ids)
        .write({ [m.field]: m.from });
  }
  await model(all, log.model).browse(log.merged).write({ active: true });
  await found.write({ undoneAt: su.now(), undoneBy: user });
  await su.flush();
  return { ...log, undoneAt: su.now().toISOString(), canUndo: false };
}
