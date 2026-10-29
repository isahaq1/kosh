/**
 * The invitation page (RFC 0019 §3.2): an invited person chooses their password (at least 12 characters) and is
 * signed in. A used, replaced or expired link says so.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type ReactElement, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, type KoshApi } from '../api.js';
import { Alert, Button, Card, Input, Label } from '../components/primitives.js';

export function Activate({
  api,
  onSignedIn,
}: {
  readonly api: KoshApi;
  readonly onSignedIn: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const id = useId();
  const token = new URLSearchParams(window.location.search).get('token') ?? '';
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const activate = useMutation({
    mutationFn: async () => {
      const { login } = await api.call<{ login: string }>('POST', '/api/v1/auth/activate', {
        token,
        password,
      });
      await api.login(login, password);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      onSignedIn();
    },
  });
  const mismatch = repeat !== '' && repeat !== password;
  return (
    <main className="grid min-h-screen place-items-center bg-background p-4">
      <Card className="w-full max-w-sm p-6">
        <h1 className="mb-1 text-xl font-semibold">{t('auth.activateTitle')}</h1>
        <p className="mb-5 text-sm text-muted-foreground">{t('auth.activateIntro')}</p>
        {token === '' ? (
          <Alert>{t('auth.activateNoToken')}</Alert>
        ) : (
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!mismatch && password.length >= 12) activate.mutate();
            }}
          >
            {activate.error === null ? null : (
              <Alert>
                {activate.error instanceof ApiError
                  ? activate.error.message
                  : String(activate.error)}
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
              busy={activate.isPending}
              disabled={password.length < 12 || mismatch}
            >
              {t('auth.activate')}
            </Button>
          </form>
        )}
      </Card>
    </main>
  );
}
