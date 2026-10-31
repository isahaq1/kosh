/**
 * Documents and schedules (RFC 0005):
 *
 * - `GET  /api/v1/models/:model/documents`                      the templates of a model the user may use
 * - `POST /api/v1/models/:model/documents/:template`            `{ ids: [..] }` (or `{ filter }` for list templates)
 *                                                                → PDF; `?format=html` previews (the designer)
 * - `POST /api/v1/reports/schedules/:id/run`                    renders a schedule now, as the caller
 * - `GET  /api/v1/reports/outputs/:id/download`                 an output's file (owner or recipient)
 *
 * Templates come from manifests (`installTemplates`) and the designer; renders are audited as `document.rendered`.
 */
import type { KoshModule } from '@kosh/modules-sdk';
import {
  type ApiModel,
  audit,
  HttpProblem,
  type ModuleContext,
  publicApiModels,
} from '@kosh/server';
import type { Env } from '@kosh/server/orm';
import type { Layout } from '@kosh/views';
import type { FastifyRequest } from 'fastify';
import { type DocumentFields, loadDocumentData, renderHtml, renderPdf } from './documents.js';
import { type Header, ReportError, runReport } from './pivot.js';
import { displayNames, parseReportQuery, reportTable } from './routes.js';
import { type Rendered, ScheduleEngine } from './schedules.js';
import { type Cell, workbook } from './xlsx.js';

type Row = Record<string, unknown>;
interface Rows {
  readonly ids: readonly number[];
  readonly length: number;
  load(spec: unknown): Promise<Rows>;
  read(keys: readonly string[]): Row[];
}
const ref = (env: Env, name: string) =>
  env.model(name as never) as unknown as {
    search(q: unknown): Promise<Rows>;
    browse(ids: readonly number[]): Rows;
    create(rows: unknown[]): Promise<Rows>;
  };
async function rows(
  env: Env,
  name: string,
  where: unknown,
  keys: string[],
  extra: Record<string, unknown> = {},
): Promise<Row[]> {
  const found = await ref(env, name).search({ where, ...extra });
  return found.length === 0 ? [] : (await found.load(keys)).read(keys);
}

function bad(detail: string): HttpProblem {
  return new HttpProblem(400, 'invalid-document', 'Invalid request', detail);
}

/** Field metadata of every served model, for labels, kinds and relation targets. */
export function documentFields(models: ReadonlyMap<string, ApiModel>): DocumentFields {
  return new Map(
    [...models].map(([name, m]) => [
      name,
      new Map(
        m.fields.map((f) => [
          f.key,
          { label: f.label, kind: f.kind, target: f.target, options: f.options },
        ]),
      ),
    ]),
  );
}

/** Validates a layout's bindings against the models (unknown paths are reported, not rendered as blanks). */
export function layoutProblems(layout: Layout, model: string, fields: DocumentFields): string[] {
  const problems: string[] = [];
  const check = (path: string, from: string): void => {
    if (path === 'now' || path === 'page' || path === 'pages') return;
    const parts = path.split('.');
    let current: string | undefined =
      parts[0] === 'company' ? 'res.company' : parts[0] === 'user' ? 'res.users' : from;
    if (parts[0] === 'company' || parts[0] === 'user') parts.shift();
    for (const [i, key] of parts.entries()) {
      const info: { readonly target: string | null } | undefined =
        current === undefined ? undefined : fields.get(current)?.get(key);
      if (info === undefined) {
        problems.push(`unknown field '${path}' (no '${key}' on ${current})`);
        return;
      }
      if (i < parts.length - 1 && info.target === null) {
        problems.push(`'${path}': '${key}' is not a relation`);
        return;
      }
      current = info.target ?? undefined;
    }
  };
  const texts = (t: string, from: string) => {
    for (const m of t.matchAll(/\{\{\s*([\w.]+)\s*(?:\|\s*\w+\s*)?\}\}/g))
      check(m[1] as string, from);
  };
  const walk = (blocks: Layout['blocks']) => {
    for (const b of blocks) {
      if (b.kind === 'field' || b.kind === 'qr') check(b.bind, model);
      else if (b.kind === 'fields') for (const i of b.items) check(i.bind, model);
      else if (b.kind === 'heading' || b.kind === 'text') texts(b.text, model);
      else if (b.kind === 'table') {
        const info = b.bind === '$records' ? undefined : fields.get(model)?.get(b.bind);
        const target =
          b.bind === '$records'
            ? model
            : info !== undefined && (info.kind === 'one2many' || info.kind === 'many2many')
              ? info.target
              : null;
        if (target === undefined || target === null)
          problems.push(`table '${b.bind}' is not a one2many / many2many of ${model}`);
        else for (const c of b.columns) check(c.bind, target);
      } else if (b.kind === 'columns') {
        walk(b.left);
        walk(b.right);
      }
    }
  };
  walk(layout.blocks);
  for (const t of [layout.header, layout.footer]) if (t !== undefined) texts(t, model);
  return problems;
}

