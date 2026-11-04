/**
 * Translated metadata (RFC 0023 §3.1): modules ship dictionaries keyed by the English text (`i18n: { bn: () =>
 * import('./i18n/bn.js') }`, each `export const bn = { 'Customer': 'গ্রাহক', … }`). The server merges every installed
 * module's dictionaries at start and translates what it serves to the request's language (`Accept-Language`): the
 * labels, help, descriptions, titles and options of views, menus, actions, apps, model metadata, searches, overviews
 * and settings, and the message of a problem. English stays the key, so code never changes; a string without a
 * translation is served in English.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';

/** language → English text → translation. */
export type Dictionaries = ReadonlyMap<string, ReadonlyMap<string, string>>;

/** The keys whose string values people read (as `pnpm i18n:extract` collects them). */
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
  'name',
]);

/** Merges the modules' dictionaries (`i18n` loaders) per language; a module's own entries never lose to an empty one. */
export async function loadDictionaries(
  modules: readonly { readonly i18n?: Readonly<Record<string, () => Promise<unknown>>> }[],
): Promise<Dictionaries> {
  const out = new Map<string, Map<string, string>>();
  for (const m of modules)
    for (const [lang, load] of Object.entries(m.i18n ?? {})) {
      const loaded = (await load()) as Record<string, unknown> | undefined;
      const dict = (loaded?.[lang] ?? loaded?.['default'] ?? loaded) as Record<string, unknown>;
      const target = out.get(lang) ?? new Map<string, string>();
      for (const [source, text] of Object.entries(dict ?? {}))
        if (typeof text === 'string' && text !== '' && !target.has(source))
          target.set(source, text);
      out.set(lang, target);
    }
  return out;
}

/** The dictionary of a Shutro language code (`bn_BD`, then `bn`), or none for English. */
export function dictionaryFor(
  dictionaries: Dictionaries,
  lang: string | null,
): ReadonlyMap<string, string> | null {
  if (lang === null || lang === '' || lang.startsWith('en')) return null;
  return dictionaries.get(lang) ?? dictionaries.get(lang.split(/[_-]/)[0] ?? '') ?? null;
}

/** A model name (`sale.order`): what keys a served view's `fields` map by. */
const MODEL = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;

/**
 * A copy of `value` with the people-facing strings translated (and `[value, label]` options' labels). A field's own
 * label may have a context key, `<model>.<field>` (`res.partner.state` → রাজ্য where "State" is a region), looked up
 * before the English text: in a served view's `fields` (model → field → description) and a model's metadata.
 */
export function translateValue(
  value: unknown,
  dict: ReadonlyMap<string, string>,
  key?: string,
  field?: string,
): unknown {
  if (typeof value === 'string') {
    if (key === undefined || !TEXT_KEYS.has(key)) return value;
    return (
      (key === 'label' && field !== undefined ? dict.get(field) : undefined) ??
      dict.get(value) ??
      value
    );
  }
  if (Array.isArray(value)) {
    // A selection's options: [value, label] pairs.
    if (
      key === 'options' &&
      value.every((o) => Array.isArray(o) && o.length === 2 && typeof o[1] === 'string')
    )
      return value.map((o) => [o[0], dict.get(o[1] as string) ?? o[1]]);
    return value.map((v) => translateValue(v, dict, key === 'options' ? undefined : key));
  }
  if (value !== null && typeof value === 'object') {
    if (value instanceof Date) return value;
    const o = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    // A model's metadata: `{ name: 'res.partner', fields: [{ key, label, … }] }`.
    const model = typeof o['name'] === 'string' && MODEL.test(o['name']) ? o['name'] : null;
    for (const [k, v] of Object.entries(o)) {
      if (k === 'fields' && v !== null && typeof v === 'object' && !Array.isArray(v)) {
        // A served view's fields: model → field → description.
        const byModel: Record<string, unknown> = {};
        for (const [m, fields] of Object.entries(v as Record<string, unknown>)) {
          if (!MODEL.test(m) || fields === null || typeof fields !== 'object') {
            byModel[m] = translateValue(fields, dict, m);
            continue;
          }
          const translated: Record<string, unknown> = {};
          for (const [f, d] of Object.entries(fields as Record<string, unknown>))
            translated[f] = translateValue(d, dict, f, `${m}.${f}`);
          byModel[m] = translated;
        }
        out[k] = byModel;
      } else if (k === 'fields' && Array.isArray(v) && model !== null)
        out[k] = v.map((d) =>
          d !== null &&
          typeof d === 'object' &&
          typeof (d as Record<string, unknown>)['key'] === 'string'
            ? translateValue(
                d,
                dict,
                undefined,
                `${model}.${String((d as Record<string, unknown>)['key'])}`,
              )
            : translateValue(d, dict, k),
        );
      else out[k] = translateValue(v, dict, k, k === 'label' ? field : undefined);
    }
    return out;
  }
  return value;
}

/** A problem's detail with the known messages in it translated (`project.project: A project …`). */
export function translateDetail(detail: string, dict: ReadonlyMap<string, string>): string {
  let out = detail;
  for (const [source, text] of dict)
    if (source.length >= 12 && out.includes(source)) out = out.split(source).join(text);
  return out;
}

/** The routes that serve metadata, translated as a whole. */
const METADATA = [
  '/api/v1/apps',
  '/api/v1/menus',
  '/api/v1/actions/',
  '/api/v1/views',
  '/api/v1/search/',
  '/api/v1/meta/',
  '/api/v1/reports/overview',
  '/api/v1/settings/',
  '/api/v1/models/', // only `/next` (transitions and their messages), below
];

/** `bn-BD,bn;q=0.9` → `bn_BD`. */
function languageOf(request: FastifyRequest): string | null {
  const header = request.headers['accept-language'];
  const first = (Array.isArray(header) ? header[0] : header)?.split(',')[0]?.split(';')[0]?.trim();
  return first === undefined || first === '' ? null : first.replace('-', '_');
}

/** Translates metadata responses and problems to the request's language. */
export function registerTranslation(app: FastifyInstance, dictionaries: Dictionaries): void {
  if (dictionaries.size === 0) return;
  app.addHook('preSerialization', async (request, reply, payload) => {
    const dict = dictionaryFor(dictionaries, languageOf(request));
    if (dict === null || payload === null || typeof payload !== 'object') return payload;
    const url = request.url.split('?')[0] ?? '';
    if (reply.statusCode >= 400) {
      const p = payload as Record<string, unknown>;
      return typeof p['detail'] === 'string'
        ? { ...p, detail: translateDetail(p['detail'], dict) }
        : payload;
    }
    const metadata =
      request.method === 'GET' &&
      METADATA.some((prefix) => url.startsWith(prefix)) &&
      (!url.startsWith('/api/v1/models/') || url.endsWith('/next'));
    return metadata ? translateValue(payload, dict) : payload;
  });
}
