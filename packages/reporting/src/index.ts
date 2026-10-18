/**
 * @packageDocumentation
 * `@kosh/reporting` (RFC 0005): the report query (pivots with every level in one GROUPING SETS statement, drill-down
 * domains, period comparisons, `asOf`), formatted XLSX / CSV exports, and the reporting module (dashboards,
 * document templates, scheduled reports). Views are in `@kosh/reporting/web`.
 */
import { defineModule } from '@kosh/modules-sdk';
import { base, type ModuleContext } from '@kosh/server';
import { dashboard, spreadsheet } from '@kosh/views';
import { reportingShutro } from './models.js';
import { registerReportRoutes } from './routes.js';

export {
  type Amount,
  type Condition,
  type FieldInfo,
  type Header,
  type Measure,
  nextBucket,
  ReportError,
  type ReportQuery,
  type ReportResult,
  runReport,
  type Value,
  zonedStart,
} from './pivot.js';
export { parseReportQuery, registerReportRoutes, reportTable } from './routes.js';
export { type Cell, moneyFormat, type Sheet, workbook, zip } from './xlsx.js';
export { reportingShutro };

/** Package identity. */
export const PACKAGE: { readonly name: string; readonly rfc: string } = Object.freeze({
  name: '@kosh/reporting',
  rfc: 'RFC 0005',
});

/** The Kosh module: install it for reports, exports, dashboards, documents and schedules. */
export const reporting: ReturnType<typeof defineModule> = defineModule({
  shutro: reportingShutro,
  kosh: '^0.1.0',
  depends: [base],
  accessLevels: {
    user: { label: 'Reports user', groups: ['reporting.user'] },
    designer: { label: 'Report designer', groups: ['reporting.designer'], implies: ['user'] },
  },
  app: { code: 'reports', label: 'Reports', icon: 'chart', sequence: 90 },
  actions: {
    'reporting.action_dashboards': {
      model: 'report.dashboard',
      label: 'Dashboards',
      views: ['dashboard'],
    },
    'reporting.action_spreadsheets': {
      model: 'report.spreadsheet',
      label: 'Spreadsheets',
      views: ['spreadsheet'],
    },
  },
  menus: [
    { id: 'reporting.root', label: 'Reports', app: 'reports' },
    {
      id: 'reporting.dashboards',
      parent: 'reporting.root',
      label: 'Dashboards',
      action: 'reporting.action_dashboards',
      sequence: 1,
    },
    {
      id: 'reporting.spreadsheets',
      parent: 'reporting.root',
      label: 'Spreadsheets',
      action: 'reporting.action_spreadsheets',
      sequence: 2,
    },
  ],
  views: {
    'report.dashboard.dashboard': dashboard({ label: 'Dashboards' }),
    'report.spreadsheet.spreadsheet': spreadsheet('report.spreadsheet', { label: 'Spreadsheets' }),
  },
  routes: (context: ModuleContext) => {
    registerReportRoutes(context);
  },
});
