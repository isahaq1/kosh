/**
 * From Kosh modules to a Shutro registry (RFC 0001 §5, RFC 0002 §6.1): the module loader's checks, then the Shutro
 * registry of the wrapped Shutro modules, then the checks that need both: every manifest wraps a real Shutro module,
 * and every Shutro module in the registry has a Kosh manifest (so none escapes declaring access levels).
 */
import { type KoshModule, type LoadedModules, loadModules } from '@isahaq/kosh-modules-sdk';
import { ServerConfigError } from './errors.js';
import { orm, type Registry, type RegistryOptions } from './orm.js';

/** The framework version this server implements (checked against each module's `kosh` range). */
export const KOSH_VERSION = '0.1.0';

/** The loaded modules and their Shutro registry. */
export interface KoshRegistry {
  readonly loaded: LoadedModules;
  readonly registry: Registry;
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
        'Pass the value returned by defineModule() from @isahaq/kosh-server/orm as `shutro`.',
      );
  const registry = orm.buildRegistry({
    modules: loaded.modules.map((m) => m.shutro as never),
    ...(options.security === undefined ? {} : { security: options.security }),
  }) as unknown as Registry;
  for (const name of registry.loadOrder)
    if (!loaded.byName.has(name))
      throw new ServerConfigError(
        `The Shutro module '${name}' has no Kosh manifest.`,
        'Wrap it with defineModule() from @isahaq/kosh-modules-sdk (its access levels are required) and depend on it.',
      );
  return { loaded, registry };
}
