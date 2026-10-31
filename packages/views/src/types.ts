/**
 * View definitions (RFC 0004): typed data, served as JSON. Every node has an id (its anchor) so other modules can
 * extend a view without forking it; conditions are Shutro domains, evaluated by the client for display and
 * re-checked by the server on write.
 */

/** A Shutro domain (`{ state: { notIn: ['draft'] } }`, `{ or: [...] }`, `{ createdBy: { $env: 'uid' } }`). */
export type Condition = Readonly<Record<string, unknown>>;

/** A field on a form, in a list or on a card. */
export interface FieldNode {
  readonly kind: 'field';
  readonly id: string;
  readonly field: string;
  readonly label?: string;
  /** A registered field widget (`badge`, `statusbar`, `money`, `many2one`, ...) or a custom one. */
  readonly widget?: string;
  readonly readonlyWhen?: Condition;
  readonly visibleWhen?: Condition;
  /** List columns: show the total. */
  readonly sum?: boolean;
  /** Placeholder / help text. */
  readonly help?: string;
}

/** Fields side by side under a title. */
export interface GroupNode {
  readonly kind: 'group';
  readonly id: string;
  readonly label?: string;
  readonly columns?: 1 | 2 | 3;
  readonly children: readonly FormNode[];
  readonly visibleWhen?: Condition;
}

export interface PageNode {
  readonly kind: 'page';
  readonly id: string;
  readonly label: string;
  readonly children: readonly FormNode[];
  readonly visibleWhen?: Condition;
}

export interface NotebookNode {
  readonly kind: 'notebook';
  readonly id: string;
  readonly pages: readonly PageNode[];
}

/** An editable one2many (order lines) shown as a table. */
export interface LinesNode {
  readonly kind: 'lines';
  readonly id: string;
  readonly field: string;
  readonly columns: readonly FieldNode[];
  readonly readonlyWhen?: Condition;
}

/** A registered React component (escape hatch, RFC 0004 §5): receives the record, model and client. */
export interface ComponentNode {
  readonly kind: 'component';
  readonly id: string;
  readonly component: string;
  readonly props?: Readonly<Record<string, unknown>>;
  readonly visibleWhen?: Condition;
}

/**
 * A tile of related records (RFC 0022 §3.1): how many — or how much — of another model relate to this record, with
 * a jump to that list. `where` takes `$record` placeholders (`{ partner: { $record: 'id' } }`); the value is computed
 * by the server with the user's rights.
 */
export interface StatNode {
  readonly kind: 'stat';
  readonly id: string;
  readonly label: string;
  readonly model: string;
  readonly where: Condition;
  /** Default: the count. */
  readonly measure?: { readonly sum: string } | { readonly avg: string };
  /** The window action that opens the records, filtered the same way. */
  readonly action?: string;
  readonly tone?: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
  readonly visibleWhen?: Condition;
}

/** A row of stat tiles; other modules append theirs (`{ append: 'related', nodes: [stat(...)] }`). */
export interface StatsNode {
  readonly kind: 'stats';
  readonly id: string;
  readonly children: readonly StatNode[];
  readonly visibleWhen?: Condition;
}

export type FormNode = FieldNode | GroupNode | NotebookNode | LinesNode | ComponentNode | StatsNode;

/** A header button running a state transition. */
export interface ButtonNode {
  readonly kind: 'button';
  readonly id: string;
  readonly transition: string;
  readonly label?: string;
  readonly primary?: boolean;
  readonly visibleWhen?: Condition;
  /** Ask for confirmation first. */
  readonly confirm?: string;
}

interface ViewBase {
  /** Set by the loader from the key in the manifest's `views`. */
  readonly id: string;
  readonly model: string;
  readonly label?: string;
  /** Replace the whole renderer by a registered component. */
  readonly component?: string;
}

export interface ListView extends ViewBase {
  readonly type: 'list';
  readonly columns: readonly FieldNode[];
  readonly defaultOrder?: readonly string[];
  /** Columns editable in the list. */
  readonly inlineEdit?: readonly string[];
  readonly pageSize?: number;
  /** RFC 0022 §3.3: rows in a tone when a condition holds on them (overdue in danger, done muted). */
  readonly decorations?: Readonly<Partial<Record<Tone, Condition>>>;
}