/** Installs the manifests' default templates that do not exist yet (by `module.key`). */
export async function installTemplates(env: Env, modules: readonly KoshModule[]): Promise<number> {
  let created = 0;
  for (const m of modules)
    for (const spec of m.documents ?? []) {
      const key = `${m.name}.${spec.key}`;
      if (
        (
          await ref(env, 'report.template').search({
            where: { key, active: { in: [true, false] } },
          })
        ).length > 0
      )
        continue;
      await ref(env, 'report.template').create([
        {
          name: spec.name,
          targetModel: spec.model,
          key,
          layout: spec.layout,
          scope: spec.scope ?? 'record',
        },
      ]);
      created++;
    }
  return created;
}

const MIME = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv; charset=utf-8',
} as const;

/** Renders a document for `ids` (or the records of `filter`) as `env`'s user. */
export async function renderDocument(
  env: Env,
  model: ApiModel,
  template: Row,
  fields: DocumentFields,
  target: {
    readonly ids?: readonly number[];
    readonly filter?: Record<string, unknown> | undefined;
    readonly limit?: number | undefined;
  },
  format: 'pdf' | 'html',
): Promise<Rendered> {
  const layout = template['layout'] as Layout;
  const scope = String(template['scope'] ?? 'record');
  let ids = [...(target.ids ?? [])];
  if (scope === 'list')
    ids = (
      await ref(env, model.name).search({
        ...(target.filter === undefined ? {} : { where: target.filter }),
        limit: Math.min(target.limit ?? 1000, 5000),
        ...(ids.length > 0 ? { where: { id: { in: ids } } } : {}),
      })
    ).ids as number[];
  if (ids.length === 0) throw bad('No records to print.');
  const data = await loadDocumentData(env, model.name, ids, layout, fields);
  // The company's number grouping (RFC 0016): lakh and crore print in the Indian English pattern.
  const grouping = await env.asSuperuser({ reason: 'document number grouping' }, async (su) => {
    const found = await ref(su, 'res.company').search({ where: { id: env.companyId }, limit: 1 });
    const [row] = (await found.load(['numberGrouping'])).read(['numberGrouping']);
    return row?.['numberGrouping'];
  });
  const lang = env.lang.replace('_', '-');
  const locale = grouping === 'lakh' && lang.startsWith('en') ? 'en-IN' : lang;
  const dir = /^(ar|fa|he|ur)/.test(env.lang) ? 'rtl' : 'ltr';
  const parts: string[] = [];
  const base = {
    model: model.name,
    company: data.company,
    user: data.user,
    now: new Date(),
    locale,
    tz: env.tz,
  };
  if (scope === 'list')
    parts.push(
      renderHtml(
        layout,
        { ...base, record: data.records[0] ?? {}, records: data.records },
        fields,
        { locale, tz: env.tz },
        { dir, lang: locale },
      ),
    );
  else
    for (const record of data.records)
      parts.push(
        renderHtml(
          layout,
          { ...base, record },
          fields,
          { locale, tz: env.tz },
          { dir, lang: locale },
        ),
      );
  // Several records: one document, a page break between them.
  const html =
    parts.length === 1
      ? (parts[0] as string)
      : (parts[0] as string).replace(
          '</main>',
          `${parts
            .slice(1)
            .map(
              (p) =>
                `<div class="page-break"></div>${p.slice(p.indexOf('<main>') + 6, p.lastIndexOf('</main>'))}`,
            )
            .join('')}</main>`,
        );
  const name =
    `${String(template['name'])}${ids.length === 1 ? `-${String(data.records[0]?.['displayName'] ?? ids[0])}` : ''}`.replace(
      /[^\w.-]+/g,
      '_',
    );
  await audit(env, {
    kind: 'document.rendered',
    summary: `Rendered "${String(template['name'])}" (${format}) for ${ids.length} ${model.name} record(s).`,
    targetModel: model.name,
    ...(ids.length === 1 ? { targetId: ids[0] as number } : {}),
    details: { template: template['id'], count: ids.length },
  });
  if (format === 'html')
    return {
      filename: `${name}.html`,
      mime: 'text/html; charset=utf-8',
      content: Buffer.from(html),
    };
  return { filename: `${name}.pdf`, mime: MIME.pdf, content: await renderPdf(html, layout) };
}

