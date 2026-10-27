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
  outdatedApps,
  planApps,
  servedModules,
} from './apps.js';
export { idByName, maybeIdByName } from './demo.js';
export { ModuleDefinitionError, ModuleLoadError } from './errors.js';
export { type LoadedModules, type LoadOptions, loadModules } from './loader.js';
export {
  type AccessLevel,
  type ApprovalLevelSpec,
  type ApprovalSpec,
  type AppSpec,
  type AutomationActionSpec,
  type AutomationRuleSpec,
  type DemoContext,
  type DemoUser,
  type DocumentSpec,
  defineModule,
  type ImportTemplateSpec,
  type InboundAliasSpec,
  type KoshModule,
  type LocalizationSpec,
  type MenuSpec,
  type ModuleHooks,
  type ModuleInput,
  type PortalActionSpec,
  type PortalDocumentSpec,
  type ShutroModuleShape,
} from './manifest.js';
export { compareVersions, satisfies } from './semver.js';
