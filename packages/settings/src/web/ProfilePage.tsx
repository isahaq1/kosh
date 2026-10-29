/**
 * Your profile (RFC 0019 §3.6), from the user menu: your details, language and region (with your default company),
 * your password, two-factor sign-in (set up with an authenticator app, recovery codes, turn off) and the devices
 * signed in as you (sign one out, or all the others). The server checks and audits every change.
 */
import {
  Alert,
  ApiError,
  Badge,
  Button,
  ImagePicker,
  Input,
  imageUrl,
  LANGUAGES,
  Label,
  type PageProps,
  Select,
  useKosh,
  useLanguage,
} from '@kosh/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Laptop, Monitor, Smartphone } from 'lucide-react';
import { type ReactElement, type ReactNode, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface Profile {
  readonly login: string;
  readonly name: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly lang: string;
  readonly tz: string;
  readonly company: number | null;
}
interface Session {
  readonly id: number;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly lastSeenAt: string;
  readonly createdAt: string | null;
  readonly current: boolean;
}
interface Me {
  readonly id: number;
  readonly avatar?: string | null;
  readonly companies: readonly number[];
  readonly twoFactorEnabled: boolean;
  readonly administrator?: boolean;
}

const message = (error: unknown) => (error instanceof ApiError ? error.message : String(error));

/** "Chrome on Windows" from a user agent; enough to recognise a device. */
export function deviceOf(userAgent: string | null): {
  browser: string;
  os: string;
  phone: boolean;
} {
  const ua = userAgent ?? '';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : (ua.split(/[\s/]/)[0] ?? '');
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Android/.test(ua)
      ? 'Android'
      : /iPhone|iPad/.test(ua)
        ? 'iOS'
        : /Mac OS X/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  return { browser, os, phone: /Mobile|Android|iPhone/.test(ua) };
}

function Section({
  title,
  hint,
  children,
}: {
  readonly title: string;
  readonly hint?: string;
  readonly children: ReactNode;
}): ReactElement {
  const id = useId();
  return (
    <section aria-labelledby={id} className="grid gap-4 rounded-lg border bg-surface p-5">
      <div>
        <h2 id={id} className="font-semibold">
          {title}
        </h2>
        {hint === undefined ? null : <p className="text-sm text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function Field({
  label,
  id,
  children,
}: {
  readonly label: string;
  readonly id: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

function TwoFactor({ api, me }: PageProps & { readonly me: Me }): ReactElement {
  const { t } = useTranslation('settings');
  const id = useId();
  const queryClient = useQueryClient();
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [codes, setCodes] = useState<readonly string[] | null>(null);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['me'] });
  const start = useMutation({
    mutationFn: () =>
      api.call<{ secret: string; otpauthUri: string }>('POST', '/api/v1/auth/2fa/setup'),
    onSuccess: (data) => {
      setSetup(data);
      setCode('');
    },
  });
  const enable = useMutation({
    mutationFn: () =>
      api.call<{ recoveryCodes: string[] }>('POST', '/api/v1/auth/2fa/enable', { code }),
    onSuccess: (data) => {
      setCodes(data.recoveryCodes);
      setSetup(null);
      refresh();
    },
  });
  const disable = useMutation({
    mutationFn: () => api.call('POST', '/api/v1/auth/2fa/disable', { password, code }),
    onSuccess: () => {
      setPassword('');
      setCode('');
      refresh();
    },
  });
  const error = start.error ?? enable.error ?? disable.error;
  return (
    <Section title={t('profile.twoFactor')} hint={t('profile.twoFactorHint')}>
      <div className="flex items-center gap-2 text-sm">
        {me.twoFactorEnabled ? (
          <Badge tone="success">{t('profile.twoFactorOn')}</Badge>
        ) : (
          <Badge tone="warning">{t('profile.twoFactorOff')}</Badge>
        )}
        {me.administrator === true && !me.twoFactorEnabled ? (
          <span className="text-warning-text">{t('profile.adminNeeds')}</span>
        ) : null}
      </div>
      {codes === null ? null : (
        <Alert tone="info">
          <p className="font-medium">{t('profile.recoveryCodes')}</p>
          <ul className="mt-2 grid grid-cols-2 gap-1 font-mono text-sm sm:grid-cols-4">
            {codes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </Alert>
      )}
      {!me.twoFactorEnabled && setup === null ? (
        <div>
          <Button variant="primary" busy={start.isPending} onClick={() => start.mutate()}>
            {t('profile.setUp')}
          </Button>
        </div>
      ) : null}
      {setup === null ? null : (
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            enable.mutate();
          }}
        >
          <ol className="grid list-decimal gap-2 ps-5 text-sm">
            <li>
              {t('profile.step1')}{' '}
              <a className="text-primary underline" href={setup.otpauthUri}>
                {t('profile.openApp')}
              </a>
            </li>
            <li>
              {t('profile.step2')}
              <code className="ms-2 select-all break-all rounded bg-muted px-2 py-1 font-mono text-xs">
                {setup.secret}
              </code>
            </li>
            <li>{t('profile.step3')}</li>
          </ol>
          <Field label={t('profile.code')} id={`${id}-code`}>
            <Input
              id={`${id}-code`}
              inputMode="numeric"
              autoComplete="one-time-code"
              className="w-40 font-mono"
              value={code}
              onChange={(e) => setCode(e.target.value.trim())}
            />
          </Field>
          <div className="flex gap-2">
            <Button
              type="submit"
              variant="primary"
              busy={enable.isPending}
              disabled={code.length < 6}
            >
              {t('profile.turnOn')}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setSetup(null)}>
              {t('profile.cancel')}
            </Button>
          </div>
        </form>
      )}
      {me.twoFactorEnabled ? (
        <details>
          <summary className="cursor-pointer text-sm">{t('profile.turnOff')}</summary>
          <form
            className="mt-3 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              disable.mutate();
            }}
          >
            <Field label={t('profile.password')} id={`${id}-off-password`}>
              <Input
                id={`${id}-off-password`}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <Field label={t('profile.code')} id={`${id}-off-code`}>
              <Input
                id={`${id}-off-code`}
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value.trim())}
              />
            </Field>
            <Button
              type="submit"
              variant="danger"
              busy={disable.isPending}
              disabled={password === '' || code === ''}
            >
              {t('profile.turnOff')}
            </Button>
          </form>
        </details>
      ) : null}
      {error === null ? null : <Alert tone="danger">{message(error)}</Alert>}
    </Section>
  );
}

