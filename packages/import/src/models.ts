/**
 * The import session (RFC 0014 §5.1): the uploaded file, its mapping and options, and what became of it. A session
 * belongs to the user who uploaded it; the routes read it as that user (record rule) and nobody else sees the file.
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
      { draft: 'Draft', done: 'Imported', undone: 'Undone' },
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
  },
});

export const importShutro: ReturnType<typeof orm.defineModule> = defineModule({
  name: 'import',
  version: '0.1.0',
  depends: [baseShutro],
  groups: [defineGroup({ code: 'import.user', label: 'Import data', implies: ['base.user'] })],
  models: [Session],
});
