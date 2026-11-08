/**
 * Explain (RFC 0031 §3.1): what a model, its fields and its buttons are, for developers and administrators — the
 * facts behind the dark popovers of Developer mode. Where each field comes from (the module that defined the model,
 * or the one that extended it), what it points to (and, for a one-to-many, through which field), whether it is
 * stored or computed and from what, its default, its rules; each transition's states and guard; and every relation
 * into the model from the other served models.
 *
 * - `GET /api/v1/meta/explain/:model`   administrators and `base.developer` only
 */
import type { FastifyInstance } from 'fastify';
import { HttpProblem } from '../errors.js';
import type { KoshRegistry } from '../registry.js';
import type { ApiModel } from './metadata.js';

type Descriptor = Readonly<Record<string, unknown>>;

/** One field, explained. */
export interface ExplainedField {
  readonly key: string;
  readonly label: string;
  readonly kind: string;
  readonly help: string | null;
  readonly target: string | null;
  /** For a one-to-many: the field of the target that points back. */
  readonly inverse: string | null;
  readonly required: boolean;
  readonly readonly: boolean;
  readonly stored: boolean;
  readonly computed: boolean;
  /** What a computed field is computed from. */
  readonly depends: readonly string[];
  readonly hasDefault: boolean;
  readonly default: string | null;
  readonly ondelete: string | null;
  readonly translate: boolean;
  readonly index: boolean;
  readonly options: readonly (readonly [string, string])[] | null;
  /** The module whose model or extension declares it. */
  readonly module: string | null;
}

/** One transition, explained. */
export interface ExplainedTransition {
  readonly name: string;
  readonly field: string;
  readonly from: readonly string[];
  readonly to: string;
  readonly guarded: boolean;
  readonly message: string | null;
  readonly requires: string | null;
}

/** A model, explained. */
export interface Explained {
  readonly model: string;
  readonly label: string;
  readonly module: string | null;
  readonly extendedBy: readonly string[];
  readonly fields: readonly ExplainedField[];
  readonly transitions: readonly ExplainedTransition[];
  /** The relations of other models into this one. */
  readonly incoming: readonly {
    readonly model: string;
    readonly field: string;
    readonly label: string;
    readonly kind: string;
  }[];
}

interface ShutroShape {
  readonly models?: readonly {
    readonly name: string;
    readonly fields?: Readonly<Record<string, Descriptor>>;
  }[];
  readonly extensions?: readonly {
    readonly name: string;
    readonly fields?: Readonly<Record<string, Descriptor>>;
  }[];
}

/** Which module declares each model and field, from the loaded modules' Shutro definitions. */
function provenance(registry: KoshRegistry): {
  owner: Map<string, string>;
  fieldOwner: Map<string, string>;
  extenders: Map<string, Set<string>>;
} {
  const owner = new Map<string, string>();
  const fieldOwner = new Map<string, string>();
  const extenders = new Map<string, Set<string>>();
  for (const m of registry.loaded.modules) {
    const shutro = (m as unknown as { shutro?: ShutroShape }).shutro;
    for (const model of shutro?.models ?? []) {
      owner.set(model.name, m.name);
      for (const key of Object.keys(model.fields ?? {}))
        fieldOwner.set(`${model.name}.${key}`, m.name);
    }
  }
  for (const m of registry.loaded.modules) {
    const shutro = (m as unknown as { shutro?: ShutroShape }).shutro;
    for (const ext of shutro?.extensions ?? []) {
      const set = extenders.get(ext.name) ?? new Set<string>();
      set.add(m.name);
      extenders.set(ext.name, set);
      for (const key of Object.keys(ext.fields ?? {})) fieldOwner.set(`${ext.name}.${key}`, m.name);
    }
  }
  return { owner, fieldOwner, extenders };
}

const show = (value: unknown): string | null => {
  if (value === undefined || value === null || typeof value === 'function') return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
};

/** A model explained, from the registry and the API metadata. */
export function explainModel(
  registry: KoshRegistry,
  models: ReadonlyMap<string, ApiModel>,
  name: string,
): Explained | null {
  const model = models.get(name);
  if (model === undefined) return null;
  const { owner, fieldOwner, extenders } = provenance(registry);
  const descriptors = registry.registry.get(name).model.fields as unknown as Readonly<
    Record<string, Descriptor>
  >;
  const description = registry.registry.describe(name).fields as unknown as Readonly<
    Record<string, Descriptor>
  >;
  const fields: ExplainedField[] = model.fields.map((f) => {
    const raw = descriptors[f.key] ?? {};
    const d = description[f.key] ?? {};
    const depends = Array.isArray(d['depends']) ? (d['depends'] as unknown[]).map(String) : [];
    const defaultValue = raw['default'];
    return {
      key: f.key,
      label: f.label,
      kind: f.kind,
      help: f.help,
      target: f.target,
      inverse: typeof raw['inverseField'] === 'string' ? (raw['inverseField'] as string) : null,
      required: f.required,
      readonly: f.readonly,
      stored: f.stored,
      computed: d['computed'] === true,
      depends,
      hasDefault: defaultValue !== undefined,
      default: typeof defaultValue === 'function' ? '(computed when created)' : show(defaultValue),
      ondelete: typeof raw['ondelete'] === 'string' ? (raw['ondelete'] as string) : null,
      translate: f.translate,
      index: raw['index'] !== undefined && raw['index'] !== false,
      options: f.options,
      module: fieldOwner.get(`${name}.${f.key}`) ?? owner.get(name) ?? null,
    };
  });
  const incoming: Explained['incoming'][number][] = [];
  for (const other of models.values())
    for (const f of other.fields)
      if (f.target === name && f.kind !== 'one2many')
        incoming.push({ model: other.name, field: f.key, label: f.label, kind: f.kind });
  return {
    model: name,
    label: model.label,
    module: owner.get(name) ?? null,
    extendedBy: [...(extenders.get(name) ?? [])].sort(),
    fields,
    transitions: model.transitionSpecs.map((t) => ({
      name: t.name,
      field: t.field,
      from: t.from,
      to: t.to,
      guarded: t.guard !== null,
      message: t.message,
      requires: t.requires,
    })),
    incoming: incoming.sort(
      (a, b) => a.model.localeCompare(b.model) || a.field.localeCompare(b.field),
    ),
  };
}

/** The group that may read explanations besides administrators. */
export const DEVELOPER_GROUP = 'base.developer';

export function registerExplain(
  app: FastifyInstance,
  options: { readonly registry: KoshRegistry; readonly models: ReadonlyMap<string, ApiModel> },
): void {
  app.get('/api/v1/meta/explain/:model', async (request) =>
    request.env(async (raw) => {
      const env = raw as unknown as {
        administrator: boolean;
        su: boolean;
        groups: ReadonlySet<string>;
      };
      if (!env.administrator && !env.su && !env.groups.has(DEVELOPER_GROUP))
        throw new HttpProblem(
          403,
          'not-developer',
          'Developers only',
          'Explanations are for administrators and developers.',
          'Ask an administrator for the Developer role.',
        );
      const name = String((request.params as { model?: unknown }).model ?? '');
      const explained = explainModel(options.registry, options.models, name);
      if (explained === null)
        throw new HttpProblem(
          404,
          'unknown-model',
          'Unknown model',
          `No installed model is named '${name}'.`,
        );
      return explained;
    }),
  );
}
