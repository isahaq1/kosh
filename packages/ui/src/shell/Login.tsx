/** The sign-in page: login and password, then the second factor when the account has 2FA. */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type ReactElement, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, type KoshApi } from '../api.js';
import { Alert, Button, Card, Input, Label } from '../components/primitives.js';

export function Login({
  api,
  onSignedIn,
}: {
  readonly api: KoshApi;
  readonly onSignedIn: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const id = useId();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'password' | 'code'>('password');
  const done = async () => {
    await queryClient.invalidateQueries();
    onSignedIn();
  };
  const signIn = useMutation({
    mutationFn: () => api.login(login, password),
    onSuccess: async ({ twoFactorRequired }) => {
      if (twoFactorRequired) setStep('code');
      else await done();
    },
  });
  const verify = useMutation({ mutationFn: () => api.verifyTwoFactor(code), onSuccess: done });
  const error = signIn.error ?? verify.error;
  return (
    <main className="grid min-h-screen place-items-center bg-background p-4">
      <Card className="w-full max-w-sm p-6">
        <h1 className="mb-1 text-xl font-semibold">{t('app.name')}</h1>
        <p className="mb-5 text-sm text-muted-foreground">{t('auth.signIn')}</p>
        {error === null ? null : (
          <div className="mb-4">
            <Alert>
              {error instanceof ApiError && error.kind === 'invalid-credentials'
                ? t('auth.invalid')
                : error.message}
            </Alert>
          </div>
        )}
        {step === 'password' ? (
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              signIn.mutate();
            }}
          >
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
            <div className="grid gap-1">
              <Label htmlFor={`${id}-password`}>{t('auth.password')}</Label>
              <Input
                id={`${id}-password`}
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <Button type="submit" variant="primary" busy={signIn.isPending}>
              {t('auth.signIn')}
            </Button>
          </form>
        ) : (
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              verify.mutate();
            }}
          >
            <div className="grid gap-1">
              <Label htmlFor={`${id}-code`}>{t('auth.code')}</Label>
              <Input
                id={`${id}-code`}
                autoComplete="one-time-code"
                inputMode="numeric"
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">{t('auth.codeHint')}</p>
            </div>
            <Button type="submit" variant="primary" busy={verify.isPending}>
              {t('auth.verify')}
            </Button>
          </form>
        )}
      </Card>
    </main>
  );
}
