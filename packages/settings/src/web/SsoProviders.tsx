/**
 * Settings › Security › Single sign-on (RFC 0034 §2.4): the OpenID Connect providers people may sign in with. An
 * Administrator adds one by its issuer and client id; the page says what to register at the provider (the redirect
 * address), which environment variable holds the client secret and whether it is set, and tests that the provider
 * can be reached. The server validates and decides.
 */
import { Alert, ApiError, Badge, Button, Input, type KoshApi, Label } from '@kosh/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactElement, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface Provider {
  readonly id: number;
  readonly key: string;
  readonly name: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly enabled: boolean;
  readonly callbackUrl: string;
  readonly secretName: string;
  readonly secretSet: boolean;
  readonly people: number;
  readonly trustEmail: boolean;
  readonly groupsClaim: string;
  readonly groupMap: Readonly<Record<string, readonly string[]>>;
}
const message = (error: unknown) => (error instanceof ApiError ? error.message : String(error));
const EMPTY = { key: '', name: '', issuer: '', clientId: '' };

/**
 * The roles a provider's groups give: one row per group at the provider, with the roles (their codes, as in
 * Settings › Roles & permissions) it gives here. The server checks every role and refuses an Administrator's.
 */
function GroupRoles({
  api,
  provider,
  onSaved,
}: {
  readonly api: KoshApi;
  readonly provider: Provider;
  readonly onSaved: () => void;
}): ReactElement {
  const { t } = useTranslation('settings');
  const id = useId();
  const [claim, setClaim] = useState(provider.groupsClaim);
  const [trust, setTrust] = useState(provider.trustEmail);
  const [rows, setRows] = useState(
    Object.entries(provider.groupMap).map(([group, roles]) => ({ group, roles: roles.join(', ') })),
  );
  const save = useMutation({
    mutationFn: () =>
      api.call<Provider>('PATCH', `/api/v1/settings/sso/${provider.id}`, {
        groupsClaim: claim,
        trustEmail: trust,
        groupMap: Object.fromEntries(
          rows
            .filter((r) => r.group.trim() !== '')
            .map((r) => [
              r.group.trim(),
              r.roles
                .split(',')
                .map((x) => x.trim())
                .filter((x) => x !== ''),
            ]),
        ),
      }),
    onSuccess: onSaved,
  });
  return (
    <details className="rounded-md border p-3">
      <summary className="cursor-pointer text-sm font-medium">{t('security.sso.roles')}</summary>
      <div className="mt-3 grid gap-3">
        <p className="text-sm text-muted-foreground">{t('security.sso.rolesHint')}</p>
        {save.error === null ? null : <Alert>{message(save.error)}</Alert>}
        {save.isSuccess ? <p role="status">{t('security.sso.rolesSaved')}</p> : null}
        {rows.map((row, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are edited in place; their position is their identity
          <div key={index} className="grid gap-2 sm:grid-cols-[1fr_2fr_auto]">
            <div className="grid gap-1">
              <Label htmlFor={`${id}-group-${index}`}>{t('security.sso.group')}</Label>
              <Input
                id={`${id}-group-${index}`}
                value={row.group}
                onChange={(e) =>
                  setRows(rows.map((r, i) => (i === index ? { ...r, group: e.target.value } : r)))
                }
              />
            </div>
            <div className="grid gap-1">
              <Label htmlFor={`${id}-roles-${index}`}>{t('security.sso.givenRoles')}</Label>
              <Input
                id={`${id}-roles-${index}`}
                value={row.roles}
                placeholder="sales.user, account.user"
                onChange={(e) =>
                  setRows(rows.map((r, i) => (i === index ? { ...r, roles: e.target.value } : r)))
                }
              />
            </div>
            <div className="flex items-end">
              <Button
                variant="secondary"
                onClick={() => setRows(rows.filter((_, i) => i !== index))}
              >
                {t('security.sso.removeGroup')}
              </Button>
            </div>
          </div>
        ))}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1">
            <Label htmlFor={`${id}-claim`}>{t('security.sso.claim')}</Label>
            <Input id={`${id}-claim`} value={claim} onChange={(e) => setClaim(e.target.value)} />
          </div>
          <label className="flex items-center gap-2 self-end text-sm">
            <input type="checkbox" checked={trust} onChange={(e) => setTrust(e.target.checked)} />
            {t('security.sso.trustEmail')}
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setRows([...rows, { group: '', roles: '' }])}>
            {t('security.sso.addGroup')}
          </Button>
          <Button variant="primary" busy={save.isPending} onClick={() => save.mutate()}>
            {t('security.sso.saveRoles')}
          </Button>
        </div>
      </div>
    </details>
  );
}