export interface FormView extends ViewBase {
  readonly type: 'form';
  readonly header: { readonly statusbar?: string; readonly buttons: readonly ButtonNode[] };
  readonly sheet: readonly FormNode[];
  /** The whole record is read-only when this matches (e.g. confirmed orders). */
  readonly readonlyWhen?: Condition;
  /** Messages and activities (RFC 0006). */
  readonly chatter?: boolean;
  /**
   * The key facts under the title (RFC 0018 §4.2): the customer, the date, the total. Default: the first many2one,
   * date and monetary fields of the form.
   */
  readonly subtitle?: readonly string[];
  /** The fields of the right rail's Summary (RFC 0018 §4.2). Default: the group named `totals`. */
  readonly summary?: readonly string[];
}

/** A semantic tone (RFC 0018 §4.5): meaning only, never decoration. */
export type Tone = 'info' | 'success' | 'warning' | 'danger' | 'neutral';

export interface KanbanCard {
  readonly title: string;
  readonly subtitle?: string;
  readonly footer?: readonly FieldNode[];
  readonly badges?: readonly FieldNode[];
  /** RFC 0022 §3.3: a cover image (an `image` field), a person (a many2one with a photo), a progress (0–100). */
  readonly image?: string;
  readonly avatar?: string;
  readonly progress?: string;
  /** A selection or char field whose value tints the card's edge. */
  readonly color?: string;
}

export interface KanbanView extends ViewBase {
  readonly type: 'kanban';
  /** Columns: a selection / state / many2one field. Dragging a card between state columns runs the transition. */
  readonly groupBy: string;
  readonly card: KanbanCard;
  readonly quickCreate?: boolean;
  /** A numeric or monetary field summed per column, shown in the column header (`amountTotal`). */
  readonly total?: string;
}

/** A measure of a report view: `'count'` or `{ sum | avg | min | max: field }`, with a label. */
export type MeasureSpec =
  | 'count'
  | { readonly sum: string }
  | { readonly avg: string }
  | { readonly min: string }
  | { readonly max: string };

export interface MeasureNode {
  readonly id: string;
  readonly measure: MeasureSpec;
  readonly label?: string;
}

/** A period comparison of a report view: the date field and what to compare with. */
export interface ComparisonSpec {
  readonly field: string;
  readonly mode: 'previous' | 'yoy';
}

/** Rows × columns × measures over the report query (RFC 0005). */
export interface PivotView extends ViewBase {
  readonly type: 'pivot';
  readonly rows: readonly string[];
  readonly cols: readonly string[];
  readonly measures: readonly MeasureNode[];
  /** Colour cells by value. */
  readonly heatmap?: boolean;
  readonly comparison?: ComparisonSpec;
}

/** A chart (ECharts) over the report query. */
export interface GraphView extends ViewBase {
  readonly type: 'graph';
  readonly chart: 'bar' | 'line' | 'area' | 'pie' | 'stacked';
  /** The category, and optionally a series split (`['dateOrder:month', 'partner']`). */
  readonly groupBy: readonly string[];
  readonly measure: MeasureNode;
  readonly comparison?: ComparisonSpec;
}

/** Records on a calendar by date. */
export interface CalendarView extends ViewBase {
  readonly type: 'calendar';
  readonly dateStart: string;
  readonly dateStop?: string;
  readonly title: string;
  /** A field whose value colours the events. */
  readonly color?: string;
  readonly mode?: 'month' | 'week';
}

/** Records as bars on a timeline. */
export interface GanttView extends ViewBase {
  readonly type: 'gantt';
  readonly dateStart: string;
  readonly dateStop: string;
  readonly title: string;
  /** Rows of the timeline (e.g. the responsible user). */
  readonly groupBy?: string;
  /** A 0–100 number shown inside the bar. */
  readonly progress?: string;
  readonly scale?: 'day' | 'week' | 'month';
}

/** Records as markers on a map (MapLibre). */
export interface MapView extends ViewBase {
  readonly type: 'map';
  readonly latitude: string;
  readonly longitude: string;
  readonly title: string;
  readonly subtitle?: string;
  /** The map style (a MapLibre style URL); default: the distribution's setting. */
  readonly style?: string;
}

/** A tree of records through a parent field (org charts, category trees). */
export interface HierarchyView extends ViewBase {
  readonly type: 'hierarchy';
  readonly parent: string;
  readonly title: string;
  readonly subtitle?: string;
}

