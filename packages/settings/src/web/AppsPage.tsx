/**
 * Settings → Apps (RFC 0008 §5.5): the App manager. A card per app with its icon, state and what it needs; search,
 * category and state filters; Install, Enable and Disable open the server's plan (what comes along, what goes, the
 * database changes and their SQL) and apply it after confirmation. The server decides and checks everything; this
 * page only shows what it says. After a change every cached query is refreshed: the menus and the launcher follow.
 */
import {
  Alert,
  ApiError,
  AppIcon,
  Badge,
  Button,
  Card,
  Checkbox,
  Dialog,
  Input,
  type PageProps,
  Select,
  Spinner,
} from '@kosh/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { type ReactElement, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppInfo, PlanInfo } from '../routes.js';

type Kind = 'install' | 'enable' | 'disable';
type Filter = 'all' | 'installed' | 'available';

interface Pending {
  readonly kind: Kind;
  readonly app: AppInfo;
  readonly plan: PlanInfo;
}

const TONE = { installed: 'success', disabled: 'warning', available: 'neutral' } as const;

const message = (error: unknown): string =>
  error instanceof ApiError
    ? error.message
    : error instanceof Error
      ? error.message
      : String(error);

export function AppsPage({ api, label }: PageProps): ReactElement {
  const { t } = useTranslation('settings');
  const id = useId();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [filter, setFilter] = useState<Filter>('all');
  const [technical, setTechnical] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const catalogue = useQuery({
    queryKey: ['settings', 'apps'],
    queryFn: () => api.call<{ apps: AppInfo[] }>('GET', '/api/v1/settings/apps'),
  });
  const plan = useMutation({
    mutationFn: async ({ kind, app }: { kind: Kind; app: AppInfo }) => ({
      kind,
      app,
      plan: await api.call<PlanInfo>('POST', '/api/v1/settings/apps/plan', { [kind]: [app.name] }),
    }),
    onSuccess: (next) => {
      setDone(null);
      setPending(next);
    },
  });
  const apply = useMutation({
    mutationFn: (p: Pending) =>
      api.call<{ installed: string[]; enabled: string[]; disabled: string[] }>(
        'POST',
        '/api/v1/settings/apps/apply',
        { change: { [p.kind]: [p.app.name] }, planId: p.plan.planId },
      ),
    onSuccess: async (result) => {
      const labelOf = (name: string) =>
        catalogue.data?.apps.find((a) => a.name === name)?.label ?? name;
      const parts = [
        ...result.installed.map((n) => t('doneInstalled', { name: labelOf(n) })),
        ...result.enabled.map((n) => t('doneEnabled', { name: labelOf(n) })),
        ...result.disabled.map((n) => t('doneDisabled', { name: labelOf(n) })),
      ];
      setPending(null);
      setDone(parts.length === 0 ? t('nothingToDo') : t('done', { list: parts.join(', ') }));
      // The installed set changed: menus, the launcher, views and this list all follow.
      await queryClient.invalidateQueries();
    },
  });

  const apps = catalogue.data?.apps ?? [];
  const categories = useMemo(
    () =>
      [...new Set(apps.filter((a) => technical || a.application).map((a) => a.category))].sort(),
    [apps, technical],
  );
  const shown = apps.filter(
    (a) =>
      (technical || a.application) &&
      (category === 'all' || a.category === category) &&
      (filter === 'all' ||
        (filter === 'installed' ? a.state !== 'available' : a.state === 'available')) &&
      (query.trim() === '' ||
        `${a.label} ${a.name} ${a.summary ?? ''} ${a.category}`
          .toLowerCase()
          .includes(query.trim().toLowerCase())),
  );
  const count = (state: AppInfo['state']) => apps.filter((a) => a.state === state).length;
  const labelOf = (name: string) => apps.find((a) => a.name === name)?.label ?? name;

  if (catalogue.isPending) return <Spinner label={t('planning')} />;
  if (catalogue.error !== null) return <Alert>{message(catalogue.error)}</Alert>;

  return (
    <section aria-labelledby={`${id}-title`} className="grid gap-4">
      <header className="grid gap-1">
        <h1 id={`${id}-title`} className="text-lg font-semibold">
          {label ?? t('apps')}
        </h1>
        <p className="text-sm text-muted-foreground">{t('appsIntro')}</p>
        <p className="text-xs text-muted-foreground">
          {t('counts', {
            installed: count('installed'),
            disabled: count('disabled'),
            available: count('available'),
          })}
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <Search
            className="pointer-events-none absolute start-2.5 top-2.5 size-4 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            aria-label={t('search')}
            placeholder={t('search')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-9 ps-8"
          />
        </div>
        <Select
          label={t('category')}
          className="w-48"
          value={category}
          onChange={setCategory}
          options={[
            { value: 'all', label: t('allCategories') },
            ...categories.map((c) => ({ value: c, label: c })),
          ]}
        />
        <fieldset className="flex gap-1">
          <legend className="sr-only">{t('show')}</legend>
          {(['all', 'installed', 'available'] as const).map((f) => (
            <Button
              key={f}
              size="sm"
              variant={filter === f ? 'primary' : 'secondary'}
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
            >
              {t(`filter${f.charAt(0).toUpperCase()}${f.slice(1)}`)}
            </Button>
          ))}
        </fieldset>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Checkbox
            id={`${id}-technical`}
            checked={technical}
            onCheckedChange={(v) => setTechnical(v === true)}
          />
          <label htmlFor={`${id}-technical`}>{t('technical')}</label>
        </div>
      </div>

      {done === null ? null : <Alert tone="info">{done}</Alert>}
      {plan.error === null ? null : <Alert>{message(plan.error)}</Alert>}

      {shown.length === 0 ? (
        <p className="p-6 text-center text-muted-foreground">{t('empty')}</p>
      ) : (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(17rem,1fr))] gap-3">
          {shown.map((a) => {
            const busy = plan.isPending && plan.variables?.app.name === a.name;
            const kind: Kind | null = a.protected
              ? null
              : a.state === 'available'
                ? 'install'
                : a.state === 'disabled'
                  ? 'enable'
                  : 'disable';
            return (
              <li key={a.name}>
                <Card
                  className="flex h-full flex-col gap-3 p-4"
                  aria-labelledby={`${id}-${a.name}`}
                >
                  <div className="flex items-start gap-3">
                    <AppIcon name={a.icon ?? a.name} />
                    <div className="min-w-0 flex-1">
                      <h2 id={`${id}-${a.name}`} className="truncate font-medium">
                        {a.label}
                      </h2>
                      <p className="text-xs text-muted-foreground">
                        {a.category} · {t('version', { version: a.version })}
                      </p>
                    </div>
                    <Badge tone={TONE[a.state]}>{t(a.state)}</Badge>
                  </div>
                  {a.summary === null ? null : <p className="text-sm">{a.summary}</p>}
                  <div className="mt-auto flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs text-muted-foreground">
                      {a.protected
                        ? t('always')
                        : a.dependency
                          ? t('neededBy')
                          : a.depends.length === 0
                            ? ''
                            : t('needs', { list: a.depends.map(labelOf).join(', ') })}
                    </p>
                    {kind === null ? null : (
                      <Button
                        size="sm"
                        variant={kind === 'disable' ? 'secondary' : 'primary'}
                        busy={busy}
                        aria-label={`${t(kind)} ${a.label}`}
                        onClick={() => plan.mutate({ kind, app: a })}
                      >
                        {t(kind)}
                      </Button>
                    )}
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      {pending === null ? null : (
        <PlanDialog
          pending={pending}
          labelOf={labelOf}
          busy={apply.isPending}
          error={apply.error === null ? null : message(apply.error)}
          onCancel={() => {
            apply.reset();
            setPending(null);
          }}
          onConfirm={() => apply.mutate(pending)}
        />
      )}
    </section>
  );
}

function PlanDialog({
  pending,
  labelOf,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  readonly pending: Pending;
  readonly labelOf: (name: string) => string;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}): ReactElement {
  const { t } = useTranslation('settings');
  const { kind, app, plan } = pending;
  const title = t(
    kind === 'install'
      ? 'planTitleInstall'
      : kind === 'enable'
        ? 'planTitleEnable'
        : 'planTitleDisable',
    { name: app.label },
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
      }}
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            {t('cancel')}
          </Button>
          <Button
            variant={kind === 'disable' ? 'danger' : 'primary'}
            busy={busy}
            disabled={plan.empty}
            onClick={onConfirm}
          >
            {busy
              ? t('applying')
              : t(
                  kind === 'install'
                    ? 'confirmInstall'
                    : kind === 'enable'
                      ? 'confirmEnable'
                      : 'confirmDisable',
                )}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 text-sm">
        {plan.empty ? <p>{t('nothingToDo')}</p> : null}
        {plan.install.length === 0 ? null : (
          <PlanList title={t('planInstall')}>
            {plan.install.map((m) => (
              <li key={m.name}>
                {labelOf(m.name)}
                {m.reason === 'dependency' ? (
                  <span className="text-muted-foreground"> · {t('planNeeded')}</span>
                ) : null}
              </li>
            ))}
          </PlanList>
        )}
        {plan.enable.length === 0 ? null : (
          <PlanList title={t('planEnable')}>
            {plan.enable.map((name) => (
              <li key={name}>{labelOf(name)}</li>
            ))}
          </PlanList>
        )}
        {plan.disable.length === 0 ? null : (
          <PlanList title={t('planDisable')}>
            {plan.disable.map((m) => (
              <li key={m.name}>
                {labelOf(m.name)}
                {m.cascade ? (
                  <span className="text-muted-foreground"> · {t('planCascade')}</span>
                ) : null}
              </li>
            ))}
          </PlanList>
        )}
        {kind === 'disable' ? <Alert tone="warning">{t('planKeepsData')}</Alert> : null}
        {kind === 'install' ? <p className="text-muted-foreground">{t('planAccess')}</p> : null}
        <p className="text-muted-foreground">
          {plan.statements.length === 0
            ? t('planNoSchema')
            : t('planSchema', { count: plan.statements.length })}
        </p>
        {plan.statements.length === 0 ? null : (
          <details>
            <summary className="cursor-pointer text-muted-foreground">{t('planShowSql')}</summary>
            <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-muted p-2 text-xs" dir="ltr">
              {plan.statements.map((sql) => `${sql};`).join('\n')}
            </pre>
          </details>
        )}
        {error === null ? null : <Alert>{error}</Alert>}
      </div>
    </Dialog>
  );
}

function PlanList({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactElement[];
}): ReactElement {
  return (
    <div>
      <h3 className="mb-1 font-medium">{title}</h3>
      <ul className="list-disc ps-5">{children}</ul>
    </div>
  );
}
