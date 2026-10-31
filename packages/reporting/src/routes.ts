/**
 * Reporting routes (RFC 0005):
 *
 * - `POST /api/v1/models/:model/report`           the report query (pivot, chart, cohort data): one statement
 * - `POST /api/v1/models/:model/report/export`    the report as XLSX or CSV (needs `export`; audited)
 * - `POST /api/v1/models/:model/export/xlsx`      a list as a formatted XLSX (needs `export`; audited)
 */
import {
  type ApiModel,
  audit,
  HttpProblem,
  type ModuleContext,
  publicApiModels,
} from '@kosh/server';
import type { Env } from '@kosh/server/orm';
import type { FastifyRequest } from 'fastify';
import { renderPdf } from './documents.js';
import {
  type FieldInfo,
  type Header,
  ReportError,
  type ReportQuery,
  type ReportResult,
  runReport,
  type Value,
} from './pivot.js';
import { type Cell, moneyFormat, workbook } from './xlsx.js';

const LIST_XLSX_LIMIT = 100_000;
const LIST_PDF_LIMIT = 2000;

type Row = Record<string, unknown>;
interface Rows {
  readonly length: number;
  load(keys: readonly string[]): Promise<{ read(keys: readonly string[]): Row[] }>;
}
const search = (env: Env, model: string, query: unknown): Promise<Rows> =>
  (env.model(model as never) as unknown as { search(q: unknown): Promise<Rows> }).search(query);

function bad(detail: string): HttpProblem {
  return new HttpProblem(400, 'invalid-report', 'Invalid report', detail);
}

function bodyOf(request: FastifyRequest): Record<string, unknown> {
  const b = request.body;
  if (typeof b !== 'object' || b === null || Array.isArray(b))
    throw bad('The body must be a JSON object.');
  return b as Record<string, unknown>;
}

function strings(value: unknown, what: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string'))
    throw bad(`${what} must be an array of strings.`);
  return value as string[];
}

/** Validates the JSON body into a report query (Shutro validates fields, measures and security). */
export function parseReportQuery(raw: Record<string, unknown>): ReportQuery {
  const measures = raw['measures'];
  if (typeof measures !== 'object' || measures === null || Array.isArray(measures))
    throw bad('measures is an object.');
  const where = raw['where'];
  if (where !== undefined && (typeof where !== 'object' || where === null || Array.isArray(where)))
    throw bad('where is a domain object.');
  const comparison = raw['comparison'];
  let parsedComparison: ReportQuery['comparison'];
  if (comparison !== undefined) {
    const c = comparison as Record<string, unknown>;
    const date = /^\d{4}-\d{2}-\d{2}$/;
    if (
      typeof c['field'] !== 'string' ||
      typeof c['from'] !== 'string' ||
      typeof c['to'] !== 'string' ||
      !date.test(c['from']) ||
      !date.test(c['to'])
    )
      throw bad('comparison is { field, from: YYYY-MM-DD, to: YYYY-MM-DD (exclusive), mode }.');
    if (c['mode'] !== 'previous' && c['mode'] !== 'yoy')
      throw bad("comparison.mode is 'previous' or 'yoy'.");
    parsedComparison = { field: c['field'], from: c['from'], to: c['to'], mode: c['mode'] };
  }
  if (raw['asOf'] !== undefined && typeof raw['asOf'] !== 'string')
    throw bad('asOf is an ISO date-time.');
  return {
    rows: strings(raw['rows'], 'rows'),
    cols: strings(raw['cols'], 'cols'),
    measures: measures as ReportQuery['measures'],
    ...(where === undefined ? {} : { where: where as Record<string, unknown> }),
    ...(parsedComparison === undefined ? {} : { comparison: parsedComparison }),
    ...(typeof raw['asOf'] === 'string' ? { asOf: raw['asOf'] } : {}),
  };
}

function fieldsOf(model: ApiModel): ReadonlyMap<string, FieldInfo> {
  return new Map(
    model.fields.map((f) => [
      f.key,
      { kind: f.kind, label: f.label, target: f.target, options: f.options },
    ]),
  );
}

/**
 * Display names of ids, as the caller may read them (no access to the target model: no names). Never swallows a
 * failed query: inside a transaction that would leave it aborted for the next statement.
 */
