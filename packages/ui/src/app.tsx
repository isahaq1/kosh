/**
 * The Kosh back-office app (RFC 0007): TanStack Router routes from apps, menus and actions, TanStack Query for
 * server state, the shell (launcher, menus filtered by the server, company, language, theme), and the view
 * renderers from the registry. Search state lives in the URL (`?view=kanban&q=...`), so deep links and the back
 * button work.
 *
 * Routes: `/login`, `/` (launcher), `/:app` (first menu entry), `/:app/a/:action` (list / kanban),
 * `/:app/a/:action/:id` (form; `new` for a new record).
 */
import { compileSearch, decodeSearch, encodeSearch, type SearchState } from '@kosh/search';
import type { ClientAction, Condition, ViewType, WindowAction } from '@kosh/views';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Navigate,
  Outlet,
  RouterProvider,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import type { i18n } from 'i18next';
import {
  CalendarDays,
  ChartColumn,
  ChartGantt,
  Columns3,
  Grid2x2,
  Grid3x3,
  Languages,
  LayoutDashboard,
  List,
  LogOut,
  Map as MapIcon,
  Monitor,
  Moon,
  Network,
  Plus,
  Sheet,
  Sun,
  Table2,
  UserRound,
} from 'lucide-react';
import { Direction } from 'radix-ui';
import {
  createContext,
  type ReactElement,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { I18nextProvider, useTranslation } from 'react-i18next';
import { ApiError, type CurrentUser, type KoshApi, type MenuNode } from './api.js';
import {
  Alert,
  Button,
  Card,
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
  Select,
  Spinner,
} from './components/primitives.js';
import { KoshProvider, type ThemeChoice, useKosh } from './context.js';
import { addMessages, createI18n, directionOf } from './i18n/index.js';
import { LANGUAGES } from './i18n/messages.js';
import type { Registry } from './registry.js';
import { SearchBar } from './search/SearchBar.js';
import { Login } from './shell/Login.js';

interface Services {
  readonly api: KoshApi;
  readonly registry: Registry;
  readonly i18n: i18n;
  readonly lang: string;
  setLang(lang: string): void;
}

const ServicesContext = createContext<Services | null>(null);

function useServices(): Services {
  const value = useContext(ServicesContext);
  if (value === null) throw new Error('Kosh routes render inside <KoshApp>.');
  return value;
}

// ------------------------------------------------------------------------------------------------- shell

function firstAction(menus: readonly MenuNode[]): MenuNode | undefined {
  for (const m of menus) {
    if (m.action !== undefined) return m;
    const child = firstAction(m.children);
    if (child !== undefined) return child;
  }
  return undefined;
}

function MenuLinks({
  app,
  menus,
}: {
  readonly app: string;
  readonly menus: readonly MenuNode[];
}): ReactElement {
  const navigate = useNavigate();
  const entries = menus.flatMap((root) => (root.action === undefined ? root.children : [root]));
  return (
    <ul className="flex flex-wrap items-center gap-1">
      {entries.map((m) =>
        m.children.length > 0 ? (
          <li key={m.id}>
            <Menu>
              <MenuTrigger asChild>
                <Button variant="ghost" size="sm">
                  {m.label}
                </Button>
              </MenuTrigger>
              <MenuContent align="start">
                {m.children.map((c) =>
                  c.action === undefined ? null : (
                    <MenuItem
                      key={c.id}
                      onSelect={() =>
                        void navigate({
                          to: '/$app/a/$action',
                          params: { app, action: c.action as string },
                        })
                      }
                    >
                      {c.label}
                    </MenuItem>
                  ),
                )}
              </MenuContent>
            </Menu>
          </li>
        ) : m.action === undefined ? null : (
          <li key={m.id}>
            <Link
              to="/$app/a/$action"
              params={{ app, action: m.action }}
              className="rounded-md px-3 py-1.5 text-sm hover:bg-muted"
              activeProps={{ 'aria-current': 'page', className: 'bg-muted font-medium' }}
            >
              {m.label}
            </Link>
          </li>
        ),
      )}
    </ul>
  );
}

function ThemeMenu(): ReactElement {
  const { t } = useTranslation();
  const { theme, setTheme } = useKosh();
  const icons = { light: Sun, dark: Moon, system: Monitor } as const;
  const Icon = icons[theme];
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t('shell.theme')}>
          <Icon aria-hidden />
        </Button>
      </MenuTrigger>
      <MenuContent>
        <MenuLabel>{t('shell.theme')}</MenuLabel>
        {(['light', 'dark', 'system'] as ThemeChoice[]).map((choice) => (
          <MenuCheckboxItem
            key={choice}
            checked={theme === choice}
            onCheckedChange={() => setTheme(choice)}
          >
            {t(`shell.${choice}`)}
          </MenuCheckboxItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

function LanguageMenu(): ReactElement {
  const { t } = useTranslation();
  const { lang, setLang } = useServices();
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t('shell.language')}>
          <Languages aria-hidden />
        </Button>
      </MenuTrigger>
      <MenuContent>
        <MenuLabel>{t('shell.language')}</MenuLabel>
        {LANGUAGES.map((l) => (
          <MenuCheckboxItem
            key={l.code}
            checked={lang === l.code}
            onCheckedChange={() => setLang(l.code)}
          >
            <span lang={l.code.replace('_', '-')}>{l.name}</span>
          </MenuCheckboxItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

function CompanySwitcher({
  me,
  company,
  onChange,
}: {
  readonly me: CurrentUser;
  readonly company: number;
  readonly onChange: (id: number) => void;
}): ReactElement | null {
  const { t } = useTranslation();
  const { api } = useServices();
  const names = useQuery({
    queryKey: ['names', 'res.company', me.companies],
    queryFn: () => api.names('res.company', { ids: me.companies }),
    enabled: me.companies.length > 1,
  });
  if (me.companies.length < 2) return null;
  return (
    <Select
      label={t('shell.company')}
      className="h-8 w-48"
      value={String(company)}
      options={(names.data ?? []).map((c) => ({ value: String(c.id), label: c.displayName }))}
      onChange={(v) => onChange(Number(v))}
    />
  );
}

function Shell(): ReactElement {
  const { api, registry, lang } = useServices();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { app?: string };
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.me(), retry: false });
  const [company, setCompany] = useState<number | undefined>(undefined);
  const apps = useQuery({
    queryKey: ['apps', company],
    queryFn: () => api.apps(),
    enabled: me.isSuccess,
  });
  const menus = useQuery({
    queryKey: ['menus', params.app, company],
    queryFn: () => api.menus(params.app),
    enabled: me.isSuccess && params.app !== undefined,
  });
  if (me.isError) {
    if (me.error instanceof ApiError && me.error.status === 401) return <Navigate to="/login" />;
    return <Alert>{me.error.message}</Alert>;
  }
  if (me.data === undefined) return <Spinner label={t('app.loading')} />;
  const user = me.data;
  const current = company ?? user.company ?? user.companies[0] ?? 0;
  const app = apps.data?.find((a) => a.code === params.app);
  return (
    <KoshProvider
      api={api}
      registry={registry}
      uid={user.id}
      companyId={current}
      lang={lang}
      tz={Intl.DateTimeFormat().resolvedOptions().timeZone}
    >
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:absolute focus:start-2 focus:top-2 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2"
      >
        {t('shell.skip')}
      </a>
      <header className="sticky top-0 z-30 border-b bg-surface">
        <div className="flex h-12 items-center gap-2 px-3">
          <Menu>
            <MenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label={t('shell.apps')}>
                <Grid3x3 aria-hidden />
              </Button>
            </MenuTrigger>
            <MenuContent align="start">
              <MenuItem onSelect={() => void navigate({ to: '/' })}>{t('shell.apps')}</MenuItem>
              <MenuSeparator />
              {(apps.data ?? []).map((a) => (
                <MenuItem
                  key={a.code}
                  onSelect={() => void navigate({ to: '/$app', params: { app: a.code } })}
                >
                  {a.label}
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
          <Link to="/" className="font-semibold">
            {app?.label ?? t('app.name')}
          </Link>
          <nav aria-label={t('shell.menu')} className="ms-2 flex-1">
            {params.app === undefined ? null : (
              <MenuLinks app={params.app} menus={menus.data ?? []} />
            )}
          </nav>
          <CompanySwitcher
            me={user}
            company={current}
            onChange={(id) => {
              api.setCompany(id);
              setCompany(id);
              void queryClient.invalidateQueries();
            }}
          />
          <LanguageMenu />
          <ThemeMenu />
          <Menu>
            <MenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label={user.name}>
                <UserRound aria-hidden />
              </Button>
            </MenuTrigger>
            <MenuContent>
              <MenuLabel>{user.name}</MenuLabel>
              <MenuItem
                onSelect={async () => {
                  await api.logout();
                  queryClient.clear();
                  await navigate({ to: '/login' });
                }}
              >
                <LogOut className="size-4" aria-hidden />
                {t('auth.signOut')}
              </MenuItem>
            </MenuContent>
          </Menu>
        </div>
      </header>
      {user.administratorNeedsSecondFactor ? (
        <div className="px-4 pt-3">
          <Alert tone="info">{t('auth.adminNeeds2fa')}</Alert>
        </div>
      ) : null}
      <main id="content" className="mx-auto w-full max-w-[100rem] p-4">
        <Outlet />
      </main>
    </KoshProvider>
  );
}

function Launcher(): ReactElement {
  const { api } = useServices();
  const { t } = useTranslation();
  const apps = useQuery({ queryKey: ['apps', 'launcher'], queryFn: () => api.apps() });
  if (apps.isPending) return <Spinner label={t('app.loading')} />;
  return (
    <section aria-labelledby="apps-title">
      <h1 id="apps-title" className="mb-4 text-xl font-semibold">
        {t('shell.apps')}
      </h1>
      {(apps.data ?? []).length === 0 ? (
        <p className="text-muted-foreground">{t('shell.noApps')}</p>
      ) : null}
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-3">
        {(apps.data ?? []).map((a) => (
          <li key={a.code}>
            <Link to="/$app" params={{ app: a.code }} className="block">
              <Card className="p-4 text-center font-medium hover:bg-muted">{a.label}</Card>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function AppHome(): ReactElement {
  const { api } = useServices();
  const { t } = useTranslation();
  const { app } = useParams({ strict: false }) as { app: string };
  const menus = useQuery({ queryKey: ['menus', app], queryFn: () => api.menus(app) });
  if (menus.isPending) return <Spinner label={t('app.loading')} />;
  const first = firstAction(menus.data ?? []);
  if (first?.action === undefined)
    return <p className="p-6 text-muted-foreground">{t('app.notFound')}</p>;
  return <Navigate to="/$app/a/$action" params={{ app, action: first.action }} replace />;
}

// ------------------------------------------------------------------------------------------------- views

function useAction(id: string) {
  const { api } = useServices();
  return useQuery({ queryKey: ['action', id], queryFn: () => api.action(id) });
}

/** The action when it is a window action (the record pages only open those). */
function useWindowAction(id: string) {
  const query = useAction(id);
  const data: WindowAction | undefined =
    query.data === undefined || query.data.type === 'client' ? undefined : query.data;
  return { isError: query.isError, error: query.error, data };
}

function useServedView(action: WindowAction | undefined, type: ViewType) {
  const { api } = useServices();
  const viewId = action?.viewIds?.[type];
  return useQuery({
    queryKey: ['view', action?.model, type, viewId],
    queryFn: () =>
      viewId === undefined ? api.viewFor(action?.model as string, type) : api.view(viewId),
    enabled: action !== undefined,
  });
}

interface ActionSearch {
  readonly view?: string;
  readonly q?: string;
}

/** A client action: the page a module registered (RFC 0008). */
function ClientPage({ action }: { readonly action: ClientAction }): ReactElement {
  const { registry, api } = useServices();
  const { t } = useTranslation();
  const Page = registry.page(action.page);
  if (Page === undefined) return <Alert>{t('app.unknownPage', { page: action.page })}</Alert>;
  return <Page api={api} {...(action.label === undefined ? {} : { label: action.label })} />;
}

function ActionPage(): ReactElement {
  const { action: actionId } = useParams({ strict: false }) as { action: string };
  const action = useAction(actionId);
  if (action.data?.type === 'client') return <ClientPage action={action.data} />;
  return <WindowActionPage />;
}

function WindowActionPage(): ReactElement {
  const { registry, api } = useServices();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { app, action: actionId } = useParams({ strict: false }) as { app: string; action: string };
  const search = useSearch({ strict: false }) as ActionSearch;
  const action = useWindowAction(actionId);
  const types: ViewType[] = (action.data?.views ?? []).filter((v) => v !== 'form');
  const type = (types.includes(search.view as ViewType) ? search.view : types[0]) as
    | ViewType
    | undefined;
  const served = useServedView(action.data, type ?? 'list');
  const spec = useQuery({
    queryKey: ['search', action.data?.model],
    queryFn: () => api.search(action.data?.model as string),
    enabled: action.data !== undefined,
  });
  if (action.error !== null) return <Alert>{action.error.message}</Alert>;
  if (served.isError) return <Alert>{served.error.message}</Alert>;
  if (
    action.data === undefined ||
    served.data === undefined ||
    spec.data === undefined ||
    type === undefined
  )
    return <Spinner label={t('app.loading')} />;
  const model = action.data.model;
  const state: SearchState =
    search.q === undefined
      ? action.data.defaultFilters === undefined
        ? {}
        : { filters: [...action.data.defaultFilters] }
      : decodeSearch(search.q);
  let compiled: ReturnType<typeof compileSearch>;
  try {
    compiled = compileSearch(spec.data, state, action.data.domain);
  } catch {
    compiled = compileSearch(spec.data, {}, action.data.domain); // a stale link: drop what no longer exists
  }
  const fields = served.data.fields[model] ?? {};
  const labels = Object.fromEntries(
    [...spec.data.fields, ...(spec.data.groupBy ?? [])].map((key) => {
      const head = key.split(/[.:]/)[0] as string;
      return [key, fields[head]?.label ?? head];
    }),
  );
  const setState = (next: SearchState) =>
    void navigate({
      to: '/$app/a/$action',
      params: { app, action: actionId },
      search: { ...search, q: encodeSearch(next) || undefined } as never,
    });
  const open = (id: number | 'new') =>
    void navigate({ to: '/$app/a/$action/$id', params: { app, action: actionId, id: String(id) } });
  const Renderer = registry.view(served.data.view.component ?? type);
  const icons = {
    list: List,
    kanban: Columns3,
    pivot: Table2,
    graph: ChartColumn,
    calendar: CalendarDays,
    gantt: ChartGantt,
    map: MapIcon,
    hierarchy: Network,
    cohort: Grid2x2,
    spreadsheet: Sheet,
    dashboard: LayoutDashboard,
  } as const;
  const drill = (domain: Condition) => {
    // The records behind a cell: the list with the search plus the cell's domain (group-bys dropped).
    const custom = state.custom === undefined ? domain : { and: [state.custom, domain] };
    void navigate({
      to: '/$app/a/$action',
      params: { app, action: actionId },
      search: {
        view: types.includes('list') ? 'list' : types[0],
        q: encodeSearch({ ...state, groupBy: [], custom }) || undefined,
      } as never,
    });
  };
  return (
    <section className="grid gap-3" aria-labelledby="action-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h1 id="action-title" className="text-lg font-semibold">
            {action.data.label ?? served.data.view.label ?? model}
          </h1>
          {served.data.operations.create && action.data.views.includes('form') ? (
            <Button variant="primary" size="sm" onClick={() => open('new')}>
              <Plus aria-hidden />
              {t('views.new')}
            </Button>
          ) : null}
        </div>
        {types.length > 1 ? (
          <fieldset className="flex gap-1">
            <legend className="sr-only">Views</legend>
            {types.map((v) => {
              const Icon = icons[v as keyof typeof icons] ?? List;
              return (
                <Button
                  key={v}
                  size="icon"
                  variant={v === type ? 'primary' : 'secondary'}
                  aria-pressed={v === type}
                  aria-label={t(`views.${v}`)}
                  onClick={() =>
                    void navigate({
                      to: '/$app/a/$action',
                      params: { app, action: actionId },
                      search: { ...search, view: v } as never,
                    })
                  }
                >
                  <Icon aria-hidden />
                </Button>
              );
            })}
          </fieldset>
        ) : null}
      </div>
      <SearchBar
        model={model}
        viewType={type}
        spec={spec.data}
        state={state}
        onChange={setState}
        labels={labels}
      />
      {Renderer === undefined ? (
        <Alert>{`No renderer for '${served.data.view.component ?? type}'.`}</Alert>
      ) : (
        <Renderer
          served={served.data}
          where={compiled.where}
          groupBy={compiled.groupBy}
          order={compiled.order}
          onOrder={(order) => setState({ ...state, order })}
          onOpen={open}
          onDrill={drill}
        />
      )}
    </section>
  );
}

function RecordPage(): ReactElement {
  const { registry } = useServices();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const {
    app,
    action: actionId,
    id,
  } = useParams({ strict: false }) as { app: string; action: string; id: string };
  const action = useWindowAction(actionId);
  const served = useServedView(action.data, 'form');
  if (action.error !== null) return <Alert>{action.error.message}</Alert>;
  if (served.isError) return <Alert>{served.error.message}</Alert>;
  if (served.data === undefined) return <Spinner label={t('app.loading')} />;
  const Form = registry.form(served.data.view.component ?? 'form');
  if (Form === undefined) return <Alert>No form renderer.</Alert>;
  const recordId = id === 'new' ? 'new' : Number(id);
  return (
    <Form
      key={id}
      served={served.data}
      recordId={recordId}
      onSaved={(saved) =>
        void navigate({
          to: '/$app/a/$action/$id',
          params: { app, action: actionId, id: String(saved) },
          replace: true,
        })
      }
      onBack={() => void navigate({ to: '/$app/a/$action', params: { app, action: actionId } })}
    />
  );
}

function LoginPage(): ReactElement {
  const navigate = useNavigate();
  return <Login api={useServices().api} onSignedIn={() => void navigate({ to: '/' })} />;
}

// ------------------------------------------------------------------------------------------------- router

const rootRoute = createRootRoute({ component: Outlet });
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: LoginPage,
});
const shellRoute = createRoute({ getParentRoute: () => rootRoute, id: 'shell', component: Shell });
const indexRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/',
  component: Launcher,
});
const appRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/$app',
  component: AppHome,
});
const actionRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/$app/a/$action',
  component: ActionPage,
  validateSearch: (raw: Record<string, unknown>): ActionSearch => ({
    ...(typeof raw['view'] === 'string' ? { view: raw['view'] } : {}),
    ...(typeof raw['q'] === 'string' ? { q: raw['q'] } : {}),
  }),
});
const recordRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/$app/a/$action/$id',
  component: RecordPage,
});
const routeTree = rootRoute.addChildren([
  loginRoute,
  shellRoute.addChildren([indexRoute, appRoute, actionRoute, recordRoute]),
]);

const LANG_KEY = 'kosh.lang';

function initialLanguage(): string {
  try {
    const stored = localStorage.getItem(LANG_KEY);
    if (stored !== null) return stored;
  } catch {
    // storage unavailable
  }
  const browser = typeof navigator === 'undefined' ? 'en' : navigator.language;
  return browser.startsWith('bn') ? 'bn_BD' : browser.startsWith('ar') ? 'ar' : 'en_US';
}

export interface KoshAppProps {
  readonly api: KoshApi;
  readonly registry: Registry;
  /** Module messages by namespace and language (`{ reporting: { en: {...}, bn: {...} } }`). */
  readonly messages?: Readonly<Record<string, Readonly<Record<string, object>>>>;
  /** Loading screen while translations initialize. */
  readonly fallback?: ReactNode;
}

/** The whole app: providers, translations, router. */
export function KoshApp({ api, registry, messages, fallback = null }: KoshAppProps): ReactElement {
  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 15_000,
            retry: (count, error) =>
              !(error instanceof ApiError && error.status < 500) && count < 2,
          },
        },
      }),
    [],
  );
  const [lang, setLangState] = useState(initialLanguage);
  const [startLang] = useState(lang); // the instance is created once; later changes go through changeLanguage
  const [instance, setInstance] = useState<i18n | null>(null);
  useEffect(() => {
    let alive = true;
    void createI18n(startLang).then((created) => {
      for (const [namespace, bundles] of Object.entries(messages ?? {}))
        addMessages(created, namespace, bundles);
      if (alive) setInstance(created);
    });
    return () => {
      alive = false;
    };
  }, [startLang, messages]);
  const router = useMemo(() => createRouter({ routeTree, defaultPreload: 'intent' }), []);
  api.setLanguage(lang);
  if (instance === null) return <>{fallback}</>;
  const services: Services = {
    api,
    registry,
    i18n: instance,
    lang,
    setLang(next) {
      try {
        localStorage.setItem(LANG_KEY, next);
      } catch {
        // storage unavailable
      }
      api.setLanguage(next);
      setLangState(next);
      void instance.changeLanguage(next.replace('_', '-'));
      void queryClient.invalidateQueries(); // labels and messages come translated from the server
    },
  };
  return (
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={instance}>
        <ServicesContext.Provider value={services}>
          <Direction.Provider dir={directionOf(lang)}>
            <RouterProvider router={router} />
          </Direction.Provider>
        </ServicesContext.Provider>
      </I18nextProvider>
    </QueryClientProvider>
  );
}