/** Renders a schedule (pivot, list or document) as `env`'s user. */
export function scheduleRenderer(models: ReadonlyMap<string, ApiModel>, fields: DocumentFields) {
  return async (env: Env, schedule: Row): Promise<Rendered> => {
    const model = models.get(String(schedule['targetModel']));
    if (model === undefined)
      throw new Error(`The model ${String(schedule['targetModel'])} is not installed.`);
    const query = (schedule['query'] as Record<string, unknown> | null) ?? {};
    const format = String(schedule['format']) as 'xlsx' | 'csv' | 'pdf';
    const name = String(schedule['name']).replace(/[^\w.-]+/g, '_');
    const kind = String(schedule['kind']);
    if (kind === 'document') {
      const templateId = schedule['template'] as number | null;
      const [template] =
        templateId === null
          ? []
          : await rows(env, 'report.template', { id: templateId }, ['name', 'layout', 'scope']);
      if (template === undefined) throw new Error('The schedule has no template.');
      return renderDocument(
        env,
        model,
        template,
        fields,
        {
          filter: query['filter'] as Record<string, unknown> | undefined,
          limit: query['limit'] as number | undefined,
        },
        'pdf',
      );
    }
    let table: Cell[][];
    if (kind === 'pivot') {
      const parsed = parseReportQuery(query);
      const labels = Object.fromEntries(
        Object.entries(parsed.measures).map(([k, m]) => [
          k,
          m === 'count' ? 'Count' : (model.byKey.get(Object.values(m)[0] as string)?.label ?? k),
        ]),
      );
      const result = await runReport(
        env,
        model.name,
        parsed,
        new Map(
          model.fields.map((f) => [
            f.key,
            { kind: f.kind, label: f.label, target: f.target, options: f.options },
          ]),
        ),
        (target, ids) => displayNames(env, target, ids),
      );
      table = reportTable(result, Object.keys(parsed.measures), labels);
    } else {
      const keys =
        Array.isArray(query['fields']) && query['fields'].length > 0
          ? (query['fields'] as string[])
          : model.fields
              .filter((f) => f.stored && !['binary', 'one2many', 'many2many'].includes(f.kind))
              .map((f) => f.key);
      const items = await rows(env, model.name, query['filter'] ?? {}, keys, {
        limit: Math.min(Number(query['limit'] ?? 10_000), 100_000),
        order: ['id asc'],
      });
      table = [
        keys.map((k) => model.byKey.get(k)?.label ?? k),
        ...items.map((r) => keys.map((k): Cell => cellOf(r[k], model.byKey.get(k)?.kind))),
      ];
    }
    if (format === 'csv') {
      const csv = table.map((r) => r.map((c) => csvText(c)).join(',')).join('\r\n');
      return { filename: `${name}.csv`, mime: MIME.csv, content: Buffer.from(`${csv}\r\n`) };
    }
    if (format === 'pdf') {
      const layout: Layout = {
        orientation: 'landscape',
        header: String(schedule['name']),
        footer: '{{now}}',
        blocks: [
          { kind: 'heading', id: 'title', text: String(schedule['name']) },
          {
            kind: 'table',
            id: 'table',
            bind: '$records',
            columns: (table[0] ?? []).map((_, i) => ({ bind: `c${i}` })),
          },
        ],
      };
      const records = table
        .slice(1)
        .map((r) => Object.fromEntries(r.map((c, i) => [`c${i}`, csvText(c)])));
      const virtual: DocumentFields = new Map([
        [
          '$table',
          new Map(
            (table[0] ?? []).map((h, i) => [
              `c${i}`,
              { label: csvText(h), kind: 'char', target: null },
            ]),
          ),
        ],
      ]);
      const html = renderHtml(
        layout,
        {
          model: '$table',
          record: records[0] ?? {},
          records,
          company: {},
          user: {},
          now: new Date(),
          locale: env.lang.replace('_', '-'),
          tz: env.tz,
        },
        virtual,
        { locale: env.lang.replace('_', '-'), tz: env.tz },
      );
      return { filename: `${name}.pdf`, mime: MIME.pdf, content: await renderPdf(html, layout) };
    }
    return {
      filename: `${name}.xlsx`,
      mime: MIME.xlsx,
      content: workbook([
        { name: String(schedule['name']), rows: table, widths: (table[0] ?? []).map(() => 18) },
      ]),
    };
  };
}

