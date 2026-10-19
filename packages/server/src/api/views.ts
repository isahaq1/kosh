/**
 * Views, actions and searches (RFC 0004): collected from the manifests, extended by anchors in dependency order,
 * validated against the installed models when the server starts, and served per user: fields the user may not read
 * are removed, fields they may not write are marked read-only, and buttons for transitions they may not run are
 * dropped (RFC 0003). The server re-checks every write anyway; this keeps the UI honest, not secure.
 *
 * - `GET /api/v1/views/:id`                       one view, for the user, with the metadata of its fields
 * - `GET /api/v1/views?model=&type=`              the model's view of that type
 * - `GET /api/v1/search/:model`                   the search definition, for the user
 */
import type { KoshModule } from '@isahaq/kosh-modules-sdk';
import {
  type ButtonNode,
  type FieldNode,
  type FormNode,
  type MeasureNode,
  type ResolvedView,
  resolveView,
  type SearchSpec,
  type ViewDefinition,
  type ViewType,
  validateAction,
  validateSearch,
  validateView,
  type WindowAction,
} from '@isahaq/kosh-views';
import type { FastifyInstance } from 'fastify';
import { HttpProblem, ServerConfigError } from '../errors.js';
import type { Env } from '../orm.js';
import type { ApiField, ApiModel } from './metadata.js';

/** A field as the UI needs it to render and edit. */
export interface ViewField {
  readonly key: string;
  readonly kind: string;
  readonly label: string;
  readonly required: boolean;
  readonly readonly: boolean;
  readonly target?: string;
  readonly options?: readonly { readonly value: string; readonly label: string }[];
}

/** What `GET /api/v1/views/:id` returns. */
export interface ServedView {
  readonly view: ViewDefinition;
  /** Model → field key → metadata, for every field the view shows (including line columns). */
  readonly fields: Readonly<Record<string, Readonly<Record<string, ViewField>>>>;
  /** Transitions of the model the user may run, with their source and target states. */
  readonly transitions: readonly {
    name: string;
    field: string;
    from: readonly string[];
    to: string;
  }[];
  /** The view's model may be written, created, deleted by the user. */
  readonly operations: {
    readonly create: boolean;
    readonly write: boolean;
    readonly unlink: boolean;
  };
  /** Fields whose changes run the model's onchange (form assistance). */
  readonly onchange: readonly string[];
}

const VIEW_TYPES: readonly string[] = [
  'list',
  'form',
  'kanban',
  'pivot',
  'graph',
  'calendar',
  'gantt',
  'map',
  'hierarchy',
  'cohort',
  'spreadsheet',
  'dashboard',
  'designer',
];

function config(problem: string): ServerConfigError {
  return new ServerConfigError(problem, 'Fix the module manifest (views, actions, search).');
}

/** The views, actions and searches of a loaded module set. */
export class ViewRegistry {
  readonly views: ReadonlyMap<string, ResolvedView>;
  readonly actions: ReadonlyMap<string, WindowAction>;
  readonly searches: ReadonlyMap<string, SearchSpec>;
  readonly #models: ReadonlyMap<string, ApiModel>;

  /** @throws {ServerConfigError} for invalid or conflicting views, actions and searches */
  constructor(modules: readonly KoshModule[], models: ReadonlyMap<string, ApiModel>) {
    this.#models = models;
    const lookup = (name: string) => {
      const m = models.get(name);
      return m === undefined
        ? undefined
        : {
            fields: new Map(
              m.fields.map((f) => [f.key, { kind: f.kind, target: f.target, stored: f.stored }]),
            ),
            transitions: m.transitions,
          };
    };
    const owners = new Map<string, string>();
    const raw = new Map<string, ViewDefinition>();
    for (const m of modules)
      for (const [id, view] of Object.entries(m.views ?? {})) {
        const owner = owners.get(id);
        if (owner !== undefined)
          throw config(`Modules ${owner} and ${m.name} both define the view '${id}'.`);
        owners.set(id, m.name);
        raw.set(id, { ...view, id });
      }
    const extensions = modules.flatMap((m) =>
      (m.viewExtensions ?? []).map((extension) => {
        if (!raw.has(extension.view))
          throw config(`Module ${m.name} extends the unknown view '${extension.view}'.`);
        return { module: m.name, extension };
      }),
    );
    const views = new Map<string, ResolvedView>();
    for (const [id, view] of raw) {
      let resolved: ResolvedView;
      try {
        resolved = resolveView(view, owners.get(id) as string, extensions);
      } catch (error) {
        throw config(error instanceof Error ? error.message : String(error));
      }
      const problems = validateView(resolved.view, lookup);
      if (problems.length > 0) throw config(`View '${id}': ${problems.join('; ')}.`);
      views.set(id, resolved);
    }
    this.views = views;
    const plain = new Map([...views].map(([id, r]) => [id, r.view]));
    const actions = new Map<string, WindowAction>();
    for (const m of modules)
      for (const [id, action] of Object.entries(m.actions ?? {})) {
        const problems = validateAction(action, lookup, plain);
        if (problems.length > 0)
          throw config(`Action '${id}' of ${m.name}: ${problems.join('; ')}.`);
        actions.set(id, action);
      }
    this.actions = actions;
    const searches = new Map<string, SearchSpec>();
    for (const m of modules)
      for (const [model, spec] of Object.entries(m.search ?? {})) {
        const problems = validateSearch(model, spec, lookup);
        if (problems.length > 0)
          throw config(`Search of ${model} in ${m.name}: ${problems.join('; ')}.`);
        // Later modules add to earlier ones (fields, filters, group-by options).
        const before = searches.get(model);
        searches.set(
          model,
          before === undefined
            ? spec
            : {
                fields: [...new Set([...before.fields, ...spec.fields])],
                filters: { ...before.filters, ...spec.filters },
                groupBy: [...new Set([...(before.groupBy ?? []), ...(spec.groupBy ?? [])])],
              },
        );
      }
    this.searches = searches;
  }

