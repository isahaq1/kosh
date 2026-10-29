/**
 * Today, the home page (RFC 0010 §3.8, RFC 0018 §4.4): a greeting with the date, the palette's search box, what needs
 * the user — each approval waiting for them by record, the activities due, unread mentions — as a list with its
 * action, recently opened records, the saved views they keep (lists, pivots, charts: one click back to them), and the
 * apps. Everything comes from routes the server already filters per user; apps that are not installed (Permissions,
 * Messaging, Notifications) simply contribute nothing.
 */
import { encodeSearch } from '@kosh/search';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  AtSign,
  BarChart3,
  CalendarClock,
  CheckCircle2,
  CircleCheckBig,
  History,
  List,
  Search,
  ShieldCheck,
  Star,
  Table2,
} from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppEntry } from '../api.js';
import { AppIcon } from '../components/AppIcon.js';
import { Badge, Button, Card, Skeleton } from '../components/primitives.js';
import { useKosh } from '../context.js';
import { cn } from '../lib/cn.js';
import { usePalette } from './CommandPalette.js';
import { recentRecords } from './recent.js';

interface Approval {
  readonly id: number;
  readonly levelName: string;
  readonly targetModel: string;
  readonly targetId: number;
}
interface Activity {
  readonly id: number;
  readonly summary: string | null;
  readonly deadline: string;
  readonly type: { readonly name: string };
  readonly model: string;
  readonly resId: number;
  readonly record: string;
}
interface Mention {
  readonly id: number;
  readonly kind: string;
  readonly params: { readonly actor?: string; readonly record?: string; readonly preview?: string };
  readonly model: string;
  readonly resId: number;
  readonly createdAt: string;
}
interface Todo {
  readonly id: number;
  readonly name: string;
  readonly dueDate: string;
  readonly priority: string;
}
interface Saved {
  readonly id: number;
  readonly name: string;
  readonly targetModel: string;
  readonly viewType: string;
  readonly state: unknown;
}

/** A tint per category, stable for the session: the same category always gets the same colour. */
const TINTS = [
  'bg-accent text-accent-foreground',
  'bg-success/15 text-success',
  'bg-warning/15 text-warning-text',
  'bg-primary/10 text-primary',
  'bg-danger/10 text-danger',
];
const VIEW_ICONS: Record<string, typeof List> = {
  pivot: Table2,
  graph: BarChart3,
  chart: BarChart3,
};

