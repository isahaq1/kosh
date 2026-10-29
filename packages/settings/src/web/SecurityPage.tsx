/**
 * Settings › Security (RFC 0019 §3.5), administrators: the policy — who must sign in with a second factor (the people
 * it would stop until they set it up are named before saving) and how long a sign-in lasts — and every signed-in
 * device across people, each signed out with one click. The server enforces the policy and audits every change.
 */
import { Alert, ApiError, Badge, Button, Input, Label, type PageProps, useKosh } from '@kosh/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Laptop, Monitor, Smartphone } from 'lucide-react';
import { type ReactElement, type ReactNode, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { deviceOf } from './ProfilePage.js';

type TwoFactor = 'administrators' | 'everyone';
interface Policy {
  readonly twoFactor: TwoFactor;
  readonly sessionDays: number | null;
  readonly withoutTwoFactor: readonly { readonly id: number; readonly name: string }[];
}
interface Session {
  readonly id: number;
  readonly name: string;
  readonly login: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly lastSeenAt: string | null;
  readonly current: boolean;
}

const message = (error: unknown) => (error instanceof ApiError ? error.message : String(error));

function Section({
  title,
  hint,
  children,
}: {
  readonly title: string;
  readonly hint: string;
  readonly children: ReactNode;
}): ReactElement {
  const id = useId();
  return (
    <section aria-labelledby={id} className="grid gap-4 rounded-lg border bg-surface p-5">
      <div>
        <h2 id={id} className="font-semibold">
          {title}
        </h2>
        <p className="text-sm text-muted-foreground">{hint}</p>
      </div>
      {children}
    </section>
  );
}

function PolicyForm({ api, policy }: PageProps & { readonly policy: Policy }): ReactElement {
  const { t } = useTranslation('settings');
  const id = useId();
  const queryClient = useQueryClient();
  const [twoFactor, setTwoFactor] = useState<TwoFactor>(policy.twoFactor);
  const [days, setDays] = useState(policy.sessionDays === null ? '' : String(policy.sessionDays));
  const save = useMutation({
    mutationFn: () =>
      api.call<Policy>('PATCH', '/api/v1/settings/security', {
        twoFactor,
        sessionDays: days === '' ? null : Number(days),
      }),
    // The form already shows what was saved; the server's answer names who is still without it.
    onSuccess: (saved) => queryClient.setQueryData(['settings', 'security'], saved),
  });
  const stopped = twoFactor === 'everyone' ? policy.withoutTwoFactor : [];
  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">{t('security.twoFactorFor')}</legend>
        {(['administrators', 'everyone'] as const).map((value) => (
          <label key={value} className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name={`${id}-two-factor`}
              className="mt-1 accent-[var(--primary)]"
              checked={twoFactor === value}
              onChange={() => setTwoFactor(value)}
            />
            <span>
              <span className="font-medium">{t(`security.${value}`)}</span>
              <span className="block text-muted-foreground">{t(`security.${value}Hint`)}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {stopped.length === 0 ? null : (
        <Alert tone="warning">
          {t('security.wouldStop', {
            count: stopped.length,
            names: stopped
              .slice(0, 5)
              .map((p) => p.name)
              .join(', '),
          })}
        </Alert>
      )}
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-days`}>{t('security.sessionDays')}</Label>
        <Input
          id={`${id}-days`}
          type="number"
          min={1}
          max={90}
          className="w-32"
          placeholder={t('security.serverDefault')}
          value={days}
          onChange={(e) => setDays(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">{t('security.sessionDaysHint')}</p>
      </div>
      {save.error === null ? null : <Alert tone="danger">{message(save.error)}</Alert>}
      {save.isSuccess ? <Alert tone="info">{t('security.saved')}</Alert> : null}
      <div className="flex justify-end">
        <Button type="submit" variant="primary" busy={save.isPending}>
          {t('security.save')}
        </Button>
      </div>
    </form>
  );
}

function Sessions({ api }: PageProps): ReactElement {
  const { t } = useTranslation('settings');
  const { format } = useKosh();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState('');
  const sessions = useQuery({
    queryKey: ['settings', 'sessions'],
    queryFn: () => api.call<{ sessions: Session[] }>('GET', '/api/v1/settings/sessions'),
  });
  const revoke = useMutation({
    mutationFn: (sid: number) => api.call('DELETE', `/api/v1/settings/sessions/${sid}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['settings', 'sessions'] }),
  });
  const words = filter.trim().toLowerCase();
  const list = (sessions.data?.sessions ?? []).filter(
    (s) => words === '' || `${s.name} ${s.login} ${s.ip ?? ''}`.toLowerCase().includes(words),
  );
  return (
    <div className="grid gap-3">
      <Input
        aria-label={t('security.searchSessions')}
        placeholder={t('security.searchSessions')}
        className="max-w-xs"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      {sessions.error === null ? null : <Alert tone="danger">{message(sessions.error)}</Alert>}
      {revoke.error === null ? null : <Alert tone="danger">{message(revoke.error)}</Alert>}
      <ul className="divide-y rounded-md border">
        {list.map((s) => {
          const device = deviceOf(s.userAgent);
          const Icon = device.phone ? Smartphone : device.os === '' ? Monitor : Laptop;
          const name =
            [device.browser, device.os].filter((x) => x !== '').join(' · ') ||
            t('profile.unknownDevice');
          return (
            <li key={s.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
              <Icon className="size-5 text-muted-foreground" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">
                  {s.name} <span className="font-normal text-muted-foreground">· {name}</span>{' '}
                  {s.current ? <Badge tone="success">{t('profile.thisDevice')}</Badge> : null}
                </p>
                <p className="text-xs text-muted-foreground">
                  {[
                    s.ip,
                    s.lastSeenAt === null
                      ? null
                      : t('profile.lastActive', { when: format.datetime(s.lastSeenAt) }),
                  ]
                    .filter((x) => x !== null)
                    .join(' · ')}
                </p>
              </div>
              {s.current ? null : (
                <Button
                  size="sm"
                  variant="secondary"
                  busy={revoke.isPending && revoke.variables === s.id}
                  onClick={() => revoke.mutate(s.id)}
                  aria-label={t('security.signOutOf', { name: s.name, device: name })}
                >
                  {t('profile.signOut')}
                </Button>
              )}
            </li>
          );
        })}
        {sessions.data !== undefined && list.length === 0 ? (
          <li className="px-3 py-2.5 text-sm text-muted-foreground">{t('security.noSessions')}</li>
        ) : null}
      </ul>
    </div>
  );
}

export function SecurityPage({ api }: PageProps): ReactElement {
  const { t } = useTranslation('settings');
  const policy = useQuery({
    queryKey: ['settings', 'security'],
    queryFn: () => api.call<Policy>('GET', '/api/v1/settings/security'),
  });
  return (
    <div className="mx-auto grid max-w-3xl gap-6">
      <header>
        <h1 className="text-xl font-semibold">{t('security.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('security.intro')}</p>
      </header>
      {policy.error !== null ? (
        <Alert tone="danger">{message(policy.error)}</Alert>
      ) : (
        <>
          <Section title={t('security.policy')} hint={t('security.policyHint')}>
            {policy.data === undefined ? (
              <p className="text-sm text-muted-foreground">…</p>
            ) : (
              <PolicyForm api={api} policy={policy.data} />
            )}
          </Section>
          <Section title={t('security.sessions')} hint={t('security.sessionsHint')}>
            <Sessions api={api} />
          </Section>
        </>
      )}
    </div>
  );
}
