/**
 * @packageDocumentation
 * `@kosh/reporting` (RFC 0005): the report query (pivots with every level in one GROUPING SETS statement, drill-down
 * domains, period comparisons, `asOf`), formatted XLSX / CSV exports, documents (layouts rendered to PDF with
 * Playwright), scheduled reports (Shutro jobs, delivery adapters), dashboards and spreadsheets. Views are in
 * `@kosh/reporting/web`.
 */
import { defineModule } from '@kosh/modules-sdk';
import { base, type ModuleContext } from '@kosh/server';
import type { Env } from '@kosh/server/orm';
import { dashboard, form, list, spreadsheet } from '@kosh/views';
import { closeDocuments } from './documents.js';
import { reportingShutro } from './models.js';
import { registerReportRoutes } from './routes.js';
import { installTemplates, registerDocumentRoutes } from './routes-documents.js';
import type { ScheduleEngine } from './schedules.js';

export {
  type Block,
  closeDocuments,
  type DocumentData,
  type DocumentFields,
  type DocumentFormat,
  formatValue as formatDocumentValue,
  type Layout,
  loadDocumentData,
  renderHtml,
  renderPdf,
} from './documents.js';
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
export {
  documentFields,
  installTemplates,
  layoutProblems,
  registerDocumentRoutes,
  renderDocument,
  scheduleRenderer,
} from './routes-documents.js';
export {
  type DeliveryAdapter,
  type JobQueue,
  nextRun,
  type Rendered,
  ScheduleEngine,
  type ScheduleRenderer,
  type ScheduleSpec,
} from './schedules.js';
export { type Cell, moneyFormat, type Sheet, workbook, zip } from './xlsx.js';
export { reportingShutro };

/** Package identity. */
export const PACKAGE: { readonly name: string; readonly rfc: string } = Object.freeze({
  name: '@kosh/reporting',
  rfc: 'RFC 0005',
});

/** The schedule engines by server app, so an application can add delivery adapters (`engineOf(app).use(...)`). */
const engines = new WeakMap<object, ScheduleEngine>();
export function engineOf(app: object): ScheduleEngine | undefined {
  return engines.get(app);
}

/** The Kosh module: install it for reports, exports, documents, schedules, dashboards and spreadsheets. */
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
    'reporting.action_templates': {
      model: 'report.template',
      label: 'Documents',
      views: ['designer'] as never,
      visibleTo: ['reporting.designer'],
    },
    'reporting.action_schedules': {
      model: 'report.schedule',
      label: 'Scheduled reports',
      views: ['list', 'form'],
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
    {
      id: 'reporting.schedules',
      parent: 'reporting.root',
      label: 'Scheduled reports',
      action: 'reporting.action_schedules',
      sequence: 3,
    },
    {
      id: 'reporting.templates',
      parent: 'reporting.root',
      label: 'Documents',
      action: 'reporting.action_templates',
      sequence: 4,
    },
  ],
  views: {
    'report.dashboard.dashboard': dashboard({ label: 'Dashboards' }),
    'report.spreadsheet.spreadsheet': spreadsheet('report.spreadsheet', { label: 'Spreadsheets' }),
    'report.schedule.list': list('report.schedule', {
      columns: [
        'name',
        'targetModel',
        { field: 'kind', widget: 'badge' },
        'format',
        'frequency',
        'nextRunAt',
        'lastRunAt',
        'lastError',
      ],
    }),
    'report.schedule.form': form('report.schedule', (f) => ({
      sheet: [
        f.group('main', ['name', 'targetModel', 'kind', 'template', 'format', 'shared']),
        f.group('when', ['frequency', 'day', 'hour', 'tz', 'nextRunAt', 'lastRunAt', 'lastError'], {
          label: 'When',
        }),
        f.group('what', ['query', 'recipients'], { label: 'What', columns: 1 }),
        f.component('outputs', 'reporting.ScheduleOutputs'),
      ],
    })),
    'report.template.designer': {
      type: 'designer',
      id: '',
      model: 'report.template',
      label: 'Documents',
    } as never,
  },
  hooks: {
    defaults: async (env, modules) =>
      `${await installTemplates(env as Env, modules)} document template(s) installed`,
  },
  routes: (context: ModuleContext) => {
    registerReportRoutes(context);
    const engine = registerDocumentRoutes(context);
    engines.set(context.app, engine);
    if (process.env['KOSH_SCHEDULES'] !== 'off') engine.start();
    context.app.addHook('onClose', async () => {
      await engine.stop();
      await closeDocuments();
    });
  },
});
