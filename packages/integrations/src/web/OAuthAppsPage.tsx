/**
 * Integrations › OAuth apps (RFC 0017 §5.2): the third-party apps that may ask users for access — their client id,
 * redirect addresses and the scopes they may ask for. A new app's client secret is shown once (public apps have none
 * and use PKCE); a new secret replaces the old at once; an app switched off stops every token it holds. The server
 * checks the addresses and scopes and audits every change.
 */
import {
  Alert,
  ApiError,
  Badge,
  Button,
  Checkbox,
  Dialog,
  Input,
  Label,
  type PageProps,
} from '@kosh/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, KeyRound, Plus } from 'lucide-react';
import { type ReactElement, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface OAuthApp {
  readonly id: number;
  readonly name: string;
  readonly clientId: string;
  readonly confidential: boolean;
  readonly redirectUris: readonly string[];
  readonly scopes: readonly string[];
  readonly homepage: string | null;
  readonly active: boolean;
}
interface Scope {
  readonly scope: string;
  readonly label: string;
}

const message = (error: unknown) => (error instanceof ApiError ? error.message : String(error));

/** A value to copy, with a button that says when it is copied. */
function Copyable({
  value,
  label,
}: {
  readonly value: string;
  readonly label: string;
}): ReactElement {
  const { t } = useTranslation('integrations');
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 select-all break-all rounded bg-muted px-2 py-1 font-mono text-xs">
        {value}
      </code>
      <Button
        size="icon"
        variant="ghost"
        aria-label={t('oauth.copy', { what: label })}
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => setCopied(true));
        }}
      >
        {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      </Button>
    </div>
  );
}

function NewAppDialog({
  api,
  open,
  onOpenChange,
}: PageProps & {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): ReactElement {
  const { t } = useTranslation('integrations');
  const id = useId();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [uris, setUris] = useState('');
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [confidential, setConfidential] = useState(true);
  const scopes = useQuery({
    queryKey: ['auth', 'scopes'],
    queryFn: () => api.call<{ scopes: Scope[] }>('GET', '/api/v1/auth/scopes'),
  });
  const create = useMutation({
    mutationFn: () =>
      api.call<OAuthApp & { clientSecret: string | null }>('POST', '/api/v1/oauth/apps', {
        name,
        confidential,
        redirectUris: uris
          .split(/\s+/)
          .map((u) => u.trim())
          .filter((u) => u !== ''),
        scopes: chosen,
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['oauth', 'apps'] }),
  });
  useEffect(() => {
    if (!open) {
      setName('');
      setUris('');
      setChosen([]);
      setConfidential(true);
      create.reset();
    }
  }, [open, create.reset]);
  const made = create.data;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('oauth.newTitle')}
      description={t('oauth.newHint')}
      wide
      footer={
        made === undefined ? (
          <>
            <Button onClick={() => onOpenChange(false)}>{t('oauth.cancel')}</Button>
            <Button
              variant="primary"
              busy={create.isPending}
              disabled={name.trim() === '' || uris.trim() === '' || chosen.length === 0}
              onClick={() => create.mutate()}
            >
              {t('oauth.create')}
            </Button>
          </>
        ) : (
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            {t('oauth.done')}
          </Button>
        )
      }
    >
      {made !== undefined ? (
        <div className="grid gap-3">
          <Alert tone="warning">
            {made.clientSecret === null ? t('oauth.publicMade') : t('oauth.secretOnce')}
          </Alert>
          <div className="grid gap-1">
            <span className="text-sm font-medium">{t('oauth.clientId')}</span>
            <Copyable value={made.clientId} label={t('oauth.clientId')} />
          </div>
          {made.clientSecret === null ? null : (
            <div className="grid gap-1" data-testid="oauth-secret">
              <span className="text-sm font-medium">{t('oauth.clientSecret')}</span>
              <Copyable value={made.clientSecret} label={t('oauth.clientSecret')} />
            </div>
          )}
        </div>
      ) : (
        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-name`}>{t('oauth.name')}</Label>
            <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-uris`}>{t('oauth.redirects')}</Label>
            <textarea
              id={`${id}-uris`}
              rows={2}
              className="rounded-md border bg-surface px-3 py-2 font-mono text-sm"
              placeholder="https://partner.example.com/oauth/callback"
              value={uris}
              onChange={(e) => setUris(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t('oauth.redirectsHint')}</p>
          </div>
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">{t('oauth.scopes')}</legend>
            <div className="grid max-h-48 gap-1.5 overflow-auto rounded-md border p-2 sm:grid-cols-2">
              {(scopes.data?.scopes ?? []).map((s) => (
                <div key={s.scope} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    id={`${id}-scope-${s.scope}`}
                    checked={chosen.includes(s.scope)}
                    onCheckedChange={(on) =>
                      setChosen((all) =>
                        on === true ? [...all, s.scope] : all.filter((x) => x !== s.scope),
                      )
                    }
                  />
                  <Label htmlFor={`${id}-scope-${s.scope}`} className="font-normal">
                    {s.label}
                  </Label>
                  <code className="ms-auto font-mono text-xs text-muted-foreground">{s.scope}</code>
                </div>
              ))}
            </div>
          </fieldset>
          <div className="flex items-start gap-2 text-sm">
            <Checkbox
              id={`${id}-public`}
              checked={!confidential}
              onCheckedChange={(on) => setConfidential(on !== true)}
            />
            <Label htmlFor={`${id}-public`} className="font-normal">
              {t('oauth.public')}
              <span className="block text-xs text-muted-foreground">{t('oauth.publicHint')}</span>
            </Label>
          </div>
          {create.error === null ? null : <Alert tone="danger">{message(create.error)}</Alert>}
        </div>
      )}
    </Dialog>
  );
}

