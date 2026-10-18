/**
 * The module loader (RFC 0001 §5): collects modules with their dependencies, orders them (dependencies first, ties by
 * name, so the order is deterministic), and checks everything that spans modules before anything runs: cycles,
 * duplicate names, framework version ranges, Kosh dependencies covering Shutro dependencies, access-level groups,
 * menu parents and actions, duplicate menu and action ids.
 */
import { ModuleLoadError } from './errors.js';
import type { AccessLevel, KoshModule, MenuSpec } from './manifest.js';
import { satisfies } from './semver.js';

/** Options of {@link loadModules}. */
export interface LoadOptions {
  /** The running framework version, checked against each module's `kosh` range. */
  readonly koshVersion: string;
}

/** Modules ready to run, with the merged contributions the server needs. */
export interface LoadedModules {
  /** Dependencies first. */
  readonly modules: readonly KoshModule[];
  readonly byName: ReadonlyMap<string, KoshModule>;
  /** Every menu of every module, with its module. */
  readonly menus: readonly (MenuSpec & { readonly module: string })[];
  /** Access levels by `<module>.<level>`. */
  readonly accessLevels: ReadonlyMap<
    string,
    AccessLevel & { readonly module: string; readonly key: string }
  >;
  /** Action ids → module. */
  readonly actions: ReadonlyMap<string, string>;
}

function fail(problem: string, hint: string): never {
  throw new ModuleLoadError(problem, hint);
}

function collect(roots: readonly KoshModule[]): Map<string, KoshModule> {
  const byName = new Map<string, KoshModule>();
  const visit = (m: KoshModule): void => {
    const seen = byName.get(m.name);
    if (seen !== undefined) {
      if (seen !== m)
        fail(
          `Two different modules are named '${m.name}'.`,
          'Module names are unique; one of them is a copy or a fork.',
        );
      return;
    }
    byName.set(m.name, m);
    for (const d of m.depends) visit(d);
  };
  for (const r of roots) visit(r);
  return byName;
}

function order(byName: ReadonlyMap<string, KoshModule>): KoshModule[] {
  const out: KoshModule[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (m: KoshModule, path: readonly string[]): void => {
    const s = state.get(m.name);
    if (s === 'done') return;
    if (s === 'visiting')
      fail(
        `Modules depend on each other in a cycle: ${[...path, m.name].join(' → ')}.`,
        'Move the shared part into a module both depend on.',
      );
    state.set(m.name, 'visiting');
    for (const d of [...m.depends].sort((a, b) => a.name.localeCompare(b.name)))
      visit(d, [...path, m.name]);
    state.set(m.name, 'done');
    out.push(m);
  };
  for (const m of [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))) visit(m, []);
  return out;
}

function closure(m: KoshModule, out = new Set<string>()): Set<string> {
  for (const d of m.depends) {
    if (out.has(d.name)) continue;
    out.add(d.name);
    closure(d, out);
  }
  return out;
}

/** Loads `roots` and their dependencies. @throws {ModuleLoadError} */
export function loadModules(roots: readonly KoshModule[], options: LoadOptions): LoadedModules {
  const byName = collect(roots);
  const modules = order(byName);
  const menus: (MenuSpec & { module: string })[] = [];
  const accessLevels = new Map<string, AccessLevel & { module: string; key: string }>();
  const actions = new Map<string, string>();
  for (const m of modules) {
    if (!satisfies(options.koshVersion, m.kosh))
      fail(
        `Module '${m.name}' needs Kosh ${m.kosh}; this is Kosh ${options.koshVersion}.`,
        'Upgrade the module or the framework.',
      );
    const deps = closure(m);
    for (const sd of m.shutro.depends)
      if (!deps.has(sd.name))
        fail(
          `Module '${m.name}' uses the Shutro module '${sd.name}' but no Kosh module it depends on provides it.`,
          `Add the Kosh module '${sd.name}' to depends.`,
        );
    // Groups an access level may grant: this module's and its dependencies'.
    const groups = new Set<string>(m.shutro.groups.map((g) => g.code));
    for (const d of deps) for (const g of byName.get(d)?.shutro.groups ?? []) groups.add(g.code);
    for (const [key, level] of Object.entries(m.accessLevels)) {
      for (const g of level.groups)
        if (!groups.has(g))
          fail(
            `Access level '${m.name}.${key}' grants the group '${g}', which neither '${m.name}' nor its dependencies declare.`,
            'Declare the group with defineGroup() in the Shutro module, or fix the code.',
          );
      accessLevels.set(`${m.name}.${key}`, { ...level, module: m.name, key });
    }
    for (const id of Object.keys(m.actions ?? {})) {
      const owner = actions.get(id);
      if (owner !== undefined)
        fail(
          `Action '${id}' is declared by '${owner}' and '${m.name}'.`,
          'Action ids are unique across modules.',
        );
      actions.set(id, m.name);
    }
  }
  const menuIds = new Map<string, string>();
  for (const m of modules)
    for (const menu of m.menus ?? []) {
      const owner = menuIds.get(menu.id);
      if (owner !== undefined)
        fail(
          `Menu '${menu.id}' is declared by '${owner}' and '${m.name}'.`,
          'Menu ids are unique across modules.',
        );
      menuIds.set(menu.id, m.name);
      menus.push({ ...menu, module: m.name });
    }
  for (const menu of menus) {
    if (menu.parent !== undefined && !menuIds.has(menu.parent))
      fail(
        `Menu '${menu.id}' has parent '${menu.parent}', which no loaded module declares.`,
        'Fix the parent id, or depend on the module that declares it.',
      );
    if (menu.action !== undefined && !actions.has(menu.action))
      fail(
        `Menu '${menu.id}' opens action '${menu.action}', which no loaded module declares.`,
        'Declare the action, or fix its id.',
      );
  }
  return Object.freeze({
    modules: Object.freeze(modules),
    byName,
    menus: Object.freeze(menus),
    accessLevels,
    actions,
  });
}
