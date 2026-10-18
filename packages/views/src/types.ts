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

export type FormNode = FieldNode | GroupNode | NotebookNode | LinesNode | ComponentNode;

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
}

export interface FormView extends ViewBase {
  readonly type: 'form';
  readonly header: { readonly statusbar?: string; readonly buttons: readonly ButtonNode[] };
  readonly sheet: readonly FormNode[];
  /** The whole record is read-only when this matches (e.g. confirmed orders). */
  readonly readonlyWhen?: Condition;
  /** Messages and activities (RFC 0006). */
  readonly chatter?: boolean;
}

export interface KanbanCard {
  readonly title: string;
  readonly subtitle?: string;
  readonly footer?: readonly FieldNode[];
  readonly badges?: readonly FieldNode[];
}

export interface KanbanView extends ViewBase {
  readonly type: 'kanban';
  /** Columns: a selection / state / many2one field. Dragging a card between state columns runs the transition. */
  readonly groupBy: string;
  readonly card: KanbanCard;
  readonly quickCreate?: boolean;
}

export type ViewDefinition = ListView | FormView | KanbanView;
export type ViewType = ViewDefinition['type'];

/** A window action: what a menu opens. */
export interface WindowAction {
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
  /** Group or permission codes; otherwise any access level of the module. */
  readonly visibleTo?: readonly string[];
}

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
  | { readonly insertAfter: string; readonly nodes: readonly (FormNode | ButtonNode)[] }
  | { readonly insertBefore: string; readonly nodes: readonly (FormNode | ButtonNode)[] }
  | { readonly append: string; readonly nodes: readonly (FormNode | ButtonNode)[] }
  | { readonly replace: string; readonly nodes: readonly (FormNode | ButtonNode)[] }
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
