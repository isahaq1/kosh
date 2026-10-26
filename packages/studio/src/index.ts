/**
 * @packageDocumentation
 * `@kosh/studio` (RFC 0012): Kosh Studio's specification and generator. A Studio module is `studio.json` plus the
 * TypeScript generated from it (`generateModule`, `kosh studio build`): fields on other modules' models, models of
 * its own, view changes by node id, menus, approval policies — an ordinary module, reviewed and versioned as code.
 */
export { type BuildResult, buildModule, readSpec, runStudio, studioModules } from './build.js';
export { unifiedDiff } from './diff.js';
export {
  applyEdit,
  type EditAnchor,
  emptySpec,
  localFromLabel,
  nameFromLabel,
  type Owners,
  type StudioEdit,
  StudioEditError,
} from './edit.js';
export {
  type GenerateOptions,
  generateModule,
  lit,
  StudioSpecError,
  viewModel,
} from './generate.js';
export {
  type GitConfig,
  GitProposalError,
  type GitProvider,
  gitConfigFromEnv,
  type Proposal,
  type ProposalResult,
  type ProposedFile,
  proposeOnGit,
} from './git.js';
export {
  createStudio,
  registerStudioRoutes,
  type StudioMode,
  type StudioOptions,
  type StudioReview,
  studio,
  studioShutro,
} from './module.js';
export {
  camel,
  FIELD_TYPES,
  type FieldType,
  modelName,
  pascal,
  prefixedKey,
  RULE_TRIGGERS,
  type StudioApproval,
  type StudioField,
  type StudioMenu,
  type StudioModel,
  type StudioModelField,
  type StudioRule,
  type StudioSpec,
  type StudioViewChange,
  type StudioViewOperation,
  validateSpec,
} from './spec.js';

/** Package identity. */
export const PACKAGE: { readonly name: string; readonly rfc: string } = Object.freeze({
  name: '@kosh/studio',
  rfc: 'RFC 0012',
});
