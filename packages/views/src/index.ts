/**
 * @packageDocumentation
 * `@isahaq/kosh-views` (RFC 0004): typed view definitions (list, form, kanban; reporting views with RFC 0005), window
 * actions and search definitions, extension by anchors, client-side condition evaluation and load-time checks.
 * Shared by the server (validation, per-user filtering) and the UI (rendering). No dependencies.
 */
export {
  action,
  calendar,
  cohort,
  dashboard,
  type FieldInput,
  type FieldKey,
  type FormKit,
  field,
  form,
  type GroupKey,
  gantt,
  graph,
  hierarchy,
  type ImplicitKey,
  kanban,
  list,
  type MeasureInput,
  type ModelHandle,
  map,
  pivot,
  search,
  spreadsheet,
} from './builders.js';
export { type ConditionEnv, evaluate, holds } from './condition.js';
export type { Block, Layout } from './documents.js';
export { nodesOf, resolveView, ViewDefinitionError } from './extend.js';
export type * from './types.js';
export {
  type ModelInfo,
  type ModelLookup,
  validateAction,
  validateSearch,
  validateView,
} from './validate.js';

/** Package identity. */
export const PACKAGE: { readonly name: string; readonly rfc: string } = Object.freeze({
  name: '@isahaq/kosh-views',
  rfc: 'RFC 0004',
});