export function SsoProviders({ api }: { readonly api: KoshApi }): ReactElement {
  const { t } = useTranslation('settings');
  const client = useQueryClient();
  const id = useId();
  const [form, setForm] = useState(EMPTY);
  const [tested, setTested] = useState<Readonly<Record<number, string>>>({});
  const list = useQuery({
    queryKey: ['settings', 'sso'],
    queryFn: () => api.call<{ providers: Provider[] }>('GET', '/api/v1/settings/sso'),
  });
  const refresh = () => void client.invalidateQueries({ queryKey: ['settings', 'sso'] });
  const add = useMutation({
    mutationFn: () => api.call<Provider>('POST', '/api/v1/settings/sso', form),
    onSuccess: () => {
      setForm(EMPTY);
      refresh();
    },
  });
  const change = useMutation({
    mutationFn: (p: { id: number; enabled: boolean }) =>
      api.call<Provider>('PATCH', `/api/v1/settings/sso/${p.id}`, { enabled: p.enabled }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (provider: number) =>
      api.call<unknown>('DELETE', `/api/v1/settings/sso/${provider}`),
    onSuccess: refresh,
  });
  const test = useMutation({
    mutationFn: async (provider: number) => ({
      provider,
      answer: await api.call<{ ok: boolean; issuer?: string; error?: string }>(
        'POST',
        `/api/v1/settings/sso/${provider}/test`,
        {},
      ),
    }),
    onSuccess: ({ provider, answer }) =>
      setTested({
        ...tested,
        [provider]: answer.ok
          ? t('security.sso.reached', { issuer: answer.issuer })
          : t('security.sso.unreachable', { error: answer.error }),
      }),
  });
  const error = list.error ?? add.error ?? change.error ?? remove.error ?? test.error;
  const field = (name: keyof typeof EMPTY, placeholder: string) => (
    <div className="grid gap-1">
      <Label htmlFor={`${id}-${name}`}>{t(`security.sso.${name}`)}</Label>
      <Input
        id={`${id}-${name}`}
        required
        value={form[name]}
        placeholder={placeholder}
        onChange={(e) => setForm({ ...form, [name]: e.target.value })}
      />
    </div>
  );
  return (
    <div className="grid gap-4">
      {error === null ? null : <Alert>{message(error)}</Alert>}
      {(list.data?.providers ?? []).length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('security.sso.none')}</p>
      ) : (
        <ul className="grid gap-3">
          {(list.data?.providers ?? []).map((p) => (
            <li key={p.id} className="grid gap-2 rounded-md border p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">
                  {p.name} <span className="text-muted-foreground">({p.key})</span>
                </span>
                <span className="flex flex-wrap items-center gap-2">
                  <Badge tone={p.enabled ? 'success' : 'neutral'}>
                    {p.enabled ? t('security.sso.on') : t('security.sso.off')}
                  </Badge>
                  <Badge tone={p.secretSet ? 'success' : 'warning'}>
                    {p.secretSet ? t('security.sso.secretSet') : t('security.sso.secretMissing')}
                  </Badge>
                </span>
              </div>
              <dl className="grid gap-1 text-muted-foreground">
                <div className="break-all">
                  <dt className="inline">{t('security.sso.issuer')}: </dt>
                  <dd className="inline">{p.issuer}</dd>
                </div>
                <div className="break-all">
                  <dt className="inline">{t('security.sso.callback')}: </dt>
                  <dd className="inline">
                    <code>{p.callbackUrl}</code>
                  </dd>
                </div>
                <div className="break-all">
                  <dt className="inline">{t('security.sso.secret')}: </dt>
                  <dd className="inline">
                    <code>{p.secretName}</code>
                  </dd>
                </div>
                <div>{t('security.sso.people', { count: p.people })}</div>
              </dl>
              <GroupRoles api={api} provider={p} onSaved={refresh} />
              {tested[p.id] === undefined ? null : (
                <p role="status" className="text-sm">
                  {tested[p.id]}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  busy={test.isPending && test.variables === p.id}
                  onClick={() => test.mutate(p.id)}
                >
                  {t('security.sso.test')}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => change.mutate({ id: p.id, enabled: !p.enabled })}
                >
                  {p.enabled ? t('security.sso.turnOff') : t('security.sso.turnOn')}
                </Button>
                <Button variant="secondary" onClick={() => remove.mutate(p.id)}>
                  {t('security.sso.remove')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <form
        className="grid gap-3 rounded-md border p-3"
        aria-label={t('security.sso.add')}
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <p className="text-sm font-medium">{t('security.sso.add')}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {field('name', 'Google')}
          {field('key', 'google')}
          {field('issuer', 'https://accounts.google.com')}
          {field('clientId', '')}
        </div>
        <div>
          <Button type="submit" variant="primary" busy={add.isPending}>
            {t('security.sso.addButton')}
          </Button>
        </div>
      </form>
    </div>
  );
}