export function OAuthAppsPage({ api }: PageProps): ReactElement {
  const { t } = useTranslation('integrations');
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<{ app: string; value: string } | null>(null);
  const apps = useQuery({
    queryKey: ['oauth', 'apps'],
    queryFn: () => api.call<{ apps: OAuthApp[] }>('GET', '/api/v1/oauth/apps'),
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['oauth', 'apps'] });
  const rotate = useMutation({
    mutationFn: (app: OAuthApp) =>
      api
        .call<{ clientSecret: string }>('POST', `/api/v1/oauth/apps/${app.id}/secret`)
        .then((r) => setSecret({ app: app.name, value: r.clientSecret })),
  });
  const toggle = useMutation({
    mutationFn: (app: OAuthApp) =>
      api.call('PATCH', `/api/v1/oauth/apps/${app.id}`, { active: !app.active }),
    onSuccess: refresh,
  });
  const error = apps.error ?? rotate.error ?? toggle.error;
  return (
    <div className="mx-auto grid max-w-4xl gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{t('oauth.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('oauth.intro')}</p>
        </div>
        <Button variant="primary" onClick={() => setCreating(true)}>
          <Plus className="size-4" aria-hidden />
          {t('oauth.new')}
        </Button>
      </header>
      {error === null ? null : <Alert tone="danger">{message(error)}</Alert>}
      {secret === null ? null : (
        <Alert tone="warning">
          <p className="mb-2">{t('oauth.newSecret', { app: secret.app })}</p>
          <Copyable value={secret.value} label={t('oauth.clientSecret')} />
        </Alert>
      )}
      {apps.data === undefined ? (
        <p className="text-sm text-muted-foreground">…</p>
      ) : apps.data.apps.length === 0 ? (
        <p className="rounded-lg border bg-surface p-6 text-center text-sm text-muted-foreground">
          {t('oauth.none')}
        </p>
      ) : (
        <ul className="grid gap-3">
          {apps.data.apps.map((a) => (
            <li key={a.id} className="grid gap-3 rounded-lg border bg-surface p-4">
              <div className="flex flex-wrap items-center gap-2">
                <KeyRound className="size-4 text-muted-foreground" aria-hidden />
                <span className="font-medium">{a.name}</span>
                <Badge tone={a.confidential ? 'neutral' : 'info'}>
                  {a.confidential ? t('oauth.confidential') : t('oauth.publicBadge')}
                </Badge>
                {a.active ? null : <Badge tone="warning">{t('oauth.inactive')}</Badge>}
                <span className="flex-1" />
                {a.confidential ? (
                  <Button
                    size="sm"
                    busy={rotate.isPending && rotate.variables?.id === a.id}
                    onClick={() => rotate.mutate(a)}
                  >
                    {t('oauth.rotate')}
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  busy={toggle.isPending && toggle.variables?.id === a.id}
                  onClick={() => toggle.mutate(a)}
                >
                  {a.active ? t('oauth.deactivate') : t('oauth.activate')}
                </Button>
              </div>
              <dl className="grid gap-2 text-sm sm:grid-cols-[10rem_1fr]">
                <dt className="text-muted-foreground">{t('oauth.clientId')}</dt>
                <dd>
                  <Copyable value={a.clientId} label={t('oauth.clientId')} />
                </dd>
                <dt className="text-muted-foreground">{t('oauth.redirects')}</dt>
                <dd className="break-all font-mono text-xs">{a.redirectUris.join('\n')}</dd>
                <dt className="text-muted-foreground">{t('oauth.scopes')}</dt>
                <dd className="flex flex-wrap gap-1">
                  {a.scopes.map((s) => (
                    <Badge key={s}>
                      <span className="font-mono text-xs">{s}</span>
                    </Badge>
                  ))}
                </dd>
              </dl>
            </li>
          ))}
        </ul>
      )}
      <NewAppDialog api={api} open={creating} onOpenChange={setCreating} />
    </div>
  );
}
