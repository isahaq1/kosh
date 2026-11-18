/**
 * Your profile › Passkeys (RFC 0034 §2.4): sign in with this device — a fingerprint, a face, a PIN, a security key —
 * instead of a password and a code. A passkey is made by the browser and checked by the server; here a person names
 * one, sees the ones they have and removes one they no longer use.
 */
import {
  Alert,
  ApiError,
  Badge,
  Button,
  createPasskey,
  Input,
  type KoshApi,
  Label,
  type PasskeyCreationOptions,
  passkeyCancelled,
  passkeysSupported,
} from '@kosh/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactElement, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface Passkey {
  readonly id: number;
  readonly name: string;
  readonly synced: boolean;
  readonly createdAt: string | null;
  readonly lastUsedAt: string | null;
}
const message = (error: unknown) => (error instanceof ApiError ? error.message : String(error));

export function Passkeys({ api }: { readonly api: KoshApi }): ReactElement {
  const { t, i18n } = useTranslation('settings');
  const client = useQueryClient();
  const id = useId();
  const [name, setName] = useState('');
  const list = useQuery({
    queryKey: ['auth', 'passkeys'],
    queryFn: () => api.call<{ passkeys: Passkey[] }>('GET', '/api/v1/auth/passkeys'),
  });
  const refresh = () => void client.invalidateQueries({ queryKey: ['auth', 'passkeys'] });
  const add = useMutation({
    mutationFn: async () => {
      const options = await api.call<PasskeyCreationOptions>(
        'POST',
        '/api/v1/auth/passkeys/register/options',
        {},
      );
      const credential = await createPasskey(options);
      return api.call<Passkey>('POST', '/api/v1/auth/passkeys/register', { name, credential });
    },
    onSuccess: () => {
      setName('');
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (passkey: number) =>
      api.call<unknown>('DELETE', `/api/v1/auth/passkeys/${passkey}`),
    onSuccess: refresh,
  });
  // Closing the browser's dialog is not an error to show.
  const failed = [list.error, add.error, remove.error].find(
    (e) => e !== null && !passkeyCancelled(e),
  );
  const date = (value: string | null) =>
    value === null ? null : new Date(value).toLocaleDateString(i18n.language);
  const supported = passkeysSupported();
  return (
    <div className="grid gap-4">
      {failed === undefined || failed === null ? null : (
        <Alert tone="danger">{message(failed)}</Alert>
      )}
      {(list.data?.passkeys ?? []).length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('profile.passkeys.none')}</p>
      ) : (
        <ul className="grid gap-2" aria-label={t('profile.passkeys.title')}>
          {(list.data?.passkeys ?? []).map((p) => (
            <li
              key={p.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm"
            >
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{p.name}</span>
                {p.synced ? <Badge tone="neutral">{t('profile.passkeys.synced')}</Badge> : null}
                <span className="text-muted-foreground">
                  {t('profile.passkeys.added', { when: date(p.createdAt) })}
                  {' · '}
                  {p.lastUsedAt === null
                    ? t('profile.passkeys.neverUsed')
                    : t('profile.passkeys.lastUsed', { when: date(p.lastUsedAt) })}
                </span>
              </span>
              <Button
                variant="secondary"
                busy={remove.isPending && remove.variables === p.id}
                onClick={() => remove.mutate(p.id)}
              >
                {t('profile.passkeys.remove')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {supported ? (
        <form
          className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end"
          aria-label={t('profile.passkeys.add')}
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-name`}>{t('profile.passkeys.name')}</Label>
            <Input
              id={`${id}-name`}
              required
              maxLength={60}
              value={name}
              placeholder={t('profile.passkeys.namePlaceholder')}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <Button type="submit" variant="secondary" busy={add.isPending}>
            {t('profile.passkeys.add')}
          </Button>
        </form>
      ) : (
        <p className="text-sm text-muted-foreground">{t('profile.passkeys.unsupported')}</p>
      )}
    </div>
  );
}
