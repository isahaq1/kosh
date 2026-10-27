/**
 * Documents (RFC 0005 §5): a template is a **layout** (JSON blocks bound to fields and x2many lines, editable in the
 * designer), compiled to HTML with CSS paged media and printed to PDF by Playwright's Chromium. The record is read
 * as the caller (rules and field security), values are formatted for the document's language, and every render is
 * audited. Modules ship default templates in their manifests; administrators edit copies as data.
 */

import type { Env } from '@kosh/server/orm';
import type { Block, Layout } from '@kosh/views';
import { amountInWords } from './words.js';

export type { Block, Layout };

/** How values are shown: the document's formatter. */
export interface DocumentFormat {
  readonly locale: string;
  readonly tz: string;
}

type Row = Record<string, unknown>;

const esc = (text: unknown): string =>
  String(text ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );

/** Formats a value for print: Money, decimals, dates, booleans, related records (their display name). */
export function formatValue(
  value: unknown,
  kind: string | undefined,
  format: DocumentFormat,
): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? '✓' : '—';
  if (value instanceof Date)
    return new Intl.DateTimeFormat(format.locale, {
      dateStyle: 'medium',
      timeStyle: kind === 'date' ? undefined : 'short',
      timeZone: format.tz,
    }).format(value);
  if (typeof value === 'object') {
    const json =
      typeof (value as { toJSON?: unknown }).toJSON === 'function'
        ? (value as { toJSON(): unknown }).toJSON()
        : value;
    if (typeof json === 'object' && json !== null && 'amount' in json && 'currency' in json) {
      const { amount, currency } = json as { amount: string; currency: string };
      return `${decimal(amount, format.locale)} ${currency}`;
    }
    if (typeof json === 'object' && json !== null && 'displayName' in json)
      return String((json as { displayName: unknown }).displayName);
    return String(json);
  }
  if (kind === 'date' && typeof value === 'string')
    return new Intl.DateTimeFormat(format.locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(
      new Date(`${value.slice(0, 10)}T00:00:00Z`),
    );
  if (kind === 'datetime' && typeof value === 'string')
    return new Intl.DateTimeFormat(format.locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: format.tz,
    }).format(new Date(value));
  if (
    (kind === 'decimal' || kind === 'monetary' || kind === 'float') &&
    (typeof value === 'string' || typeof value === 'number')
  )
    return decimal(String(value), format.locale);
  if (typeof value === 'number') return new Intl.NumberFormat(format.locale).format(value);
  return String(value);
}

/** The number in a decimal string, a number or a Money-like value, else `null`. */
function numberOf(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : null;
  if (typeof value === 'object' && value !== null) {
    const json =
      typeof (value as { toJSON?: unknown }).toJSON === 'function'
        ? (value as { toJSON(): unknown }).toJSON()
        : value;
    if (typeof json === 'object' && json !== null && 'amount' in json)
      return Number((json as { amount: unknown }).amount);
  }
  return null;
}

function decimal(text: string, locale: string): string {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (m === null) return text;
  const [, sign, whole = '0', frac = ''] = m;
  const grouped = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(BigInt(whole));
  const sep =
    new Intl.NumberFormat(locale).formatToParts(1.5).find((p) => p.type === 'decimal')?.value ??
    '.';
  return `${sign}${grouped}${frac === '' ? '' : `${sep}${frac}`}`;
}

/** Field metadata for labels and kinds (model → key → { label, kind, target }). */
export type DocumentFields = ReadonlyMap<
  string,
  ReadonlyMap<
    string,
    {
      readonly label: string;
      readonly kind: string;
      readonly target: string | null;
      readonly options?: readonly (readonly [string, string])[] | null;
    }
  >
>;

/** The data a template renders: the record (with related records resolved to rows), its model, the company. */
export interface DocumentData {
  readonly model: string;
  readonly record: Row;
  /** For list documents: the records. */
  readonly records?: readonly Row[];
  readonly company: Row;
  readonly user: Row;
  readonly now: Date;
  readonly locale?: string;
  readonly tz?: string;
}

