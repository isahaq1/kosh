/**
 * From Kosh modules to a Shutro registry (RFC 0001 §5, RFC 0002 §6.1): the module loader's checks, then the Shutro
 * registry of the wrapped Shutro modules, then the checks that need both: every manifest wraps a real Shutro module,
 * and every Shutro module in the registry has a Kosh manifest (so none escapes declaring access levels).
 */
import { type KoshModule, type LoadedModules, loadModules } from '@kosh/modules-sdk';
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
    ] as never,
    ...(options.security === undefined ? {} : { security: options.security }),
  }) as unknown as Registry;
  for (const name of registry.loadOrder)
    if (!loaded.byName.has(name) && name !== CHANGE_EVENTS_MODULE)
      throw new ServerConfigError(
        `The Shutro module '${name}' has no Shutro ERP manifest.`,
        'Wrap it with defineModule() from @kosh/modules-sdk (its access levels are required) and depend on it.',
      );
  return { loaded, registry };
}
