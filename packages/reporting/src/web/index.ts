/**
 * @packageDocumentation
 * The web contribution of `@isahaq/kosh-reporting` (RFC 0005, RFC 0007): renderers for the report views — pivot, graph,
 * calendar, gantt, map, hierarchy, cohort, spreadsheet, dashboard — registered by view type, and their messages.
 * ECharts and MapLibre load on demand, when a chart or map is shown.
 */
import { addMessages, type Registry } from '@isahaq/kosh-ui';
import type { i18n } from 'i18next';
import { CalendarView } from './CalendarView.js';
import { CohortView } from './CohortView.js';
import { Documents, ScheduleOutputs } from './components.js';
import { DashboardView } from './DashboardView.js';
import { DesignerView } from './DesignerView.js';
import { GanttView } from './GanttView.js';
import { GraphView } from './GraphView.js';
import { HierarchyView } from './HierarchyView.js';
import { MapView } from './MapView.js';
import { messages } from './messages.js';
import { PivotView } from './PivotView.js';
import { SpreadsheetView } from './SpreadsheetView.js';

export { CalendarView, gridDays } from './CalendarView.js';
export { CohortView, cohortTable, periodsBetween } from './CohortView.js';
export { Documents, ScheduleOutputs } from './components.js';
export { type Card, DashboardView } from './DashboardView.js';
export { DesignerView } from './DesignerView.js';
export { evaluateSheet, reportCalls } from './formula.js';
export { GanttView, windowOf } from './GanttView.js';
export { chartData, GraphView, ReportChart, type ReportChartProps } from './GraphView.js';
export { HierarchyView } from './HierarchyView.js';
export { DEFAULT_MAP_STYLE, MapView } from './MapView.js';
export { PivotView } from './PivotView.js';
export { SpreadsheetView } from './SpreadsheetView.js';

/** Registers the report views (and their messages in `i18n`, when given). */
export function registerReportingWeb(registry: Registry, i18n?: i18n): Registry {
  registry
    .registerView('pivot', PivotView)
    .registerView('graph', GraphView)
    .registerView('calendar', CalendarView)
    .registerView('gantt', GanttView)
    .registerView('map', MapView)
    .registerView('hierarchy', HierarchyView)
    .registerView('cohort', CohortView)
    .registerView('spreadsheet', SpreadsheetView)
    .registerView('dashboard', DashboardView)
    .registerView('designer', DesignerView)
    .registerComponent('reporting.Documents', Documents)
    .registerComponent('reporting.ScheduleOutputs', ScheduleOutputs);
  if (i18n !== undefined) addMessages(i18n, 'reporting', messages);
  return registry;
}

export { messages as reportingMessages };
