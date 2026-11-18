/**
 * Settings › Data health (RFC 0036 §2.3), for Administrators: where the company's data stands — the checks the
 * installed apps declare, run now or as last recorded —, the records that look like one another, merging the ones
 * that are one, and undoing a merge. The server finds, checks, merges and refuses; this page shows its answers.
 */
import { Alert, ApiError, Badge, Button, Dialog, type PageProps, useKosh } from '@kosh/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactElement, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface Finding {
  readonly what: string;
  readonly detail: string;
  readonly records?: { readonly model: string; readonly ids: readonly number[] };
}
interface Check {
  readonly module: string;
  readonly key: string;
  readonly label: string;
  readonly ok: boolean;
  readonly findings: readonly Finding[];
  readonly error?: string;
}
interface Health {
  readonly checkedAt: string;
  readonly ok: boolean;
  readonly checks: readonly Check[];
}
interface Summary {
  readonly checkedAt: string;
  readonly ok: boolean;
  readonly failing: readonly { readonly label: string; readonly findings: number }[];
}
interface Group {
  readonly model: string;
  readonly label: string;
  readonly key: string;
  readonly value: string;
  readonly records: readonly { readonly id: number; readonly name: string }[];
}
interface Merge {
  readonly id: number;
  readonly model: string;
  readonly keep: number;
  readonly merged: readonly number[];
  readonly links: number;
  readonly at: string;
  readonly undoneAt: string | null;
  readonly canUndo: boolean;
}

const message = (error: unknown) => (error instanceof ApiError ? error.message : String(error));
const groupId = (g: Group) => `${g.model}:${g.key}:${g.value}`;