interface Resolved {
  readonly value: unknown;
  readonly kind: string | undefined;
  readonly label: string;
}

/** A selection value as its label. */
function optionLabel(
  value: unknown,
  options: readonly (readonly [string, string])[] | null | undefined,
): unknown {
  if (options === null || options === undefined || typeof value !== 'string') return value;
  return options.find(([v]) => v === value)?.[1] ?? value;
}

/** Follows a path on the record (`partner.name`, `company.currency.name`). Related records are preloaded rows. */
function resolve(data: DocumentData, fields: DocumentFields, path: string): Resolved {
  const parts = path.split('.');
  let current: unknown =
    parts[0] === 'company'
      ? data.company
      : parts[0] === 'user'
        ? data.user
        : parts[0] === 'now'
          ? data.now
          : data.record;
  let model: string | undefined =
    parts[0] === 'company' ? 'res.company' : parts[0] === 'user' ? 'res.users' : data.model;
  if (parts[0] === 'now') return { value: data.now, kind: 'datetime', label: 'Date' };
  if (parts[0] === 'company' || parts[0] === 'user') parts.shift();
  let kind: string | undefined;
  let label = path;
  let options: readonly (readonly [string, string])[] | null | undefined;
  for (const key of parts) {
    if (typeof current !== 'object' || current === null) return { value: null, kind, label };
    const info:
      | {
          readonly label: string;
          readonly kind: string;
          readonly target: string | null;
          readonly options?: readonly (readonly [string, string])[] | null;
        }
      | undefined = model === undefined ? undefined : fields.get(model)?.get(key);
    kind = info?.kind;
    options = info?.options;
    label = info?.label ?? key;
    model = info?.target ?? undefined;
    current = (current as Row)[key];
  }
  return { value: optionLabel(current, options), kind, label };
}

/** `{{path}}`, or `{{path|words}}`: an amount in words, in the document's language (RFC 0016). */
function text(data: DocumentData, fields: DocumentFields, template: string): string {
  return esc(template).replace(
    /\{\{\s*([\w.]+)\s*(?:\|\s*(\w+)\s*)?\}\}/g,
    (_, path: string, filter?: string) => {
      if (path === 'page' || path === 'pages') return `<span class="${path}"></span>`;
      const r = resolve(data, fields, path);
      if (filter === 'words') {
        const json =
          r.value !== null && typeof r.value === 'object' && 'toJSON' in r.value
            ? (r.value as { toJSON(): unknown }).toJSON()
            : r.value;
        if (json === null || typeof json !== 'object' || !('amount' in json)) return '';
        const money = json as { amount: string; currency: string };
        return esc(amountInWords(String(money.amount), money.currency, data.locale ?? 'en'));
      }
      return esc(
        formatValue(r.value, r.kind, { locale: data.locale ?? 'en-US', tz: data.tz ?? 'UTC' }),
      );
    },
  );
}

