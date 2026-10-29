/**
 * Settings › People (RFC 0019 §3.2): who works here — searched and filtered by status —, invitations (the link
 * emailed when mail is set up, always shown to copy), a person's details and roles per app and company, a new
 * invitation, a two-factor reset, deactivation and reactivation, and their recent activity. The server decides
 * what a People manager may do (not administrators, not their own roles) and audits it all.
 */
import {
  Alert,
  ApiError,
  Avatar,
  Badge,
  Button,
  Dialog,
  EmptyState,
  Input,
  imageUrl,
  Label,
  type PageProps,
  useKosh,
} from '@kosh/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Search, ShieldCheck, UserPlus } from 'lucide-react';
import { type ReactElement, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type Assignment, type Catalogue, RolesEditor } from './RolesEditor.js';

interface Person {
  readonly id: number;
  readonly name: string;
  readonly avatar?: string | null;
  readonly login: string;
  readonly email: string | null;
  readonly active: boolean;
  readonly state: 'active' | 'invited' | 'deactivated';
  readonly invitationExpiresAt: string | null;
  readonly twoFactor: boolean;
  readonly lastSeenAt: string | null;
  readonly administrator: boolean;
  readonly assignments: readonly (Assignment & { readonly label: string })[];
}
interface Detail extends Person {
  readonly activity: readonly {
    readonly kind: string;
    readonly summary: string;
    readonly at: string | null;
  }[];
}
type Status = 'all' | 'active' | 'invited' | 'deactivated';
const P = '/api/v1/settings/people';
const message = (error: unknown) => (error instanceof ApiError ? error.message : String(error));

function StateBadge({ person }: { readonly person: Person }): ReactElement {
  const { t } = useTranslation('settings');
  return person.state === 'deactivated' ? (
    <Badge tone="neutral">{t('people.deactivated')}</Badge>
  ) : person.state === 'invited' ? (
    <Badge tone="warning">{t('people.invited')}</Badge>
  ) : (
    <Badge tone="success">{t('people.active')}</Badge>
  );
}

/** The link to pass on, with a copy button. */
function InvitationLink({
  url,
  emailed,
  to,
}: {
  readonly url: string;
  readonly emailed: boolean;
  readonly to: string;
}): ReactElement {
  const { t } = useTranslation('settings');
  const [copied, setCopied] = useState(false);
  return (
    <Alert tone="info">
      <p>{emailed ? t('people.emailed', { to }) : t('people.notEmailed')}</p>
      <div className="mt-2 flex items-center gap-2">
        <code
          className="min-w-0 flex-1 truncate rounded bg-surface px-2 py-1 font-mono text-xs"
          data-testid="invitation-link"
        >
          {url}
        </code>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            void navigator.clipboard?.writeText(url).then(() => setCopied(true));
          }}
        >
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          {copied ? t('people.copied') : t('people.copy')}
        </Button>
      </div>
    </Alert>
  );
}

