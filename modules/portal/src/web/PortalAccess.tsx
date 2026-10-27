/**
 * "Portal access" on a contact's form (RFC 0015 §5.2), for portal access managers: grant access (the invitation is
 * emailed when the server can, and its link shown to share), send it again, revoke. Hidden from anyone else (the
 * server answers 403 and the panel stays away).
 */
import { Alert, Button, Input, type NodeComponentProps, useKosh } from '@kosh/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Copy, KeyRound, Send, UserX } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface PortalUser {
  readonly id: number;
  readonly login: string;
  readonly active: boolean;
  readonly activated: boolean;
  readonly invitationExpiresAt: string | null;
}
interface Invitation {
  readonly activationUrl: string;
  readonly emailed: boolean;
}

export function PortalAccess({ record, api }: NodeComponentProps): ReactElement | null {
  const { t } = useTranslation('portal');
  const { format } = useKosh();
  const partner = typeof record?.['id'] === 'number' ? record['id'] : null;
  const [link, setLink] = useState<Invitation | null>(null);
  const [copied, setCopied] = useState(false);
  const access = useQuery({
    queryKey: ['portal', 'access', partner],
    queryFn: () =>
      api.call<{ users: PortalUser[] }>('GET', `/api/v1/portal/access?partner=${partner}`),
    enabled: partner !== null,
    retry: false,
  });
  const done = (invitation?: Invitation) => {
    if (invitation !== undefined) setLink(invitation);
    setCopied(false);
    void access.refetch();
  };
  const grant = useMutation({
    mutationFn: () => api.call<Invitation>('POST', '/api/v1/portal/access', { partner }),
    onSuccess: (invitation) => done(invitation),
  });
  const resend = useMutation({
    mutationFn: (user: number) =>
      api.call<Invitation>('POST', `/api/v1/portal/access/${user}/invitation`, {}),
    onSuccess: (invitation) => done(invitation),
  });
  const revoke = useMutation({
    mutationFn: (user: number) => api.call('DELETE', `/api/v1/portal/access/${user}`),
    onSuccess: () => {
      setLink(null);
      done();
    },
  });
  if (partner === null || access.data === undefined) return null;
  const users = access.data.users;
  const current = users.find((u) => u.active);
  const former = users[0];
  const error = grant.error ?? resend.error ?? revoke.error;
  let status: string;
  if (current === undefined)
    status = former === undefined ? t('none') : t('revoked', { login: former.login });
  else if (current.activated) status = t('active', { login: current.login });
  else if (current.invitationExpiresAt === null) status = t('expired', { login: current.login });
  else
    status = t('pending', {
      login: current.login,
      until: format.datetime(current.invitationExpiresAt),
    });
  return (
    <section className="grid gap-2 rounded-md border p-3" aria-labelledby="portal-access-title">
      <h3 id="portal-access-title" className="text-sm font-semibold">
        {t('title')}
      </h3>
      <p className="text-sm text-muted-foreground">{status}</p>
      <div className="flex flex-wrap gap-2">
        {current === undefined ? (
          <Button
            size="sm"
            variant="secondary"
            busy={grant.isPending}
            onClick={() => grant.mutate()}
          >
            <KeyRound aria-hidden />
            {t('grant')}
          </Button>
        ) : (
          <>
            <Button size="sm" busy={resend.isPending} onClick={() => resend.mutate(current.id)}>
              <Send aria-hidden />
              {t('resend')}
            </Button>
            <Button
              size="sm"
              variant="danger"
              busy={revoke.isPending}
              onClick={() => revoke.mutate(current.id)}
            >
              <UserX aria-hidden />
              {t('revoke')}
            </Button>
          </>
        )}
      </div>
      {link === null ? null : (
        <div className="grid gap-1">
          <p className="text-sm">{link.emailed ? t('emailed') : t('share')}</p>
          <div className="flex gap-2">
            <Input readOnly value={link.activationUrl} aria-label={t('copy')} />
            <Button
              size="sm"
              variant="ghost"
              aria-label={t('copy')}
              onClick={() => {
                void navigator.clipboard?.writeText(link.activationUrl).then(() => setCopied(true));
              }}
            >
              <Copy aria-hidden />
            </Button>
          </div>
          {copied ? (
            <p role="status" className="text-xs text-muted-foreground">
              {t('copied')}
            </p>
          ) : null}
        </div>
      )}
      {error === null ? null : <Alert>{error.message}</Alert>}
    </section>
  );
}
