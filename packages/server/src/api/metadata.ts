/**
 * Model metadata for the generated API (RFC 0002 §6.3–6.4), read from Shutro's registry: `registry.describe()` plus
 * the field descriptors for what `describe()` does not normalize yet (selection values, state transitions;
 * docs/shutro-requests.md #1). Computed once per registry; per-user views are filtered at request time.
 */
import type { Registry } from '../orm.js';

/** One field as the API exposes it. */
export interface ApiField {
  readonly key: string;
  readonly kind: string;
  readonly label: string;
  readonly required: boolean;
  /** Not writable through the API (readonly, computed without inverse, implicit). */
  readonly readonly: boolean;
  /** Has a column: listable, filterable, sortable. */
  readonly stored: boolean;
  /** Required when creating (required, no default, not computed). */
  readonly requiredOnCreate: boolean;
  readonly target: string | null;
  /** `[value, label]` for selection and state fields with a static list. */
  readonly options: readonly (readonly [string, string])[] | null;
  readonly translate: boolean;
}

/** A state transition. */
export interface TransitionSpec {
  readonly name: string;
  readonly field: string;
  readonly from: readonly string[];
  readonly to: string;
  /** A feature permission the user needs (`definePermission`), or `null`. */
  readonly requires: string | null;
}

/** One model as the API exposes it. */
export interface ApiModel {
  readonly name: string;
  readonly label: string;
  /** `res.partner` → `ResPartner` (OpenAPI component names). */
  readonly schemaName: string;
  readonly fields: readonly ApiField[];
  readonly byKey: ReadonlyMap<string, ApiField>;
  /** Transition names (state fields). */
  readonly transitions: readonly string[];
  /** The transitions in detail: their state field, source and target states, and required permission. */
  readonly transitionSpecs: readonly TransitionSpec[];
  /** Fields with onchange handlers. */
  readonly onchange: readonly string[];
  /** The stored field names are searched by (`name` by default), or `null`. */
  readonly recName: string | null;
}

const IMPLICIT_READONLY = new Set([
  'id',
  'createdAt',
  'createdBy',
  'updatedAt',
  'updatedBy',
  'displayName',
]);

/** `res.partner` → `ResPartner`. */
export function schemaName(model: string): string {
  return model
    .split(/[._]/)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join('');
}

/** The API metadata of every model of the registry. */
export function apiModels(registry: Registry): ReadonlyMap<string, ApiModel> {
  const out = new Map<string, ApiModel>();
  for (const name of registry.models.keys()) {
    const description = registry.describe(name);
    const descriptors = registry.get(name).model.fields as unknown as Readonly<
      Record<string, Record<string, unknown>>
    >;
    const fields: ApiField[] = [];
    const transitions: string[] = [];
    const transitionSpecs: TransitionSpec[] = [];
    for (const [key, d] of Object.entries(description.fields)) {
      const raw = descriptors[key] ?? {};
      const selection = raw['selection'];
      if (d.kind === 'state')
        for (const [t, spec] of Object.entries(
          (raw['transitions'] as Record<string, Record<string, unknown>> | undefined) ?? {},
        )) {
          transitions.push(t);
          transitionSpecs.push({
            name: t,
            field: key,
            from: Array.isArray(spec['from']) ? (spec['from'] as string[]) : [],
            to: String(spec['to'] ?? ''),
            requires: typeof spec['requires'] === 'string' ? spec['requires'] : null,
          });
        }
      const computedReadonly = d.computed && raw['inverse'] === undefined;
      fields.push({
        key,
        kind: d.kind,
        label: d.label,
        required: d.required,
        readonly:
          d.readonly || computedReadonly || IMPLICIT_READONLY.has(key) || d.kind === 'state',
        stored: d.column !== null,
        requiredOnCreate:
          d.required &&
          !d.hasDefault &&
          !d.computed &&
          d.sequence === null &&
          !IMPLICIT_READONLY.has(key),
        target: typeof d['target'] === 'string' ? (d['target'] as string) : null,
        options: Array.isArray(selection)
          ? (selection as readonly (readonly [string, string])[])
          : null,
        translate: d.translate,
      });
    }
    out.set(name, {
      name,
      label: description.label,
      schemaName: schemaName(name),
      fields,
      byKey: new Map(fields.map((f) => [f.key, f])),
      transitions,
      transitionSpecs,
      onchange: [...description.onchange],
      recName: recNameOf(registry, name, fields),
    });
  }
  return out;
}

function recNameOf(registry: Registry, name: string, fields: readonly ApiField[]): string | null {
  const declared = (registry.get(name).model as unknown as { recName?: unknown }).recName;
  const key = typeof declared === 'string' ? declared : 'name';
  const field = fields.find((f) => f.key === key);
  return field?.stored === true && (field.kind === 'char' || field.kind === 'text') ? key : null;
}

/** Fields listed by default: stored, not binary, not x2many. */
export function defaultFields(model: ApiModel): readonly ApiField[] {
  return model.fields.filter(
    (f) => f.stored && f.kind !== 'binary' && f.kind !== 'one2many' && f.kind !== 'many2many',
  );
}

/** The models the generated API serves: every installed model except the modules' `privateModels`. */
export function publicApiModels(registry: {
  readonly loaded: { readonly modules: readonly { readonly privateModels?: readonly string[] }[] };
  readonly registry: Registry;
}): ReadonlyMap<string, ApiModel> {
  const hidden = new Set(registry.loaded.modules.flatMap((m) => m.privateModels ?? []));
  return new Map([...apiModels(registry.registry)].filter(([name]) => !hidden.has(name)));
}