export async function displayNames(
  env: Env,
  target: string,
  ids: readonly number[],
): Promise<ReadonlyMap<number, string>> {
  if (ids.length === 0 || !env.access.can(target as never, 'read')) return new Map();
  const found = await search(env, target, { where: { id: { in: [...ids] } } });
  if (found.length === 0) return new Map();
  return new Map(
    (await found.load(['displayName']))
      .read(['displayName'])
      .map((r) => [r['id'] as number, String(r['displayName'])]),
  );
}

/** A measure value as text (CSV) or a typed cell (XLSX). */
function cellOf(value: Value | undefined): Cell {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return { decimal: value };
  if (value.length === 1) {
    const [only] = value;
    return { decimal: only?.amount ?? '0', format: moneyFormat(only?.currency ?? '') };
  }
  return value.map((a) => `${a.currency} ${a.amount}`).join('; ');
}

const text = (cell: Cell): string => {
  if (cell === null) return '';
  if (typeof cell === 'object' && !(cell instanceof Date))
    return 'decimal' in cell ? cell.decimal : cell.text;
  return cell instanceof Date ? cell.toISOString() : String(cell);
};

/** The report as a table: row headers (indented by level), then one column per column header × measure. */
export function reportTable(
  result: ReportResult,
  measures: readonly string[],
  labels: Readonly<Record<string, string>>,
): Cell[][] {
  const leaves = (node: Header): Header[] =>
    node.children.length === 0 ? [node] : node.children.flatMap(leaves);
  const columns =
    result.cols.children.length === 0 ? [result.cols] : [...leaves(result.cols), result.cols];
  const header: Cell[] = [''];
  for (const col of columns)
    for (const m of measures)
      header.push(
        `${col === result.cols ? 'Total' : pathLabel(result.cols, col)}${measures.length > 1 || col === result.cols ? ` · ${labels[m] ?? m}` : ''}`,
      );
  const out: Cell[][] = [header];
  const walk = (row: Header): void => {
    const cells = result.cells[row.key] ?? {};
    const line: Cell[] = [
      row === result.rows
        ? { text: 'Total', bold: true }
        : { text: row.label || '—', indent: row.depth - 1, bold: row.children.length > 0 },
    ];
    for (const col of columns) for (const m of measures) line.push(cellOf(cells[col.key]?.[m]));
    if (row !== result.rows) out.push(line);
    for (const child of row.children) walk(child);
    if (row === result.rows) out.push(line);
  };
  walk(result.rows);
  return out;
}

function pathLabel(root: Header, target: Header): string {
  const find = (node: Header, trail: string[]): string[] | null => {
    if (node === target) return trail;
    for (const child of node.children) {
      const found = find(child, [...trail, child.label || '—']);
      if (found !== null) return found;
    }
    return null;
  };
  return (find(root, []) ?? []).join(' / ');
}

