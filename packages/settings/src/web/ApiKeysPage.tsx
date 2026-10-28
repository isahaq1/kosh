/**
 * Settings › API keys (RFC 0017 §5.1): your keys — and the service accounts' for administrators —, a new key with its
 * scopes and expiry, its secret shown once, revocation. The server decides what each key may do; scopes only narrow
 * the user's own rights.
 */
import { Alert, ApiError, Button, Input, Label, type PageProps, Select, useKosh } from '@kosh/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactElement, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface Key {
  readonly id: number;
  readonly name: string;
  readonly userName: string;
  readonly prefix: string;
  readonly scopes: readonly string[];
  readonly expiresAt: string;
  readonly lastUsedAt: string | null;
  readonly revoked: boolean;
}

type Level = 'none' | 'read' | 'write';

export function ApiKeysPage({ api }: PageProps): ReactElement {
  const { t } = useTranslation('settings');
  const { format } = useKosh();
  const id = useId();
  const queryClient = useQueryClient();
  const keys = useQuery({
    queryKey: ['settings', 'api-keys'],
    queryFn: () => api.call<{ keys: Key[] }>('GET', '/api/v1/auth/api-keys'),
  });
  const scopes = useQuery({
    queryKey: ['settings', 'scopes'],
    queryFn: () => api.call<{ scopes: { scope: string }[] }>('GET', '/api/v1/auth/scopes'),
  });
  const apps = [
    ...new Set(
      (scopes.data?.scopes ?? [])
        .map((s) => s.scope)
        .filter((s) => s.startsWith('read:'))
        .map((s) => s.slice(5)),
    ),
  ];
  const [name, setName] = useState('');
  const [days, setDays] = useState<string | null>('365');
  const [everything, setEverything] = useState(false);
  const [levels, setLevels] = useState<Readonly<Record<string, Level>>>({});
  const [secret, setSecret] = useState<string | null>(null);
  const chosen = everything
    ? ['*']
    : Object.entries(levels).flatMap(([app, level]) =>
        level === 'none' ? [] : [`${level}:${app}`],
      );
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['settings', 'api-keys'] });
  const create = useMutation({
    mutationFn: () =>
      api.call<Key & { token: string }>('POST', '/api/v1/auth/api-keys', {
        name,
        scopes: chosen,
        expiresInDays: Number(days),
      }),
    onSuccess: async (key) => {
      setSecret(key.token);
      setName('');
      setLevels({});
      setEverything(false);
      await refresh();
    },
  });
  const revoke = useMutation({
    mutationFn: (key: number) => api.call('POST', `/api/v1/auth/api-keys/${key}/revoke`),
    onSuccess: refresh,
  });
  const error = create.error ?? revoke.error;
  const message = (e: unknown) => (e instanceof ApiError ? e.message : String(e));

  return (
    <div className="mx-auto grid max-w-4xl gap-6 p-4">
      <h1 className="text-xl font-semibold">{t('apiKeys.title')}</h1>
      <p className="text-sm text-muted-foreground">{t('apiKeys.intro')}</p>
      {error === null ? null : <Alert tone="danger">{message(error)}</Alert>}
      {secret === null ? null : (
        <Alert tone="info">
          <div className="grid gap-2">
            <p>{t('apiKeys.secretOnce')}</p>
            <code className="break-all rounded bg-muted px-2 py-1 font-mono text-sm">{secret}</code>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                onClick={() => void navigator.clipboard?.writeText(secret)}
              >
                {t('apiKeys.copy')}
              </Button>
              <Button variant="secondary" onClick={() => setSecret(null)}>
                {t('apiKeys.done')}
              </Button>
            </div>
          </div>
        </Alert>
      )}

      <section className="grid gap-3 rounded-lg border p-4" aria-labelledby={`${id}-new`}>
        <h2 id={`${id}-new`} className="font-medium">
          {t('apiKeys.new')}
        </h2>
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1">
            <Label htmlFor={`${id}-name`}>{t('apiKeys.name')}</Label>
            <Input
              id={`${id}-name`}
              className="w-64"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <Select
            id={`${id}-days`}
            label={t('apiKeys.expires')}
            className="w-40"
            value={days}
            options={['30', '90', '365', '730'].map((d) => ({
              value: d,
              label: t('apiKeys.days', { count: Number(d) }),
            }))}
            onChange={setDays}
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={everything}
            onChange={(e) => setEverything(e.target.checked)}
          />
          {t('apiKeys.everything')}
        </label>
        {everything ? null : (
          <fieldset className="grid gap-2 sm:grid-cols-2">
            <legend className="mb-1 text-sm text-muted-foreground">{t('apiKeys.perApp')}</legend>
            {apps.map((app) => (
              <Select
                key={app}
                id={`${id}-app-${app}`}
                label={app}
                value={levels[app] ?? 'none'}
                options={(['none', 'read', 'write'] as const).map((l) => ({
                  value: l,
                  label: t(`apiKeys.levels.${l}`),
                }))}
                onChange={(v) => setLevels({ ...levels, [app]: (v ?? 'none') as Level })}
              />
            ))}
          </fieldset>
        )}
        <div>
          <Button
            variant="primary"
            disabled={name.trim() === '' || chosen.length === 0}
            busy={create.isPending}
            onClick={() => create.mutate()}
          >
            {t('apiKeys.create')}
          </Button>
        </div>
      </section>

      {(keys.data?.keys ?? []).length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('apiKeys.none')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted">
              <tr>
                {(['name', 'user', 'key', 'scopes', 'expires', 'lastUsed', 'status'] as const).map(
                  (c) => (
                    <th key={c} className="px-2 py-1 text-start">
                      {t(`apiKeys.columns.${c}`)}
                    </th>
                  ),
                )}
                <th className="px-2 py-1">
                  <span className="sr-only">{t('apiKeys.revoke')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {(keys.data?.keys ?? []).map((k) => (
                <tr key={k.id} className="border-b">
                  <td className="px-2 py-1">{k.name}</td>
                  <td className="px-2 py-1">{k.userName}</td>
                  <td className="px-2 py-1 font-mono text-xs">{k.prefix}…</td>
                  <td className="px-2 py-1">{k.scopes.join(' ')}</td>
                  <td className="px-2 py-1">{format.datetime(k.expiresAt)}</td>
                  <td className="px-2 py-1">
                    {k.lastUsedAt === null ? '—' : format.datetime(k.lastUsedAt)}
                  </td>
                  <td className="px-2 py-1">
                    {k.revoked
                      ? t('apiKeys.revoked')
                      : new Date(k.expiresAt).getTime() < Date.now()
                        ? t('apiKeys.expired')
                        : t('apiKeys.active')}
                  </td>
                  <td className="px-2 py-1 text-end">
                    {k.revoked ? null : (
                      <Button
                        variant="secondary"
                        aria-label={t('apiKeys.revokeKey', { name: k.name })}
                        busy={revoke.isPending && revoke.variables === k.id}
                        onClick={() => revoke.mutate(k.id)}
                      >
                        {t('apiKeys.revoke')}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
