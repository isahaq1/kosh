/** Signing in (email and password, then the second factor when the user has one) and choosing a first password. */
import { Alert, Button, Card, Input, Label } from '@kosh/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { type FormEvent, type ReactElement, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePortal } from '../portal.js';

function Frame({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}) {
  return (
    <main className="grid min-h-svh place-items-center bg-background p-4 text-foreground">
      <Card className="grid w-full max-w-sm gap-4 p-6">
        <h1 className="text-lg font-semibold">{title}</h1>
        {children}
      </Card>
    </main>
  );
}

export function SignIn(): ReactElement {
  const { t } = useTranslation('portal');
  const { api } = usePortal();
  const id = useId();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needCode, setNeedCode] = useState(false);
  const enter = async () => {
    await queryClient.invalidateQueries();
    await navigate({ to: '/' });
  };
  const signIn = useMutation({
    mutationFn: async () => {
      if (needCode) await api.verifyTwoFactor(code);
      else {
        const { twoFactorRequired } = await api.login(login.trim(), password);
        if (twoFactorRequired) {
          setNeedCode(true);
          return;
        }
      }
      await enter();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    signIn.mutate();
  };
  return (
    <Frame title={t('signInTitle')}>
      <form className="grid gap-3" onSubmit={submit}>
        {needCode ? (
          <div className="grid gap-1">
            <Label htmlFor={`${id}-code`}>{t('twoFactor')}</Label>
            <Input
              id={`${id}-code`}
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </div>
        ) : (
          <>
            <div className="grid gap-1">
              <Label htmlFor={`${id}-login`}>{t('email')}</Label>
              <Input
                id={`${id}-login`}
                type="email"
                autoComplete="username"
                value={login}
                onChange={(e) => setLogin(e.target.value)}
              />
            </div>
            <div className="grid gap-1">
              <Label htmlFor={`${id}-password`}>{t('password')}</Label>
              <Input
                id={`${id}-password`}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          </>
        )}
        {signIn.error === null ? null : <Alert>{signIn.error.message}</Alert>}
        <Button type="submit" variant="primary" busy={signIn.isPending}>
          {needCode ? t('verify') : t('signIn')}
        </Button>
      </form>
    </Frame>
  );
}

export function Activate(): ReactElement {
  const { t } = useTranslation('portal');
  const { api } = usePortal();
  const id = useId();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { readonly token?: unknown };
  const token = typeof search.token === 'string' ? search.token : '';
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const activate = useMutation({
    mutationFn: async () => {
      if (password !== repeat) throw new Error(t('mismatch'));
      const { login } = await api.call<{ login: string }>('POST', '/api/portal/v1/activate', {
        token,
        password,
      });
      await api.login(login, password);
      await navigate({ to: '/' });
    },
  });
  return (
    <Frame title={t('activateTitle')}>
      {token === '' ? (
        <Alert>{t('noToken')}</Alert>
      ) : (
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            activate.mutate();
          }}
        >
          <p className="text-sm text-muted-foreground">{t('activateIntro')}</p>
          <div className="grid gap-1">
            <Label htmlFor={`${id}-password`}>{t('password')}</Label>
            <Input
              id={`${id}-password`}
              type="password"
              autoComplete="new-password"
              minLength={12}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor={`${id}-repeat`}>{t('repeat')}</Label>
            <Input
              id={`${id}-repeat`}
              type="password"
              autoComplete="new-password"
              value={repeat}
              onChange={(e) => setRepeat(e.target.value)}
            />
          </div>
          {activate.error === null ? null : <Alert>{activate.error.message}</Alert>}
          <Button type="submit" variant="primary" busy={activate.isPending}>
            {t('activate')}
          </Button>
        </form>
      )}
    </Frame>
  );
}
