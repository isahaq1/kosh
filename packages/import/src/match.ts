/**
 * Relation cells to record ids (RFC 0014 §5.1 step 3), read as the user: an external id (`contacts.partner_acme`),
 * then a field the target keeps unique (a code, an email), then its display name — exactly, ignoring case, then as
 * the one record whose name contains the text. Several matches are an error, never a guess.
 */
import { type Env, orm } from '@kosh/server/orm';

interface Rows {
  readonly ids: readonly number[];
  readonly length: number;
}
interface Ref {
  search(q: unknown): Promise<Rows>;
}
const ref = (env: Env, name: string): Ref => env.model(name as never) as unknown as Ref;

/** How the records of a target model are found from text. */
export interface MatchTarget {
  readonly model: string;
  /** The field the display name comes from. */
  readonly recName: string;
  /** Stored char fields with a unique constraint of their own (besides the company). */
  readonly keys: readonly string[];
}

export type Match =
  | { readonly id: number; readonly by: 'id' | 'external-id' | 'key' | 'name' }
  | { readonly error: 'not-found' | 'ambiguous' };

const EXTERNAL_ID = /^[a-z0-9_]+\.[a-z0-9_.-]+$/i;

const escapeLike = (text: string) => text.replace(/[%_\\]/g, (m) => `\\${m}`);

/** The record `text` names in `target`, as the user sees it. */
export async function matchOne(env: Env, target: MatchTarget, text: string): Promise<Match> {
  const model = ref(env, target.model);
  if (/^#\d+$/.test(text)) {
    // `#42`: a record id, as an export with ids writes it.
    const found = await model.search({ where: { id: Number(text.slice(1)) }, limit: 1 });
    return found.length === 1 ? { id: found.ids[0] as number, by: 'id' } : { error: 'not-found' };
  }
  if (EXTERNAL_ID.test(text)) {
    try {
      const id = Number(await env.refId(target.model as never, text));
      const found = await model.search({ where: { id }, limit: 1 });
      if (found.length === 1) return { id, by: 'external-id' };
    } catch (error) {
      if (!(error instanceof orm.ShutroError)) throw error; // an unknown id: try the other ways
    }
  }
  for (const key of target.keys) {
    const found = await model.search({ where: { [key]: text }, limit: 2 });
    if (found.length === 1) return { id: found.ids[0] as number, by: 'key' };
    if (found.length > 1) return { error: 'ambiguous' };
  }
  const exact = await model.search({
    where: { [target.recName]: { ilike: escapeLike(text) } },
    limit: 2,
  });
  if (exact.length === 1) return { id: exact.ids[0] as number, by: 'name' };
  if (exact.length > 1) return { error: 'ambiguous' };
  const partial = await model.search({
    where: { [target.recName]: { ilike: `%${escapeLike(text)}%` } },
    limit: 2,
  });
  if (partial.length === 1) return { id: partial.ids[0] as number, by: 'name' };
  return { error: partial.length > 1 ? 'ambiguous' : 'not-found' };
}

/** Each distinct text once (a file names the same customer on many rows). */
export async function matchAll(
  env: Env,
  target: MatchTarget,
  texts: Iterable<string>,
): Promise<Map<string, Match>> {
  const out = new Map<string, Match>();
  for (const text of texts) if (!out.has(text)) out.set(text, await matchOne(env, target, text));
  return out;
}
