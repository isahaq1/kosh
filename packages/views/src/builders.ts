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
  ComponentNode,
  Condition,
  FieldNode,
  FormNode,
  FormView,
  GroupNode,
  KanbanView,
  LinesNode,
  ListView,
  NotebookNode,
  PageNode,
  SearchSpec,
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
  spec: Omit<ViewInput<KanbanView>, 'groupBy' | 'card'> & {
    readonly groupBy: FieldKey<M>;
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
