/**
 * Connected apps (RFC 0017 §5.2), from the account menu: the apps you allowed to act for you through OAuth, what each
 * may do in words, when it last did, and *Remove access* — which ends every token the app holds for you at once.
 */
import { Alert, ApiError, Button, type PageProps, useKosh } from '@kosh/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Plug } from 'lucide-react';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';

interface Grant {
  readonly id: number;
  readonly app: string;
  readonly homepage: string | null;
  readonly scopes: readonly { readonly scope: string; readonly label: string }[];
  readonly createdAt: string | null;
  readonly lastUsedAt: string | null;
}

export function ConnectedAppsPage({ api }: PageProps): ReactElement {
  const { t } = useTranslation('settings');
  const { format } = useKosh();
  const queryClient = useQueryClient();
  const grants = useQuery({
    queryKey: ['oauth', 'grants'],
    queryFn: () => api.call<{ grants: Grant[] }>('GET', '/api/v1/auth/oauth/grants'),
  });
  const revoke = useMutation({
    mutationFn: (id: number) => api.call('POST', `/api/v1/auth/oauth/grants/${id}/revoke`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['oauth', 'grants'] }),
  });
  const error = grants.error ?? revoke.error;
  return (
    <div className="mx-auto grid max-w-3xl gap-6">
      <header>
        <h1 className="text-xl font-semibold">{t('connected.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('connected.intro')}</p>
      </header>
      {error === null ? null : (
        <Alert tone="danger">{error instanceof ApiError ? error.message : String(error)}</Alert>
      )}
      {grants.data === undefined ? (
        <p className="text-sm text-muted-foreground">…</p>
      ) : grants.data.grants.length === 0 ? (
        <p className="rounded-lg border bg-surface p-6 text-center text-sm text-muted-foreground">
          {t('connected.none')}
        </p>
      ) : (
        <ul className="grid gap-3">
          {grants.data.grants.map((g) => (
            <li
              key={g.id}
              className="flex flex-wrap items-start gap-3 rounded-lg border bg-surface p-4"
            >
              <span
                aria-hidden
                className="grid size-9 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground"
              >
                <Plug className="size-4" />
              </span>
              <div className="grid min-w-0 flex-1 gap-1">
                <p className="flex items-center gap-2 font-medium">
                  {g.app}
                  {g.homepage === null ? null : (
                    <a
                      href={g.homepage}
                      target="_blank"
                      rel="noreferrer noopener"
                      aria-label={t('connected.homepage', { app: g.app })}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <ExternalLink className="size-3.5" aria-hidden />
                    </a>
                  )}
                </p>
                <ul className="flex flex-wrap gap-x-3 text-sm text-muted-foreground">
                  {g.scopes.map((s) => (
                    <li key={s.scope}>{s.label}</li>
                  ))}
                </ul>
                <p className="text-xs text-muted-foreground">
                  {[
                    g.createdAt === null
                      ? null
                      : t('connected.since', { when: format.date(g.createdAt.slice(0, 10)) }),
                    g.lastUsedAt === null
                      ? t('connected.neverUsed')
                      : t('connected.lastUsed', { when: format.datetime(g.lastUsedAt) }),
                  ]
                    .filter((x) => x !== null)
                    .join(' · ')}
                </p>
              </div>
              <Button
                size="sm"
                variant="danger"
                busy={revoke.isPending && revoke.variables === g.id}
                onClick={() => revoke.mutate(g.id)}
                aria-label={t('connected.revokeApp', { app: g.app })}
              >
                {t('connected.revoke')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
