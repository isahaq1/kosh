/**
 * Typed view builders (RFC 0004 §5). Field keys are checked against the model at compile time when the builders
 * get the model handle (`list(PurchaseOrder, { columns: ['name', 'amountTotal'] })`; a typo is a type error);
 * transitions, targets of relations and widgets are checked when the server loads the modules.
 *
 * The model handle is described structurally (a name and a `fields` record), so this package does not depend on
 * Shutro.
 */
import type {
  ButtonNode,
  CalendarView,
  CohortView,
  ComponentNode,
  Condition,
  DashboardView,
  FieldNode,
  FormNode,
  FormView,
  GanttView,
  GraphView,
  GroupNode,
  HierarchyView,
  KanbanView,
  LinesNode,
  ListView,
  MapView,
  MeasureNode,
  NotebookNode,
  PageNode,
  PivotView,
  SearchSpec,
  SpreadsheetView,
  WindowAction,
} from './types.js';

/** What the builders read from a Shutro model handle. */
export interface ModelHandle {
  readonly name: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

/** Fields every model has (Shutro implicit fields), plus the opt-in ones. */
export type ImplicitKey =
  | 'id'
  | 'displayName'
  | 'createdAt'
  | 'createdBy'
  | 'updatedAt'
  | 'updatedBy'
  | 'active'
  | 'company';

/** The field keys of a model handle, or any string for a model given by name. */
export type FieldKey<M> = M extends ModelHandle
  ? (keyof M['fields'] & string) | ImplicitKey
  : string;

type ModelRef = ModelHandle | string;
const nameOf = (model: ModelRef): string => (typeof model === 'string' ? model : model.name);

/** A field given by key, or with options. */
export type FieldInput<K extends string> =
  | K
  | ({ readonly field: K; readonly id?: string } & Omit<FieldNode, 'kind' | 'id' | 'field'>);

function fieldNode<K extends string>(input: FieldInput<K>): FieldNode {
  if (typeof input === 'string') return { kind: 'field', id: input, field: input };
  const { field, id, ...rest } = input;
  return { kind: 'field', id: id ?? field, field, ...rest };
}

/** A field node (forms, cards). */
export function field<K extends string>(input: FieldInput<K>): FieldNode {
  return fieldNode(input);
}

type ViewInput<V> = Omit<V, 'id' | 'model' | 'type'>;

/** A list view. */
export function list<M extends ModelRef>(
  model: M,
  spec: Omit<ViewInput<ListView>, 'columns' | 'inlineEdit' | 'defaultOrder'> & {
    readonly columns: readonly FieldInput<FieldKey<M>>[];
    readonly inlineEdit?: readonly FieldKey<M>[];
    readonly defaultOrder?: readonly (FieldKey<M> | `${FieldKey<M>} asc` | `${FieldKey<M>} desc`)[];
  },
): ListView {
  return {
    ...spec,
    type: 'list',
    id: '',
    model: nameOf(model),
    columns: spec.columns.map(fieldNode),
  };
}

/** Form nodes built for a model (`form(PurchaseOrder, (f) => ({ sheet: [f.group('main', ['name'])] }))`). */
export interface FormKit<K extends string> {
  field(input: FieldInput<K>): FieldNode;
  group(
    id: string,
    children: readonly (FieldInput<K> | FormNode)[],
    options?: Omit<GroupNode, 'kind' | 'id' | 'children'>,
  ): GroupNode;
  notebook(id: string, pages: readonly PageNode[]): NotebookNode;
  page(id: string, label: string, children: readonly (FieldInput<K> | FormNode)[]): PageNode;
  /** An editable one2many; its columns are keys of the related model (checked at load). */
  lines(
    field: K,
    columns: readonly FieldInput<string>[],
    options?: { readonly readonlyWhen?: Condition },
  ): LinesNode;
  component(
    id: string,
    component: string,
    props?: Readonly<Record<string, unknown>>,
  ): ComponentNode;
  button(
    transition: string,
    options?: Omit<ButtonNode, 'kind' | 'id' | 'transition'> & { readonly id?: string },
  ): ButtonNode;
}

const child = <K extends string>(c: FieldInput<K> | FormNode): FormNode =>
  typeof c === 'string' || !('kind' in c) ? fieldNode(c as FieldInput<K>) : c;

function kit<K extends string>(): FormKit<K> {
  return {
    field: fieldNode,
    group: (id, children, options = {}) => ({
      kind: 'group',
      id,
      ...options,
      children: children.map(child),
    }),
    notebook: (id, pages) => ({ kind: 'notebook', id, pages }),
    page: (id, label, children) => ({ kind: 'page', id, label, children: children.map(child) }),
    lines: (key, columns, options = {}) => ({
      kind: 'lines',
      id: key,
      field: key,
      columns: columns.map(fieldNode),
      ...options,
    }),
    component: (id, component, props) => ({
      kind: 'component',
      id,
      component,
      ...(props === undefined ? {} : { props }),
    }),
    button: (transition, options = {}) => {
      const { id, ...rest } = options;
      return { kind: 'button', id: id ?? transition, transition, ...rest };
    },
  };
}

/** A form view. */
export function form<M extends ModelRef>(
  model: M,
  build: (f: FormKit<FieldKey<M>>) => Omit<ViewInput<FormView>, 'header'> & {
    readonly header?: {
      readonly statusbar?: FieldKey<M>;
      readonly buttons?: readonly ButtonNode[];
    };
  },
): FormView {
  const spec = build(kit<FieldKey<M>>());
  return {
    ...spec,
    type: 'form',
    id: '',
    model: nameOf(model),
    header: {
      ...(spec.header?.statusbar === undefined ? {} : { statusbar: spec.header.statusbar }),
      buttons: spec.header?.buttons ?? [],
    },
  };
}

/** A kanban view. */
export function kanban<M extends ModelRef>(
  model: M,
  spec: Omit<ViewInput<KanbanView>, 'groupBy' | 'card' | 'total'> & {
    readonly groupBy: FieldKey<M>;
    /** A numeric or monetary field summed per column, shown in the column header. */
    readonly total?: FieldKey<M>;
    readonly card: {
      readonly title: FieldKey<M>;
      readonly subtitle?: FieldKey<M>;
      readonly footer?: readonly FieldInput<FieldKey<M>>[];
      readonly badges?: readonly FieldInput<FieldKey<M>>[];
    };
  },
): KanbanView {
  return {
    ...spec,
    type: 'kanban',
    id: '',
    model: nameOf(model),
    card: {
      title: spec.card.title,
      ...(spec.card.subtitle === undefined ? {} : { subtitle: spec.card.subtitle }),
      footer: (spec.card.footer ?? []).map(fieldNode),
      badges: (spec.card.badges ?? []).map(fieldNode),
    },
  };
}

/** A window action. */
export function action<M extends ModelRef>(
  model: M,
  spec: Omit<WindowAction, 'model'>,
): WindowAction {
  return { ...spec, model: nameOf(model) };
}

/** A search definition. */
export function search<M extends ModelRef>(
  _model: M,
  spec: Omit<SearchSpec, 'fields' | 'groupBy'> & {
    readonly fields: readonly (FieldKey<M> | `${FieldKey<M>}.${string}`)[];
    readonly groupBy?: readonly (
      | FieldKey<M>
      | `${FieldKey<M>}:${'day' | 'week' | 'month' | 'quarter' | 'year'}`
    )[];
  },
): SearchSpec {
  return spec;
}

// ------------------------------------------------------------------------------------------------- report views

type Granularity = 'day' | 'week' | 'month' | 'quarter' | 'year';
/** A group of a report view: a field, or a date field with a granularity (`dateOrder:month`). */
export type GroupKey<M> = FieldKey<M> | `${FieldKey<M>}:${Granularity}`;

/** A measure: `'count'`, `{ sum | avg | min | max: field }`, optionally with a label and id. */
export type MeasureInput<K extends string> =
  | 'count'
  | { readonly sum: K; readonly label?: string; readonly id?: string }
  | { readonly avg: K; readonly label?: string; readonly id?: string }
  | { readonly min: K; readonly label?: string; readonly id?: string }
  | { readonly max: K; readonly label?: string; readonly id?: string }
  | { readonly count: true; readonly label?: string; readonly id?: string };

function measureNode<K extends string>(input: MeasureInput<K>): MeasureNode {
  if (input === 'count') return { id: 'count', measure: 'count' };
  if ('count' in input)
    return {
      id: input.id ?? 'count',
      measure: 'count',
      ...(input.label === undefined ? {} : { label: input.label }),
    };
  const op = (['sum', 'avg', 'min', 'max'] as const).find((o) => o in input) as
    | 'sum'
    | 'avg'
    | 'min'
    | 'max';
  const field = (input as Record<string, unknown>)[op] as string;
  return {
    id: input.id ?? `${op}_${field}`,
    measure: { [op]: field } as MeasureNode['measure'],
    ...(input.label === undefined ? {} : { label: input.label }),
  };
}

/** A pivot view. */
export function pivot<M extends ModelRef>(
  model: M,
  spec: Omit<ViewInput<PivotView>, 'rows' | 'cols' | 'measures' | 'comparison'> & {
    readonly rows: readonly GroupKey<M>[];
    readonly cols?: readonly GroupKey<M>[];
    readonly measures: readonly MeasureInput<FieldKey<M>>[];
    readonly comparison?: { readonly field: FieldKey<M>; readonly mode: 'previous' | 'yoy' };
  },
): PivotView {
  return {
    ...spec,
    type: 'pivot',
    id: '',
    model: nameOf(model),
    cols: spec.cols ?? [],
    measures: spec.measures.map(measureNode),
  };
}

/** A chart view. */
export function graph<M extends ModelRef>(
  model: M,
  spec: Omit<ViewInput<GraphView>, 'groupBy' | 'measure' | 'comparison'> & {
    readonly groupBy: readonly [GroupKey<M>] | readonly [GroupKey<M>, GroupKey<M>];
    readonly measure: MeasureInput<FieldKey<M>>;
    readonly comparison?: { readonly field: FieldKey<M>; readonly mode: 'previous' | 'yoy' };
  },
): GraphView {
  return {
    ...spec,
    type: 'graph',
    id: '',
    model: nameOf(model),
    measure: measureNode(spec.measure),
  };
}

type Keys<M, V> = {
  readonly [K in keyof V]: V[K] extends string
    ? FieldKey<M>
    : V[K] extends string | undefined
      ? FieldKey<M> | undefined
      : V[K];
};

/** A calendar view. */
export function calendar<M extends ModelRef>(
  model: M,
  spec: Keys<M, Omit<ViewInput<CalendarView>, 'mode' | 'label' | 'component'>> &
    Pick<CalendarView, 'mode' | 'label' | 'component'>,
): CalendarView {
  return {
    ...(spec as Omit<CalendarView, 'type' | 'id' | 'model'>),
    type: 'calendar',
    id: '',
    model: nameOf(model),
  };
}

/** A gantt (timeline) view. */
export function gantt<M extends ModelRef>(
  model: M,
  spec: Keys<M, Omit<ViewInput<GanttView>, 'scale' | 'label' | 'component'>> &
    Pick<GanttView, 'scale' | 'label' | 'component'>,
): GanttView {
  return {
    ...(spec as Omit<GanttView, 'type' | 'id' | 'model'>),
    type: 'gantt',
    id: '',
    model: nameOf(model),
  };
}

/** A map view. */
export function map<M extends ModelRef>(
  model: M,
  spec: Keys<M, Omit<ViewInput<MapView>, 'style' | 'label' | 'component'>> &
    Pick<MapView, 'style' | 'label' | 'component'>,
): MapView {
  return {
    ...(spec as Omit<MapView, 'type' | 'id' | 'model'>),
    type: 'map',
    id: '',
    model: nameOf(model),
  };
}

/** A hierarchy (tree) view. */
export function hierarchy<M extends ModelRef>(
  model: M,
  spec: Keys<M, Omit<ViewInput<HierarchyView>, 'label' | 'component'>> &
    Pick<HierarchyView, 'label' | 'component'>,
): HierarchyView {
  return {
    ...(spec as Omit<HierarchyView, 'type' | 'id' | 'model'>),
    type: 'hierarchy',
    id: '',
    model: nameOf(model),
  };
}

/** A cohort view. */
export function cohort<M extends ModelRef>(
  model: M,
  spec: { readonly dateStart: FieldKey<M>; readonly dateStop: FieldKey<M> } & Pick<
    CohortView,
    'interval' | 'mode' | 'label' | 'component'
  >,
): CohortView {
  return { ...spec, type: 'cohort', id: '', model: nameOf(model) };
}

/** The dashboards view (on `report.dashboard`). */
export function dashboard(spec: Pick<DashboardView, 'label' | 'component'> = {}): DashboardView {
  return { ...spec, type: 'dashboard', id: '', model: 'report.dashboard' };
}

/** A spreadsheet view (sheets are records; the view is the entry point for a model's sheets). */
export function spreadsheet<M extends ModelRef>(
  model: M,
  spec: Pick<SpreadsheetView, 'label' | 'component'> = {},
): SpreadsheetView {
  return { ...spec, type: 'spreadsheet', id: '', model: nameOf(model) };
}
