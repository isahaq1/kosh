/**
 * @packageDocumentation
 * `@kosh/odoo` (RFC 0034 §2.3): leave Odoo safely — read a live Odoo through its JSON-RPC API with a read-only user,
 * import its records with their Odoo ids kept, and account for every record in a report. A dry run first, always.
 */
export {
  externalIdFor,
  readableFields,
  STEPS,
  type Step,
  type StepContext,
} from './plan.js';
export {
  connectOdoo,
  idOf,
  idsOf,
  type OdooClient,
  type OdooConnection,
  OdooError,
  type OdooField,
  type OdooRecord,
  type OdooValue,
  textOf,
} from './rpc.js';
export {
  type FailedRecord,
  importFromOdoo,
  type OdooImportOptions,
  type OdooReport,
  reportText,
  type StepReport,
} from './run.js';
