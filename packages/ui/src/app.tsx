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
import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
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
  Search,
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
  useCallback,
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
import { DesignProvider } from './design.js';
import { addMessages, createI18n, directionOf } from './i18n/index.js';
import { LANGUAGES } from './i18n/messages.js';
import {
  claimOfflineCache,
  createOfflinePersister,
  dropOfflineCache,
  OFFLINE_MAX_AGE_MS,
  offlinePersistOptions,
} from './offline/persist.js';
import { OfflineQueue } from './offline/queue.js';
import { setPrefill, takePrefill } from './prefill.js';
import { onAppUpdate, registerServiceWorker } from './pwa/register.js';
import { createRealtimeClient, type RealtimeClient } from './realtime.js';
import type { Registry } from './registry.js';
import { SearchBar } from './search/SearchBar.js';
import { CommandPalette, PaletteContext } from './shell/CommandPalette.js';
import { Home } from './shell/Home.js';
import { Login } from './shell/Login.js';
import { OfflineMenu } from './shell/OfflineMenu.js';
import { rememberRecord } from './shell/recent.js';
import { ShortcutsHelp, useShortcuts } from './shell/shortcuts.js';
import { ToastProvider, useToast } from './shell/toast.js';
import { neighbours } from './views/listMemory.js';

interface Services {
  readonly api: KoshApi;
  readonly registry: Registry;
  /** Live updates and presence (absent without a browser WebSocket, e.g. in tests). */
  readonly realtime?: RealtimeClient;
  /** Changes saved offline (absent without IndexedDB). */
  readonly offline?: OfflineQueue;
  readonly persister?: ReturnType<typeof createOfflinePersister>;
  readonly i18n: i18n;
  readonly lang: string;
  setLang(lang: string): void;
}

/**
 * Inside the shell, for the signed-in user: claims the device's cache for them, loads their queue of changes,
 * sends it when the network is back, registers the service worker and offers the reload of a new version.
 */
