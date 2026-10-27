/**
 * @packageDocumentation
 * `@kosh/import` (RFC 0014): CSV and XLSX files become records of any served model — columns mapped to fields
 * (guessed from keys and labels), cells converted (decimals exact, dates in the file's order, Bangla digits),
 * relations matched by external id, unique key or name as the user, a dry run with every error on its row and cell,
 * and an all-or-nothing import that is audited. Nothing is bypassed: record rules, field security, constraints and
 * sequences apply as for a record typed in a form.
 */
import { defineModule, type KoshModule } from '@kosh/modules-sdk';
import { base, type ModuleContext } from '@kosh/server';
import { importShutro } from './models.js';
import { type ImportRoutesOptions, registerImportRoutes } from './routes.js';
import { createImportService } from './service.js';
import { importWorker } from './worker.js';

export {
  asciiDigits,
  type Cell,
  type CellError,
  type Converted,
  type ConvertField,
  type ConvertOptions,
  convertCell,
  importable,
  parseDate,
  parseDateTime,
  plainNumber,
} from './convert.js';
export {
  type CsvEncoding,
  type CsvTable,
  decodeText,
  guessSeparator,
  parseCsvText,
  readCsv,
} from './csv.js';
export { type ColumnMapping, guessMapping, type MappableField, normalize } from './mapping.js';
export { type Match, type MatchTarget, matchAll, matchOne } from './match.js';
export { importShutro } from './models.js';
export { type ImportRoutesOptions, registerImportRoutes } from './routes.js';
export {
  EXTERNAL_ID_KEY,
  externalIdOf,
  ID_KEY,
  IMPORT_MODULE,
  type ImportField,
  type ImportModels,
  type ImportOptions,
  type ImportResult,
  importFields,
  type RowError,
  type RowErrorCode,
  runImport,
  type UndoData,
  type UndoResult,
  undoImport,
  WRITE_BATCH,
} from './run.js';
export {
  createImportService,
  FINISHED_TOPIC,
  IMPORT_MAX_BYTES,
  IMPORT_ROWS,
  type ImportContext,
  type ImportService,
  INLINE_ROWS,
  parseOptions,
  RUN_JOB,
  type SavedMapping,
  type Session,
  UNDO_DAYS,
} from './service.js';
export { importWorker } from './worker.js';
export {
  fromSerial,
  isDateFormat,
  readXlsx,
  unzip,
  type XlsxCell,
  XlsxError,
  type XlsxSheet,
  xlsxSheetNames,
} from './xlsx.js';

/** Package identity. */
export const PACKAGE: { readonly name: string; readonly rfc: string } = Object.freeze({
  name: '@kosh/import',
  rfc: 'RFC 0014',
});

export interface ImportModuleOptions extends Omit<ImportRoutesOptions, 'service'> {
  /** Run background imports in this process (default: unless `KOSH_SCHEDULES=off`). */
  readonly worker?: boolean;
}

/** The import module with explicit limits (tests). */
export function createImport(options: ImportModuleOptions = {}): KoshModule {
  const env = process.env;
  const maxBytes = Number(env['KOSH_IMPORT_MAX_BYTES'] ?? Number.NaN);
  const maxRows = Number(env['KOSH_IMPORT_MAX_ROWS'] ?? Number.NaN);
  return defineModule({
    shutro: importShutro,
    kosh: '^0.1.0',
    depends: [base],
    accessLevels: { user: { label: 'Import data', groups: ['import.user'] } },
    privateModels: ['import.session', 'import.progress', 'import.mapping'],
    routes: (context: ModuleContext) => {
      const { worker, ...limits } = options;
      const service = createImportService(
        context,
        limits.inlineRows === undefined ? {} : { inlineRows: limits.inlineRows },
      );
      registerImportRoutes(context, {
        ...(Number.isFinite(maxBytes) && maxBytes > 0 ? { maxBytes } : {}),
        ...(Number.isFinite(maxRows) && maxRows > 0 ? { maxRows } : {}),
        ...limits,
        service,
      });
      // Background work is off in the CLI (kosh init, migrate), like the schedules.
      if (!(worker ?? env['KOSH_SCHEDULES'] !== 'off')) return;
      const running = importWorker(context, service);
      running.start();
      context.app.addHook('onClose', () => running.stop());
    },
  });
}

/** Data import, limits from the environment (`KOSH_IMPORT_MAX_BYTES`, `KOSH_IMPORT_MAX_ROWS`). */
export const dataImport: KoshModule = createImport();
