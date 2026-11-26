/**
 * From Kosh modules to a Shutro registry (RFC 0001 §5, RFC 0002 §6.1): the module loader's checks, then the Shutro
 * registry of the wrapped Shutro modules, then the checks that need both: every manifest wraps a real Shutro module,
 * and every Shutro module in the registry has a Kosh manifest (so none escapes declaring access levels).
 */
import { type KoshModule, type LoadedModules, loadModules } from '@kosh/modules-sdk';
import { leftOutOfTrail } from './audit-scope.js';
import { ServerConfigError } from './errors.js';
import { orm, type Registry, type RegistryOptions } from './orm.js';

/** The framework version this server implements (checked against each module's `kosh` range). */
export const KOSH_VERSION = '0.1.0';

/** The loaded modules and their Shutro registry. */
export interface KoshRegistry {
  readonly loaded: LoadedModules;
  readonly registry: Registry;
}

/** The Shutro module Kosh adds to turn on the change events modules ask for (no models, no Kosh manifest). */
export const CHANGE_EVENTS_MODULE = 'kosh_change_events';

/**
 * Extensions turning on Shutro's change events (RFC 0018 §7.5) for the models modules list in `changeEvents`
 * (`'*'`: every served model but the private ones); empty when none asks.
 */
function changeEventsModule(modules: readonly KoshModule[]): unknown[] {
  const asked = modules.filter((m) => m.changeEvents !== undefined);
  if (asked.length === 0) return [];
  const all = modules.flatMap((m) =>
    ((m.shutro as { models?: readonly { name: string }[] }).models ?? []).map(
      (model) => model.name,
    ),
  );
  const hidden = new Set(modules.flatMap((m) => m.privateModels ?? []));
  const wanted = new Set<string>();
  for (const m of asked)
    for (const name of m.changeEvents === '*'
      ? all.filter((n) => !hidden.has(n))
      : (m.changeEvents ?? []))
      if (all.includes(name)) wanted.add(name);
  if (wanted.size === 0) return [];
  return [
    orm.defineModule({
      name: CHANGE_EVENTS_MODULE,
      depends: modules.map((m) => m.shutro as never),
      models: [],
      extensions: [...wanted].sort().map((name) => orm.extendModel(name, { changeEvents: true })),
    }),
  ];
}

/** The Shutro module Kosh adds to index the links of lines to their parents (no models, no Kosh manifest). */
export const PARENT_INDEXES_MODULE = 'kosh_parent_indexes';

interface DeclaredModel {
  readonly name: string;
  readonly fields: Readonly<
    Record<
      string,
      {
        readonly kind: string;
        readonly required?: boolean;
        readonly ondelete?: string;
        readonly index?: unknown;
      }
    >
  >;
  readonly indexes?: readonly { readonly fields: readonly string[] }[];
  readonly sqlConstraints?: readonly {
    readonly kind: string;
    readonly fields: readonly string[];
  }[];
}

/**
 * The links of lines to their parents that have no index (RFC 0039 §5b): a many2one that is required and
 * deleted with its target is how a line finds its document — read on every form, joined in every report,
 * followed by every cascade — and Shutro indexes only what a model declares. Not those that already lead an
 * index or a unique constraint. By model.
 */
export function parentLinksWithoutIndex(
  modules: readonly KoshModule[],
): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, string[]>();
  for (const m of modules)
    for (const model of (m.shutro as { models?: readonly DeclaredModel[] }).models ?? []) {
      const led = new Set<string>();
      for (const index of model.indexes ?? [])
        if (index.fields[0] !== undefined) led.add(index.fields[0]);
      for (const c of model.sqlConstraints ?? [])
        if (c.kind === 'unique' && c.fields[0] !== undefined) led.add(c.fields[0]);
      const keys = Object.entries(model.fields)
        .filter(
          ([key, field]) =>
            field.kind === 'many2one' &&
            field.required === true &&
            field.ondelete === 'cascade' &&
            (field.index === undefined || field.index === false) &&
            !led.has(key),
        )
        .map(([key]) => key);
      if (keys.length > 0) out.set(model.name, keys);
    }
  return out;
}

/** Extensions that index those links; empty when every one has its index. */
function parentIndexesModule(modules: readonly KoshModule[]): unknown[] {
  const missing = parentLinksWithoutIndex(modules);
  if (missing.size === 0) return [];
  return [
    orm.defineModule({
      name: PARENT_INDEXES_MODULE,
      depends: modules.map((m) => m.shutro as never),
      models: [],
      extensions: [...missing]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, keys]) =>
          orm.extendModel(name, {
            fieldOverrides: Object.fromEntries(keys.map((key) => [key, { index: true }])),
          }),
        ),
    }),
  ];
}

/** Loads `modules` (and their dependencies) and builds the Shutro registry. @throws {ServerConfigError} */
export function buildKoshRegistry(
  modules: readonly KoshModule[],
  options: { readonly security?: RegistryOptions<[]>['security'] } = {},
): KoshRegistry {
  const loaded = loadModules(modules, { koshVersion: KOSH_VERSION });
  for (const m of loaded.modules)
    if (!orm.isModule(m.shutro))
      throw new ServerConfigError(
        `Module '${m.name}' does not wrap a Shutro module.`,
        'Pass the value returned by defineModule() from @kosh/server/orm as `shutro`.',
      );
  const registry = orm.buildRegistry({
    modules: [
      ...loaded.modules.map((m) => m.shutro as never),
      ...changeEventsModule(loaded.modules),
      ...parentIndexesModule(loaded.modules),
    ] as never,
    ...(options.security === undefined ? {} : { security: options.security }),
    // Every business record logs its creation, its changes and its deletion (see audit-scope.ts).
    tracking: {
      default: 'all',
      except: leftOutOfTrail,
    },
  } as never) as unknown as Registry;
  for (const name of registry.loadOrder)
    if (!loaded.byName.has(name) && name !== CHANGE_EVENTS_MODULE && name !== PARENT_INDEXES_MODULE)
      throw new ServerConfigError(
        `The Shutro module '${name}' has no Shutro ERP manifest.`,
        'Wrap it with defineModule() from @kosh/modules-sdk (its access levels are required) and depend on it.',
      );
  return { loaded, registry };
}