function blockHtml(
  block: Block,
  data: DocumentData,
  fields: DocumentFields,
  format: DocumentFormat,
): string {
  switch (block.kind) {
    case 'heading': {
      const level = block.level ?? 1;
      return `<h${level}>${text(data, fields, block.text)}</h${level}>`;
    }
    case 'text':
      return `<p>${text(data, fields, block.text).replaceAll('\n', '<br>')}</p>`;
    case 'field': {
      const r = resolve(data, fields, block.bind);
      return `<div class="field"><span class="label">${esc(block.label ?? r.label)}</span><span class="value">${esc(formatValue(r.value, r.kind, format))}</span></div>`;
    }
    case 'fields':
      return `<div class="fields cols-${block.columns ?? 2}">${block.items
        .map((item) => {
          const r = resolve(data, fields, item.bind);
          return `<div class="field"><span class="label">${esc(item.label ?? r.label)}</span><span class="value">${esc(formatValue(r.value, r.kind, format))}</span></div>`;
        })
        .join('')}</div>`;
    case 'table': {
      const rows =
        block.bind === '$records'
          ? (data.records ?? [])
          : ((data.record[block.bind] as Row[] | undefined) ?? []);
      const target =
        block.bind === '$records'
          ? data.model
          : (fields.get(data.model)?.get(block.bind)?.target ?? data.model);
      const sums = new Map<number, number>();
      const body = rows
        .map(
          (row) =>
            `<tr>${block.columns
              .map((col, i) => {
                const r = resolve({ ...data, model: target, record: row }, fields, col.bind);
                if (col.sum === true) {
                  const n = numberOf(r.value);
                  if (n !== null) sums.set(i, (sums.get(i) ?? 0) + n);
                }
                return `<td class="${col.align ?? (['decimal', 'monetary', 'integer', 'float'].includes(r.kind ?? '') ? 'end' : 'start')}">${esc(formatValue(r.value, r.kind, format))}</td>`;
              })
              .join('')}</tr>`,
        )
        .join('');
      const head = block.columns
        .map(
          (col) =>
            `<th class="${col.align ?? 'start'}">${esc(col.label ?? fields.get(target)?.get(col.bind.split('.')[0] as string)?.label ?? col.bind)}</th>`,
        )
        .join('');
      const foot =
        sums.size === 0
          ? ''
          : `<tfoot><tr>${block.columns.map((_, i) => (sums.has(i) ? `<td class="end"><strong>${esc(decimal((sums.get(i) ?? 0).toFixed(2), format.locale))}</strong></td>` : '<td></td>')).join('')}</tr></tfoot>`;
      return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody>${foot}</table>`;
    }
    case 'divider':
      return '<hr>';
    case 'pageBreak':
      return '<div class="page-break"></div>';
    case 'signature':
      return `<div class="signatures">${block.labels.map((l) => `<div class="signature"><div class="line"></div><div>${esc(l)}</div></div>`).join('')}</div>`;
    case 'columns':
      return `<div class="columns"><div>${block.left.map((b) => blockHtml(b, data, fields, format)).join('')}</div><div>${block.right.map((b) => blockHtml(b, data, fields, format)).join('')}</div></div>`;
  }
}

const CSS = `
@page { size: var(--paper); margin: 18mm 16mm 20mm 16mm; }
:root { font-family: Inter, 'Noto Sans Bengali', 'Noto Sans Arabic', system-ui, sans-serif; font-size: 10.5pt; color: #111; }
body { margin: 0; }
header, footer { position: fixed; left: 0; right: 0; font-size: 9pt; color: #555; }
header { top: -12mm; } footer { bottom: -14mm; display: flex; justify-content: space-between; }
h1 { font-size: 20pt; margin: 0 0 6mm; } h2 { font-size: 14pt; margin: 6mm 0 3mm; } h3 { font-size: 11.5pt; margin: 4mm 0 2mm; }
p { margin: 0 0 3mm; line-height: 1.45; }
.field { display: grid; grid-template-columns: 38% 1fr; gap: 3mm; padding: 1.2mm 0; border-bottom: 1px solid #eee; }
.field .label { color: #555; } .fields { display: grid; gap: 0 8mm; margin-bottom: 4mm; }
.fields.cols-2 { grid-template-columns: 1fr 1fr; } .fields.cols-3 { grid-template-columns: 1fr 1fr 1fr; }
table { width: 100%; border-collapse: collapse; margin: 3mm 0 5mm; }
th, td { padding: 1.8mm 2mm; border-bottom: 1px solid #ddd; vertical-align: top; }
th { background: #f3f4f6; font-weight: 600; } .end { text-align: end; } .start { text-align: start; }
tfoot td { border-top: 2px solid #111; border-bottom: none; }
hr { border: 0; border-top: 1px solid #ccc; margin: 5mm 0; }
.page-break { break-after: page; }
.columns { display: grid; grid-template-columns: 1fr 1fr; gap: 10mm; }
.signatures { display: grid; grid-auto-flow: column; gap: 12mm; margin-top: 18mm; text-align: center; font-size: 9.5pt; }
.signature .line { border-top: 1px solid #111; margin-bottom: 2mm; }
tr, .field { break-inside: avoid; }
`;

/** The HTML of a document (a complete page, also used for the designer's preview). */
export function renderHtml(
  layout: Layout,
  data: DocumentData,
  fields: DocumentFields,
  format: DocumentFormat,
  options: { readonly dir?: 'ltr' | 'rtl'; readonly lang?: string } = {},
): string {
  const paper = `${layout.paper ?? 'A4'} ${layout.orientation ?? 'portrait'}`;
  const body = layout.blocks.map((b) => blockHtml(b, data, fields, format)).join('\n');
  return `<!doctype html><html lang="${esc(options.lang ?? 'en')}" dir="${options.dir ?? 'ltr'}"><head><meta charset="utf-8"><title>${esc(data.record['displayName'] ?? data.model)}</title><style>${CSS.replace('var(--paper)', paper)}</style></head><body>${
    layout.header === undefined ? '' : `<header>${text(data, fields, layout.header)}</header>`
  }<main>${body}</main>${layout.footer === undefined ? '' : `<footer><span>${text(data, fields, layout.footer)}</span></footer>`}</body></html>`;
}

type Browser = {
  newPage(): Promise<{
    setContent(html: string, o?: unknown): Promise<void>;
    pdf(o: unknown): Promise<Buffer>;
    close(): Promise<void>;
  }>;
  close(): Promise<void>;
  isConnected(): boolean;
};
let browser: Promise<Browser> | undefined;

/** Prints HTML to PDF with Playwright's Chromium (one shared browser per process, launched on first use). */
export async function renderPdf(html: string, layout: Layout): Promise<Buffer> {
  browser ??= import('playwright-core').then(
    (pw) => pw.chromium.launch({ headless: true }) as Promise<Browser>,
  );
  let instance = await browser;
  if (!instance.isConnected()) {
    browser = import('playwright-core').then(
      (pw) => pw.chromium.launch({ headless: true }) as Promise<Browser>,
    );
    instance = await browser;
  }
  const page = await instance.newPage();
  try {
    await page.setContent(html, { waitUntil: 'load' });
    const footer =
      layout.footer === undefined
        ? undefined
        : `<div style="font-size:8pt;color:#555;width:100%;padding:0 16mm;display:flex;justify-content:flex-end"><span class="pageNumber"></span>/<span class="totalPages"></span></div>`;
    return await page.pdf({
      format: layout.paper ?? 'A4',
      landscape: layout.orientation === 'landscape',
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: footer !== undefined,
      headerTemplate: '<span></span>',
      footerTemplate: footer ?? '<span></span>',
    });
  } finally {
    await page.close();
  }
}

/** Closes the shared browser (on server shutdown). */
export async function closeDocuments(): Promise<void> {
  const b = await browser?.catch(() => undefined);
  browser = undefined;
  await b?.close();
}

/** Loads a record with its related rows for the paths a layout binds, as the caller. */
export async function loadDocumentData(
  env: Env,
  model: string,
  ids: readonly number[],
  layout: Layout,
  fields: DocumentFields,
): Promise<{ records: Row[]; company: Row; user: Row }> {
  const paths = new Set<string>();
  const collect = (blocks: readonly Block[], prefix = ''): void => {
    for (const b of blocks) {
      if (b.kind === 'field') paths.add(prefix + b.bind);
      else if (b.kind === 'fields') for (const i of b.items) paths.add(prefix + i.bind);
      else if (b.kind === 'table') {
        if (b.bind !== '$records') paths.add(b.bind);
        for (const c of b.columns)
          paths.add(b.bind === '$records' ? c.bind : `${b.bind}.${c.bind}`);
      } else if (b.kind === 'columns') {
        collect(b.left, prefix);
        collect(b.right, prefix);
      } else if (b.kind === 'heading' || b.kind === 'text')
        for (const m of b.text.matchAll(/\{\{\s*([\w.]+)\s*(?:\|\s*\w+\s*)?\}\}/g))
          paths.add(m[1] as string);
    }
  };
  collect(layout.blocks);
  for (const t of [layout.header, layout.footer])
    if (t !== undefined)
      for (const m of t.matchAll(/\{\{\s*([\w.]+)\s*(?:\|\s*\w+\s*)?\}\}/g))
        paths.add(m[1] as string);

  type Rows = {
    readonly length: number;
    load(spec: unknown): Promise<Rows>;
    read(keys: readonly string[]): Row[];
  };
  const ref = (name: string) =>
    env.model(name as never) as unknown as {
      browse(ids: readonly number[]): Rows;
      search(q: unknown): Promise<Rows>;
    };
  /** Loads `keys` on `rows` of `name`, recursing into relation paths. */
  const hydrate = async (
    name: string,
    rows: Row[],
    keys: Map<string, Set<string>>,
  ): Promise<void> => {
    const meta = fields.get(name);
    for (const [key, rest] of keys) {
      const info = meta?.get(key);
      if (info?.target === null || info === undefined || rest.size === 0) continue;
      const target = info.target;
      const idsOf = rows.flatMap((r) =>
        Array.isArray(r[key])
          ? (r[key] as number[])
          : typeof r[key] === 'number'
            ? [r[key] as number]
            : [],
      );
      if (idsOf.length === 0) continue;
      const sub = groupPaths([...rest]);
      const scalar = [...sub.keys()];
      const loaded = await ref(target)
        .browse([...new Set(idsOf)])
        .load(['displayName', ...scalar.filter((k) => k !== 'displayName')]);
      const related = loaded.read(['displayName', ...scalar]);
      await hydrate(target, related, sub);
      const byId = new Map(related.map((r) => [r['id'] as number, r]));
      for (const r of rows)
        r[key] = Array.isArray(r[key])
          ? (r[key] as number[]).map((i) => byId.get(i) ?? { id: i })
          : typeof r[key] === 'number'
            ? (byId.get(r[key] as number) ?? { id: r[key] })
            : null;
    }
  };
  const groupPaths = (list: string[]): Map<string, Set<string>> => {
    const out = new Map<string, Set<string>>();
    for (const p of list) {
      const [head = '', ...tail] = p.split('.');
      const set = out.get(head) ?? new Set<string>();
      if (tail.length > 0) set.add(tail.join('.'));
      out.set(head, set);
    }
    return out;
  };
  const own = groupPaths(
    [...paths].filter((p) => !p.startsWith('company.') && !p.startsWith('user.') && p !== 'now'),
  );
  const scalarKeys = ['displayName', ...own.keys()].filter(
    (k) => fields.get(model)?.has(k) === true || k === 'displayName',
  );
  const x2many = [...own.keys()].filter((k) =>
    ['one2many', 'many2many'].includes(fields.get(model)?.get(k)?.kind ?? ''),
  );
  let set = await ref(model)
    .browse(ids)
    .load(scalarKeys.filter((k) => !x2many.includes(k)));
  if (x2many.length > 0) set = await set.load(Object.fromEntries(x2many.map((k) => [k, true])));
  const records = set.read(scalarKeys);
  await hydrate(model, records, own);
  const companyPaths = groupPaths(
    [...paths].filter((p) => p.startsWith('company.')).map((p) => p.slice(8)),
  );
  const [company] = (
    await ref('res.company')
      .browse([env.companyId])
      .load(['name', ...[...companyPaths.keys()].filter((k) => fields.get('res.company')?.has(k))])
  ).read(['name', ...companyPaths.keys()].filter((k) => fields.get('res.company')?.has(k)));
  await hydrate('res.company', [company ?? {}], companyPaths);
  const [user] = (await ref('res.users').browse([env.uid]).load(['name'])).read(['name']);
  return { records, company: company ?? {}, user: user ?? {} };
}