function cellOf(value: unknown, kind: string | undefined): Cell {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (kind === 'date') return new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
  if (kind === 'decimal' || kind === 'float') return { decimal: String(value) };
  if (kind === 'monetary') {
    const m = (
      typeof (value as { toJSON?: unknown }).toJSON === 'function'
        ? (value as { toJSON(): unknown }).toJSON()
        : value
    ) as { amount?: unknown };
    return { decimal: String(m.amount ?? value) };
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return String(value);
}

function csvText(c: Cell): string {
  const t =
    c === null
      ? ''
      : typeof c === 'object' && !(c instanceof Date)
        ? 'decimal' in c
          ? c.decimal
          : c.text
        : c instanceof Date
          ? c.toISOString().slice(0, 10)
          : String(c);
  const safe = /^[=+\-@\t\r]/.test(t) && !/^-?\d+(\.\d+)?$/.test(t) ? `'${t}` : t;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

function bodyOf(request: FastifyRequest): Record<string, unknown> {
  const b = request.body;
  return typeof b === 'object' && b !== null && !Array.isArray(b)
    ? (b as Record<string, unknown>)
    : {};
}

/** Registers the routes and returns the schedule engine (started by the module). */
export function registerDocumentRoutes(context: ModuleContext): ScheduleEngine {
  const { app, shutro } = context;
  const models = publicApiModels(context.registry);
  const fields = documentFields(models);
  const engine = new ScheduleEngine(shutro, scheduleRenderer(models, fields));
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
  const positive = (value: unknown, what: string): number => {
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n <= 0) throw bad(`${what} must be a positive integer.`);
    return n;
  };

  app.get('/api/v1/models/:model/documents', async (request) => {
    const model = modelOf(request.params);
    return request.env(async (env) => ({
      templates: (
        await rows(env, 'report.template', { targetModel: model.name }, ['name', 'scope', 'key'])
      ).map((t) => ({ id: t['id'], name: t['name'], scope: t['scope'], key: t['key'] ?? null })),
    }));
  });

  app.post('/api/v1/models/:model/documents/:template', async (request, reply) => {
    const model = modelOf(request.params);
    const templateId = positive((request.params as { template?: unknown }).template, 'template');
    const format = (request.query as { format?: unknown }).format === 'html' ? 'html' : 'pdf';
    const body = bodyOf(request);
    const ids = Array.isArray(body['ids'])
      ? (body['ids'] as unknown[]).map((v) => positive(v, 'ids'))
      : [];
    const filter =
      typeof body['filter'] === 'object' && body['filter'] !== null
        ? (body['filter'] as Record<string, unknown>)
        : undefined;
    // A preview from the designer may send an unsaved layout (designers only).
    const draft = body['layout'];
    const file = await request.env(
      async (env) => {
        const [stored] = await rows(
          env,
          'report.template',
          { id: templateId, targetModel: model.name },
          ['name', 'layout', 'scope'],
        );
        if (stored === undefined)
          throw new HttpProblem(
            404,
            'unknown-template',
            'Unknown template',
            `No template ${templateId} for ${model.name}.`,
          );
        let template = stored;
        if (draft !== undefined) {
          env.access.check('report.template' as never, 'write');
          const problems = layoutProblems(draft as Layout, model.name, fields);
          if (problems.length > 0) throw bad(problems.join('; '));
          template = { ...stored, layout: draft };
        }
        return renderDocument(
          env,
          model,
          template,
          fields,
          { ids, ...(filter === undefined ? {} : { filter }) },
          format,
        );
      },
      { write: true },
    );
    await reply
      .type(file.mime)
      .header(
        'content-disposition',
        `${format === 'html' ? 'inline' : 'attachment'}; filename="${file.filename}"`,
      )
      .send(file.content);
  });

  app.post('/api/v1/reports/schedules/:id/run', async (request) => {
    const id = positive((request.params as { id?: unknown }).id, 'id');
    return request.env(async (env) => {
      try {
        return { output: await engine.run(env, id) };
      } catch (error) {
        if (error instanceof ReportError) throw bad(error.message);
        throw error;
      }
    });
  });

  app.get('/api/v1/reports/outputs/:id/download', async (request, reply) => {
    const id = positive((request.params as { id?: unknown }).id, 'id');
    const file = await request.env(async (env) => {
      const set = await ref(env, 'report.output').search({ where: { id } });
      if (set.length === 0)
        throw new HttpProblem(404, 'missing-record', 'Not found', `No output ${id}.`);
      const [row] = (await set.load(['filename', 'mime', 'content'])).read([
        'filename',
        'mime',
        'content',
      ]);
      return row as { filename: string; mime: string; content: Uint8Array };
    });
    await reply
      .type(file.mime)
      .header('content-disposition', `attachment; filename="${file.filename}"`)
      .send(Buffer.from(file.content));
  });

  // New schedules get their next run from the cadence (unless given); a changed cadence is replanned by the ticker.
  app.addHook('preHandler', async (request) => {
    const path = request.url.split('?')[0] ?? '';
    if (
      !/^\/api\/v1\/models\/report\.schedule(\/\d+)?$/.test(path) ||
      (request.method !== 'POST' && request.method !== 'PATCH')
    )
      return;
    const body = bodyOf(request);
    const cadence = ['frequency', 'hour', 'day', 'tz'].some((k) => body[k] !== undefined);
    if (body['nextRunAt'] !== undefined) return;
    if (request.method === 'POST') {
      const spec = { frequency: 'monthly', hour: 8, day: 1, tz: 'UTC', ...body } as {
        frequency: 'daily' | 'weekly' | 'monthly';
        hour: number;
        day: number;
        tz: string;
      };
      body['nextRunAt'] = ScheduleEngine.plan(spec).toISOString();
    } else if (cadence) body['nextRunAt'] = null; // the ticker plans it from the stored cadence
  });

  // Validate template layouts when saved through the generated API (designers): a broken binding is refused.
  app.addHook('preHandler', async (request) => {
    if (
      !/^\/api\/v1\/models\/report\.template(\/\d+)?$/.test(request.url.split('?')[0] ?? '') ||
      (request.method !== 'POST' && request.method !== 'PATCH')
    )
      return;
    const body = bodyOf(request);
    if (body['layout'] === undefined) return;
    const model = String(body['targetModel'] ?? '');
    if (model !== '' && !models.has(model)) throw bad(`The model '${model}' is not installed.`);
    if (model !== '') {
      const problems = layoutProblems(body['layout'] as Layout, model, fields);
      if (problems.length > 0) throw bad(problems.join('; '));
    }
  });
  return engine;
}

export type { Header };