function Sessions({ api }: PageProps): ReactElement {
  const { t } = useTranslation('settings');
  const { format } = useKosh();
  const queryClient = useQueryClient();
  const sessions = useQuery({
    queryKey: ['profile', 'sessions'],
    queryFn: () => api.call<{ sessions: Session[] }>('GET', '/api/v1/auth/sessions'),
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['profile', 'sessions'] });
  const one = useMutation({
    mutationFn: (sid: number) => api.call('DELETE', `/api/v1/auth/sessions/${sid}`),
    onSuccess: refresh,
  });
  const others = useMutation({
    mutationFn: () => api.call('POST', '/api/v1/auth/sessions/sign-out-others'),
    onSuccess: refresh,
  });
  const list = sessions.data?.sessions ?? [];
  return (
    <Section title={t('profile.sessions')} hint={t('profile.sessionsHint')}>
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
                  {name}{' '}
                  {s.current ? <Badge tone="success">{t('profile.thisDevice')}</Badge> : null}
                </p>
                <p className="text-xs text-muted-foreground">
                  {[s.ip, t('profile.lastActive', { when: format.datetime(s.lastSeenAt) })]
                    .filter((x) => x !== null)
                    .join(' · ')}
                </p>
              </div>
              {s.current ? null : (
                <Button
                  size="sm"
                  variant="secondary"
                  busy={one.isPending && one.variables === s.id}
                  onClick={() => one.mutate(s.id)}
                  aria-label={t('profile.signOutDevice', { device: name })}
                >
                  {t('profile.signOut')}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {list.filter((s) => !s.current).length === 0 ? null : (
        <div>
          <Button variant="secondary" busy={others.isPending} onClick={() => others.mutate()}>
            {t('profile.signOutOthers')}
          </Button>
        </div>
      )}
      {(one.error ?? others.error) === null ? null : (
        <Alert tone="danger">{message(one.error ?? others.error)}</Alert>
      )}
    </Section>
  );
}

export function ProfilePage({ api }: PageProps): ReactElement {
  const { t } = useTranslation('settings');
  const id = useId();
  const queryClient = useQueryClient();
  const { setLang } = useLanguage();
  const profile = useQuery({
    queryKey: ['profile'],
    queryFn: () => api.call<Profile>('GET', '/api/v1/auth/profile'),
  });
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.call<Me>('GET', '/api/v1/auth/me') });
  const companies = useQuery({
    queryKey: ['names', 'res.company', me.data?.companies],
    queryFn: () => api.names('res.company', { ids: me.data?.companies ?? [] }),
    enabled: (me.data?.companies.length ?? 0) > 1,
  });
  const [draft, setDraft] = useState<Profile | null>(null);
  useEffect(() => {
    if (profile.data !== undefined) setDraft(profile.data);
  }, [profile.data]);
  const save = useMutation({
    mutationFn: (values: Partial<Profile>) =>
      api.call<Profile>('PATCH', '/api/v1/auth/profile', values),
    onSuccess: (saved) => {
      queryClient.setQueryData(['profile'], saved);
      void queryClient.invalidateQueries({ queryKey: ['me'] });
      // The app follows the language chosen here.
      setLang(saved.lang);
    },
  });
  const photo = useMutation({
    mutationFn: (image: string | null) =>
      image === null
        ? api.call('DELETE', '/api/v1/auth/profile/avatar')
        : api.call('PUT', '/api/v1/auth/profile/avatar', { image }),
    // The shell shows the photo from the user's details.
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['me'] }),
  });
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const password = useMutation({
    mutationFn: () => api.call('POST', '/api/v1/auth/password', { current, next }),
    onSuccess: () => {
      setCurrent('');
      setNext('');
      setRepeat('');
    },
  });
  const zones = (() => {
    let list: string[];
    try {
      list = (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf(
        'timeZone',
      );
    } catch {
      list = ['Asia/Dhaka', 'Asia/Kolkata'];
    }
    // UTC (every new user's default) and the saved zone are always offered.
    return [...new Set(['UTC', ...(draft === null ? [] : [draft.tz]), ...list])];
  })();
  if (profile.error !== null) return <Alert tone="danger">{message(profile.error)}</Alert>;
  if (draft === null || me.data === undefined)
    return <p className="text-sm text-muted-foreground">…</p>;
  const set = (patch: Partial<Profile>) => setDraft({ ...draft, ...patch });
  return (
    <div className="mx-auto grid max-w-3xl gap-6">
      <header className="grid gap-4">
        <div>
          <h1 className="text-xl font-semibold">{t('profile.title')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('profile.signedInAs', { login: draft.login })}
          </p>
        </div>
        <section aria-label={t('profile.photo')} className="rounded-lg border bg-surface p-5">
          <ImagePicker
            name={draft.name}
            src={imageUrl('user', me.data.id, me.data.avatar)}
            fit="photo"
            busy={photo.isPending}
            onChoose={(image) => photo.mutate(image)}
            onRemove={() => photo.mutate(null)}
          />
          {photo.error === null ? null : (
            <div className="mt-3">
              <Alert tone="danger">{message(photo.error)}</Alert>
            </div>
          )}
        </section>
      </header>

      <form
        className="grid gap-6"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate({
            name: draft.name,
            email: draft.email ?? '',
            phone: draft.phone ?? '',
            lang: draft.lang,
            tz: draft.tz,
            ...(draft.company === null ? {} : { company: draft.company }),
          });
        }}
      >
        <Section title={t('profile.details')}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('profile.name')} id={`${id}-name`}>
              <Input
                id={`${id}-name`}
                autoComplete="name"
                required
                value={draft.name}
                onChange={(e) => set({ name: e.target.value })}
              />
            </Field>
            <Field label={t('profile.email')} id={`${id}-email`}>
              <Input
                id={`${id}-email`}
                type="email"
                autoComplete="email"
                value={draft.email ?? ''}
                onChange={(e) => set({ email: e.target.value })}
              />
            </Field>
            <Field label={t('profile.phone')} id={`${id}-phone`}>
              <Input
                id={`${id}-phone`}
                type="tel"
                autoComplete="tel"
                value={draft.phone ?? ''}
                onChange={(e) => set({ phone: e.target.value })}
              />
            </Field>
          </div>
        </Section>
        <Section title={t('profile.region')} hint={t('profile.regionHint')}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('profile.language')} id={`${id}-lang`}>
              <Select
                id={`${id}-lang`}
                label={t('profile.language')}
                value={draft.lang}
                options={LANGUAGES.map((l) => ({ value: l.code, label: l.name }))}
                onChange={(v) => set({ lang: v })}
              />
            </Field>
            <Field label={t('profile.timeZone')} id={`${id}-tz`}>
              <Select
                id={`${id}-tz`}
                label={t('profile.timeZone')}
                value={draft.tz}
                options={zones.map((z) => ({ value: z, label: z.replace(/_/g, ' ') }))}
                onChange={(v) => set({ tz: v })}
              />
            </Field>
            {(me.data.companies.length ?? 0) > 1 ? (
              <Field label={t('profile.defaultCompany')} id={`${id}-company`}>
                <Select
                  id={`${id}-company`}
                  label={t('profile.defaultCompany')}
                  value={draft.company === null ? null : String(draft.company)}
                  options={(companies.data ?? []).map((c) => ({
                    value: String(c.id),
                    label: c.displayName,
                  }))}
                  onChange={(v) => set({ company: Number(v) })}
                />
              </Field>
            ) : null}
          </div>
        </Section>
        {save.error === null ? null : <Alert tone="danger">{message(save.error)}</Alert>}
        {save.isSuccess ? <Alert tone="info">{t('profile.saved')}</Alert> : null}
        <div className="flex justify-end">
          <Button type="submit" variant="primary" busy={save.isPending}>
            {t('profile.save')}
          </Button>
        </div>
      </form>

      <Section title={t('profile.passwordTitle')} hint={t('profile.passwordHint')}>
        <form
          className="grid gap-4 sm:grid-cols-3 sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            password.mutate();
          }}
        >
          <Field label={t('profile.currentPassword')} id={`${id}-current`}>
            <Input
              id={`${id}-current`}
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </Field>
          <Field label={t('profile.newPassword')} id={`${id}-next`}>
            <Input
              id={`${id}-next`}
              type="password"
              autoComplete="new-password"
              minLength={12}
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          </Field>
          <Field label={t('profile.repeatPassword')} id={`${id}-repeat`}>
            <Input
              id={`${id}-repeat`}
              type="password"
              autoComplete="new-password"
              value={repeat}
              aria-invalid={repeat !== '' && repeat !== next ? true : undefined}
              onChange={(e) => setRepeat(e.target.value)}
            />
          </Field>
          <div className="sm:col-span-3">
            <Button
              type="submit"
              variant="secondary"
              busy={password.isPending}
              disabled={current === '' || next.length < 12 || next !== repeat}
            >
              {t('profile.changePassword')}
            </Button>
          </div>
        </form>
        {password.error === null ? null : <Alert tone="danger">{message(password.error)}</Alert>}
        {password.isSuccess ? <Alert tone="info">{t('profile.passwordChanged')}</Alert> : null}
      </Section>

      <TwoFactor api={api} me={me.data} />
      <Sessions api={api} />
    </div>
  );
}
