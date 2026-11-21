/**
 * Document numbering (RFC 0020 §3.3), for Administrators, per company, through Shutro's `env.sequenceAdmin`
 * (request #31): every sequence the installed apps declare, with what its numbers look like, when the counter
 * restarts and the next number, previewed as a document would carry it.
 *
 * - `GET  /api/v1/settings/numbering`                 the apps with their sequences, for the current company
 * - `POST /api/v1/settings/numbering/:code/preview`   `{ format, next? }` → what that would give; changes nothing
 * - `PUT  /api/v1/settings/numbering/:code`           `{ format, next? }`: `format` null goes back to the app's own
 *
 * Shutro validates a format like a definition, refuses a next number below one already issued, and audits each
 * change; the change is also in the audit log of Settings, in words.
 */
import type { KoshModule } from '@kosh/modules-sdk';
import { audit, HttpProblem, type ModuleContext } from '@kosh/server';
import type { Env } from '@kosh/server/orm';
import { orm } from '@kosh/server/orm';

const RESETS = ['never', 'yearly', 'monthly', 'daily'] as const;
type Reset = (typeof RESETS)[number];
interface Format {
  prefix?: string;
  suffix?: string;
  padding?: number;
  reset?: Reset;
}

/** What the screen sends as a format: each part given is checked here for its kind; Shutro checks its meaning. */
function formatOf(raw: unknown): Format | null {
  if (raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw))
    throw new HttpProblem(400, 'invalid-body', 'Invalid format', 'format: an object, or null.');
  const given = raw as Record<string, unknown>;
  const out: Format = {};
  for (const key of ['prefix', 'suffix'] as const) {
    const value = given[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string')
      throw new HttpProblem(422, 'invalid-format', 'Another look', `${key}: text.`);
    out[key] = value;
  }
  if (given['padding'] !== undefined && given['padding'] !== null) {
    if (!Number.isInteger(given['padding']))
      throw new HttpProblem(422, 'invalid-format', 'Another look', 'padding: a whole number.');
    out.padding = given['padding'] as number;
  }
  if (given['reset'] !== undefined && given['reset'] !== null) {
    if (!RESETS.includes(given['reset'] as Reset))
      throw new HttpProblem(
        422,
        'invalid-format',
        'Another look',
        `reset: one of ${RESETS.join(', ')}.`,
      );
    out.reset = given['reset'] as Reset;
  }
  return out;
}

/** Shutro's refusals, as the API says them. */
function refused(error: unknown): never {
  if (error instanceof orm.InvalidSequenceError || error instanceof orm.ValidationError)
    throw new HttpProblem(422, 'invalid-numbering', 'Another look', error.message);
  throw error;
}