  /** The first view of `type` for `model`, in module order. */
  defaultView(model: string, type: ViewType): string | undefined {
    for (const [id, r] of this.views) if (r.view.model === model && r.view.type === type) return id;
    return undefined;
  }

  /** The view for `env`'s user. @throws {AccessError} without read access */
  serve(env: Env, id: string): ServedView {
    const resolved = this.views.get(id);
    if (resolved === undefined)
      throw new HttpProblem(404, 'unknown-view', 'Unknown view', `No view '${id}'.`);
    const view = resolved.view;
    env.access.check(view.model as never, 'read');
    const model = this.#models.get(view.model) as ApiModel;
    const fields: Record<string, Record<string, ViewField>> = {};
    const meta = (owner: ApiModel, key: string): ViewField | null => {
      const head = key.split('.')[0] as string;
      const field = owner.byKey.get(head);
      if (field === undefined || !env.access.canField(owner.name as never, head, 'read'))
        return null;
      const served = describe(env, owner, field);
      const byModel = fields[owner.name] ?? {};
      byModel[head] = served;
      fields[owner.name] = byModel;
      return served;
    };
    const canWrite = env.access.can(view.model as never, 'write');
    const keepField =
      (owner: ApiModel) =>
      (node: FieldNode): FieldNode | null => {
        const served = meta(owner, node.field);
        return served === null ? null : node;
      };
    const filterNodes = (nodes: readonly FormNode[], owner: ApiModel): FormNode[] =>
      nodes.flatMap((node): FormNode[] => {
        switch (node.kind) {
          case 'field': {
            const kept = keepField(owner)(node);
            return kept === null ? [] : [kept];
          }
          case 'group':
            return [{ ...node, children: filterNodes(node.children, owner) }];
          case 'notebook':
            return [
              {
                ...node,
                pages: node.pages.map((p) => ({ ...p, children: filterNodes(p.children, owner) })),
              },
            ];
          case 'lines': {
            const field = owner.byKey.get(node.field);
            const target =
              field?.target === null || field === undefined
                ? undefined
                : this.#models.get(field.target);
            if (
              meta(owner, node.field) === null ||
              target === undefined ||
              !env.access.can(target.name as never, 'read')
            )
              return [];
            return [
              {
                ...node,
                columns: node.columns.flatMap((c) => (keepField(target)(c) === null ? [] : [c])),
              },
            ];
          }
          default:
            return [node]; // components: rendered as they are
        }
      });
    const transitions = model.transitionSpecs.filter(
      (t) => canWrite && (t.requires === null || hasPermission(env, t.requires)),
    );
    const allowed = new Set(transitions.map((t) => t.name));
    let served: ViewDefinition;
    switch (view.type) {
      case 'list':
        served = {
          ...view,
          columns: view.columns.flatMap((c) => (keepField(model)(c) === null ? [] : [c])),
        };
        break;
      case 'form': {
        if (view.header.statusbar !== undefined) meta(model, view.header.statusbar);
        const buttons: ButtonNode[] = view.header.buttons.filter((b) => allowed.has(b.transition));
        served = {
          ...view,
          header: { ...view.header, buttons },
          sheet: filterNodes(view.sheet, model),
        };
        break;
      }
      case 'kanban': {
        meta(model, view.groupBy);
        for (const key of [view.card.title, view.card.subtitle].filter(
          (k): k is string => k !== undefined,
        ))
          meta(model, key);
        const keep = (nodes: readonly FieldNode[] | undefined) =>
          (nodes ?? []).flatMap((c) => (keepField(model)(c) === null ? [] : [c]));
        served = {
          ...view,
          card: { ...view.card, footer: keep(view.card.footer), badges: keep(view.card.badges) },
        };
        break;
      }
      default: {
        // Report views: groups and measures on fields the user may not read are left out (the report query
        // would refuse them); the metadata of every referenced field goes along.
        const readable = (key: string) => meta(model, key.split(':')[0] as string) !== null;
        const measureField = (m: MeasureNode) =>
          m.measure === 'count' ? undefined : (Object.values(m.measure)[0] as string);
        const readableMeasure = (m: MeasureNode) => {
          const key = measureField(m);
          return key === undefined || readable(key);
        };
        if (view.type === 'pivot')
          served = {
            ...view,
            rows: view.rows.filter(readable),
            cols: view.cols.filter(readable),
            measures: view.measures.filter(readableMeasure),
          };
        else if (view.type === 'graph') {
          if (!readableMeasure(view.measure) || !view.groupBy.every(readable))
            throw new HttpProblem(
              403,
              'access',
              'Forbidden',
              'This chart uses fields you may not read.',
            );
          served = view;
        } else {
          for (const value of Object.values(view))
            if (typeof value === 'string' && model.byKey.has(value.split('.')[0] as string))
              meta(model, value);
          served = view;
        }
      }
    }
    for (const key of ['id', 'displayName']) meta(model, key);
    return {
      view: served,
      fields,
      transitions: transitions.map(({ name, field, from, to }) => ({ name, field, from, to })),
      operations: {
        create: env.access.can(view.model as never, 'create'),
        write: canWrite,
        unlink: env.access.can(view.model as never, 'unlink'),
      },
      onchange: model.onchange,
    };
  }

