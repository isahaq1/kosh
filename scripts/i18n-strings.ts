/**
 * The strings a module serves to people (RFC 0023 §3.1), shared by `pnpm i18n:extract` (which writes the
 * dictionaries) and `check-modules` (whose T1 counts what is missing).
 */
import { existsSync, readFileSync } from 'node:fs';

export type M = Record<string, unknown>;

/** Shutro's `humanize` (`amountTotal` → `Amount Total`): the label a field without one is served with. */
export function humanize(name: string): string {
  return name
    .replace(/[._]/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(' ')
    .filter((w) => w !== '')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** A string a person reads (not an id, a path or a code). */
export const readable = (s: unknown): s is string =>
  typeof s === 'string' &&
  s.trim() !== '' &&
  /[A-Za-z]/.test(s.replace(/\{\{[^}]*\}\}/g, '')) && // not only placeholders (`{{name}}`)
  !/^[a-z0-9_]+(\.[a-z0-9_]+)+$/.test(s) && // `projects.action_tasks`
  !/^[a-z][a-zA-Z0-9]*$/.test(s) && // `amountTotal`
  !/^https?:/.test(s);

/** The keys whose string values are shown to people, wherever they sit in a manifest. */
const TEXT_KEYS = new Set([
  'label',
  'description',
  'help',
  'title',
  'summary',
  'confirm',
  'message',
  'placeholder',
  'category',
  'text',
  'header',
  'footer',
  'successMessage',
]);

export function manifestStrings(m: M): Set<string> {
  const out = new Set<string>();
  const walk = (value: unknown, parentKey: string | null, parent: M | null): void => {
    if (typeof value === 'function' || value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const v of value) walk(v, parentKey, parent);
      return;
    }
    if (typeof value === 'object') {
      const o = value as M;
      for (const [k, v] of Object.entries(o)) {
        if (k === 'shutro' || k === 'depends' || k === 'bridge' || k === 'hooks' || k === 'i18n')
          continue;
        // A print template's or an approval policy's (or level's) name is shown to people.
        if (k === 'name' && ('layout' in o || 'levels' in o || 'approverRole' in o) && readable(v))
          out.add(v);
        else if (TEXT_KEYS.has(k) && readable(v)) out.add(v);
        else walk(v, k, o);
      }
    }
  };
  walk(m, null, null);
  return out;
}

export function modelStrings(shutro: M | undefined): Set<string> {
  const out = new Set<string>();
  const add = (s: unknown) => {
    if (readable(s)) out.add(s);
  };
  const fieldsOf = (x: M) => Object.entries((x['fields'] as Record<string, M> | undefined) ?? {});
  for (const model of [
    ...((shutro?.['models'] as M[] | undefined) ?? []),
    ...((shutro?.['extensions'] as M[] | undefined) ?? []),
  ]) {
    if ('label' in model) add(model['label']);
    else if ((shutro?.['models'] as M[] | undefined)?.includes(model))
      add(humanize(model['name'] as string));
    for (const [key, d] of fieldsOf(model)) {
      add(typeof d['label'] === 'string' ? d['label'] : humanize(key));
      add(d['help']);
      const selection = d['selection'];
      if (Array.isArray(selection)) for (const s of selection) add((s as unknown[])[1]);
      else if (selection !== null && typeof selection === 'object')
        for (const v of Object.values(selection as M)) add(v);
      if (d['kind'] === 'state') {
        for (const s of Object.values((d['states'] as M | undefined) ?? {}))
          add(typeof s === 'string' ? s : (s as M)?.['label']);
        for (const t of Object.values((d['transitions'] as Record<string, M> | undefined) ?? {}))
          add(t['message']);
      }
    }
    for (const c of Object.values((model['constraints'] as Record<string, M> | undefined) ?? {}))
      add(c['message']);
    for (const c of Object.values((model['sqlConstraints'] as Record<string, M> | undefined) ?? {}))
      add(c['message']);
  }
  for (const g of (shutro?.['groups'] as M[] | undefined) ?? []) add(g['label']);
  return out;
}

/** Reads a module's `src/i18n/bn.ts` (`export const bn = { 'Source': 'অনুবাদ', … }`) without importing it. */
export function readDictionary(file: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(file)) return out;
  const text = readFileSync(file, 'utf8');
  // Keys are quoted, or bare identifiers once formatted (`Active: 'সক্রিয়'`).
  const pattern =
    /^\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|[A-Za-z_$][\w$]*):\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"),?\s*$/gm;
  const unquote = (t: string): string => {
    if (!(t.startsWith("'") || t.startsWith('"'))) return t;
    const inner = t.slice(1, -1);
    return inner.replace(/\\(.)/g, '$1');
  };
  for (const m of text.matchAll(pattern)) out.set(unquote(m[1] as string), unquote(m[2] as string));
  return out;
}
