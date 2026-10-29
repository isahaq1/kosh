/**
 * Two-factor sign-in required of everyone (RFC 0019 §3.5): until the person sets it up, the server allows nothing
 * else, so the shell shows this page instead — the key for the authenticator app, a code to turn it on, the recovery
 * codes once — then opens the back-office.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type ReactElement, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, type KoshApi } from '../api.js';
import { Alert, Button, Card, Input, Label } from '../components/primitives.js';

export function TwoFactorSetup({ api }: { readonly api: KoshApi }): ReactElement {
  const { t } = useTranslation();
  const id = useId();
  const queryClient = useQueryClient();
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<readonly string[] | null>(null);
  const start = useMutation({
    mutationFn: () =>
      api.call<{ secret: string; otpauthUri: string }>('POST', '/api/v1/auth/2fa/setup'),
  });
  const enable = useMutation({
    mutationFn: () =>
      api.call<{ recoveryCodes: string[] }>('POST', '/api/v1/auth/2fa/enable', { code }),
    onSuccess: (data) => setCodes(data.recoveryCodes),
  });
  const error = start.error ?? enable.error;
  const setup = start.data;
  return (
    <main className="grid min-h-screen place-items-center bg-background p-4">
      <Card className="grid w-full max-w-md gap-4 p-6">
        <div>
          <h1 className="mb-1 text-xl font-semibold">{t('auth.setupTitle')}</h1>
          <p className="text-sm text-muted-foreground">{t('auth.setupIntro')}</p>
        </div>
        {error === null ? null : (
          <Alert>{error instanceof ApiError ? error.message : String(error)}</Alert>
        )}
        {codes !== null ? (
          <>
            <Alert tone="info">
              <p className="font-medium">{t('auth.setupCodes')}</p>
              <ul className="mt-2 grid grid-cols-2 gap-1 font-mono text-sm">
                {codes.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </Alert>
            <Button variant="primary" onClick={() => void queryClient.invalidateQueries()}>
              {t('auth.setupContinue')}
            </Button>
          </>
        ) : setup === undefined ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" busy={start.isPending} onClick={() => start.mutate()}>
              {t('auth.setupStart')}
            </Button>
            <Button
              variant="ghost"
              onClick={() => void api.logout().then(() => window.location.assign('/login'))}
            >
              {t('auth.signOut')}
            </Button>
          </div>
        ) : (
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (code.length >= 6) enable.mutate();
            }}
          >
            <ol className="grid list-decimal gap-2 ps-5 text-sm">
              <li>
                {t('auth.setupStep1')}{' '}
                <a className="text-primary underline" href={setup.otpauthUri}>
                  {t('auth.setupOpenApp')}
                </a>
              </li>
              <li>
                {t('auth.setupStep2')}
                <code
                  data-testid="two-factor-key"
                  className="ms-2 select-all break-all rounded bg-muted px-2 py-1 font-mono text-xs"
                >
                  {setup.secret}
                </code>
              </li>
              <li>{t('auth.setupStep3')}</li>
            </ol>
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-code`}>{t('auth.code')}</Label>
              <Input
                id={`${id}-code`}
                inputMode="numeric"
                autoComplete="one-time-code"
                className="w-40 font-mono"
                value={code}
                onChange={(e) => setCode(e.target.value.trim())}
              />
            </div>
            <Button
              type="submit"
              variant="primary"
              busy={enable.isPending}
              disabled={code.length < 6}
            >
              {t('auth.setupTurnOn')}
            </Button>
          </form>
        )}
      </Card>
    </main>
  );
}