/** One row of "Needs your attention": an icon, what it is, and its actions. */
function Item({
  icon,
  title,
  detail,
  children,
}: {
  readonly icon: ReactNode;
  readonly title: ReactNode;
  readonly detail?: ReactNode;
  readonly children?: ReactNode;
}): ReactElement {
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <span
        aria-hidden
        className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground"
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{title}</p>
        {detail === undefined ? null : (
          <p className="truncate text-xs text-muted-foreground">{detail}</p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">{children}</div>
    </li>
  );
}

export function Home(): ReactElement {
  const { api, uid, format } = useKosh();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const openPalette = usePalette();
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.me() });
  const apps = useQuery({ queryKey: ['apps', 'launcher'], queryFn: () => api.apps() });
  const routes = useQuery({ queryKey: ['routes'], queryFn: () => api.routes() });
  // Each is a module's route: absent (404) when the module is not installed, so an absent list is empty.
  const approvals = useQuery({
    queryKey: ['home', 'approvals'],
    queryFn: async () => {
      const requests = await api
        .call<{ requests: Approval[] }>('GET', '/api/v1/approvals/inbox')
        .then((r) => r.requests)
        .catch(() => [] as Approval[]);
      // The records' names, one request per model.
      const names = new Map<string, string>();
      for (const model of new Set(requests.map((r) => r.targetModel)))
        for (const n of await api
          .names(model, {
            ids: requests.filter((r) => r.targetModel === model).map((r) => r.targetId),
          })
          .catch(() => []))
          names.set(`${model}:${n.id}`, n.displayName);
      return requests.map((r) => ({
        ...r,
        record: names.get(`${r.targetModel}:${r.targetId}`) ?? `#${r.targetId}`,
      }));
    },
  });
  const activities = useQuery({
    queryKey: ['home', 'activities'],
    queryFn: () =>
      api
        .call<{ activities: Activity[] }>('GET', '/api/v1/activities/mine')
        .then((r) => r.activities)
        .catch(() => [] as Activity[]),
  });
  const mentions = useQuery({
    queryKey: ['home', 'mentions'],
    queryFn: () =>
      api
        .call<{ items: Mention[] }>('GET', '/api/v1/notifications?unread=true&limit=50')
        .then((r) => r.items.filter((n) => n.kind === 'mention'))
        .catch(() => [] as Mention[]),
  });
  // Focus (RFC 0021): my open to-dos due today or before; nothing when Focus is not installed or not mine.
  const todos = useQuery({
    queryKey: ['home', 'todos'],
    queryFn: () =>
      api
        .list('todo.task', {
          filter: {
            state: 'open',
            owner: uid,
            dueDate: { lte: new Date().toISOString().slice(0, 10) },
          },
          fields: ['name', 'dueDate', 'priority'],
          order: ['dueDate asc', 'id asc'],
          limit: 20,
        })
        .then((r) => r.items as unknown as Todo[])
        .catch(() => [] as Todo[]),
  });
  const complete = useMutation({
    mutationFn: (id: number) => api.transition('todo.task', id, 'complete'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['home', 'todos'] }),
  });
  const saved = useQuery({
    queryKey: ['home', 'saved-views'],
    queryFn: () =>
      api
        .list('kosh.saved_view', {
          fields: ['name', 'targetModel', 'viewType', 'state'],
          limit: 12,
        })
        .then((r) => r.items as unknown as Saved[])
        .catch(() => [] as Saved[]),
  });
  const done = useMutation({
    mutationFn: (id: number) => api.call('POST', `/api/v1/activities/${id}/done`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['home', 'activities'] }),
  });
  const read = useMutation({
    mutationFn: (id: number) => api.call('POST', `/api/v1/notifications/${id}/read`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['home', 'mentions'] });
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });

  const now = new Date();
  const hour = now.getHours();
  const greeting = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
  const today = now.toISOString().slice(0, 10);
  const due = (activities.data ?? []).filter((a) => a.deadline <= today);
  const open = (model: string, id: number) => {
    const route = routes.data?.[model];
    if (route?.app === undefined) return;
    void navigate({
      to: '/$app/a/$action/$id',
      params: { app: route.app, action: route.action, id: String(id) },
    });
  };
  const openSaved = (view: Saved) => {
    const route = routes.data?.[view.targetModel];
    if (route?.app === undefined) return;
    const q = encodeSearch((view.state ?? {}) as Parameters<typeof encodeSearch>[0]);
    void navigate({
      to: '/$app/a/$action',
      params: { app: route.app, action: route.action },
      search: { view: view.viewType, ...(q === '' ? {} : { q }) } as never,
    });
  };
  const categories = [...new Set((apps.data ?? []).map((a) => a.category ?? ''))].sort((a, b) =>
    a.localeCompare(b),
  );
  const tint = (a: AppEntry) => TINTS[categories.indexOf(a.category ?? '') % TINTS.length];
  const recent = recentRecords(uid);
  const waiting =
    (approvals.data?.length ?? 0) +
    due.length +
    (mentions.data?.length ?? 0) +
    (todos.data?.length ?? 0);
  const views = (saved.data ?? []).filter((v) => routes.data?.[v.targetModel]?.app !== undefined);

  return (
    <div className="mx-auto grid max-w-5xl gap-8 py-4">
      <header className="grid gap-4">
        <div>
          <p className="text-sm font-medium text-muted-foreground">
            {t('home.today', { date: format.date(today) })}
          </p>
          <h1 className="text-2xl font-semibold">
            {me.data === undefined ? (
              <Skeleton className="h-8 w-64" />
            ) : (
              t(`home.${greeting}`, { name: me.data.name.split(' ')[0] })
            )}
          </h1>
        </div>
        <button
          type="button"
          onClick={openPalette}
          className="flex h-12 w-full items-center gap-3 rounded-xl border bg-surface px-4 text-start text-muted-foreground shadow-sm hover:bg-muted"
        >
          <Search className="size-5" aria-hidden />
          <span className="flex-1">{t('home.search')}</span>
          <kbd className="rounded border px-1.5 text-xs">Ctrl K</kbd>
        </button>
      </header>

      <section aria-labelledby="home-attention" className="grid gap-3">
        <h2
          id="home-attention"
          className="flex items-center gap-2 text-sm font-semibold text-muted-foreground"
        >
          {t('home.attention')}
          {waiting === 0 ? null : <Badge tone="info">{waiting}</Badge>}
        </h2>
        {approvals.isPending || activities.isPending || mentions.isPending || todos.isPending ? (
          <Skeleton className="h-16" />
        ) : waiting === 0 ? (
          <Card className="flex items-center gap-3 p-4 text-sm text-muted-foreground">
            <CircleCheckBig className="size-5 text-success" aria-hidden />
            {t('home.nothing')}
          </Card>
        ) : (
          <Card className="p-0">
            <ul className="divide-y">
              {(approvals.data ?? []).map((a) => (
                <Item
                  key={`approval-${a.id}`}
                  icon={<ShieldCheck className="size-4" />}
                  title={t('home.approve', { record: a.record })}
                  detail={a.levelName}
                >
                  <Button size="sm" onClick={() => open(a.targetModel, a.targetId)}>
                    {t('home.review')}
                  </Button>
                </Item>
              ))}
              {due.map((a) => (
                <Item
                  key={`activity-${a.id}`}
                  icon={<CalendarClock className="size-4" />}
                  title={
                    <span className="flex items-center gap-2">
                      <span className="truncate">{a.summary ?? a.type.name}</span>
                      {a.deadline < today ? (
                        <Badge tone="danger">{t('home.overdue')}</Badge>
                      ) : (
                        <Badge tone="warning">{t('home.dueToday')}</Badge>
                      )}
                    </span>
                  }
                  detail={`${a.type.name} · ${a.record}`}
                >
                  <Button size="sm" variant="ghost" onClick={() => open(a.model, a.resId)}>
                    {t('home.open')}
                  </Button>
                  <Button
                    size="sm"
                    busy={done.isPending && done.variables === a.id}
                    onClick={() => done.mutate(a.id)}
                  >
                    {t('home.done')}
                  </Button>
                </Item>
              ))}
              {(todos.data ?? []).map((todo) => (
                <Item
                  key={`todo-${todo.id}`}
                  icon={<CheckCircle2 className="size-4" />}
                  title={
                    <span className="flex items-center gap-2">
                      <span className="truncate">{todo.name}</span>
                      {todo.dueDate < today ? (
                        <Badge tone="danger">{t('home.overdue')}</Badge>
                      ) : (
                        <Badge tone="warning">{t('home.dueToday')}</Badge>
                      )}
                    </span>
                  }
                  detail={t('home.todo')}
                >
                  <Button size="sm" variant="ghost" onClick={() => open('todo.task', todo.id)}>
                    {t('home.open')}
                  </Button>
                  <Button
                    size="sm"
                    busy={complete.isPending && complete.variables === todo.id}
                    onClick={() => complete.mutate(todo.id)}
                  >
                    {t('home.done')}
                  </Button>
                </Item>
              ))}
              {(mentions.data ?? []).map((m) => (
                <Item
                  key={`mention-${m.id}`}
                  icon={<AtSign className="size-4" />}
                  title={t('home.mentioned', {
                    actor: m.params.actor ?? '',
                    record: m.params.record ?? '',
                  })}
                  detail={m.params.preview ?? format.datetime(m.createdAt)}
                >
                  <Button
                    size="sm"
                    onClick={() => {
                      read.mutate(m.id);
                      open(m.model, m.resId);
                    }}
                  >
                    {t('home.open')}
                  </Button>
                </Item>
              ))}
            </ul>
          </Card>
        )}
      </section>

      {recent.length === 0 ? null : (
        <section aria-labelledby="home-recent" className="grid gap-3">
          <h2 id="home-recent" className="text-sm font-semibold text-muted-foreground">
            {t('home.recent')}
          </h2>
          <ul className="flex flex-wrap gap-2">
            {recent.slice(0, 8).map((r) => (
              <li key={`${r.model}:${r.id}`}>
                <Link
                  to="/$app/a/$action/$id"
                  params={{ app: r.app, action: r.action, id: String(r.id) }}
                  className="flex items-center gap-2 rounded-full border bg-surface px-3 py-1.5 text-sm hover:bg-muted"
                >
                  <History className="size-3.5 text-muted-foreground" aria-hidden />
                  <span className="max-w-56 truncate">{r.title}</span>
                  <span className="text-xs text-muted-foreground">
                    {format.date(new Date(r.at).toISOString().slice(0, 10))}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {views.length === 0 ? null : (
        <section aria-labelledby="home-saved" className="grid gap-3">
          <h2 id="home-saved" className="text-sm font-semibold text-muted-foreground">
            {t('home.saved')}
          </h2>
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-2">
            {views.map((v) => {
              const Icon = VIEW_ICONS[v.viewType] ?? List;
              return (
                <li key={v.id}>
                  <button
                    type="button"
                    onClick={() => openSaved(v)}
                    className="flex w-full items-center gap-2 rounded-lg border bg-surface px-3 py-2 text-start text-sm hover:bg-muted"
                  >
                    <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{v.name}</span>
                    <Star className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section aria-labelledby="apps-title" className="grid gap-3">
        <h2 id="apps-title" className="text-sm font-semibold text-muted-foreground">
          {t('home.apps')}
        </h2>
        {apps.isPending ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-3">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-16" />
            ))}
          </div>
        ) : (apps.data ?? []).length === 0 ? (
          <p className="text-muted-foreground">{t('shell.noApps')}</p>
        ) : (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-2">
            {(apps.data ?? []).map((a) => (
              <li key={a.code}>
                <Link to="/$app" params={{ app: a.code }} className="block h-full">
                  <Card className="flex h-full items-center gap-3 p-3 hover:bg-muted">
                    <AppIcon name={a.icon ?? a.code} className={cn('size-9', tint(a))} />
                    <div className="grid min-w-0 gap-0.5">
                      <span className="truncate font-medium">{a.label}</span>
                      {a.summary === undefined ? null : (
                        <span className="truncate text-xs text-muted-foreground">{a.summary}</span>
                      )}
                    </div>
                  </Card>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
