/**
 * The home page (RFC 0010 §3.8): a greeting, the palette's search box, what needs the user's attention (approvals
 * they may decide, activities due), recently opened records, and the apps. Everything on it comes from routes the
 * server already filters per user; apps that are not installed (Permissions, Messaging) simply contribute nothing.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { CalendarClock, CircleCheckBig, History, Search } from 'lucide-react';
import type { ReactElement } from 'react';
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

/** A tint per category, stable for the session: the same category always gets the same colour. */
const TINTS = [
  'bg-accent text-accent-foreground',
  'bg-success/15 text-success',
  'bg-warning/15 text-warning-text',
  'bg-primary/10 text-primary',
  'bg-danger/10 text-danger',
];

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
    queryFn: () =>
      api
        .call<{ requests: Approval[] }>('GET', '/api/v1/approvals/inbox')
        .then((r) => r.requests)
        .catch(() => [] as Approval[]),
  });
  const activities = useQuery({
    queryKey: ['home', 'activities'],
    queryFn: () =>
      api
        .call<{ activities: Activity[] }>('GET', '/api/v1/activities/mine')
        .then((r) => r.activities)
        .catch(() => [] as Activity[]),
  });
  const done = useMutation({
    mutationFn: (id: number) => api.call('POST', `/api/v1/activities/${id}/done`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['home', 'activities'] }),
  });

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
  const today = new Date().toISOString().slice(0, 10);
  const due = (activities.data ?? []).filter((a) => a.deadline <= today);
  const open = (model: string, id: number) => {
    const route = routes.data?.[model];
    if (route?.app === undefined) return;
    void navigate({
      to: '/$app/a/$action/$id',
      params: { app: route.app, action: route.action, id: String(id) },
    });
  };
  const categories = [...new Set((apps.data ?? []).map((a) => a.category ?? ''))].sort((a, b) =>
    a.localeCompare(b),
  );
  const tint = (a: AppEntry) => TINTS[categories.indexOf(a.category ?? '') % TINTS.length];
  const recent = recentRecords(uid);
  const waiting = (approvals.data?.length ?? 0) + due.length;

  return (
    <div className="mx-auto grid max-w-5xl gap-8 py-4">
      <header className="grid gap-4">
        <h1 className="text-2xl font-semibold">
          {me.data === undefined ? (
            <Skeleton className="h-8 w-64" />
          ) : (
            t(`home.${greeting}`, { name: me.data.name.split(' ')[0] })
          )}
        </h1>
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
        <h2 id="home-attention" className="text-sm font-semibold text-muted-foreground">
          {t('home.attention')}
        </h2>
        {approvals.isPending || activities.isPending ? (
          <Skeleton className="h-16" />
        ) : waiting === 0 ? (
          <Card className="flex items-center gap-3 p-4 text-sm text-muted-foreground">
            <CircleCheckBig className="size-5 text-success" aria-hidden />
            {t('home.nothing')}
          </Card>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {(approvals.data?.length ?? 0) === 0 ? null : (
              <li>
                <Card className="flex items-center justify-between gap-3 p-4">
                  <div className="grid gap-1">
                    <span className="font-medium">
                      {t('home.approvals', { count: approvals.data?.length ?? 0 })}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {[...new Set((approvals.data ?? []).map((a) => a.levelName))].join(' · ')}
                    </span>
                  </div>
                  {approvals.data?.[0] === undefined ? null : (
                    <Button
                      size="sm"
                      onClick={() => {
                        const first = approvals.data?.[0];
                        if (first !== undefined) open(first.targetModel, first.targetId);
                      }}
                    >
                      {t('home.open')}
                    </Button>
                  )}
                </Card>
              </li>
            )}
            {due.length === 0 ? null : (
              <li>
                <Card className="grid gap-2 p-4">
                  <span className="font-medium">{t('home.activities', { count: due.length })}</span>
                  <ul className="grid gap-1 text-sm">
                    {due.slice(0, 5).map((a) => (
                      <li key={a.id} className="flex items-center justify-between gap-2">
                        <button
                          type="button"
                          className="flex min-w-0 items-center gap-2 text-start hover:underline"
                          onClick={() => open(a.model, a.resId)}
                        >
                          <CalendarClock
                            className="size-4 shrink-0 text-muted-foreground"
                            aria-hidden
                          />
                          <span className="truncate">
                            {a.summary ?? a.type.name} · {a.record}
                          </span>
                          {a.deadline < today ? (
                            <Badge tone="danger">{t('home.overdue')}</Badge>
                          ) : null}
                        </button>
                        <Button
                          size="sm"
                          variant="ghost"
                          busy={done.isPending && done.variables === a.id}
                          onClick={() => done.mutate(a.id)}
                        >
                          {t('home.done')}
                        </Button>
                      </li>
                    ))}
                  </ul>
                </Card>
              </li>
            )}
          </ul>
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

      <section aria-labelledby="apps-title" className="grid gap-3">
        <h2 id="apps-title" className="text-sm font-semibold text-muted-foreground">
          {t('home.apps')}
        </h2>
        {apps.isPending ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-3">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-28" />
            ))}
          </div>
        ) : (apps.data ?? []).length === 0 ? (
          <p className="text-muted-foreground">{t('shell.noApps')}</p>
        ) : (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-3">
            {(apps.data ?? []).map((a) => (
              <li key={a.code}>
                <Link to="/$app" params={{ app: a.code }} className="block h-full">
                  <Card className="flex h-full flex-col gap-3 p-4 hover:bg-muted">
                    <AppIcon name={a.icon ?? a.code} className={cn('size-11', tint(a))} />
                    <div className="grid gap-0.5">
                      <span className="font-medium">{a.label}</span>
                      {a.summary === undefined ? null : (
                        <span className="line-clamp-2 text-xs text-muted-foreground">
                          {a.summary}
                        </span>
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
