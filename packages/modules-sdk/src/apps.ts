/**
 * Planning app changes (RFC 0008 §5.3–5.4) without a database: which modules an install, enable or disable request
 * adds, wakes or switches off, given the catalogue (the modules this installation can install) and the installed
 * set. Dependencies come along on install and enable; dependents go along on disable. The server turns a plan into
 * schema changes and applies it (`@kosh/server`, `prepareApps` / `applyApps`).
 */
import { ModuleLoadError } from './errors.js';
import type { KoshModule } from './manifest.js';

/** A module's state in a database: `installed` serves it; `disabled` keeps its tables and data, serves nothing. */
export type AppState = 'installed' | 'disabled';
/** Why a module is in the installed set. */
export type AppReason = 'selected' | 'dependency' | 'bridge';

/** One row of the installed set. */
export interface InstalledApp {
  readonly name: string;
  readonly version: string;
  readonly state: AppState;
  readonly reason: AppReason;
}

/** What to change (module names). */
export interface AppChange {
  readonly install?: readonly string[];
  readonly enable?: readonly string[];
  readonly disable?: readonly string[];
}

/** What a change does to the installed set. */
export interface AppPlan {
  /** New modules, dependencies first. */
  readonly install: readonly { readonly name: string; readonly reason: AppReason }[];
  /** Disabled modules served again, dependencies first. */
  readonly enable: readonly string[];
  /** Modules switched off; `cascade` when it goes because a module it depends on does. */
  readonly disable: readonly { readonly name: string; readonly cascade: boolean }[];
  /** Asked for but already in the requested state. */
  readonly unchanged: readonly string[];
  /** The installed set afterwards. */
  readonly after: readonly InstalledApp[];
}

/** A request that cannot be planned (unknown module, protected module, conflicting asks). */
export class AppPlanError extends ModuleLoadError {
  constructor(problem: string, hint: string) {
    super(problem, hint);
    this.name = 'AppPlanError';
  }
}

/** Every module of the catalogue and their dependencies, by name. */
export function catalogueOf(modules: readonly KoshModule[]): ReadonlyMap<string, KoshModule> {
  const byName = new Map<string, KoshModule>();
  const visit = (m: KoshModule) => {
    if (byName.has(m.name)) return;
    byName.set(m.name, m);
    for (const d of m.depends) visit(d);
  };
  for (const m of modules) visit(m);
  return byName;
}

/** `names` and everything they depend on, dependencies first. */
function withDependencies(
  names: readonly string[],
  catalogue: ReadonlyMap<string, KoshModule>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (name: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    for (const d of catalogue.get(name)?.depends ?? []) visit(d.name);
    out.push(name);
  };
  for (const n of [...names].sort()) visit(n);
  return out;
}

/**
 * Plans `change` against the installed set `current`.
 * @param protect modules that can never be disabled (`base`, Settings).
 * @throws {AppPlanError}
 */
export function planApps(
  catalogueModules: readonly KoshModule[],
  current: readonly InstalledApp[],
  change: AppChange,
  protect: readonly string[] = ['base'],
): AppPlan {
  const catalogue = catalogueOf(catalogueModules);
  const state = new Map(current.map((row) => [row.name, row]));
  const asked = [...(change.install ?? []), ...(change.enable ?? []), ...(change.disable ?? [])];
  const unknown = asked.filter((n) => !catalogue.has(n));
  if (unknown.length > 0)
    throw new AppPlanError(
      `Not in the catalogue: ${[...new Set(unknown)].join(', ')}.`,
      `Known: ${[...catalogue.keys()].sort().join(', ')} (add modules to src/modules.ts).`,
    );
  const up = new Set([...(change.install ?? []), ...(change.enable ?? [])]);
  const both = (change.disable ?? []).filter((n) => up.has(n));
  if (both.length > 0)
    throw new AppPlanError(
      `Asked to switch on and off at once: ${both.join(', ')}.`,
      'Ask for one change per module.',
    );
  const notInstalled = (change.enable ?? []).filter((n) => state.get(n) === undefined);
  if (notInstalled.length > 0)
    throw new AppPlanError(
      `Not installed, so it cannot be enabled: ${notInstalled.join(', ')}.`,
      'Install it instead.',
    );

  const unchanged: string[] = [];
  const install: { name: string; reason: AppReason }[] = [];
  const enable: string[] = [];
  const selected = new Set(change.install ?? []);
  for (const name of withDependencies([...up], catalogue)) {
    const row = state.get(name);
    if (row === undefined)
      install.push({ name, reason: selected.has(name) ? 'selected' : 'dependency' });
    else if (row.state === 'disabled') enable.push(name);
    else if (up.has(name)) unchanged.push(name);
  }

  // Disabling takes every installed module that depends on it (directly or not) along.
  const switchedOff = new Map<string, boolean>();
  const dependents = (name: string) =>
    current.filter(
      (row) =>
        row.state === 'installed' &&
        (catalogue.get(row.name)?.depends ?? []).some((d) => d.name === name),
    );
  const off = (name: string, cascade: boolean) => {
    if (switchedOff.has(name)) return;
    switchedOff.set(name, cascade);
    for (const d of dependents(name)) off(d.name, true);
  };
  for (const name of change.disable ?? []) {
    const row = state.get(name);
    if (row === undefined || row.state === 'disabled') unchanged.push(name);
    else off(name, false);
  }
  const forbidden = [...switchedOff.keys()].filter((n) => protect.includes(n));
  if (forbidden.length > 0)
    throw new AppPlanError(
      `${forbidden.join(', ')} cannot be disabled${forbidden.some((n) => !(change.disable ?? []).includes(n)) ? ' (it would go with a module that depends on it)' : ''}.`,
      'Every installation needs it.',
    );
  const waking = [...switchedOff.keys()].filter((n) => up.has(n) || enable.includes(n));
  if (waking.length > 0)
    throw new AppPlanError(
      `${waking.join(', ')} would be enabled and disabled at once.`,
      'Disable the modules that depend on it in a separate change.',
    );
  const order = withDependencies([...switchedOff.keys()], catalogue);
  const disable = order
    .filter((n) => switchedOff.has(n))
    .reverse() // dependents first
    .map((name) => ({ name, cascade: switchedOff.get(name) === true }));

  const after = new Map(current.map((row) => [row.name, row]));
  for (const { name, reason } of install)
    after.set(name, {
      name,
      version: catalogue.get(name)?.version ?? '0.0.0',
      state: 'installed',
      reason,
    });
  for (const name of enable) {
    const row = after.get(name);
    if (row !== undefined) after.set(name, { ...row, state: 'installed' });
  }
  for (const { name } of disable) {
    const row = after.get(name);
    if (row !== undefined) after.set(name, { ...row, state: 'disabled' });
  }
  return {
    install,
    enable,
    disable,
    unchanged: [...new Set(unchanged)],
    after: withDependencies([...after.keys()], catalogue)
      .map((n) => after.get(n))
      .filter((row): row is InstalledApp => row !== undefined),
  };
}

/** The catalogue modules a set serves (state `installed`), for building the runtime registry. */
export function servedModules(
  catalogueModules: readonly KoshModule[],
  rows: readonly InstalledApp[],
  states: readonly AppState[] = ['installed'],
): KoshModule[] {
  const catalogue = catalogueOf(catalogueModules);
  return rows
    .filter((row) => states.includes(row.state))
    .map((row) => catalogue.get(row.name))
    .filter((m): m is KoshModule => m !== undefined);
}