export function registerNumberingRoutes(context: ModuleContext): void {
  const { app, registry } = context;
  const modules = registry.loaded.modules as readonly KoshModule[];
  /** Each sequence: the app that declares it, and the documents it numbers. */
  const owners = new Map<string, { app: string; label: string }>();
  // Read from Shutro's registry: the modules as loaded, with the sequences they declare and their models.
  const loaded = context.shutro.registry?.modules ?? [];
  for (const m of loaded)
    for (const s of m.sequences) owners.set(s.code, { app: m.name, label: s.code });
  for (const m of loaded)
    for (const model of m.models)
      for (const field of Object.values(
        model.fields as Record<string, { sequence?: { code: string } }>,
      )) {
        const owner = field.sequence === undefined ? undefined : owners.get(field.sequence.code);
        if (owner !== undefined && owner.label === field.sequence?.code)
          owner.label = (model as { label?: string }).label ?? model.name;
      }
  const appOf = (name: string) => {
    const m = modules.find((x) => x.name === name);
    return { label: m?.app?.label ?? name, icon: m?.app?.icon ?? null };
  };
  const administrators = (env: Env): void => {
    if (!env.administrator)
      throw new HttpProblem(
        403,
        'access',
        'Administrators only',
        'Document numbering is an Administrator’s to read and change.',
      );
  };
  type Described = Awaited<ReturnType<Env['sequenceAdmin']['describe']>>[number];
  const shape = (d: Described) => ({
    code: d.code,
    label: owners.get(d.code)?.label ?? d.code,
    gapless: d.declared.gapless,
    declared: {
      prefix: d.declared.prefix,
      suffix: d.declared.suffix,
      padding: d.declared.padding,
      reset: d.declared.reset,
    },
    format: {
      prefix: d.effective.prefix,
      suffix: d.effective.suffix,
      padding: d.effective.padding,
      reset: d.effective.reset,
    },
    changed: d.format !== null,
    period: d.period,
    next: d.next,
    preview: d.preview,
  });
  const codeOf = (params: unknown): string => {
    const code = String((params as { code?: unknown }).code ?? '');
    if (!owners.has(code))
      throw new HttpProblem(404, 'missing-record', 'Not found', `There is no sequence ${code}.`);
    return code;
  };
  const nextOf = (body: { next?: unknown }): number | undefined => {
    if (body.next === undefined || body.next === null || body.next === '') return undefined;
    const next = Number(body.next);
    if (!Number.isSafeInteger(next) || next < 0)
      throw new HttpProblem(422, 'invalid-numbering', 'Another look', 'next: a whole number.');
    return next;
  };

  app.get('/api/v1/settings/numbering', async (request) =>
    request.env(async (env) => {
      administrators(env);
      const described = await env.sequenceAdmin.describe();
      const byApp = new Map<string, ReturnType<typeof shape>[]>();
      for (const d of described) {
        const owner = owners.get(d.code);
        if (owner === undefined) continue;
        byApp.set(owner.app, [...(byApp.get(owner.app) ?? []), shape(d)]);
      }
      return {
        company: env.companyId,
        apps: [...byApp.entries()]
          .map(([name, sequences]) => ({
            app: name,
            ...appOf(name),
            sequences: sequences.sort((a, b) => a.label.localeCompare(b.label)),
          }))
          .sort((a, b) => a.label.localeCompare(b.label)),
      };
    }),
  );

  app.post('/api/v1/settings/numbering/:code/preview', async (request) => {
    const code = codeOf(request.params);
    const body = (request.body ?? {}) as { format?: unknown; next?: unknown };
    const format = formatOf(body.format ?? null);
    const next = nextOf(body);
    return request.env(async (env) => {
      administrators(env);
      return shape(
        await env.sequenceAdmin
          .preview(code, format, next === undefined ? {} : { next })
          .catch(refused),
      );
    });
  });

  app.put('/api/v1/settings/numbering/:code', async (request) => {
    const code = codeOf(request.params);
    const body = (request.body ?? {}) as { format?: unknown; next?: unknown };
    if (!('format' in body))
      throw new HttpProblem(400, 'invalid-body', 'Invalid request', 'format: an object, or null.');
    const format = formatOf(body.format);
    const next = nextOf(body);
    return request.env(
      async (env) => {
        administrators(env);
        const [before] = await env.sequenceAdmin.describe({ codes: [code] });
        let after = await env.sequenceAdmin.setFormat(code, format).catch(refused);
        // The next number, when it is asked to move: Shutro refuses one below what was issued.
        if (next !== undefined && next !== after.next)
          after = await env.sequenceAdmin.setNext(code, next).catch(refused);
        const owner = owners.get(code);
        await audit(env, {
          kind: 'settings.numbering',
          summary: `${appOf(owner?.app ?? '').label} › Numbering › ${owner?.label ?? code}: the next is ${after.preview}${before === undefined || before.preview === after.preview ? '' : ` (was ${before.preview})`}.`,
          details: { code, format, next: after.next, was: before?.preview ?? null },
          ip: request.ip,
        });
        return shape(after);
      },
      { write: true },
    );
  });
}
