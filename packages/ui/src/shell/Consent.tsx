/**
 * The OAuth consent page (RFC 0017 §5.2), at `/oauth/authorize`: an app asks to act for the signed-in user. It names
 * the app, where it sends the user back, and what it may do in words; *Allow* or *Cancel* — either returns to the
 * app. The server checks the request (registered redirect, allowed scopes, PKCE) before anything is shown; signed out,
 * the person signs in and comes back here.
 */
import { useMutation, useQuery } from '@tanstack/react-query';
import { ExternalLink, ShieldCheck } from 'lucide-react';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, type KoshApi } from '../api.js';
import { Alert, Button, Card, Spinner } from '../components/primitives.js';

interface Screen {
  readonly app: { readonly name: string; readonly homepage: string | null };
  readonly redirectHost: string;
  readonly scopes: readonly { readonly scope: string; readonly label: string }[];
  readonly alreadyAllowed: boolean;
}

export function Consent({ api }: { readonly api: KoshApi }): ReactElement {
  const { t } = useTranslation();
  const search = window.location.search;
  const params = Object.fromEntries(new URLSearchParams(search));
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.me(), retry: false });
  const screen = useQuery({
    queryKey: ['oauth', 'consent', search],
    queryFn: () => api.call<Screen>('GET', `/api/v1/oauth/authorize${search}`),
    enabled: me.isSuccess,
    retry: false,
  });
  const decide = useMutation({
    mutationFn: (decision: 'allow' | 'deny') =>
      api.call<{ redirect: string }>('POST', '/api/v1/oauth/authorize', { ...params, decision }),
    onSuccess: ({ redirect }) => window.location.assign(redirect),
  });
  if (me.error instanceof ApiError && me.error.status === 401) {
    // Signed out: sign in, then back here with the same request.
    window.location.assign(`/login?next=${encodeURIComponent(`/oauth/authorize${search}`)}`);
    return <Spinner label={t('app.loading')} />;
  }
  const error = me.error ?? screen.error ?? decide.error;
  return (
    <main className="grid min-h-screen place-items-center bg-background p-4">
      <Card className="grid w-full max-w-md gap-5 p-6">
        {error !== null ? (
          <Alert>{error instanceof ApiError ? error.message : String(error)}</Alert>
        ) : screen.data === undefined || me.data === undefined ? (
          <Spinner label={t('app.loading')} />
        ) : (
          <>
            <div className="grid gap-1">
              <span
                aria-hidden
                className="mb-2 grid size-10 place-items-center rounded-lg bg-accent text-accent-foreground"
              >
                <ShieldCheck className="size-5" />
              </span>
              <h1 className="text-xl font-semibold">
                {t('oauth.title', { app: screen.data.app.name })}
              </h1>
              <p className="text-sm text-muted-foreground">
                {t('oauth.as', { name: me.data.name, login: me.data.login })}
              </p>
            </div>
            <div className="grid gap-2">
              <h2 className="text-sm font-medium">{t('oauth.may')}</h2>
              <ul className="grid gap-1.5 rounded-md border p-3 text-sm">
                {screen.data.scopes.map((s) => (
                  <li key={s.scope} className="flex items-center gap-2">
                    <ShieldCheck className="size-4 text-success" aria-hidden />
                    {s.label}
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">{t('oauth.limits')}</p>
            </div>
            <p className="text-sm text-muted-foreground">
              {t('oauth.back', { host: screen.data.redirectHost })}
              {screen.data.app.homepage === null ? null : (
                <>
                  {' '}
                  <a
                    className="inline-flex items-center gap-1 text-primary underline"
                    href={screen.data.app.homepage}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    {t('oauth.homepage')}
                    <ExternalLink className="size-3" aria-hidden />
                  </a>
                </>
              )}
            </p>
            {screen.data.alreadyAllowed ? <Alert tone="info">{t('oauth.already')}</Alert> : null}
            <div className="flex justify-end gap-2">
              <Button
                busy={decide.isPending && decide.variables === 'deny'}
                onClick={() => decide.mutate('deny')}
              >
                {t('oauth.cancel')}
              </Button>
              <Button
                variant="primary"
                busy={decide.isPending && decide.variables === 'allow'}
                onClick={() => decide.mutate('allow')}
              >
                {t('oauth.allow')}
              </Button>
            </div>
          </>
        )}
      </Card>
    </main>
  );
}