  /** The search definition for `env`'s user: options on fields they may not read are left out. */
  serveSearch(env: Env, model: string): SearchSpec {
    env.access.check(model as never, 'read');
    const spec = this.searches.get(model) ?? { fields: this.#defaultSearchFields(model) };
    const readable = (key: string) => {
      const head = key.split(/[.:]/)[0] as string;
      return env.access.canField(model as never, head, 'read');
    };
    const filters = Object.fromEntries(
      Object.entries(spec.filters ?? {}).filter(([, f]) =>
        Object.keys(f.domain).every((k) => ['and', 'or', 'not'].includes(k) || readable(k)),
      ),
    );
    return {
      fields: spec.fields.filter(readable),
      filters,
      groupBy: (spec.groupBy ?? []).filter(readable),
    };
  }

  #defaultSearchFields(model: string): string[] {
    const m = this.#models.get(model);
    if (m === undefined) return [];
    return ['name', 'displayName'].filter((k) => m.byKey.get(k)?.stored === true).slice(0, 1);
  }

  /** Registers the routes. */
  register(app: FastifyInstance): void {
    app.get('/api/v1/views/:id', async (request) => {
      const id = String((request.params as { id?: unknown }).id ?? '');
      return request.env(async (env) => this.serve(env, id));
    });
    app.get('/api/v1/views', async (request) => {
      const q = (request.query ?? {}) as { model?: unknown; type?: unknown };
      const model = String(q.model ?? '');
      const type = String(q.type ?? '') as ViewType;
      if (!VIEW_TYPES.includes(type))
        throw new HttpProblem(
          400,
          'invalid-type',
          'Invalid view type',
          `type is one of ${VIEW_TYPES.join(', ')}.`,
        );
      const id = this.defaultView(model, type);
      if (id === undefined)
        throw new HttpProblem(
          404,
          'unknown-view',
          'No view',
          `${model} has no ${type} view.`,
          'Define one in a module manifest.',
        );
      return request.env(async (env) => this.serve(env, id));
    });
    app.get('/api/v1/search/:model', async (request) => {
      const model = String((request.params as { model?: unknown }).model ?? '');
      if (!this.#models.has(model))
        throw new HttpProblem(404, 'unknown-model', 'Unknown model', `No model '${model}'.`);
      return request.env(async (env) => this.serveSearch(env, model));
    });
  }
}

function hasPermission(env: Env, code: string): boolean {
  try {
    return env.access.has(code);
  } catch {
    return false;
  }
}

function describe(env: Env, model: ApiModel, field: ApiField): ViewField {
  return {
    key: field.key,
    kind: field.kind,
    label: field.label,
    required: field.required,
    // Field-level only: the UI combines it with `operations` (create for new records, write for existing ones).
    readonly: field.readonly || !env.access.canField(model.name as never, field.key, 'write'),
    ...(field.target === null ? {} : { target: field.target }),
    ...(field.options === null
      ? {}
      : { options: field.options.map(([value, label]) => ({ value, label })) }),
  };
}
