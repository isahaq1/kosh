/**
 * App settings (RFC 0020): each app's own settings, declared in its manifest (`settings.sections`), shown and saved
 * here. A `company` section names `res.company` fields the app adds (their type, label and default come from Shutro);
 * an `installation` section keeps key / values in `kosh.setting`. Seeing an app's settings needs access to the app;
 * changing a section needs one of its `editors` or the Administrator role. Every change is audited with the old and
 * new values. Declarations are checked when the server starts.
 *
 * - `GET   /api/v1/settings/app-settings`                       the apps with settings the user may see
 * - `GET   /api/v1/settings/app-settings/:app`                  its sections, values, defaults, what may be changed
 * - `PATCH /api/v1/settings/app-settings/:app/:section`         `{ values: { key: value } }`
 * - `POST  /api/v1/settings/app-settings/:app/:section/reset`   `{ keys }`: back to the defaults
 * - `GET   /api/v1/settings/app-settings/:app/:section/history?key=`  who changed what and when (the audit log)
 * - `POST  /api/v1/settings/app-settings/copy`     `{ from, to, sections?, preview? }`: a company's settings to another
 * - `GET   /api/v1/settings/app-settings/export`   the installation's and the current company's settings as a file
 * - `POST  /api/v1/settings/app-settings/import`   `{ file, preview? }`: such a file, checked, into the current company
 * Copy, export and import are for administrators; every change they make is audited like a change by hand.
 */
import type { KoshModule, SettingFieldSpec, SettingsSectionSpec } from '@kosh/modules-sdk';
import {
  type ApiField,
  audit,
  HttpProblem,
  type ModuleContext,
  publicApiModels,
  ServerConfigError,
} from '@kosh/server';
import type { Env } from '@kosh/server/orm';
import type { FastifyRequest } from 'fastify';

type Row = Record<string, unknown>;
type Value = string | number | boolean | null;
interface Records {
  readonly length: number;
  readonly ids: readonly number[];
  load(keys: readonly string[]): Promise<Records>;
  read(keys: readonly string[]): Row[];
  write(values: Row): Promise<void>;
  unlink(): Promise<void>;
}
interface Ref {
  search(q: unknown): Promise<Records>;
  browse(ids: readonly number[]): Records;
  create(rows: readonly Row[]): Promise<Records>;
}
const ref = (env: Env, name: string) => env.model(name as never) as unknown as Ref;

const TYPES = new Set(['boolean', 'integer', 'decimal', 'char', 'text', 'selection', 'date']);
/** Company field kinds a setting may be. */
const KINDS: Readonly<Record<string, SettingFieldSpec['type'] & string>> = {
  boolean: 'boolean',
  integer: 'integer',
  decimal: 'decimal',
  monetary: 'decimal',
  float: 'decimal',
  char: 'char',
  text: 'text',
  selection: 'selection',
  date: 'date',
};

/** A setting as the screens and the checks see it, whatever its scope. */
interface Setting {
  readonly key: string;
  readonly type: NonNullable<SettingFieldSpec['type']>;
  readonly label: string;
  readonly help: string | null;
  readonly default: Value;
  readonly min: number | null;
  readonly max: number | null;
  readonly options: readonly { readonly value: string; readonly label: string }[] | null;
  readonly visibleWhen: NonNullable<SettingFieldSpec['visibleWhen']> | null;
}
interface Section {
  readonly app: string;
  readonly spec: SettingsSectionSpec;
  readonly settings: readonly Setting[];
}

