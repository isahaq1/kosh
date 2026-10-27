/**
 * The import's models (RFC 0014):
 *
 * - `import.session` (§5.1): the uploaded file, its mapping and options, and what became of it. A session belongs to
 *   the user who uploaded it; the routes read it as that user (record rule) and nobody else sees the file.
 * - `import.progress` (§5.3): how far a background run is, written by the job in short transactions of its own (the
 *   job's transaction commits only at the end); read through the routes.
 * - `import.mapping` (§5.4): a saved mapping (columns by header, options) for a model, the user's own or shared with
 *   every import user of the company.
 */
import { baseShutro } from '@kosh/server';
import { orm } from '@kosh/server/orm';

const { defineGroup, defineModel, defineModule, f } = orm;

const Session = defineModel('import.session', {
  label: 'Import',
  order: ['id desc'],
  companyScoped: { required: true },
  access: { 'import.user': ['read', 'write', 'create', 'unlink'] },
  rules: {
    own: {
      groups: ['import.user'],
      perms: ['read', 'write', 'create', 'unlink'],
      domain: { user: { $env: 'uid' } },
    },
  },
  fields: {
    user: f.many2one('res.users', { required: true, ondelete: 'cascade' }),
    /** The model the rows become (`res.partner`). */
    resModel: f.char({ required: true, label: 'Model' }),
    fileName: f.char({ required: true, size: 255 }),
    fileType: f.selection({ csv: 'CSV', xlsx: 'Excel' }, { required: true }),
    file: f.binary({ required: true }),
    /** The XLSX sheet read (the first by default). */
    sheet: f.char({ size: 100 }),
    /** `[{ index, header, field }]`. */
    columns: f.json({ required: true, default: [] }),
    /** Conversion options and the mode (`ImportOptions`). */
    options: f.json({ required: true, default: {} }),
    state: f.selection(
      { draft: 'Draft', running: 'Running', done: 'Imported', undone: 'Undone' },
      { required: true, default: 'draft' },
    ),
    rowCount: f.integer({ required: true, default: 0, label: 'Rows' }),
    /** The ids the commit created. */
    createdIds: f.json({ label: 'Created records' }),
    /** What undo needs (`UndoData`, RFC 0014 §5.5). */
    undo: f.json(),
    /** The errors and file rows of the records left out (`onError: 'skip'`), for the rejected-rows file. */
    rejected: f.json(),
    importedAt: f.datetime({ label: 'Imported on' }),
    /** The last dry run or commit as the API shows it (background runs leave it here). */
    result: f.json(),
    /** Whether `result` is a dry run's. */
    resultDry: f.boolean({ required: true, default: false }),
    /** Why a background run could not finish (a fault, not the data). */
    failure: f.char({ size: 500 }),
  },
});

const Progress = defineModel('import.progress', {
  label: 'Import progress',
  access: {},
  fields: {
    session: f.many2one('import.session', { required: true, ondelete: 'cascade' }),
    done: f.integer({ required: true, default: 0 }),
    total: f.integer({ required: true, default: 0 }),
  },
  sqlConstraints: {
    onePerSession: { unique: ['session'], message: 'One progress row per import.' },
  },
});

const Mapping = defineModel('import.mapping', {
  label: 'Import mapping',
  order: ['name'],
  companyScoped: { required: true },
  access: { 'import.user': ['read', 'write', 'create', 'unlink'] },
  rules: {
    visible: {
      groups: ['import.user'],
      perms: ['read'],
      domain: { or: [{ user: { $env: 'uid' } }, { shared: true }] },
    },
    own: {
      groups: ['import.user'],
      perms: ['write', 'create', 'unlink'],
      domain: { user: { $env: 'uid' } },
    },
  },
  fields: {
    name: f.char({ required: true, size: 100 }),
    resModel: f.char({ required: true, label: 'Model' }),
    user: f.many2one('res.users', { required: true, ondelete: 'cascade', label: 'Owner' }),
    /** Every import user of the company sees it (only its owner changes it). */
    shared: f.boolean({ required: true, default: false }),
    /** `[{ header, field }]`: by header, so a file with the columns in another order still matches. */
    columns: f.json({ required: true, default: [] }),
    options: f.json({ required: true, default: {} }),
  },
});

export const importShutro: ReturnType<typeof orm.defineModule> = defineModule({
  name: 'import',
  version: '0.1.0',
  depends: [baseShutro],
  groups: [defineGroup({ code: 'import.user', label: 'Import data', implies: ['base.user'] })],
  models: [Session, Progress, Mapping],
});
