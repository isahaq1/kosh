/**
 * Password reset (RFC 0034 §2.4), outside the shell like sign-in: {@link Forgot} asks for the link — the answer is
 * the same whether or not the account exists —, and {@link Reset}, opened from the emailed link, sets the new
 * password once. The server decides everything; a used, replaced or expired link says so.
 */
import { useMutation } from '@tanstack/react-query';
import { type ReactElement, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, type KoshApi } from '../api.js';
import { Alert, Button, Card, Input, Label } from '../components/primitives.js';

const message = (error: unknown) => (error instanceof ApiError ? error.message : String(error));

export function Forgot({ api }: { readonly api: KoshApi }): ReactElement {
  const { t } = useTranslation();
  const id = useId();
  const [login, setLogin] = useState('');
  const ask = useMutation({
    mutationFn: () => api.call<{ ok: boolean }>('POST', '/api/v1/auth/password/forgot', { login }),
  });
  return (
    <main className="grid min-h-screen place-items-center bg-background p-4">
      <Card className="w-full max-w-sm p-6">
        <h1 className="mb-1 text-xl font-semibold">{t('auth.forgotTitle')}</h1>
        <p className="mb-5 text-sm text-muted-foreground">{t('auth.forgotIntro')}</p>
        {ask.isSuccess ? (
          <div className="grid gap-4">
            <Alert tone="info">{t('auth.forgotSent')}</Alert>
            <a className="text-sm underline" href="/login">
              {t('auth.backToSignIn')}
            </a>
          </div>
        ) : (
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              ask.mutate();
            }}
          >
            {ask.error === null ? null : <Alert>{message(ask.error)}</Alert>}
            <div className="grid gap-1">
              <Label htmlFor={`${id}-login`}>{t('auth.login')}</Label>
              <Input
                id={`${id}-login`}
                autoComplete="username"
                required
                value={login}
                onChange={(e) => setLogin(e.target.value)}
              />
            </div>
            <Button type="submit" variant="primary" busy={ask.isPending}>
              {t('auth.forgotSend')}
            </Button>
            <a className="text-sm underline" href="/login">
              {t('auth.backToSignIn')}
            </a>
          </form>
        )}
      </Card>
    </main>
  );
}

export function Reset({ api }: { readonly api: KoshApi }): ReactElement {
  const { t } = useTranslation();
  const id = useId();
  const token = new URLSearchParams(window.location.search).get('token') ?? '';
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const reset = useMutation({
    mutationFn: () =>
      api.call<{ login: string }>('POST', '/api/v1/auth/password/reset', { token, password }),
  });
  const mismatch = repeat !== '' && repeat !== password;
  return (
    <main className="grid min-h-screen place-items-center bg-background p-4">
      <Card className="w-full max-w-sm p-6">
        <h1 className="mb-1 text-xl font-semibold">{t('auth.resetTitle')}</h1>
        <p className="mb-5 text-sm text-muted-foreground">{t('auth.resetIntro')}</p>
        {token === '' ? (
          <Alert>{t('auth.resetNoToken')}</Alert>
        ) : reset.isSuccess ? (
          <div className="grid gap-4">
            <Alert tone="info">{t('auth.resetDone')}</Alert>
            <a className="text-sm underline" href="/login">
              {t('auth.signIn')}
            </a>
          </div>
        ) : (
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!mismatch && password.length >= 12) reset.mutate();
            }}
          >
            {reset.error === null ? null : (
              <Alert
                action={
                  <a className="underline" href="/forgot">
                    {t('auth.forgotLink')}
                  </a>
                }
              >
                {message(reset.error)}
              </Alert>
            )}
            <div className="grid gap-1">
              <Label htmlFor={`${id}-password`}>{t('auth.newPassword')}</Label>
              <Input
                id={`${id}-password`}
                type="password"
                autoComplete="new-password"
                minLength={12}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">{t('auth.passwordRule')}</p>
            </div>
            <div className="grid gap-1">
              <Label htmlFor={`${id}-repeat`}>{t('auth.repeatPassword')}</Label>
              <Input
                id={`${id}-repeat`}
                type="password"
                autoComplete="new-password"
                required
                value={repeat}
                aria-invalid={mismatch ? true : undefined}
                onChange={(e) => setRepeat(e.target.value)}
              />
              {mismatch ? <p className="text-xs text-danger">{t('auth.mismatch')}</p> : null}
            </div>
            <Button
              type="submit"
              variant="primary"
              busy={reset.isPending}
              disabled={password.length < 12 || mismatch}
            >
              {t('auth.resetSave')}
            </Button>
          </form>
        )}
      </Card>
    </main>
  );
}