/** Registers the routes. */
export function registerReportRoutes(context: ModuleContext): void {
  const { app } = context;
  const models = publicApiModels(context.registry);
  const modelOf = (params: unknown): ApiModel => {
    const name = String((params as { model?: unknown }).model ?? '');
    const model = models.get(name);
    if (model === undefined)
      throw new HttpProblem(
        404,
        'unknown-model',
        'Unknown model',
        `No installed model is named '${name}'.`,
      );
    return model;
  };
  const report = async (env: Env, model: ApiModel, query: ReportQuery): Promise<ReportResult> => {
    try {
      return await runReport(env, model.name, query, fieldsOf(model), (target, ids) =>
        displayNames(env, target, ids),
      );
    } catch (error) {
      if (error instanceof ReportError) throw bad(error.message);
      throw error;
    }
  };

  app.post('/api/v1/models/:model/report', async (request) => {
    const model = modelOf(request.params);
    const query = parseReportQuery(bodyOf(request));
    // asOf reads run in their own read-only scope; the rest is an ordinary read.
    return request.env((env) => report(env, model, query));
  });

  app.post('/api/v1/models/:model/report/export', async (request, reply) => {
    const model = modelOf(request.params);
    const raw = bodyOf(request);
    const query = parseReportQuery(raw);
    const format = raw['format'] ?? 'xlsx';
    if (format !== 'xlsx' && format !== 'csv') throw bad('format is xlsx or csv.');
    const title =
      typeof raw['title'] === 'string' && raw['title'] !== '' ? raw['title'] : model.label;
    const labels = Object.fromEntries(
      Object.entries(query.measures).map(([name, m]) => {
        const field = typeof m === 'object' ? Object.values(m)[0] : undefined;
        return [name, field === undefined ? 'Count' : (model.byKey.get(field)?.label ?? field)];
      }),
    );
    const table = await request.env(async (env) => {
      env.access.check(model.name as never, 'export');
      const result = await report(env, model, query);
      await audit(env, {
        kind: 'data.export',
        summary: `Exported the report "${title}" of ${model.name} as ${format}.`,
        targetModel: model.name,
        details: {
          report: { rows: query.rows, cols: query.cols, measures: Object.keys(query.measures) },
          filter: query.where ?? null,
        },
        ip: request.ip,
      });
      return reportTable(result, Object.keys(query.measures), labels);
    });
    const file = `${title.replace(/[^\w.-]+/g, '_')}.${format}`;
    if (format === 'csv') {
      const csv = table.map((row) => row.map((c) => csvCell(text(c))).join(',')).join('\r\n');
      await reply
        .type('text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="${file}"`)
        .send(`${csv}\r\n`);
      return;
    }
    const widths = [32, ...(table[0] ?? []).slice(1).map(() => 16)];
    await reply
      .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('content-disposition', `attachment; filename="${file}"`)
      .send(workbook([{ name: title, rows: table, widths }]));
  });

  app.post('/api/v1/models/:model/export/xlsx', async (request, reply) => {
    const model = modelOf(request.params);
    const raw = bodyOf(request);
    const keys = strings(raw['fields'], 'fields');
    const where = raw['filter'];
    const limit = raw['limit'] === undefined ? LIST_XLSX_LIMIT : Number(raw['limit']);
    if (!Number.isInteger(limit) || limit < 1 || limit > LIST_XLSX_LIMIT)
      throw bad(`limit must be 1–${LIST_XLSX_LIMIT}.`);
    const sheet = await request.env((env) =>
      listSheet(env, model, keys, where, limit, request.ip, 'xlsx'),
    );
    await reply
      .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('content-disposition', `attachment; filename="${model.name}.xlsx"`)
      .send(workbook([sheet]));
  });

  // RFC 0022 §3.5: a list printed as PDF — the columns shown, the filter, up to LIST_PDF_LIMIT rows.
  app.post('/api/v1/models/:model/export/pdf', async (request, reply) => {
    const model = modelOf(request.params);
    const raw = bodyOf(request);
    const keys = strings(raw['fields'], 'fields');
    const where = raw['filter'];
    const limit = raw['limit'] === undefined ? LIST_PDF_LIMIT : Number(raw['limit']);
    if (!Number.isInteger(limit) || limit < 1 || limit > LIST_PDF_LIMIT)
      throw bad(`limit must be 1–${LIST_PDF_LIMIT}.`);
    const sheet = await request.env((env) =>
      listSheet(env, model, keys, where, limit, request.ip, 'pdf'),
    );
    const lang = String(request.headers['accept-language'] ?? 'en').slice(0, 2);
    const html = listHtml(sheet, { lang, dir: lang === 'ar' || lang === 'he' ? 'rtl' : 'ltr' });
    const pdf = await renderPdf(html, {
      paper: 'A4',
      orientation: (sheet.rows[0]?.length ?? 0) > 6 ? 'landscape' : 'portrait',
      blocks: [],
    });
    await reply
      .type('application/pdf')
      .header('content-disposition', `attachment; filename="${model.name}.pdf"`)
      .send(pdf);
  });
}

function csvCell(value: string): string {
  let t = value;
  if (/^[=+\-@\t\r]/.test(t) && !/^-?\d+(\.\d+)?$/.test(t)) t = `'${t}`;
  return /[",\r\n]/.test(t) ? `"${t.replaceAll('"', '""')}"` : t;
}

/** The rows of a list for an export: the columns the user may read, many2one names, typed cells; audited. */
async function listSheet(
  env: Env,
  model: ApiModel,
  keys: readonly string[],
  where: unknown,
  limit: number,
  ip: string,
  format: 'xlsx' | 'pdf',
): Promise<{ name: string; rows: Cell[][]; widths: number[] }> {
  env.access.check(model.name as never, 'export');
  const fields = (
    keys.length > 0
      ? keys
      : model.fields
          .filter(
            (f) =>
              f.stored && f.kind !== 'binary' && f.kind !== 'one2many' && f.kind !== 'many2many',
          )
          .map((f) => f.key)
  )
    .map((k) => model.byKey.get(k))
    .filter((f) => f !== undefined && env.access.canField(model.name as never, f.key, 'read'));
  const found = await search(env, model.name, {
    ...(where === undefined ? {} : { where }),
    order: ['id asc'],
    limit,
  });
  const loaded =
    found.length === 0
      ? []
      : (await found.load(['id', ...fields.map((f) => f?.key as string)])).read(
          fields.map((f) => f?.key as string),
        );
  // many2one columns show names, not ids.
  const names = new Map<string, ReadonlyMap<number, string>>();
  for (const f of fields)
    if (f?.kind === 'many2one' && f.target !== null) {
      const ids = [
        ...new Set(loaded.map((r) => r[f.key]).filter((v): v is number => typeof v === 'number')),
      ];
      names.set(f.key, ids.length === 0 ? new Map() : await displayNames(env, f.target, ids));
    }
  await audit(env, {
    kind: 'data.export',
    summary: `Exported ${loaded.length} ${model.name} record(s) as ${format}.`,
    targetModel: model.name,
    details: { fields: fields.map((f) => f?.key), count: loaded.length, filter: where ?? null },
    ip,
  });
  const header: Cell[] = fields.map((f) => f?.label ?? '');
  const body: Cell[][] = loaded.map((r) =>
    fields.map((f): Cell => {
      if (f === undefined) return null;
      const v = r[f.key];
      if (v === null || v === undefined) return null;
      switch (f.kind) {
        case 'many2one':
          return names.get(f.key)?.get(v as number) ?? `#${String(v)}`;
        case 'decimal':
        case 'float':
          return { decimal: String(v) };
        case 'monetary': {
          const m = (
            typeof (v as { toJSON?: unknown }).toJSON === 'function'
              ? (v as { toJSON(): unknown }).toJSON()
              : v
          ) as { amount?: unknown; currency?: unknown };
          return {
            decimal: String(m.amount ?? v),
            format: moneyFormat(String(m.currency ?? '')),
          };
        }
        case 'date':
          return new Date(`${String(v).slice(0, 10)}T00:00:00Z`);
        case 'datetime':
          return v instanceof Date ? v : new Date(String(v));
        case 'selection':
        case 'state':
          return f.options?.find(([value]) => value === v)?.[1] ?? String(v);
        case 'boolean':
          return v === true;
        case 'integer':
        case 'bigint':
          return Number(v);
        default:
          return String(v);
      }
    }),
  );
  return {
    name: model.label,
    rows: [header, ...body],
    widths: fields.map((f) => Math.min(48, Math.max(10, (f?.label.length ?? 10) + 4))),
  };
}

const escapeHtml = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );

/** A cell as text on paper. */
function cellText(cell: Cell): string {
  if (cell === null) return '';
  if (cell instanceof Date) return cell.toISOString().slice(0, 10);
  if (typeof cell === 'boolean') return cell ? '✓' : '';
  if (typeof cell === 'object') return 'decimal' in cell ? cell.decimal : cell.text;
  return String(cell);
}

/** A list as a printable page: the title, the count, a table with the header on every page. */
function listHtml(
  sheet: { readonly name: string; readonly rows: readonly Cell[][] },
  options: { readonly lang: string; readonly dir: 'ltr' | 'rtl' },
): string {
  const [header = [], ...body] = sheet.rows;
  const numeric = header.map((_, i) =>
    body.every((row) => {
      const c = row[i];
      return (
        c === null ||
        c === undefined ||
        typeof c === 'number' ||
        (typeof c === 'object' && 'decimal' in c)
      );
    }),
  );
  const th = header.map((h) => `<th>${escapeHtml(cellText(h))}</th>`).join('');
  const tr = body
    .map(
      (row) =>
        `<tr>${row.map((c, i) => `<td${numeric[i] ? ' class="n"' : ''}>${escapeHtml(cellText(c))}</td>`).join('')}</tr>`,
    )
    .join('\n');
  return `<!doctype html><html lang="${escapeHtml(options.lang)}" dir="${options.dir}"><head><meta charset="utf-8"><title>${escapeHtml(sheet.name)}</title><style>
body{font:10pt/1.4 "Inter","Noto Sans Bengali",system-ui,sans-serif;color:#111;margin:0}
h1{font-size:14pt;margin:0 0 2mm}p{margin:0 0 4mm;color:#555}
table{width:100%;border-collapse:collapse}thead{display:table-header-group}
th,td{padding:1.2mm 2mm;border-bottom:0.2mm solid #ccc;text-align:start;vertical-align:top}
th{font-weight:600;background:#f3f4f6}td.n,th.n{text-align:end;font-variant-numeric:tabular-nums}
tr{break-inside:avoid}</style></head><body><h1>${escapeHtml(sheet.name)}</h1><p>${body.length}</p><table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></body></html>`;
}