/** Invite someone (they choose their password from a link), or add them directly with a password you pass on. */
function InviteDialog({
  api,
  catalogue,
  open,
  onOpenChange,
}: PageProps & {
  readonly catalogue: Catalogue;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): ReactElement {
  const { t } = useTranslation('settings');
  const id = useId();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'invite' | 'password'>('invite');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const invite = useMutation({
    mutationFn: () =>
      api.call<{ activationUrl: string | null; emailed: boolean; login: string }>(
        'POST',
        P,
        mode === 'invite'
          ? { name, email, assignments }
          : { name, email, login: login.trim() === '' ? email : login, password, assignments },
      ),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['settings', 'people'] }),
  });
  useEffect(() => {
    if (!open) {
      setMode('invite');
      setName('');
      setEmail('');
      setLogin('');
      setPassword('');
      setRepeat('');
      setAssignments([]);
      invite.reset();
    }
  }, [open, invite.reset]);
  const done = invite.data;
  const mismatch = repeat !== '' && repeat !== password;
  const ready =
    name.trim() !== '' &&
    (mode === 'invite'
      ? email.includes('@')
      : (login.trim() !== '' || email.includes('@')) &&
        password.length >= 12 &&
        repeat === password);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={mode === 'invite' ? t('people.inviteTitle') : t('people.addTitle')}
      description={mode === 'invite' ? t('people.inviteHint') : t('people.addHint')}
      wide
      footer={
        done === undefined ? (
          <>
            <Button onClick={() => onOpenChange(false)}>{t('profile.cancel')}</Button>
            <Button
              variant="primary"
              busy={invite.isPending}
              disabled={!ready}
              onClick={() => invite.mutate()}
            >
              {mode === 'invite' ? t('people.send') : t('people.add')}
            </Button>
          </>
        ) : (
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            {t('people.done')}
          </Button>
        )
      }
    >
      {done !== undefined ? (
        done.activationUrl === null ? (
          <Alert tone="info">{t('people.added', { login: done.login })}</Alert>
        ) : (
          <InvitationLink url={done.activationUrl} emailed={done.emailed} to={done.login} />
        )
      ) : (
        <div className="grid gap-4">
          <fieldset className="grid gap-2 sm:grid-cols-2">
            <legend className="sr-only">{t('people.how')}</legend>
            {(['invite', 'password'] as const).map((m) => (
              <label
                key={m}
                className={`flex cursor-pointer items-start gap-2 rounded-lg border p-3 text-sm ${
                  mode === m ? 'border-primary bg-accent/40' : ''
                }`}
              >
                <input
                  type="radio"
                  name={`${id}-mode`}
                  className="mt-1"
                  checked={mode === m}
                  onChange={() => setMode(m)}
                />
                <span>
                  <span className="font-medium">{t(`people.mode.${m}`)}</span>
                  <span className="block text-muted-foreground">{t(`people.mode.${m}Hint`)}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-name`}>{t('profile.name')}</Label>
              <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-email`}>
                {mode === 'invite' ? t('profile.email') : t('people.emailOptional')}
              </Label>
              <Input
                id={`${id}-email`}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            {mode === 'password' ? (
              <>
                <div className="grid gap-1.5">
                  <Label htmlFor={`${id}-login`}>{t('people.login')}</Label>
                  <Input
                    id={`${id}-login`}
                    autoComplete="off"
                    placeholder={email === '' ? 'rahim' : email}
                    value={login}
                    onChange={(e) => setLogin(e.target.value)}
                  />
                </div>
                <div />
                <div className="grid gap-1.5">
                  <Label htmlFor={`${id}-password`}>{t('people.password')}</Label>
                  <Input
                    id={`${id}-password`}
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">{t('people.passwordHint')}</p>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor={`${id}-repeat`}>{t('people.repeat')}</Label>
                  <Input
                    id={`${id}-repeat`}
                    type="password"
                    autoComplete="new-password"
                    aria-invalid={mismatch ? true : undefined}
                    value={repeat}
                    onChange={(e) => setRepeat(e.target.value)}
                  />
                  {mismatch ? <p className="text-xs text-danger">{t('people.mismatch')}</p> : null}
                </div>
              </>
            ) : null}
          </div>
          <div className="grid gap-2">
            <h3 className="text-sm font-semibold">{t('people.roles')}</h3>
            <RolesEditor catalogue={catalogue} value={assignments} onChange={setAssignments} />
          </div>
          {invite.error === null ? null : <Alert tone="danger">{message(invite.error)}</Alert>}
        </div>
      )}
    </Dialog>
  );
}

