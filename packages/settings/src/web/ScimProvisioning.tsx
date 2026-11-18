/**
 * Settings › Security › Directory provisioning (RFC 0034 §2.4): the company's directory — Entra ID, Okta, any SCIM
 * 2.0 client — adds people when they join and deactivates them when they leave. An Administrator makes the token
 * the directory uses (shown once), and says which roles each of the directory's groups gives. The server validates
 * and decides.
 */
import { Alert, ApiError, Button, Input, type KoshApi, Label } from '@kosh/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactElement, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface Token {
  readonly id: number;
  readonly name: string;
  readonly prefix: string;
  readonly company: { readonly id: number; readonly name: string };
  readonly lastUsedAt: string | null;
}
interface Group {
  readonly id: number;
  readonly name: string;
  readonly roles: readonly string[];
  readonly members: number;
}
interface Provisioning {
  readonly baseUrl: string;
  readonly people: number;
  readonly tokens: readonly Token[];
  readonly groups: readonly Group[];
}
const message = (error: unknown) => (error instanceof ApiError ? error.message : String(error));

/** One directory group: how many people it has, and the roles (their codes) it gives. */
function GroupRow({
  api,
  group,
  onSaved,
}: {
  readonly api: KoshApi;
  readonly group: Group;
  readonly onSaved: () => void;
}): ReactElement {
  const { t } = useTranslation('settings');
  const id = useId();
  const [roles, setRoles] = useState(group.roles.join(', '));
  const save = useMutation({
    mutationFn: () =>
      api.call<{ changed: number }>('PATCH', `/api/v1/settings/scim/groups/${group.id}`, {
        roles: roles
          .split(',')
          .map((x) => x.trim())
          .filter((x) => x !== ''),
      }),
    onSuccess: onSaved,
  });
  return (
    <li className="grid gap-2 rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{group.name}</span>
        <span className="text-muted-foreground">
          {t('security.scim.members', { count: group.members })}
        </span>
      </div>
      {save.error === null ? null : <Alert>{message(save.error)}</Alert>}
      {save.isSuccess ? (
        <p role="status">{t('security.scim.rolesSaved', { count: save.data.changed })}</p>
      ) : null}
      <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
        <div className="grid gap-1">
          <Label htmlFor={`${id}-roles`}>{t('security.scim.givenRoles')}</Label>
          <Input
            id={`${id}-roles`}
            value={roles}
            placeholder="sales.user, account.user"
            onChange={(e) => setRoles(e.target.value)}
          />
        </div>
        <div className="flex items-end">
          <Button variant="secondary" busy={save.isPending} onClick={() => save.mutate()}>
            {t('security.scim.saveRoles')}
          </Button>
        </div>
      </div>
    </li>
  );
}

export function ScimProvisioning({ api }: { readonly api: KoshApi }): ReactElement {
  const { t, i18n } = useTranslation('settings');
  const client = useQueryClient();
  const id = useId();
  const [name, setName] = useState('');
  const state = useQuery({
    queryKey: ['settings', 'scim'],
    queryFn: () => api.call<Provisioning>('GET', '/api/v1/settings/scim'),
  });
  const refresh = () => void client.invalidateQueries({ queryKey: ['settings', 'scim'] });
  const make = useMutation({
    mutationFn: () =>
      api.call<{ token: string; name: string }>('POST', '/api/v1/settings/scim/tokens', { name }),
    onSuccess: () => {
      setName('');
      refresh();
    },
  });
  const revoke = useMutation({
    mutationFn: (token: number) =>
      api.call<unknown>('DELETE', `/api/v1/settings/scim/tokens/${token}`),
    onSuccess: refresh,
  });
  const error = state.error ?? make.error ?? revoke.error;
  const when = (value: string | null) =>
    value === null
      ? t('security.scim.neverUsed')
      : t('security.scim.lastUsed', {
          when: new Date(value).toLocaleString(i18n.language),
        });
  return (
    <div className="grid gap-4">
      {error === null ? null : <Alert>{message(error)}</Alert>}
      <dl className="grid gap-1 text-sm text-muted-foreground">
        <div className="break-all">
          <dt className="inline">{t('security.scim.address')}: </dt>
          <dd className="inline">
            <code>{state.data?.baseUrl ?? '…'}</code>
          </dd>
        </div>
        <div>{t('security.scim.people', { count: state.data?.people ?? 0 })}</div>
      </dl>
      {make.data === undefined ? null : (
        <div role="status" className="grid gap-1 rounded-md border p-3 text-sm">
          <p className="font-medium">{t('security.scim.tokenMade', { name: make.data.name })}</p>
          <code className="break-all">{make.data.token}</code>
          <p className="text-muted-foreground">{t('security.scim.tokenOnce')}</p>
        </div>
      )}
      {(state.data?.tokens ?? []).length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('security.scim.none')}</p>
      ) : (
        <ul className="grid gap-2" aria-label={t('security.scim.tokens')}>
          {(state.data?.tokens ?? []).map((token) => (
            <li
              key={token.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm"
            >
              <span>
                <span className="font-medium">{token.name}</span>{' '}
                <span className="text-muted-foreground">
                  <code>{token.prefix}…</code> · {token.company.name} · {when(token.lastUsedAt)}
                </span>
              </span>
              <Button
                variant="secondary"
                busy={revoke.isPending && revoke.variables === token.id}
                onClick={() => revoke.mutate(token.id)}
              >
                {t('security.scim.revoke')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="grid gap-3 rounded-md border p-3"
        aria-label={t('security.scim.add')}
        onSubmit={(e) => {
          e.preventDefault();
          make.mutate();
        }}
      >
        <p className="text-sm font-medium">{t('security.scim.add')}</p>
        <div className="grid gap-1 sm:max-w-sm">
          <Label htmlFor={`${id}-name`}>{t('security.scim.tokenName')}</Label>
          <Input
            id={`${id}-name`}
            required
            value={name}
            placeholder="Entra ID"
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div>
          <Button type="submit" variant="primary" busy={make.isPending}>
            {t('security.scim.addButton')}
          </Button>
        </div>
      </form>
      <div className="grid gap-2">
        <p className="text-sm font-medium">{t('security.scim.groups')}</p>
        <p className="text-sm text-muted-foreground">{t('security.scim.groupsHint')}</p>
        {(state.data?.groups ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('security.scim.noGroups')}</p>
        ) : (
          <ul className="grid gap-2" aria-label={t('security.scim.groups')}>
            {(state.data?.groups ?? []).map((group) => (
              <GroupRow key={group.id} api={api} group={group} onSaved={refresh} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