/** Cohorts: records grouped by when they started, counted by how long until they stopped (RFC 0005 §6). */
export interface CohortView extends ViewBase {
  readonly type: 'cohort';
  readonly dateStart: string;
  readonly dateStop: string;
  readonly interval: 'day' | 'week' | 'month';
  /** `retention`: share still open after n periods; `churn`: share closed by then. */
  readonly mode?: 'retention' | 'churn';
}

/** Spreadsheets (records of `report.spreadsheet`): cells with values and formulas over cells and report totals. */
export interface SpreadsheetView extends ViewBase {
  readonly type: 'spreadsheet';
}

/** Dashboards (records of `report.dashboard`): a grid of cards, each a report query (KPI, chart, pivot, list). */
export interface DashboardView extends ViewBase {
  readonly type: 'dashboard';
}

export type ViewDefinition =
  | ListView
  | FormView
  | KanbanView
  | PivotView
  | GraphView
  | CalendarView
  | GanttView
  | MapView
  | HierarchyView
  | CohortView
  | SpreadsheetView
  | DashboardView;
export type ViewType = ViewDefinition['type'];

/** A window action: what a menu opens. */
export interface WindowAction {
  readonly type?: 'window';
  readonly model: string;
  readonly label?: string;
  /** View types in switcher order; the first is the default. */
  readonly views: readonly ViewType[];
  /** Specific view ids per type (otherwise the model's first view of that type). */
  readonly viewIds?: Partial<Record<ViewType, string>>;
  /** A fixed domain the user cannot remove. */
  readonly domain?: Condition;
  /** Search filters selected when the action opens. */
  readonly defaultFilters?: readonly string[];
  /** Values of a record created from this action (`{ kind: 'out_invoice' }`). */
  readonly defaults?: Readonly<Record<string, unknown>>;
  /** Group or permission codes; otherwise any access level of the module. */
  readonly visibleTo?: readonly string[];
}

/**
 * A client action (RFC 0008): a page registered by a module's web contribution (`registry.registerPage`), for screens
 * that are not one model's views, such as the App manager. Visibility is the module's access levels or `visibleTo`,
 * as for window actions; the page calls its module's routes, which check access again.
 */
export interface ClientAction {
  readonly type: 'client';
  /** The page's name in the web registry, `<module>.<Name>` (e.g. `settings.Apps`). */
  readonly page: string;
  readonly label?: string;
  /** Group or permission codes; otherwise any access level of the module. */
  readonly visibleTo?: readonly string[];
}

/** What a menu opens. */
export type Action = WindowAction | ClientAction;

/** A search filter. Filters of the same `group` combine with OR, groups with AND. */
export interface SearchFilter {
  readonly label: string;
  readonly domain: Condition;
  readonly group?: string;
}

/** The search definition of a model (RFC 0004 §5 search layer). */
export interface SearchSpec {
  /** Fields the search box looks in (`ilike`), e.g. `['name', 'partner.name']`. */
  readonly fields: readonly string[];
  readonly filters?: Readonly<Record<string, SearchFilter>>;
  /** Group-by options; dates with a granularity: `dateOrder:month`. */
  readonly groupBy?: readonly string[];
}

/** An operation of a view extension, on the node with id `anchor`. */
export type ViewOperation =
  | { readonly insertAfter: string; readonly nodes: readonly (FormNode | ButtonNode | StatNode)[] }
  | { readonly insertBefore: string; readonly nodes: readonly (FormNode | ButtonNode | StatNode)[] }
  | { readonly append: string; readonly nodes: readonly (FormNode | ButtonNode | StatNode)[] }
  | { readonly replace: string; readonly nodes: readonly (FormNode | ButtonNode | StatNode)[] }
  | { readonly remove: string }
  | { readonly setAttrs: string; readonly attrs: Readonly<Record<string, unknown>> };

/** Another module's changes to a view. */
export interface ViewExtension {
  readonly view: string;
  readonly operations: readonly ViewOperation[];
}

/** A view after extensions, with where each node came from (`kosh inspect view`). */
export interface ResolvedView {
  readonly view: ViewDefinition;
  /** Node id → the module that added or last changed it. */
  readonly origins: Readonly<Record<string, string>>;
  /** Modules in the order they changed the view. */
  readonly chain: readonly string[];
}
