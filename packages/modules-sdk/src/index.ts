/**
 * @packageDocumentation
 * `@kosh/modules-sdk`: module manifests (`defineModule`) and the module loader (RFC 0001).
 */
export {
  type AppChange,
  type AppPlan,
  AppPlanError,
  type AppReason,
  type AppState,
  catalogueOf,
  type InstalledApp,
  planApps,
  servedModules,
} from './apps.js';
export { ModuleDefinitionError, ModuleLoadError } from './errors.js';
export { type LoadedModules, type LoadOptions, loadModules } from './loader.js';
export {
  type AccessLevel,
  type ApprovalLevelSpec,
  type ApprovalSpec,
  type AppSpec,
  type DocumentSpec,
  defineModule,
  type KoshModule,
  type MenuSpec,
  type ModuleHooks,
  type ModuleInput,
  type ShutroModuleShape,
} from './manifest.js';
export { satisfies } from './semver.js';