/** What a person can do, computed by the server as them (administrators only). */
function Effective({ api, personId }: PageProps & { readonly personId: number }): ReactElement {
  const { t } = useTranslation('settings');
  const [open, setOpen] = useState(false);
  const effective = useQuery({
    queryKey: ['settings', 'people', personId, 'effective'],
    queryFn: () =>
      api.call<{
        administrator: boolean;
        models: Record<string, { label: string; perms: string[]; hiddenFields: string[] }>;
        permissions: string[];
        permissionLabels: Record<string, string>;
      }>('GET', `/api/v1/admin/users/${personId}/effective`),
    enabled: open,
  });
  const models = Object.entries(effective.data?.models ?? {})
    .filter(([, m]) => m.perms.includes('read'))
    .sort((a, b) => a[1].label.localeCompare(b[1].label));
  return (
    <details
      className="rounded-md border"
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer px-3 py-2 text-sm font-semibold">
        {t('people.canDo')}
      </summary>
      <div className="grid gap-3 border-t p-3 text-sm">
        {effective.data === undefined ? (
          <p className="text-muted-foreground">…</p>
        ) : effective.data.administrator ? (
          <p>{t('people.canDoAll')}</p>
        ) : (
          <>
            {models.length === 0 ? (
              <p className="text-muted-foreground">{t('people.canDoNothing')}</p>
            ) : (
              <ul className="grid gap-1">
                {models.map(([name, m]) => (
                  <li key={name} className="flex flex-wrap gap-x-2">
                    <span className="font-medium">{m.label}</span>
                    <span className="text-muted-foreground">
                      {m.perms.map((p) => t(`roles.perm.${p}`)).join(', ')}
                    </span>
                    {m.hiddenFields.length === 0 ? null : (
                      <span className="text-xs text-muted-foreground">
                        {t('people.hiddenFields', { count: m.hiddenFields.length })}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {effective.data.permissions.length === 0 ? null : (
              <p>
                <span className="font-medium">{t('roles.permissions')}: </span>
                {effective.data.permissions
                  .map((p) => effective.data?.permissionLabels[p] ?? p)
                  .join(', ')}
              </p>
            )}
          </>
        )}
      </div>
    </details>
  );
}

function PersonDialog({
  api,
  catalogue,
  personId,
  onClose,
}: PageProps & {
  readonly catalogue: Catalogue;
  readonly personId: number;
  readonly onClose: () => void;
}): ReactElement {
  const { t } = useTranslation('settings');
  const { format, uid } = useKosh();
  const id = useId();
  const queryClient = useQueryClient();
  const person = useQuery({
    queryKey: ['settings', 'people', personId],
    queryFn: () => api.call<Detail>('GET', `${P}/${personId}`),
  });
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [link, setLink] = useState<{ url: string; emailed: boolean } | null>(null);
  const [confirm, setConfirm] = useState<'deactivate' | 'reset' | null>(null);
  useEffect(() => {
    if (person.data === undefined) return;
    setName(person.data.name);
    setEmail(person.data.email ?? '');
    setAssignments(person.data.assignments.map(({ group, company }) => ({ group, company })));
  }, [person.data]);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['settings', 'people'] });
  const saveDetails = useMutation({
    mutationFn: () => api.call('PATCH', `${P}/${personId}`, { name, email }),
    onSuccess: refresh,
  });
  const saveRoles = useMutation({
    mutationFn: () => api.call('PUT', `${P}/${personId}/roles`, { assignments }),
    onSuccess: refresh,
  });
  const setActive = useMutation({
    mutationFn: (active: boolean) => api.call('PATCH', `${P}/${personId}`, { active }),
    onSuccess: () => {
      setConfirm(null);
      refresh();
    },
  });
  const resend = useMutation({
    mutationFn: () =>
      api.call<{ activationUrl: string; emailed: boolean }>('POST', `${P}/${personId}/invitation`),
    onSuccess: (data) => {
      setLink({ url: data.activationUrl, emailed: data.emailed });
      refresh();
    },
  });
  const reset = useMutation({
    mutationFn: () => api.call('POST', `${P}/${personId}/reset-2fa`),
    onSuccess: () => {
      setConfirm(null);
      refresh();
    },
  });
  const p = person.data;
  const error =
    saveDetails.error ?? saveRoles.error ?? setActive.error ?? resend.error ?? reset.error;
  const self = personId === uid;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} title={p?.name ?? '…'} wide>
      {p === undefined ? null : (
        <div className="grid gap-5">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Avatar name={p.name} src={imageUrl('user', p.id, p.avatar)} className="size-8" />
            <span className="text-muted-foreground">{p.login}</span>
            <StateBadge person={p} />
            {p.administrator ? <Badge tone="info">{t('people.administrator')}</Badge> : null}
            {p.twoFactor ? (
              <Badge tone="success">
                <ShieldCheck className="size-3" aria-hidden />
                {t('people.twoFactor')}
              </Badge>
            ) : null}
          </div>

          <section className="grid gap-3">
            <h3 className="text-sm font-semibold">{t('people.details')}</h3>
            <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
              <div className="grid gap-1.5">
                <Label htmlFor={`${id}-name`}>{t('profile.name')}</Label>
                <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={`${id}-email`}>{t('profile.email')}</Label>
                <Input
                  id={`${id}-email`}
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <Button
                variant="secondary"
                busy={saveDetails.isPending}
                onClick={() => saveDetails.mutate()}
              >
                {t('profile.save')}
              </Button>
            </div>
          </section>

          <section className="grid gap-3">
            <h3 className="text-sm font-semibold">{t('people.roles')}</h3>
            {self && !catalogue.manager.administrator ? (
              <p className="text-sm text-muted-foreground">{t('people.notYourOwn')}</p>
            ) : (
              <>
                <RolesEditor catalogue={catalogue} value={assignments} onChange={setAssignments} />
                <div>
                  <Button
                    variant="primary"
                    busy={saveRoles.isPending}
                    onClick={() => saveRoles.mutate()}
                  >
                    {t('people.saveRoles')}
                  </Button>
                </div>
              </>
            )}
          </section>

          <section className="grid gap-3">
            <h3 className="text-sm font-semibold">{t('people.access')}</h3>
            <div className="flex flex-wrap gap-2">
              {p.state === 'invited' || p.state === 'active' ? (
                <Button variant="secondary" busy={resend.isPending} onClick={() => resend.mutate()}>
                  {p.state === 'invited' ? t('people.resend') : t('people.newLink')}
                </Button>
              ) : null}
              {p.twoFactor ? (
                <Button variant="secondary" onClick={() => setConfirm('reset')}>
                  {t('people.reset2fa')}
                </Button>
              ) : null}
              {self ? null : p.active ? (
                <Button variant="danger" onClick={() => setConfirm('deactivate')}>
                  {t('people.deactivate')}
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  busy={setActive.isPending}
                  onClick={() => setActive.mutate(true)}
                >
                  {t('people.reactivate')}
                </Button>
              )}
            </div>
            {link === null ? null : (
              <InvitationLink url={link.url} emailed={link.emailed} to={p.login} />
            )}
            {confirm === null ? null : (
              <Alert
                tone="warning"
                action={
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => setConfirm(null)}>
                      {t('profile.cancel')}
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      busy={setActive.isPending || reset.isPending}
                      onClick={() =>
                        confirm === 'reset' ? reset.mutate() : setActive.mutate(false)
                      }
                    >
                      {confirm === 'reset' ? t('people.reset2fa') : t('people.deactivate')}
                    </Button>
                  </div>
                }
              >
                {confirm === 'reset' ? t('people.resetConfirm') : t('people.deactivateConfirm')}
              </Alert>
            )}
          </section>

          {error === null ? null : <Alert tone="danger">{message(error)}</Alert>}

          {catalogue.manager.administrator ? <Effective api={api} personId={personId} /> : null}

          <section className="grid gap-2">
            <h3 className="text-sm font-semibold">{t('people.activity')}</h3>
            {p.activity.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('people.noActivity')}</p>
            ) : (
              <ol className="grid gap-1.5 text-sm">
                {p.activity.map((a, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: audit events in their order
                  <li key={i} className="flex gap-3">
                    <span className="w-40 shrink-0 text-xs text-muted-foreground">
                      {a.at === null ? '' : format.datetime(a.at)}
                    </span>
                    <span>{a.summary}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      )}
    </Dialog>
  );
}

export function PeoplePage({ api }: PageProps): ReactElement {
  const { t } = useTranslation('settings');
  const { format } = useKosh();
  const id = useId();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<Status>('all');
  const [inviting, setInviting] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const catalogue = useQuery({
    queryKey: ['settings', 'people', 'catalogue'],
    queryFn: () => api.call<Catalogue>('GET', `${P}/catalogue`),
  });
  const people = useQuery({
    queryKey: ['settings', 'people', 'list', q, status],
    queryFn: () =>
      api.call<{ people: Person[] }>(
        'GET',
        `${P}?status=${status}&q=${encodeURIComponent(q.trim())}`,
      ),
  });
  if (catalogue.error !== null) return <Alert tone="danger">{message(catalogue.error)}</Alert>;
  const list = people.data?.people ?? [];
  const statuses: Status[] = ['all', 'active', 'invited', 'deactivated'];
  return (
    <div className="mx-auto grid max-w-5xl gap-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{t('people.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('people.intro')}</p>
        </div>
        <Button
          variant="primary"
          onClick={() => setInviting(true)}
          disabled={catalogue.data === undefined}
        >
          <UserPlus aria-hidden />
          {t('people.invite')}
        </Button>
      </header>
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-60 flex-1">
          <Search
            className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <label htmlFor={`${id}-q`} className="sr-only">
            {t('people.search')}
          </label>
          <Input
            id={`${id}-q`}
            type="search"
            className="ps-9"
            placeholder={t('people.search')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <fieldset className="flex rounded-md border p-0.5">
          <legend className="sr-only">{t('people.status')}</legend>
          {statuses.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={status === s}
              onClick={() => setStatus(s)}
              className="rounded px-3 py-1 text-sm aria-pressed:bg-accent aria-pressed:font-medium aria-pressed:text-accent-foreground"
            >
              {t(`people.filter.${s}`)}
            </button>
          ))}
        </fieldset>
      </div>
      {people.isSuccess && list.length === 0 ? (
        <EmptyState title={t('people.empty')} />
      ) : (
        <ul className="divide-y rounded-lg border bg-surface" aria-label={t('people.title')}>
          {list.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => setOpen(p.id)}
                className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-start hover:bg-muted/50"
              >
                <Avatar name={p.name} src={imageUrl('user', p.id, p.avatar)} className="size-8" />
                <span className="grid min-w-48 flex-1">
                  <span className="font-medium">{p.name}</span>
                  <span className="text-sm text-muted-foreground">{p.login}</span>
                </span>
                <span className="flex min-w-48 flex-1 flex-wrap gap-1">
                  {p.administrator ? <Badge tone="info">{t('people.administrator')}</Badge> : null}
                  {p.assignments
                    .filter((a) => !a.group.startsWith('base.'))
                    .slice(0, 3)
                    .map((a) => (
                      <Badge key={`${a.group}-${a.company}`} tone="neutral">
                        {a.label}
                      </Badge>
                    ))}
                  {p.assignments.length > 3 ? (
                    <span className="text-xs text-muted-foreground">
                      +{p.assignments.length - 3}
                    </span>
                  ) : null}
                </span>
                <span className="flex items-center gap-2">
                  {p.twoFactor ? (
                    <ShieldCheck
                      className="size-4 text-success"
                      aria-label={t('people.twoFactor')}
                    />
                  ) : null}
                  <StateBadge person={p} />
                </span>
                <span className="w-40 text-end text-xs text-muted-foreground">
                  {p.state === 'invited' && p.invitationExpiresAt !== null
                    ? t('people.expires', { when: format.date(p.invitationExpiresAt) })
                    : p.lastSeenAt === null
                      ? t('people.never')
                      : t('profile.lastActive', { when: format.datetime(p.lastSeenAt) })}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {catalogue.data === undefined ? null : (
        <InviteDialog
          api={api}
          catalogue={catalogue.data}
          open={inviting}
          onOpenChange={setInviting}
        />
      )}
      {open === null || catalogue.data === undefined ? null : (
        <PersonDialog
          api={api}
          catalogue={catalogue.data}
          personId={open}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}
