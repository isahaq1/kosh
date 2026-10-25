/**
 * The renderer registry (RFC 0004 §5 escape hatches, RFC 0007 §5): view renderers by type, field widgets by name
 * (or field kind), node components by name, and pages (what client actions open, RFC 0008) by name. Modules add entries; replacing an existing one must be asked for
 * (`{ replace: true }`), so two modules cannot silently fight over a widget.
 */
import type { ComponentNode, Condition, FieldNode, ViewType } from '@kosh/views';
import type { ComponentType } from 'react';
import type { KoshApi, Row, ServedView, ViewField } from './api.js';

/** Props of a field widget (display and edit). */
export interface WidgetProps {
  readonly id: string;
  readonly node: FieldNode;
  readonly field: ViewField;
  readonly value: unknown;
  readonly record: Readonly<Record<string, unknown>>;
  readonly readonly: boolean;
  /** Absent in display-only contexts (list cells, cards). */
  readonly onChange?: (value: unknown) => void;
  readonly invalid?: boolean;
}

/** Props of a registered node component (`{ kind: 'component', component: 'approvals.Panel' }`). */
export interface NodeComponentProps {
  readonly node: ComponentNode;
  readonly record: Row | null;
  readonly model: string;
  readonly served: ServedView;
  readonly api: KoshApi;
  /** The record's version (its ETag): changes after every save or transition, so components refetch with it. */
  readonly version: string | null;
  /** Reloads the record (after the component changed it on the server). */
  readonly reload: () => void;
}

/** Props of a view renderer. */
export interface ViewProps {
  readonly served: ServedView;
  /** The compiled search (`@kosh/search`). */
  readonly where: Condition | undefined;
  readonly groupBy: readonly string[];
  readonly order: readonly string[];
  readonly onOrder?: (order: readonly string[]) => void;
  /** Opens a record (`'new'` for a new one) in the form. */
  readonly onOpen: (id: number | 'new', defaults?: Record<string, unknown>) => void;
  /** Drill-down (report views): shows the records of `domain` in the list. */
  readonly onDrill?: (domain: Condition, label?: string) => void;
}

/** Props of the form renderer. */
export interface FormProps {
  readonly served: ServedView;
  readonly recordId: number | 'new';
  readonly defaults?: Record<string, unknown>;
  readonly onSaved: (id: number) => void;
  readonly onBack: () => void;
  /** Where the record sits: app › list (each with a way back), shown before the title (RFC 0010 §3.4). */
  readonly crumbs?: readonly { readonly label: string; readonly onClick?: () => void }[];
  /** Its position in the list it was opened from, and the way to its neighbours. */
  readonly pager?: {
    readonly position: number;
    readonly total: number;
    readonly onPrev?: () => void;
    readonly onNext?: () => void;
  };
}

/** Props of a page: what a client action opens (`{ type: 'client', page: 'settings.Apps' }`). */
export interface PageProps {
  readonly api: KoshApi;
  /** The action's label. */
  readonly label?: string;
}

export class RegistryError extends Error {
  constructor(problem: string) {
    super(problem);
    this.name = 'RegistryError';
  }
}

type Kind = 'view' | 'widget' | 'component' | 'page';

/** Renderers, widgets and components by name. */
export class Registry {
  readonly #entries: Record<Kind, Map<string, ComponentType<never>>> = {
    view: new Map(),
    widget: new Map(),
    component: new Map(),
    page: new Map(),
  };

  #add(kind: Kind, name: string, component: ComponentType<never>, replace: boolean): this {
    if (this.#entries[kind].has(name) && !replace)
      throw new RegistryError(
        `The ${kind} '${name}' is already registered. Pass { replace: true } to replace it.`,
      );
    this.#entries[kind].set(name, component);
    return this;
  }

  /** A view renderer for a view type (`list`, `form`, `kanban`) or a named custom view. */
  registerView(
    type: ViewType | string,
    component: ComponentType<ViewProps> | ComponentType<FormProps>,
    options: { readonly replace?: boolean } = {},
  ): this {
    return this.#add('view', type, component as ComponentType<never>, options.replace === true);
  }

  /** A field widget, by name (`badge`) or field kind (`many2one`). */
  registerWidget(
    name: string,
    component: ComponentType<WidgetProps>,
    options: { readonly replace?: boolean } = {},
  ): this {
    return this.#add('widget', name, component as ComponentType<never>, options.replace === true);
  }

  /** A node component (`approvals.Panel`). */
  registerComponent(
    name: string,
    component: ComponentType<NodeComponentProps>,
    options: { readonly replace?: boolean } = {},
  ): this {
    return this.#add(
      'component',
      name,
      component as ComponentType<never>,
      options.replace === true,
    );
  }

  /** A page client actions open (`settings.Apps`). */
  registerPage(
    name: string,
    component: ComponentType<PageProps>,
    options: { readonly replace?: boolean } = {},
  ): this {
    return this.#add('page', name, component as ComponentType<never>, options.replace === true);
  }

  view(name: string): ComponentType<ViewProps> | undefined {
    return this.#entries.view.get(name) as ComponentType<ViewProps> | undefined;
  }

  form(name = 'form'): ComponentType<FormProps> | undefined {
    return this.#entries.view.get(name) as ComponentType<FormProps> | undefined;
  }

  /** The widget for a node: its `widget`, else the field kind, else plain text. */
  widget(node: FieldNode, field: ViewField): ComponentType<WidgetProps> {
    const entries = this.#entries.widget;
    return (entries.get(node.widget ?? '') ??
      entries.get(field.kind) ??
      entries.get('char')) as ComponentType<WidgetProps>;
  }

  component(name: string): ComponentType<NodeComponentProps> | undefined {
    return this.#entries.component.get(name) as ComponentType<NodeComponentProps> | undefined;
  }

  page(name: string): ComponentType<PageProps> | undefined {
    return this.#entries.page.get(name) as ComponentType<PageProps> | undefined;
  }

  /** A copy, for an app that changes entries without touching the defaults. */
  clone(): Registry {
    const copy = new Registry();
    for (const kind of ['view', 'widget', 'component', 'page'] as const)
      for (const [name, c] of this.#entries[kind]) copy.#entries[kind].set(name, c);
    return copy;
  }
}
