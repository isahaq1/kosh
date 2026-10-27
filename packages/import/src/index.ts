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
export {
  IMPORT_MAX_BYTES,
  IMPORT_ROWS,
  type ImportRoutesOptions,
  registerImportRoutes,
} from './routes.js';
export {
  type ImportField,
  type ImportOptions,
  type ImportResult,
  importFields,
  type RowError,
  type RowErrorCode,
  runImport,
} from './run.js';
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

/** The import module with explicit limits (tests). */
export function createImport(options: ImportRoutesOptions = {}): KoshModule {
  const env = process.env;
  const maxBytes = Number(env['KOSH_IMPORT_MAX_BYTES'] ?? Number.NaN);
  return defineModule({
    shutro: importShutro,
    kosh: '^0.1.0',
    depends: [base],
    accessLevels: { user: { label: 'Import data', groups: ['import.user'] } },
    privateModels: ['import.session'],
    routes: (context: ModuleContext) =>
      registerImportRoutes(context, {
        ...(Number.isFinite(maxBytes) && maxBytes > 0 ? { maxBytes } : {}),
        ...options,
      }),
  });
}

/** Data import, limits from the environment (`KOSH_IMPORT_MAX_BYTES`). */
export const dataImport: KoshModule = createImport();