export function registerAppSettingsRoutes(context: ModuleContext): void {
  const { app, registry } = context;
  const modules = registry.loaded.modules as readonly KoshModule[];
  const company = publicApiModels(registry).get('res.company');
  const companyFields = new Map((company?.fields ?? []).map((f) => [f.key, f] as const));
  const descriptors = registry.registry.get('res.company').model.fields as unknown as Readonly<
    Record<string, Record<string, unknown>>
  >;
  const groups = registry.registry.security.groups;

  // ---- the declarations, checked once at start: a wrong one stops the server, like other manifest errors.
  const fail = (module: string, detail: string) =>
    new ServerConfigError(
      `The settings of ${module}: ${detail}`,
      'Fix the module’s settings declaration.',
    );
  const fromField = (
    module: string,
    spec: SettingFieldSpec,
    field: ApiField | undefined,
  ): Setting => {
    if (field === undefined || !field.stored)
      throw fail(
        module,
        `'${spec.key}' is not a stored res.company field (add it with extendModel).`,
      );
    const type = KINDS[field.kind];
    if (type === undefined)
      throw fail(module, `'${spec.key}' is a ${field.kind} field: not a setting type.`);
    const raw = descriptors[spec.key]?.['default'];
    return {
      key: spec.key,
      type,
      label: spec.label ?? field.label,
      help: spec.help ?? null,
      default:
        spec.default !== undefined
          ? spec.default
          : typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean'
            ? raw
            : null,
      min: spec.min ?? null,
      max: spec.max ?? null,
      options:
        field.options === null ? null : field.options.map(([value, label]) => ({ value, label })),
      visibleWhen: spec.visibleWhen ?? null,
    };
  };
  const ownSetting = (module: string, spec: SettingFieldSpec): Setting => {
    if (spec.type === undefined || !TYPES.has(spec.type) || spec.label === undefined)
      throw fail(module, `'${spec.key}' needs a type and a label (an installation setting).`);
    if (spec.type === 'selection' && spec.options === undefined)
      throw fail(module, `'${spec.key}' is a selection without options.`);
    return {
      key: spec.key,
      type: spec.type,
      label: spec.label,
      help: spec.help ?? null,
      default: spec.default ?? null,
      min: spec.min ?? null,
      max: spec.max ?? null,
      options:
        spec.options === undefined
          ? null
          : Object.entries(spec.options).map(([value, label]) => ({ value, label })),
      visibleWhen: spec.visibleWhen ?? null,
    };
  };
  const sections: Section[] = [];
  const seen = new Set<string>();
  for (const m of modules)
    for (const spec of m.settings?.sections ?? []) {
      if (!/^[a-z][a-z0-9_]*$/.test(spec.key)) throw fail(m.name, `the section key '${spec.key}'.`);
      if (seen.has(`${m.name}.${spec.key}`)) throw fail(m.name, `two sections '${spec.key}'.`);
      seen.add(`${m.name}.${spec.key}`);
      for (const g of spec.editors ?? [])
        if (!groups.has(g)) throw fail(m.name, `the editor group '${g}' is not defined.`);
      const keys = new Set<string>();
      const settings = spec.fields.map((f) => {
        if (keys.has(f.key)) throw fail(m.name, `'${f.key}' twice in '${spec.key}'.`);
        keys.add(f.key);
        return spec.scope === 'company'
          ? fromField(m.name, f, companyFields.get(f.key))
          : ownSetting(m.name, f);
      });
      for (const s of settings)
        if (s.visibleWhen !== null && !keys.has(s.visibleWhen.key))
          throw fail(m.name, `'${s.key}' depends on '${s.visibleWhen.key}', not in its section.`);
      sections.push({ app: m.name, spec, settings });
    }

  /** The groups that open an app: its access levels' groups. */
  const openers = new Map(
    modules.map((m) => [
      m.name,
      new Set(Object.values(m.accessLevels ?? {}).flatMap((l) => [...l.groups])),
    ]),
  );
  const mayView = (env: Env, module: string) =>
    env.administrator || [...(openers.get(module) ?? [])].some((g) => env.groups.has(g));
  const mayEdit = (env: Env, section: Section) =>
    env.administrator || (section.spec.editors ?? []).some((g) => env.groups.has(g));
  const label = (module: string) => {
    const m = modules.find((x) => x.name === module);
    return { label: m?.app?.label ?? module, icon: m?.app?.icon ?? null };
  };
  const storedKey = (section: Section, key: string) => `${section.app}.${key}`;

  /** The current values of a section: the company's fields, or the installation's records. */
  const valuesOf = async (
    su: Env,
    section: Section,
    companyId: number,
  ): Promise<Record<string, Value>> => {
    if (section.spec.scope === 'company') {
      const keys = section.settings.map((s) => s.key);
      const [row] = (await ref(su, 'res.company').browse([companyId]).load(keys)).read(keys);
      return Object.fromEntries(keys.map((k) => [k, normalize(row?.[k])]));
    }
    const found = await ref(su, 'kosh.setting').search({
      where: { key: { in: section.settings.map((s) => storedKey(section, s.key)) } },
    });
    const rows =
      found.length === 0 ? [] : (await found.load(['key', 'value'])).read(['key', 'value']);
    const stored = new Map(rows.map((r) => [String(r['key']), r['value'] as Value]));
    return Object.fromEntries(
      section.settings.map((s) => [
        s.key,
        stored.has(storedKey(section, s.key))
          ? (stored.get(storedKey(section, s.key)) as Value)
          : s.default,
      ]),
    );
  };

  /** A value checked against its setting. @throws {HttpProblem} 422 */
  const check = (s: Setting, value: unknown): Value => {
    const bad = (detail: string) =>
      new HttpProblem(422, 'invalid-setting', 'Invalid setting', `${s.label}: ${detail}`);
    if (value === null || value === '') {
      if (s.type === 'boolean') throw bad('yes or no.');
      return null;
    }
    switch (s.type) {
      case 'boolean':
        if (typeof value !== 'boolean') throw bad('yes or no.');
        return value;
      case 'integer': {
        if (!Number.isSafeInteger(value)) throw bad('a whole number.');
        const n = value as number;
        if ((s.min !== null && n < s.min) || (s.max !== null && n > s.max))
          throw bad(`from ${s.min ?? '…'} to ${s.max ?? '…'}.`);
        return n;
      }
      case 'decimal': {
        // Money and quantities stay strings (Shutro Decimal), never JS numbers.
        const text = typeof value === 'number' ? String(value) : String(value);
        if (!/^-?\d+(\.\d+)?$/.test(text)) throw bad('a number.');
        return text;
      }
      case 'selection':
        if (typeof value !== 'string' || !(s.options ?? []).some((o) => o.value === value))
          throw bad('one of the choices.');
        return value;
      case 'date':
        if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
          throw bad('a date (YYYY-MM-DD).');
        return value;
      default:
        if (typeof value !== 'string' || value.length > (s.type === 'char' ? 500 : 20_000))
          throw bad('text.');
        return value;
    }
  };

  const sectionOf = (request: FastifyRequest) => {
    const { app: module, section } = request.params as { app?: string; section?: string };
    const found = sections.find((s) => s.app === module && s.spec.key === section);
    if (found === undefined)
      throw new HttpProblem(
        404,
        'missing-record',
        'Not found',
        `There are no settings ${module}/${section}.`,
      );
    return found;
  };
  const shape = (section: Section, values: Record<string, Value>, editable: boolean) => ({
    key: section.spec.key,
    label: section.spec.label,
    description: section.spec.description ?? null,
    scope: section.spec.scope,
    editable,
    settings: section.settings.map((s) => ({
      ...s,
      value: values[s.key] ?? null,
      changed: (values[s.key] ?? null) !== s.default,
    })),
  });

  app.get('/api/v1/settings/app-settings', async (request) =>
    request.env(async (env) => {
      const apps = [...new Set(sections.map((s) => s.app))].filter((m) => mayView(env, m));
      return {
        administrator: env.administrator,
        apps: apps.map((m) => ({
          app: m,
          ...label(m),
          sections: sections
            .filter((s) => s.app === m)
            .map((s) => ({
              key: s.spec.key,
              label: s.spec.label,
              description: s.spec.description ?? null,
              keywords: [s.spec.keywords ?? '', ...s.settings.map((x) => x.label)].join(' '),
            })),
        })),
      };
    }),
  );

  app.get('/api/v1/settings/app-settings/:app', async (request) => {
    const module = (request.params as { app?: string }).app ?? '';
    return request.env(
      async (env) => {
        const mine = sections.filter((s) => s.app === module);
        if (mine.length === 0 || !mayView(env, module))
          throw new HttpProblem(
            404,
            'missing-record',
            'Not found',
            `There are no settings for ${module}.`,
          );
        return env.asSuperuser({ reason: 'app settings' }, async (su) => ({
          app: module,
          ...label(module),
          company: env.companyId,
          sections: await Promise.all(
            mine.map(async (s) => shape(s, await valuesOf(su, s, env.companyId), mayEdit(env, s))),
          ),
        }));
      },
      { write: true }, // the superuser read is audited
    );
  });

  type Changes = Record<string, { from: Value; to: Value }>;
  /** Writes `changes` to the section's store for `companyId` and audits them with the old and new values. */
  const apply = async (
    env: Env,
    su: Env,
    section: Section,
    changes: Changes,
    companyId: number,
    how: string,
    extra: Row,
    ip: string,
  ): Promise<void> => {
    if (section.spec.scope === 'company')
      await ref(su, 'res.company')
        .browse([companyId])
        .write(Object.fromEntries(Object.entries(changes).map(([k, c]) => [k, c.to])));
    else
      for (const [k, c] of Object.entries(changes)) {
        const key = storedKey(section, k);
        const existing = await ref(su, 'kosh.setting').search({ where: { key } });
        if (existing.length > 0) await existing.write({ value: c.to });
        else await ref(su, 'kosh.setting').create([{ key, value: c.to }]);
      }
    await audit(env, {
      kind: 'settings.changed',
      summary: `${label(section.app).label} › ${section.spec.label}: ${Object.keys(changes).join(', ')} ${how}.`,
      details: {
        app: section.app,
        section: section.spec.key,
        scope: section.spec.scope,
        changes,
        ...extra,
      },
      company: companyId,
      ip,
    });
  };

  /** Writes `next` (only the keys that changed), audited with the old and new values. */
  const save = (
    request: FastifyRequest,
    section: Section,
    next: (old: Record<string, Value>) => Record<string, Value>,
  ) =>
    request.env(
      async (env) => {
        if (!mayView(env, section.app) || !mayEdit(env, section))
          throw new HttpProblem(
            403,
            'access',
            'App settings',
            `Changing ${section.spec.label} needs ${
              (section.spec.editors ?? []).length === 0
                ? 'the Administrator role'
                : `one of: ${(section.spec.editors ?? []).join(', ')}`
            }.`,
          );
        return env.asSuperuser({ reason: 'app settings' }, async (su) => {
          const old = await valuesOf(su, section, env.companyId);
          const wanted = next(old);
          const changes = Object.fromEntries(
            Object.entries(wanted)
              .filter(([k, v]) => old[k] !== v)
              .map(([k, v]) => [k, { from: old[k] ?? null, to: v }]),
          );
          if (Object.keys(changes).length > 0) {
            await apply(env, su, section, changes, env.companyId, 'changed', {}, request.ip);
            await su.flush();
          }
          return shape(section, { ...old, ...wanted }, true);
        });
      },
      { write: true },
    );

  app.patch('/api/v1/settings/app-settings/:app/:section', async (request) => {
    const section = sectionOf(request);
    const body = (request.body ?? {}) as Row;
    const values = body['values'];
    if (typeof values !== 'object' || values === null || Array.isArray(values))
      throw new HttpProblem(422, 'invalid-setting', 'Invalid setting', 'values is { key: value }.');
    const checked: Record<string, Value> = {};
    for (const [key, value] of Object.entries(values as Row)) {
      const s = section.settings.find((x) => x.key === key);
      if (s === undefined)
        throw new HttpProblem(
          422,
          'invalid-setting',
          'Invalid setting',
          `'${key}' is not in ${section.spec.label}.`,
        );
      checked[key] = check(s, value);
    }
    return save(request, section, () => checked);
  });

  app.post('/api/v1/settings/app-settings/:app/:section/reset', async (request) => {
    const section = sectionOf(request);
    const keys = (request.body as Row | null)?.['keys'];
    const chosen = Array.isArray(keys) ? keys.map(String) : section.settings.map((s) => s.key);
    const defaults: Record<string, Value> = {};
    for (const key of chosen) {
      const s = section.settings.find((x) => x.key === key);
      if (s === undefined)
        throw new HttpProblem(
          422,
          'invalid-setting',
          'Invalid setting',
          `'${key}' is not in ${section.spec.label}.`,
        );
      defaults[key] = s.default;
    }
    return save(request, section, () => defaults);
  });

  // ---- step 2: history, copy between companies, export and import.
  const administrators = (env: Env): void => {
    if (!env.administrator)
      throw new HttpProblem(403, 'access', 'App settings', 'This needs the Administrator role.');
  };
  /** Whether `companyId` is one of the user's companies. */
  const memberOf = async (su: Env, uid: number, companyId: number): Promise<boolean> =>
    (
      await ref(su, 'res.users').search({
        where: { id: uid, companies: { any: { id: companyId } } },
      })
    ).length > 0;
  const companyOf = async (su: Env, id: number): Promise<{ id: number; name: string }> => {
    const [row] = (await ref(su, 'res.company').browse([id]).load(['name'])).read(['name']);
    if (row === undefined)
      throw new HttpProblem(404, 'missing-record', 'Not found', `There is no company ${id}.`);
    return { id, name: String(row['name']) };
  };
  const sectionKey = (s: Section) => `${s.app}.${s.spec.key}`;
  const describeChanges = (s: Section, changes: Changes) => ({
    app: s.app,
    appLabel: label(s.app).label,
    section: s.spec.key,
    label: s.spec.label,
    scope: s.spec.scope,
    changes: Object.entries(changes).map(([key, c]) => ({
      key,
      label: s.settings.find((x) => x.key === key)?.label ?? key,
      from: c.from,
      to: c.to,
    })),
  });

  app.get('/api/v1/settings/app-settings/export', async (request) =>
    request.env(
      async (env) => {
        administrators(env);
        return env.asSuperuser({ reason: 'app settings export' }, async (su) => {
          const installation: Record<string, Record<string, Value>> = {};
          const companySettings: Record<string, Record<string, Value>> = {};
          for (const s of sections)
            (s.spec.scope === 'company' ? companySettings : installation)[sectionKey(s)] =
              await valuesOf(su, s, env.companyId);
          await audit(env, {
            kind: 'settings.exported',
            summary: 'App settings exported.',
            ip: request.ip,
          });
          return {
            kosh: 'app-settings',
            version: 1,
            exportedAt: new Date().toISOString(),
            company: await companyOf(su, env.companyId),
            installation,
            companySettings,
          };
        });
      },
      { write: true },
    ),
  );

  app.get('/api/v1/settings/app-settings/:app/:section/history', async (request) => {
    const section = sectionOf(request);
    const key = (request.query as { key?: string }).key;
    return request.env(
      async (env) => {
        if (!mayView(env, section.app))
          throw new HttpProblem(404, 'missing-record', 'Not found', 'There are no such settings.');
        return env.asSuperuser({ reason: 'app settings history' }, async (su) => {
          const found = await ref(su, 'audit.event').search({
            where: {
              kind: 'settings.changed',
              ...(section.spec.scope === 'company' ? { company: env.companyId } : {}),
            },
            order: ['id desc'],
            limit: 500,
          });
          const rows =
            found.length === 0
              ? []
              : (await found.load(['actor', 'createdAt', 'details'])).read([
                  'actor',
                  'createdAt',
                  'details',
                ]);
          const events = rows
            .map((r) => {
              const details = (r['details'] ?? {}) as {
                app?: string;
                section?: string;
                changes?: Changes;
                copiedFrom?: number;
                imported?: boolean;
              };
              const actor = r['actor'] as number | { id: number; name?: string } | null;
              return {
                actor: typeof actor === 'object' && actor !== null ? actor.id : actor,
                actorName:
                  typeof actor === 'object' && actor !== null ? (actor.name ?? null) : null,
                at:
                  r['createdAt'] instanceof Date
                    ? r['createdAt'].toISOString()
                    : String(r['createdAt']),
                details,
              };
            })
            .filter(
              (e) =>
                e.details.app === section.app &&
                e.details.section === section.spec.key &&
                (key === undefined || key in (e.details.changes ?? {})),
            )
            .slice(0, 50);
          const unnamed = [
            ...new Set(
              events
                .filter((e) => e.actor !== null && e.actorName === null)
                .map((e) => e.actor as number),
            ),
          ];
          const users = ref(su, 'res.users').browse(unnamed);
          const names = new Map(
            unnamed.length === 0
              ? []
              : (await users.load(['name']))
                  .read(['name'])
                  .map((r, i) => [users.ids[i] as number, String(r['name'])] as const),
          );
          return {
            events: events.map((e) => ({
              at: e.at,
              actor:
                e.actor === null
                  ? null
                  : { id: e.actor, name: e.actorName ?? names.get(e.actor) ?? String(e.actor) },
              how:
                e.details.copiedFrom !== undefined
                  ? 'copied'
                  : e.details.imported === true
                    ? 'imported'
                    : 'changed',
              changes: Object.entries(e.details.changes ?? {})
                .filter(([k]) => key === undefined || k === key)
                .map(([k, c]) => ({
                  key: k,
                  label: section.settings.find((x) => x.key === k)?.label ?? k,
                  from: c.from,
                  to: c.to,
                })),
            })),
          };
        });
      },
      { write: true },
    );
  });

  app.post('/api/v1/settings/app-settings/copy', async (request) => {
    const body = (request.body ?? {}) as Row;
    const from = Number(body['from']);
    const to = Number(body['to']);
    const preview = body['preview'] === true;
    const chosen = Array.isArray(body['sections']) ? body['sections'].map(String) : null;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from === to)
      throw new HttpProblem(422, 'invalid-copy', 'Copy settings', 'Give two different companies.');
    return request.env(
      async (env) => {
        administrators(env);
        return env.asSuperuser({ reason: 'app settings copy' }, async (su) => {
          for (const c of [from, to])
            if (!(await memberOf(su, env.uid, c)))
              throw new HttpProblem(
                403,
                'access',
                'Copy settings',
                `Company ${c} is not one of yours.`,
              );
          const source = await companyOf(su, from);
          const target = await companyOf(su, to);
          const picked = sections.filter(
            (s) =>
              s.spec.scope === 'company' && (chosen === null || chosen.includes(sectionKey(s))),
          );
          const out = [];
          for (const s of picked) {
            const a = await valuesOf(su, s, from);
            const b = await valuesOf(su, s, to);
            const changes: Changes = Object.fromEntries(
              s.settings
                .filter((x) => (a[x.key] ?? null) !== (b[x.key] ?? null))
                .map((x) => [x.key, { from: b[x.key] ?? null, to: a[x.key] ?? null }]),
            );
            if (Object.keys(changes).length === 0) continue;
            out.push(describeChanges(s, changes));
            if (!preview)
              await apply(
                env,
                su,
                s,
                changes,
                to,
                `copied from ${source.name}`,
                { copiedFrom: from },
                request.ip,
              );
          }
          if (!preview) await su.flush();
          return { preview, from: source, to: target, sections: out };
        });
      },
      { write: true },
    );
  });

  app.post('/api/v1/settings/app-settings/import', async (request) => {
    const body = (request.body ?? {}) as Row;
    const file = body['file'] as Row | null | undefined;
    const preview = body['preview'] === true;
    if (typeof file !== 'object' || file === null || file['kosh'] !== 'app-settings')
      throw new HttpProblem(422, 'invalid-file', 'Import settings', 'Not an app settings export.');
    const given: [SettingsSectionSpec['scope'], unknown][] = [
      ['installation', file['installation']],
      ['company', file['companySettings']],
    ];
    return request.env(
      async (env) => {
        administrators(env);
        return env.asSuperuser({ reason: 'app settings import' }, async (su) => {
          const skipped: string[] = [];
          const plan: { section: Section; changes: Changes }[] = [];
          for (const [scope, part] of given) {
            if (typeof part !== 'object' || part === null) continue;
            for (const [k, values] of Object.entries(part as Row)) {
              const s = sections.find((x) => sectionKey(x) === k && x.spec.scope === scope);
              if (s === undefined || typeof values !== 'object' || values === null) {
                skipped.push(k);
                continue;
              }
              const current = await valuesOf(su, s, env.companyId);
              const changes: Changes = {};
              for (const [key, value] of Object.entries(values as Row)) {
                const setting = s.settings.find((x) => x.key === key);
                if (setting === undefined) {
                  skipped.push(`${k}.${key}`);
                  continue;
                }
                const checked = check(setting, value);
                if (checked !== (current[key] ?? null))
                  changes[key] = { from: current[key] ?? null, to: checked };
              }
              if (Object.keys(changes).length > 0) plan.push({ section: s, changes });
            }
          }
          if (!preview) {
            for (const { section, changes } of plan)
              await apply(
                env,
                su,
                section,
                changes,
                env.companyId,
                'imported',
                { imported: true },
                request.ip,
              );
            await su.flush();
          }
          return {
            preview,
            skipped,
            sections: plan.map(({ section, changes }) => describeChanges(section, changes)),
          };
        });
      },
      { write: true },
    );
  });
}

/** Database values as settings carry them: dates as YYYY-MM-DD, decimals as strings. */
function normalize(value: unknown): Value {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return value;
  return String(value);
}