export function DataHealthPage({ api }: PageProps): ReactElement {
  const { t } = useTranslation('settings');
  const { format } = useKosh();
  const client = useQueryClient();
  const id = useId();
  const [health, setHealth] = useState<Health | null>(null);
  // The record kept in each group (the first, until another is chosen).
  const [kept, setKept] = useState<Readonly<Record<string, number>>>({});
  const [merging, setMerging] = useState<Group | null>(null);
  const [notice, setNotice] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null);

  const last = useQuery({
    queryKey: ['settings', 'data-health'],
    queryFn: () => api.call<{ last: Summary | null }>('GET', '/api/v1/settings/data-health'),
    retry: false,
  });
  const duplicates = useQuery({
    queryKey: ['settings', 'duplicates'],
    queryFn: () => api.call<{ groups: Group[] }>('GET', '/api/v1/settings/duplicates'),
    retry: false,
  });
  const merges = useQuery({
    queryKey: ['settings', 'merges'],
    queryFn: () => api.call<{ merges: Merge[] }>('GET', '/api/v1/settings/merges'),
    retry: false,
  });
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ['settings', 'duplicates'] });
    void client.invalidateQueries({ queryKey: ['settings', 'merges'] });
  };
  const run = useMutation({
    mutationFn: () => api.call<Health>('POST', '/api/v1/settings/data-health/run', {}),
    onSuccess: (answer) => {
      setHealth(answer);
      setNotice(null);
      void client.invalidateQueries({ queryKey: ['settings', 'data-health'] });
    },
    onError: (error) => setNotice({ tone: 'danger', text: message(error) }),
  });
  const merge = useMutation({
    mutationFn: (g: Group) => {
      const keep = kept[groupId(g)] ?? g.records[0]?.id ?? 0;
      return api.call<{ merged: number[]; moved: Record<string, number> }>(
        'POST',
        '/api/v1/settings/duplicates/merge',
        { model: g.model, keep, merge: g.records.map((r) => r.id).filter((r) => r !== keep) },
      );
    },
    onSuccess: (done) => {
      setMerging(null);
      setNotice({
        tone: 'info',
        text: t('dataHealth.merged', {
          count: done.merged.length,
          links: Object.values(done.moved).reduce((a, b) => a + b, 0),
        }),
      });
      refresh();
    },
    onError: (error) => {
      setMerging(null);
      setNotice({ tone: 'danger', text: message(error) });
    },
  });
  const undo = useMutation({
    mutationFn: (mergeId: number) =>
      api.call<unknown>('POST', `/api/v1/settings/merges/${mergeId}/undo`, {}),
    onSuccess: () => {
      setNotice({ tone: 'info', text: t('dataHealth.undone') });
      refresh();
    },
    onError: (error) => setNotice({ tone: 'danger', text: message(error) }),
  });

  if (last.isError)
    return (
      <div className="mx-auto grid max-w-4xl gap-2">
        <h1 className="text-2xl font-semibold">{t('dataHealth.title')}</h1>
        <Alert>{t('dataHealth.administrators')}</Alert>
      </div>
    );
  const summary = last.data?.last ?? null;
  const groups = duplicates.data?.groups ?? [];
  const recent = merges.data?.merges ?? [];

  return (
    <div className="mx-auto grid max-w-4xl gap-6">
      <header className="grid gap-1">
        <h1 className="text-2xl font-semibold">{t('dataHealth.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('dataHealth.intro')}</p>
      </header>
      {notice !== null ? <Alert tone={notice.tone}>{notice.text}</Alert> : null}

      <section aria-labelledby={`${id}-checks`} className="grid gap-3 rounded-lg border p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id={`${id}-checks`} className="font-semibold">
            {t('dataHealth.checks')}
          </h2>
          <Button variant="primary" busy={run.isPending} onClick={() => run.mutate()}>
            {t('dataHealth.run')}
          </Button>
        </div>
        {health === null ? (
          <p className="text-sm text-muted-foreground">
            {summary === null
              ? t('dataHealth.never')
              : summary.ok
                ? t('dataHealth.lastOk', { at: format.datetime(summary.checkedAt) })
                : t('dataHealth.lastFound', {
                    at: format.datetime(summary.checkedAt),
                    what: summary.failing.map((f) => `${f.label} (${f.findings})`).join('; '),
                  })}
          </p>
        ) : (
          <ul className="grid gap-2" aria-live="polite">
            {health.checks.map((c) => (
              <li key={`${c.module}:${c.key}`} className="rounded-md border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={c.ok ? 'success' : 'warning'}>
                    {c.ok
                      ? t('dataHealth.holds')
                      : t('dataHealth.found', { count: c.findings.length })}
                  </Badge>
                  <span className="font-medium">{c.label}</span>
                </div>
                {c.error !== undefined ? (
                  <p className="mt-1 text-sm text-danger">
                    {t('dataHealth.broken', { error: c.error })}
                  </p>
                ) : null}
                {c.findings.length > 0 ? (
                  <ul className="mt-2 grid gap-1 text-sm">
                    {c.findings.slice(0, 20).map((f) => (
                      <li key={`${f.what}:${f.detail}`}>
                        <span className="font-medium">{f.what}</span>: {f.detail}
                        {f.records !== undefined && f.records.ids.length > 0 ? (
                          <span className="text-muted-foreground">
                            {' '}
                            ({f.records.model} {f.records.ids.slice(0, 10).join(', ')})
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby={`${id}-duplicates`} className="grid gap-3 rounded-lg border p-4">
        <h2 id={`${id}-duplicates`} className="font-semibold">
          {t('dataHealth.duplicates')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('dataHealth.duplicatesHint')}</p>
        {groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('dataHealth.noDuplicates')}</p>
        ) : (
          <ul className="grid gap-3">
            {groups.map((g) => {
              const key = groupId(g);
              const keep = kept[key] ?? g.records[0]?.id;
              return (
                <li key={key} className="grid gap-2 rounded-md border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="neutral">{g.label}</Badge>
                    <span className="text-sm">
                      {t('dataHealth.same', { key: g.key })}: <strong>{g.value}</strong>
                    </span>
                  </div>
                  <fieldset className="grid gap-1">
                    <legend className="text-sm text-muted-foreground">
                      {t('dataHealth.keep')}
                    </legend>
                    {g.records.map((r) => (
                      <label key={r.id} className="flex items-center gap-2 text-sm">
                        <input
                          type="radio"
                          name={`${id}-${key}`}
                          checked={keep === r.id}
                          onChange={() => setKept({ ...kept, [key]: r.id })}
                        />
                        {r.name} <span className="text-muted-foreground">#{r.id}</span>
                      </label>
                    ))}
                  </fieldset>
                  <div>
                    <Button variant="secondary" onClick={() => setMerging(g)}>
                      {t('dataHealth.merge')}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {recent.length > 0 ? (
        <section aria-labelledby={`${id}-merges`} className="grid gap-3 rounded-lg border p-4">
          <h2 id={`${id}-merges`} className="font-semibold">
            {t('dataHealth.merges')}
          </h2>
          <ul className="grid gap-2">
            {recent.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span>
                  {t('dataHealth.mergeLine', {
                    model: m.model,
                    count: m.merged.length,
                    keep: m.keep,
                    links: m.links,
                    at: format.datetime(m.at),
                  })}
                </span>
                {m.undoneAt !== null ? (
                  <Badge tone="neutral">{t('dataHealth.wasUndone')}</Badge>
                ) : m.canUndo ? (
                  <Button
                    variant="secondary"
                    busy={undo.isPending && undo.variables === m.id}
                    onClick={() => undo.mutate(m.id)}
                  >
                    {t('dataHealth.undo')}
                  </Button>
                ) : (
                  <span className="text-muted-foreground">{t('dataHealth.tooLate')}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <Dialog
        open={merging !== null}
        onOpenChange={(open) => {
          if (!open) setMerging(null);
        }}
        title={t('dataHealth.confirmTitle')}
        description={t('dataHealth.confirmText')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setMerging(null)}>
              {t('dataHealth.cancel')}
            </Button>
            <Button
              variant="primary"
              busy={merge.isPending}
              onClick={() => {
                if (merging !== null) merge.mutate(merging);
              }}
            >
              {t('dataHealth.merge')}
            </Button>
          </>
        }
      />
    </div>
  );
}
