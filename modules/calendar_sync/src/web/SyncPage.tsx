/**
 * Agenda › My other calendars (RFC 0034 §2.4): the calendars a person may connect — Google, Microsoft 365 —, the
 * ones they have connected with when each last synced and what it did, *Sync now* and *Disconnect*. Connecting
 * sends them to the provider to say yes; the server keeps the tokens and decides everything else.
 */
import { Alert, ApiError, Button, type PageProps, Spinner, useKosh } from '@kosh/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';

interface Sync {
  readonly ready: boolean;
  readonly providers: readonly {
    readonly code: string;
    readonly label: string;
    readonly configured: boolean;
  }[];
  readonly accounts: readonly {
    readonly id: number;
    readonly provider: string;
    readonly label: string;
    readonly email: string | null;
    readonly lastSyncAt: string | null;
    readonly lastResult: string | null;
    readonly lastError: string | null;
  }[];
}
const BASE = '/api/v1/agenda/sync';
const message = (e: unknown): string => (e instanceof ApiError ? e.message : String(e));

export function SyncPage({ api }: PageProps): ReactElement {
  const { t } = useTranslation('calendar_sync');
  const { format } = useKosh();
  const queryClient = useQueryClient();
  const sync = useQuery({
    queryKey: ['agenda', 'sync'],
    queryFn: () => api.call<Sync>('GET', BASE),
  });
  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['agenda', 'sync'] });
  };
  const connect = useMutation({
    mutationFn: (provider: string) =>
      api.call<{ url: string }>('POST', `${BASE}/connect`, { provider }),
    // To the provider, to say yes; it sends them back here.
    onSuccess: (r) => window.location.assign(r.url),
  });
  const run = useMutation({
    mutationFn: (id: number) => api.call('POST', `${BASE}/${id}/run`),
    onSettled: refresh,
  });
  const disconnect = useMutation({
    mutationFn: (id: number) => api.call('DELETE', `${BASE}/${id}`),
    onSettled: refresh,
  });
  if (sync.isPending) return <Spinner label={t('loading')} />;
  if (sync.isError) return <Alert tone="danger">{message(sync.error)}</Alert>;
  const data = sync.data;
  // What the provider's answer came to, said once on the way back.
  const said = new URLSearchParams(window.location.search).get('sync');
  const problem = connect.error ?? run.error ?? disconnect.error;
  return (
    <div className="mx-auto grid max-w-3xl gap-6 p-4">
      <header>
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('intro')}</p>
      </header>
      {said === 'connected' ? <Alert tone="info">{t('connected')}</Alert> : null}
      {said === 'refused' ? <Alert tone="danger">{t('refused')}</Alert> : null}
      {data.ready ? null : <Alert tone="info">{t('notReady')}</Alert>}
      {problem === null ? null : <Alert tone="danger">{message(problem)}</Alert>}

      <section aria-labelledby="sync-mine" className="grid gap-3">
        <h2 id="sync-mine" className="font-semibold">
          {t('mine')}
        </h2>
        {data.accounts.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('none')}</p>
        ) : (
          <ul className="grid gap-3">
            {data.accounts.map((a) => (
              <li key={a.id} className="grid gap-2 rounded-lg border bg-surface p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">
                    {a.label}
                    {a.email === null || a.email === '' ? '' : ` · ${a.email}`}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {a.lastSyncAt === null
                      ? t('never')
                      : t('lastSynced', { when: format.datetime(a.lastSyncAt) })}
                  </span>
                </div>
                {a.lastError === null ? (
                  a.lastResult === null ? null : (
                    <p className="text-sm text-muted-foreground">{a.lastResult}</p>
                  )
                ) : (
                  <p role="alert" className="text-sm text-danger">
                    {a.lastError}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    aria-label={t('syncNamed', { name: a.email ?? a.label })}
                    busy={run.isPending && run.variables === a.id}
                    onClick={() => run.mutate(a.id)}
                  >
                    {t('syncNow')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t('disconnectNamed', { name: a.email ?? a.label })}
                    busy={disconnect.isPending && disconnect.variables === a.id}
                    onClick={() => disconnect.mutate(a.id)}
                  >
                    {t('disconnect')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="sync-connect" className="grid gap-3">
        <h2 id="sync-connect" className="font-semibold">
          {t('connect')}
        </h2>
        <ul className="flex flex-wrap gap-2">
          {data.providers.map((p) => (
            <li key={p.code}>
              <Button
                variant="secondary"
                disabled={!p.configured || !data.ready}
                title={p.configured ? undefined : t('notConfigured')}
                busy={connect.isPending && connect.variables === p.code}
                onClick={() => connect.mutate(p.code)}
              >
                {t('connectTo', { name: p.label })}
              </Button>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">{t('what')}</p>
      </section>
    </div>
  );
}
