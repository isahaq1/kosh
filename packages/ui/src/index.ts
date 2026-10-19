/**
 * @packageDocumentation
 * `@kosh/ui` (RFC 0007): the design system (tokens, light/dark themes, RTL, Radix-based primitives), the app shell
 * and router, i18n (English, Bangla, Arabic for RTL), and the view renderers (list, form, kanban) driven by
 * `@kosh/views` definitions and the `@kosh/search` layer. Renderers, widgets and components are registered by name:
 * modules add their own and replace defaults explicitly.
 */
import { Registry } from './registry.js';
import { FormView } from './views/FormView.js';
import { KanbanView } from './views/KanbanView.js';
import { ListView } from './views/ListView.js';
import { registerDefaultWidgets } from './views/widgets.js';

export {
  ApiError,
  type ApiOptions,
  type AppEntry,
  type CurrentUser,
  createKoshApi,
  type KoshApi,
  type ListQuery,
  type MenuNode,
  type Problem,
  type Row,
  type ServedView,
  type Versioned,
  type ViewField,
} from './api.js';
export { KoshApp, type KoshAppProps } from './app.js';
export * from './components/primitives.js';
export { type KoshContextValue, KoshProvider, type ThemeChoice, useKosh } from './context.js';
export { addMessages, createI18n, directionOf, NAMESPACE } from './i18n/index.js';
export { LANGUAGES } from './i18n/messages.js';
export { cn } from './lib/cn.js';
export { bcp47, createFormatter, type Formatter } from './lib/format.js';
export {
  type FormProps,
  type NodeComponentProps,
  type PageProps,
  Registry,
  RegistryError,
  type ViewProps,
  type WidgetProps,
} from './registry.js';
export { SearchBar, type SearchBarProps } from './search/SearchBar.js';
export { Login } from './shell/Login.js';
export { FormView } from './views/FormView.js';
export { KanbanView } from './views/KanbanView.js';
export { ListView } from './views/ListView.js';
export {
  PrefetchedNames,
  registerDefaultWidgets,
  useDisplayNames,
  useRowNames,
} from './views/widgets.js';

/** A registry with the default renderers and widgets; modules register theirs on top. */
export function createDefaultRegistry(): Registry {
  const registry = new Registry();
  registry
    .registerView('list', ListView)
    .registerView('kanban', KanbanView)
    .registerView('form', FormView);
  return registerDefaultWidgets(registry);
}

/** Package identity. */
export const PACKAGE: { readonly name: string; readonly rfc: string } = Object.freeze({
  name: '@kosh/ui',
  rfc: 'RFC 0007',
});
