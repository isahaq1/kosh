/** The sign-in page: login and password, then the second factor when the account has 2FA. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactElement, useEffect, useId, useRef, useState } from 'react';
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
  // Single sign-on (RFC 0034 §2.4): the providers offered, and the way back from one — a hand-off code in the
  // address becomes the session; a refusal is said in words.
  const params = new URLSearchParams(window.location.search);
  const ssoError = params.get('sso_error');
  const providers = useQuery({
    queryKey: ['auth', 'sso-providers'],
    queryFn: () =>
      api.call<{ providers: { key: string; name: string }[] }>('GET', '/api/v1/auth/sso/providers'),
    retry: false,
  });
  const handOff = useMutation({
    mutationFn: (handOffCode: string) => api.completeSso(handOffCode),
    onSuccess: async ({ twoFactorRequired }) => {
      if (twoFactorRequired) setStep('code');
      else await done();
    },
  });
  const exchanged = useRef(false);
  useEffect(() => {
    const handOffCode = new URLSearchParams(window.location.search).get('sso');
    if (handOffCode === null || exchanged.current) return;
    exchanged.current = true; // once: the code works once
    handOff.mutate(handOffCode);
  }, [handOff]);
  const next = params.get('next');
  const error = signIn.error ?? verify.error ?? handOff.error;
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
        {ssoError === null || error !== null ? null : (
          <div className="mb-4">
            <Alert>
              {t(`auth.ssoError.${ssoError}`, { defaultValue: t('auth.ssoError.provider') })}
            </Alert>
          </div>
        )}
        {step === 'password' && (providers.data?.providers ?? []).length > 0 ? (
          <div className="mb-4 grid gap-2">
            {(providers.data?.providers ?? []).map((p) => (
              <a
                key={p.key}
                className="rounded-md border px-3 py-2 text-center text-sm font-medium hover:bg-muted"
                href={`/api/v1/auth/sso/${encodeURIComponent(p.key)}/start${next === null ? '' : `?next=${encodeURIComponent(next)}`}`}
              >
                {t('auth.ssoWith', { name: p.name })}
              </a>
            ))}
            <p className="text-center text-xs text-muted-foreground">{t('auth.ssoOr')}</p>
          </div>
        ) : null}
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
            <a className="text-sm underline" href="/forgot">
              {t('auth.forgotLink')}
            </a>
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