function OfflineAgent({ uid }: { readonly uid: number }): null {
  const { offline } = useServices();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { t } = useTranslation();
  useEffect(() => {
    void claimOfflineCache(queryClient, uid);
  }, [queryClient, uid]);
  useEffect(
    () =>
      onAppUpdate((reload) =>
        toast({
          title: t('offline.newVersion'),
          tone: 'info',
          duration: 60_000,
          action: { label: t('offline.reload'), run: reload },
        }),
      ),
    [toast, t],
  );
  useEffect(() => {
    if (offline === undefined) return;
    let alive = true;
    const sync = async () => {
      await offline.setUser(uid);
      if (!alive || !onlineManager.isOnline() || offline.snapshot().length === 0) return;
      const result = await offline.sync();
      if (!alive || result.offline) return;
      if (result.synced > 0) {
        toast({ title: t('offline.synced', { count: result.synced }) });
        await queryClient.invalidateQueries();
      }
      if (result.attention > 0)
        toast({ title: t('offline.needsAttention', { count: result.attention }), tone: 'danger' });
    };
    void sync();
    const unsubscribe = onlineManager.subscribe((online) => {
      if (!alive) return;
      if (online) void sync();
      else
        toast({
          title: t('offline.nowOffline'),
          description: t('offline.offlineHint'),
          tone: 'info',
        });
    });
    return () => {
      alive = false;
      unsubscribe();
      void offline.setUser(null);
    };
  }, [offline, uid, queryClient, toast, t]);
  return null;
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
  const { api, registry, lang, realtime, offline, persister } = useServices();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { app?: string };
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.me(), retry: false });
  const [company, setCompany] = useState<number | undefined>(undefined);
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const shortcutHandlers = useMemo(
    () => ({ palette: () => setPalette(true), help: () => setHelp(true) }),
    [],
  );
  useShortcuts(shortcutHandlers);
  const openHelp = useCallback(() => setHelp(true), []);
  const openPalette = useCallback(() => setPalette(true), []);
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
  if (me.error instanceof ApiError && me.error.status === 401) return <Navigate to="/login" />;
  // A failed refresh keeps the last answer (offline, the server down): the cached screens stay usable.
  if (me.isError && me.data === undefined) return <Alert>{me.error.message}</Alert>;
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
      grouping={user.groupings?.[String(current)] ?? 'international'}
      {...(realtime === undefined ? {} : { realtime })}
      {...(offline === undefined ? {} : { offline })}
    >
      <ToastProvider>
        <DesignProvider>
          <OfflineAgent uid={user.id} />
          <PaletteContext.Provider value={openPalette}>
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
                    <MenuItem onSelect={() => void navigate({ to: '/' })}>
                      {t('shell.apps')}
                    </MenuItem>
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
                <Button
                  variant="secondary"
                  size="sm"
                  className="hidden h-8 w-56 justify-between text-muted-foreground sm:flex"
                  onClick={() => setPalette(true)}
                  aria-keyshortcuts="Control+K Meta+K"
                >
                  <span className="flex items-center gap-2">
                    <Search className="size-4" aria-hidden />
                    {t('palette.button')}
                  </span>
                  <kbd className="rounded border bg-surface px-1.5 text-xs">Ctrl K</kbd>
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="sm:hidden"
                  aria-label={t('palette.button')}
                  onClick={() => setPalette(true)}
                >
                  <Search aria-hidden />
                </Button>
                <OfflineMenu />
                {registry.headerItems().map(({ name, component: Item }) => (
                  <Item key={name} api={api} />
                ))}
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
                        await dropOfflineCache(persister);
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
            <CommandPalette
              open={palette}
              onOpenChange={setPalette}
              api={api}
              onShortcuts={openHelp}
            />
            <ShortcutsHelp open={help} onOpenChange={setHelp} />
          </PaletteContext.Provider>
        </DesignProvider>
      </ToastProvider>
    </KoshProvider>
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
  // A failed refresh keeps what the device has (offline): only a screen with nothing to show says so.
  if (action.error !== null && action.data === undefined)
    return <Alert>{action.error.message}</Alert>;
  if (served.isError && served.data === undefined) return <Alert>{served.error.message}</Alert>;
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
            <>
              <Button variant="primary" size="sm" data-kosh-new onClick={() => open('new')}>
                <Plus aria-hidden />
                {t('views.new')}
              </Button>
              {registry.createAssists().map((Assist, i) => (
                <Assist
                  // biome-ignore lint/suspicious/noArrayIndexKey: registered once at start, never reordered
                  key={i}
                  api={api}
                  model={model}
                  onCreate={(values, proposed) => {
                    setPrefill(actionId, { values, proposed });
                    open('new');
                  }}
                />
              ))}
            </>
          ) : null}
        </div>
        {types.length > 1 ? (
          <fieldset className="flex gap-1">
            <legend className="sr-only">Views</legend>
            {types.map((v, index) => {
              const Icon = icons[v as keyof typeof icons] ?? List;
              return (
                <Button
                  key={v}
                  data-kosh-view={index < 9 ? String(index + 1) : undefined}
                  title={index < 9 ? `${t(`views.${v}`)} (Alt+${index + 1})` : undefined}
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

/** What the record page needs from the shell: the API, the user, the apps (for breadcrumbs). */
function useRecordContext() {
  const { api } = useServices();
  const { uid } = useKosh();
  const apps = useQuery({ queryKey: ['palette', 'apps'], queryFn: () => api.apps() });
  return { api, uid, apps: apps.data ?? [] };
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
  const { api, uid, apps } = useRecordContext();
  const model = action.data?.model;
  const recordId = id === 'new' ? 'new' : Number(id);
  // Values proposed for this new record (Fill from a document), taken once.
  const [prefill] = useState(() => (recordId === 'new' ? takePrefill(actionId) : undefined));
  const name = useQuery({
    queryKey: ['names', model, recordId],
    queryFn: () => api.names(model as string, { ids: [recordId as number] }),
    enabled: model !== undefined && recordId !== 'new',
  });
  const title = name.data?.[0]?.displayName;
  useEffect(() => {
    if (model !== undefined && recordId !== 'new' && title !== undefined)
      rememberRecord(uid, { app, action: actionId, model, id: recordId, title });
  }, [uid, app, actionId, model, recordId, title]);
  // A failed refresh keeps what the device has (offline): only a screen with nothing to show says so.
  if (action.error !== null && action.data === undefined)
    return <Alert>{action.error.message}</Alert>;
  if (served.isError && served.data === undefined) return <Alert>{served.error.message}</Alert>;
  if (served.data === undefined) return <Spinner label={t('app.loading')} />;
  const Form = registry.form(served.data.view.component ?? 'form');
  if (Form === undefined) return <Alert>No form renderer.</Alert>;
  const go = (target: number) =>
    void navigate({
      to: '/$app/a/$action/$id',
      params: { app, action: actionId, id: String(target) },
    });
  const near = recordId === 'new' || model === undefined ? undefined : neighbours(model, recordId);
  const appLabel = apps.find((a) => a.code === app)?.label;
  const listLabel = action.data?.label ?? served.data.view.label ?? model ?? '';
  return (
    <Form
      key={id}
      served={served.data}
      recordId={recordId}
      {...(action.data?.defaults === undefined && prefill === undefined
        ? {}
        : { defaults: { ...(action.data?.defaults ?? {}), ...(prefill?.values ?? {}) } })}
      {...(prefill === undefined ? {} : { proposed: prefill.proposed })}
      crumbs={[
        // The app, then the list; one crumb when they share a name (Contacts › Contacts says nothing more).
        ...(appLabel === undefined || appLabel === listLabel
          ? []
          : [{ label: appLabel, onClick: () => void navigate({ to: '/$app', params: { app } }) }]),
        {
          label: listLabel,
          onClick: () =>
            void navigate({ to: '/$app/a/$action', params: { app, action: actionId } }),
        },
      ]}
      {...(near === undefined
        ? {}
        : {
            pager: {
              position: near.position,
              total: near.total,
              ...(near.prev === undefined ? {} : { onPrev: () => go(near.prev as number) }),
              ...(near.next === undefined ? {} : { onNext: () => go(near.next as number) }),
            },
          })}
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

/** A deep link (emails, chat): opens the record where this user may open it. */
function OpenRecordPage(): ReactElement {
  const { api } = useServices();
  const { t } = useTranslation();
  const { model, id } = useParams({ strict: false }) as { model: string; id: string };
  const routes = useQuery({ queryKey: ['routes'], queryFn: () => api.routes() });
  if (routes.isPending) return <Spinner label={t('app.loading')} />;
  const route = routes.data?.[model];
  if (route?.app === undefined) return <Alert>{t('app.notFound')}</Alert>;
  return (
    <Navigate
      to="/$app/a/$action/$id"
      params={{ app: route.app, action: route.action, id }}
      replace
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
  component: Home,
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
const openRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/open/$model/$id',
  component: OpenRecordPage,
});
const routeTree = rootRoute.addChildren([
  loginRoute,
  shellRoute.addChildren([indexRoute, openRoute, appRoute, actionRoute, recordRoute]),
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
            gcTime: OFFLINE_MAX_AGE_MS, // kept on the device that long (offline/persist.ts)
            retry: (count, error) =>
              !(error instanceof ApiError && error.status < 500) && count < 2,
          },
          // A save while offline fails at once (NetworkError) and the form keeps it on the device, rather than
          // hanging until the network is back.
          mutations: { networkMode: 'always' },
        },
      }),
    [],
  );
  const persister = useMemo(() => createOfflinePersister(), []);
  // TanStack Query starts "online" and follows the browser's events; a page opened while offline must know it.
  useEffect(() => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false)
      onlineManager.setOnline(false);
    registerServiceWorker(); // the shell offline and web push, from the first visit (the login page too)
  }, []);
  const offline = useMemo(
    () => (persister === undefined ? undefined : new OfflineQueue(api)),
    [persister, api],
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
  // Live updates and presence: one connection per tab, for as long as the app lives.
  const realtime = useMemo(
    () => (typeof WebSocket === 'undefined' ? undefined : createRealtimeClient()),
    [],
  );
  useEffect(() => () => realtime?.close(), [realtime]);
  api.setLanguage(lang);
  if (instance === null) return <>{fallback}</>;
  const services: Services = {
    api,
    registry,
    ...(realtime === undefined ? {} : { realtime }),
    ...(offline === undefined ? {} : { offline }),
    ...(persister === undefined ? {} : { persister }),
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
  const inner = (
    <I18nextProvider i18n={instance}>
      <ServicesContext.Provider value={services}>
        <Direction.Provider dir={directionOf(lang)}>
          <RouterProvider router={router} />
        </Direction.Provider>
      </ServicesContext.Provider>
    </I18nextProvider>
  );
  // The query cache lives on the device (IndexedDB): recently opened screens show offline.
  return persister === undefined ? (
    <QueryClientProvider client={queryClient}>{inner}</QueryClientProvider>
  ) : (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={offlinePersistOptions(persister)}
      onSuccess={() => void queryClient.invalidateQueries()} // restored data is a previous visit's: refresh
    >
      {inner}
    </PersistQueryClientProvider>
  );
}
