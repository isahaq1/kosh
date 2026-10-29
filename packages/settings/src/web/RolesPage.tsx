/**
 * Settings › Roles & permissions (RFC 0019 §3.3): every role with what it opens and who holds it; a role's page —
 * simple first (per app, one access level), *Advanced* below (rights per model with code rights locked, feature
 * permissions, record rules, field security) — saved only after a preview of who gains and who loses what. New
 * roles from scratch or copied. Administrators only: the server refuses everyone else.
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
  Select,
  Textarea,
} from '@kosh/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, Plus, Search, Trash2 } from 'lucide-react';
import { type ReactElement, useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

const PERMS = ['read', 'create', 'write', 'unlink', 'export', 'import'] as const;
const RULE_PERMS = ['read', 'write', 'create', 'unlink'] as const;
const A = '/api/v1/admin';
const message = (error: unknown) => (error instanceof ApiError ? error.message : String(error));

interface RoleRow {
  readonly code: string;
  readonly label: string;
  readonly implies: readonly string[];
  readonly administrator: boolean;
  readonly builtIn: boolean;
  readonly accessLevels: readonly string[];
  readonly holders: number;
}
interface Level {
  readonly code: string;
  readonly module: string;
  readonly label: string;
  readonly groups: readonly string[];
}
interface ModelRow {
  readonly name: string;
  readonly label: string;
  readonly app: string | null;
  readonly locked: readonly string[];
  readonly own: readonly string[];
}
interface RoleDetail extends Omit<RoleRow, 'holders'> {
  readonly holders: readonly {
    readonly id: number;
    readonly name: string;
    readonly login: string;
  }[];
  readonly models: readonly ModelRow[];
  readonly permissions: readonly {
    readonly code: string;
    readonly label: string;
    readonly locked: boolean;
    readonly own: boolean;
  }[];
  readonly rules: readonly {
    readonly name: string;
    readonly model: string;
    readonly perms: readonly string[];
    readonly domain: Readonly<Record<string, unknown>>;
  }[];
  readonly fields: readonly {
    readonly model: string;
    readonly field: string;
    readonly read: readonly string[];
    readonly write: readonly string[];
  }[];
}
interface Preview {
  readonly holders: number;
  readonly people: readonly {
    readonly id: number;
    readonly name: string;
    readonly gains: readonly string[];
    readonly losses: readonly string[];
  }[];
  readonly models: readonly {
    readonly model: string;
    readonly label: string;
    readonly added: readonly string[];
    readonly removed: readonly string[];
  }[];
}
interface Apps {
  readonly apps: readonly {
    readonly module: string;
    readonly label: string;
    readonly app: boolean;
  }[];
}

/** Per app module: its levels, in declared order (lowest first). */
function useLevels(api: PageProps['api']) {
  const levels = useQuery({
    queryKey: ['admin', 'access-levels'],
    queryFn: () => api.call<{ accessLevels: Level[] }>('GET', `${A}/access-levels`),
  });
  const apps = useQuery({
    queryKey: ['settings', 'people', 'catalogue'],
    queryFn: () => api.call<Apps>('GET', '/api/v1/settings/people/catalogue'),
  });
  return useMemo(() => {
    const byModule = new Map<string, { label: string; app: boolean; levels: Level[] }>();
    for (const l of levels.data?.accessLevels ?? []) {
      const a = apps.data?.apps.find((x) => x.module === l.module);
      const entry = byModule.get(l.module) ?? {
        label: a?.label ?? l.module,
        app: a?.app ?? false,
        levels: [],
      };
      entry.levels.push(l);
      byModule.set(l.module, entry);
    }
    /** Whether a level belongs to an app (the list shows those; technical levels are in every role). */
    const isApp = (code: string) => {
      const l = levels.data?.accessLevels.find((x) => x.code === code);
      return l !== undefined && byModule.get(l.module)?.app === true;
    };
    const label = (code: string) => {
      const l = levels.data?.accessLevels.find((x) => x.code === code);
      return l === undefined ? code : `${byModule.get(l.module)?.label ?? l.module} · ${l.label}`;
    };
    return { byModule, label, isApp, ready: levels.data !== undefined };
  }, [levels.data, apps.data]);
}

function PreviewPanel({ preview }: { readonly preview: Preview }): ReactElement {
  const { t } = useTranslation('settings');
  const nothing = preview.people.length === 0 && preview.models.length === 0;
  return (
    <section
      aria-label={t('roles.preview')}
      className="grid gap-3 rounded-md border bg-muted/40 p-4 text-sm"
    >
      <h3 className="font-semibold">{t('roles.preview')}</h3>
      {nothing ? <p>{t('roles.noEffect')}</p> : null}
      {preview.people.length === 0 ? null : (
        <ul className="grid gap-1.5">
          {preview.people.map((p) => (
            <li key={p.id}>
              <span className="font-medium">{p.name}</span>
              {p.gains.length === 0 ? null : (
                <span className="text-success">
                  {' '}
                  {t('roles.gains', { what: p.gains.join(', ') })}
                </span>
              )}
              {p.losses.length === 0 ? null : (
                <span className="text-danger">
                  {' '}
                  {t('roles.loses', { what: p.losses.join(', ') })}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {preview.models.length === 0 ? null : (
        <ul className="grid gap-1 text-muted-foreground">
          {preview.models.map((m) => (
            <li key={m.model}>
              {m.label}: {m.added.map((p) => `+${t(`roles.perm.${p}`)}`).join(' ')}{' '}
              {m.removed.map((p) => `−${t(`roles.perm.${p}`)}`).join(' ')}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">
        {preview.holders === 0
          ? t('roles.nobodyYet')
          : t('roles.holders', { count: preview.holders })}
      </p>
    </section>
  );
}

function RoleDialog({
  api,
  code,
  onClose,
}: PageProps & { readonly code: string; readonly onClose: () => void }): ReactElement {
  const { t } = useTranslation('settings');
  const id = useId();
  const queryClient = useQueryClient();
  const levels = useLevels(api);
  const role = useQuery({
    queryKey: ['admin', 'role', code],
    queryFn: () => api.call<RoleDetail>('GET', `${A}/roles/${encodeURIComponent(code)}`),
  });
  const [label, setLabel] = useState('');
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [own, setOwn] = useState<Record<string, string[]>>({});
  const [granted, setGranted] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const r = role.data;
  useEffect(() => {
    if (r === undefined) return;
    setLabel(r.label);
    // The highest level per app the role gives.
    const next: Record<string, string> = {};
    for (const [module, entry] of levels.byModule)
      next[module] =
        [...entry.levels].reverse().find((l) => r.accessLevels.includes(l.code))?.code ?? 'none';
    setChosen(next);
    setOwn(Object.fromEntries(r.models.map((m) => [m.name, [...m.own]])));
    setGranted(new Set(r.permissions.filter((p) => p.own).map((p) => p.code)));
    setPreview(null);
  }, [r, levels.byModule]);
  const proposal = () => {
    if (r === undefined) return {};
    const changed = Object.fromEntries(
      r.models
        .filter((m) => [...(own[m.name] ?? [])].sort().join() !== [...m.own].sort().join())
        .map((m) => [m.name, own[m.name] ?? []]),
    );
    const allOwn = Object.fromEntries(
      r.models
        .filter((m) => (own[m.name] ?? []).length > 0)
        .map((m) => [m.name, own[m.name] ?? []]),
    );
    const accessLevels = Object.values(chosen).filter((c) => c !== 'none');
    const levelGroups = new Set(
      [...levels.byModule.values()].flatMap((e) => e.levels.flatMap((l) => l.groups)),
    );
    return {
      changed,
      body: {
        ...(r.builtIn
          ? {}
          : { accessLevels, implies: r.implies.filter((g) => !levelGroups.has(g)) }),
        access: allOwn,
        permissions: [...granted],
      },
    };
  };
  const preview$ = useMutation({
    mutationFn: () =>
      api.call<Preview>('POST', `${A}/roles/${encodeURIComponent(code)}/preview`, proposal().body),
    onSuccess: setPreview,
  });
  const save = useMutation({
    mutationFn: async () => {
      if (r === undefined) return;
      const { changed, body } = proposal();
      if (!r.builtIn)
        await api.call('PUT', `${A}/roles/${encodeURIComponent(code)}`, {
          label,
          accessLevels: (body as { accessLevels: string[] }).accessLevels,
          implies: (body as { implies: string[] }).implies,
        });
      for (const [model, perms] of Object.entries(changed ?? {}))
        await api.call(
          'PUT',
          `${A}/roles/${encodeURIComponent(code)}/access/${encodeURIComponent(model)}`,
          {
            perms,
          },
        );
      const before = new Set(r.permissions.filter((p) => p.own).map((p) => p.code));
      for (const p of granted)
        if (!before.has(p))
          await api.call(
            'PUT',
            `${A}/roles/${encodeURIComponent(code)}/permissions/${encodeURIComponent(p)}`,
          );
      for (const p of before)
        if (!granted.has(p))
          await api.call(
            'DELETE',
            `${A}/roles/${encodeURIComponent(code)}/permissions/${encodeURIComponent(p)}`,
          );
    },
    onSuccess: () => {
      setPreview(null);
      void queryClient.invalidateQueries({ queryKey: ['admin'] });
    },
  });
  const remove = useMutation({
    mutationFn: () => api.call('DELETE', `${A}/roles/${encodeURIComponent(code)}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin'] });
      onClose();
    },
  });
  // A new record rule and a field restriction.
  const [ruleModel, setRuleModel] = useState('');
  const [rulePerms, setRulePerms] = useState<Set<string>>(new Set(['read']));
  const [ruleDomain, setRuleDomain] = useState('{ "createdBy": { "$env": "uid" } }');
  const addRule = useMutation({
    mutationFn: () => {
      const domain = JSON.parse(ruleDomain) as unknown;
      const name = `${code.replace('.', '_')}_${ruleModel.replace(/\./g, '_')}_${Date.now().toString(36)}`;
      return api.call('PUT', `${A}/roles/${encodeURIComponent(code)}/rules/${name}`, {
        model: ruleModel,
        perms: [...rulePerms],
        domain,
      });
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['admin', 'role', code] }),
  });
  const deleteRule = useMutation({
    mutationFn: (name: string) => api.call('DELETE', `${A}/rules/${encodeURIComponent(name)}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['admin', 'role', code] }),
  });
  const error = preview$.error ?? save.error ?? remove.error ?? addRule.error ?? deleteRule.error;
  const groupedModels = useMemo(() => {
    const out = new Map<string, ModelRow[]>();
    for (const m of r?.models ?? []) {
      const key = m.app ?? t('roles.technical');
      out.set(key, [...(out.get(key) ?? []), m]);
    }
    return [...out];
  }, [r, t]);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} title={r?.label ?? code} wide>
      {r === undefined ? null : (
        <div className="grid gap-5">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{r.code}</code>
            {r.builtIn ? (
              <Badge tone="neutral">{t('roles.builtIn')}</Badge>
            ) : (
              <Badge tone="info">{t('roles.custom')}</Badge>
            )}
            {r.administrator ? <Badge tone="warning">{t('people.administrator')}</Badge> : null}
            <span className="text-muted-foreground">
              {r.holders.length === 0
                ? t('roles.nobody')
                : t('roles.heldBy', { names: r.holders.map((h) => h.name).join(', ') })}
            </span>
          </div>
          {r.builtIn ? (
            <p className="text-sm text-muted-foreground">{t('roles.builtInHint')}</p>
          ) : (
            <div className="grid gap-1.5 sm:max-w-sm">
              <Label htmlFor={`${id}-label`}>{t('roles.name')}</Label>
              <Input id={`${id}-label`} value={label} onChange={(e) => setLabel(e.target.value)} />
            </div>
          )}

          <section className="grid gap-2">
            <h3 className="text-sm font-semibold">{t('roles.apps')}</h3>
            <ul className="divide-y rounded-md border">
              {[...levels.byModule]
                .filter(([, e]) => e.app)
                .map(([module, entry]) => (
                  <li
                    key={module}
                    className="flex flex-wrap items-center justify-between gap-3 px-3 py-2"
                  >
                    <Label htmlFor={`${id}-${module}`} className="font-medium">
                      {entry.label}
                    </Label>
                    {r.builtIn ? (
                      <span className="text-sm text-muted-foreground">
                        {entry.levels.find((l) => l.code === chosen[module])?.label ??
                          t('people.noAccess')}
                      </span>
                    ) : (
                      <Select
                        id={`${id}-${module}`}
                        label={entry.label}
                        className="w-48"
                        value={chosen[module] ?? 'none'}
                        options={[
                          { value: 'none', label: t('people.noAccess') },
                          ...entry.levels.map((l) => ({ value: l.code, label: l.label })),
                        ]}
                        onChange={(v) => {
                          setChosen({ ...chosen, [module]: v });
                          setPreview(null);
                        }}
                      />
                    )}
                  </li>
                ))}
            </ul>
          </section>

          <details className="rounded-md border">
            <summary className="cursor-pointer px-3 py-2 text-sm font-semibold">
              {t('roles.advanced')}
            </summary>
            <div className="grid gap-5 border-t p-3">
              <section className="grid gap-2">
                <h4 className="text-sm font-semibold">{t('roles.models')}</h4>
                <p className="text-xs text-muted-foreground">
                  <Lock className="inline size-3" aria-hidden /> {t('roles.lockedHint')}
                </p>
                <div className="max-h-96 overflow-auto rounded-md border">
                  <table className="w-full text-sm">
                    <caption className="sr-only">{t('roles.models')}</caption>
                    <thead className="sticky top-0 bg-surface">
                      <tr className="border-b text-xs text-muted-foreground">
                        <th scope="col" className="px-2 py-1.5 text-start font-medium">
                          {t('roles.model')}
                        </th>
                        {PERMS.map((p) => (
                          <th key={p} scope="col" className="px-2 py-1.5 font-medium">
                            {t(`roles.perm.${p}`)}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {groupedModels.map(([app, models]) => [
                        <tr key={`h-${app}`} className="bg-muted/50">
                          <th
                            colSpan={PERMS.length + 1}
                            scope="colgroup"
                            className="px-2 py-1 text-start text-xs font-medium"
                          >
                            {app}
                          </th>
                        </tr>,
                        ...models.map((m) => (
                          <tr key={m.name} className="border-b last:border-0">
                            <th scope="row" className="px-2 py-1 text-start font-normal">
                              {m.label}
                            </th>
                            {PERMS.map((p) => {
                              const locked = m.locked.includes(p);
                              const mine = (own[m.name] ?? []).includes(p);
                              return (
                                <td key={p} className="px-2 py-1 text-center">
                                  <Checkbox
                                    aria-label={`${m.label}: ${t(`roles.perm.${p}`)}`}
                                    checked={locked || mine}
                                    disabled={locked}
                                    onCheckedChange={(c) => {
                                      const set = new Set(own[m.name] ?? []);
                                      if (c === true) set.add(p);
                                      else set.delete(p);
                                      setOwn({ ...own, [m.name]: [...set] });
                                      setPreview(null);
                                    }}
                                  />
                                </td>
                              );
                            })}
                          </tr>
                        )),
                      ])}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="grid gap-2">
                <h4 className="text-sm font-semibold">{t('roles.permissions')}</h4>
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {r.permissions.map((p) => (
                    <div key={p.code} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        id={`${id}-p-${p.code}`}
                        checked={p.locked || granted.has(p.code)}
                        disabled={p.locked}
                        onCheckedChange={(c) => {
                          const next = new Set(granted);
                          if (c === true) next.add(p.code);
                          else next.delete(p.code);
                          setGranted(next);
                          setPreview(null);
                        }}
                      />
                      <Label htmlFor={`${id}-p-${p.code}`}>{p.label}</Label>
                    </div>
                  ))}
                </div>
              </section>

              <section className="grid gap-2">
                <h4 className="text-sm font-semibold">{t('roles.rules')}</h4>
                <p className="text-xs text-muted-foreground">{t('roles.rulesHint')}</p>
                {r.rules.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t('roles.noRules')}</p>
                ) : (
                  <ul className="divide-y rounded-md border text-sm">
                    {r.rules.map((rule) => (
                      <li key={rule.name} className="flex flex-wrap items-center gap-2 px-3 py-2">
                        <span className="font-medium">{rule.model}</span>
                        <span className="text-muted-foreground">{rule.perms.join(', ')}</span>
                        <code className="min-w-0 flex-1 truncate text-xs">
                          {JSON.stringify(rule.domain)}
                        </code>
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={t('roles.deleteRule', { model: rule.model })}
                          onClick={() => deleteRule.mutate(rule.name)}
                        >
                          <Trash2 aria-hidden />
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="grid gap-2 rounded-md border p-3 sm:grid-cols-2">
                  <div className="grid gap-1.5">
                    <Label htmlFor={`${id}-rule-model`}>{t('roles.model')}</Label>
                    <Select
                      id={`${id}-rule-model`}
                      label={t('roles.model')}
                      value={ruleModel === '' ? null : ruleModel}
                      options={r.models.map((m) => ({ value: m.name, label: m.label }))}
                      onChange={setRuleModel}
                    />
                  </div>
                  <fieldset className="grid gap-1.5">
                    <legend className="text-sm font-medium">{t('roles.ruleApplies')}</legend>
                    <div className="flex flex-wrap gap-3">
                      {RULE_PERMS.map((p) => (
                        <div key={p} className="flex items-center gap-1.5 text-sm">
                          <Checkbox
                            id={`${id}-rp-${p}`}
                            checked={rulePerms.has(p)}
                            onCheckedChange={(c) => {
                              const next = new Set(rulePerms);
                              if (c === true) next.add(p);
                              else next.delete(p);
                              setRulePerms(next);
                            }}
                          />
                          <Label htmlFor={`${id}-rp-${p}`}>{t(`roles.perm.${p}`)}</Label>
                        </div>
                      ))}
                    </div>
                  </fieldset>
                  <div className="grid gap-1.5 sm:col-span-2">
                    <Label htmlFor={`${id}-rule-domain`}>{t('roles.ruleCondition')}</Label>
                    <Textarea
                      id={`${id}-rule-domain`}
                      className="font-mono text-xs"
                      value={ruleDomain}
                      onChange={(e) => setRuleDomain(e.target.value)}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <Button
                      variant="secondary"
                      busy={addRule.isPending}
                      disabled={ruleModel === '' || rulePerms.size === 0}
                      onClick={() => addRule.mutate()}
                    >
                      <Plus aria-hidden />
                      {t('roles.addRule')}
                    </Button>
                  </div>
                </div>
              </section>

              {r.fields.length === 0 ? null : (
                <section className="grid gap-2">
                  <h4 className="text-sm font-semibold">{t('roles.fields')}</h4>
                  <ul className="grid gap-1 text-sm">
                    {r.fields.map((f) => (
                      <li key={`${f.model}.${f.field}`}>
                        {f.model}.{f.field}:{' '}
                        {f.write.includes(code) ? t('roles.mayEdit') : t('roles.mayRead')}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          </details>

          {preview === null ? null : <PreviewPanel preview={preview} />}
          {error === null ? null : <Alert tone="danger">{message(error)}</Alert>}
          {save.isSuccess && preview === null ? (
            <Alert tone="info">{t('roles.saved')}</Alert>
          ) : null}

          <div className="flex flex-wrap justify-between gap-2">
            {r.builtIn ? (
              <span />
            ) : confirmDelete ? (
              <div className="flex items-center gap-2 text-sm">
                {t('roles.deleteConfirm', { count: r.holders.length })}
                <Button size="sm" onClick={() => setConfirmDelete(false)}>
                  {t('profile.cancel')}
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  busy={remove.isPending}
                  onClick={() => remove.mutate()}
                >
                  {t('roles.delete')}
                </Button>
              </div>
            ) : (
              <Button variant="ghost" onClick={() => setConfirmDelete(true)}>
                <Trash2 aria-hidden />
                {t('roles.delete')}
              </Button>
            )}
            {preview === null ? (
              <Button variant="primary" busy={preview$.isPending} onClick={() => preview$.mutate()}>
                {t('roles.review')}
              </Button>
            ) : (
              <div className="flex gap-2">
                <Button onClick={() => setPreview(null)}>{t('roles.keepEditing')}</Button>
                <Button variant="primary" busy={save.isPending} onClick={() => save.mutate()}>
                  {t('roles.confirmSave')}
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}

function NewRoleDialog({
  api,
  roles,
  open,
  onOpenChange,
  onCreated,
}: PageProps & {
  readonly roles: readonly RoleRow[];
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreated: (code: string) => void;
}): ReactElement {
  const { t } = useTranslation('settings');
  const id = useId();
  const [label, setLabel] = useState('');
  const [from, setFrom] = useState<string | null>(null);
  const code = `company.${label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')}`;
  const create = useMutation({
    mutationFn: async () => {
      const source =
        from === null
          ? null
          : await api.call<RoleDetail>('GET', `${A}/roles/${encodeURIComponent(from)}`);
      await api.call('PUT', `${A}/roles/${encodeURIComponent(code)}`, {
        label: label.trim(),
        implies: source === null ? ['base.user'] : [...source.implies],
      });
      // A copy takes the source's own grants too.
      for (const m of source?.models ?? [])
        if (m.own.length > 0)
          await api.call(
            'PUT',
            `${A}/roles/${encodeURIComponent(code)}/access/${encodeURIComponent(m.name)}`,
            {
              perms: m.own,
            },
          );
      for (const p of source?.permissions ?? [])
        if (p.own)
          await api.call(
            'PUT',
            `${A}/roles/${encodeURIComponent(code)}/permissions/${encodeURIComponent(p.code)}`,
          );
      return code;
    },
    onSuccess: (made) => {
      setLabel('');
      setFrom(null);
      onCreated(made);
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('roles.newTitle')}
      description={t('roles.newHint')}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t('profile.cancel')}</Button>
          <Button
            variant="primary"
            busy={create.isPending}
            disabled={code === 'company.'}
            onClick={() => create.mutate()}
          >
            {t('roles.create')}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-label`}>{t('roles.name')}</Label>
          <Input id={`${id}-label`} value={label} onChange={(e) => setLabel(e.target.value)} />
          {code === 'company.' ? null : (
            <code className="text-xs text-muted-foreground">{code}</code>
          )}
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-from`}>{t('roles.copyFrom')}</Label>
          <Select
            id={`${id}-from`}
            label={t('roles.copyFrom')}
            value={from ?? 'none'}
            options={[
              { value: 'none', label: t('roles.fromScratch') },
              ...roles
                .filter((r) => !r.administrator)
                .map((r) => ({ value: r.code, label: r.label })),
            ]}
            onChange={(v) => setFrom(v === 'none' ? null : v)}
          />
        </div>
        {create.error === null ? null : <Alert tone="danger">{message(create.error)}</Alert>}
      </div>
    </Dialog>
  );
}

export function RolesPage({ api }: PageProps): ReactElement {
  const { t } = useTranslation('settings');
  const id = useId();
  const levels = useLevels(api);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<'all' | 'custom' | 'builtIn'>('all');
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const roles = useQuery({
    queryKey: ['admin', 'roles'],
    queryFn: () => api.call<{ roles: RoleRow[] }>('GET', `${A}/roles`),
  });
  if (roles.error !== null)
    return (
      <Alert tone="danger">
        {roles.error instanceof ApiError && roles.error.status === 403
          ? t('roles.adminsOnly')
          : message(roles.error)}
      </Alert>
    );
  const query = q.trim().toLowerCase();
  const list = (roles.data?.roles ?? [])
    .filter((r) => !r.code.startsWith('portal.'))
    .filter((r) => (kind === 'custom' ? !r.builtIn : kind === 'builtIn' ? r.builtIn : true))
    .filter((r) => query === '' || r.label.toLowerCase().includes(query) || r.code.includes(query))
    .sort((a, b) => Number(a.builtIn) - Number(b.builtIn) || a.label.localeCompare(b.label));
  return (
    <div className="mx-auto grid max-w-5xl gap-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{t('roles.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('roles.intro')}</p>
        </div>
        <Button variant="primary" onClick={() => setCreating(true)}>
          <Plus aria-hidden />
          {t('roles.new')}
        </Button>
      </header>
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-60 flex-1">
          <Search
            className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <label htmlFor={`${id}-q`} className="sr-only">
            {t('roles.search')}
          </label>
          <Input
            id={`${id}-q`}
            type="search"
            className="ps-9"
            placeholder={t('roles.search')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <fieldset className="flex rounded-md border p-0.5">
          <legend className="sr-only">{t('roles.kind')}</legend>
          {(['all', 'custom', 'builtIn'] as const).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={kind === k}
              onClick={() => setKind(k)}
              className="rounded px-3 py-1 text-sm aria-pressed:bg-accent aria-pressed:font-medium aria-pressed:text-accent-foreground"
            >
              {t(`roles.filter.${k}`)}
            </button>
          ))}
        </fieldset>
      </div>
      <ul className="divide-y rounded-lg border bg-surface" aria-label={t('roles.title')}>
        {list.map((r) => (
          <li key={r.code}>
            <button
              type="button"
              onClick={() => setOpen(r.code)}
              className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-start hover:bg-muted/50"
            >
              <span className="grid min-w-52 flex-1">
                <span className="font-medium">{r.label}</span>
                <code className="text-xs text-muted-foreground">{r.code}</code>
              </span>
              <span className="flex min-w-52 flex-[2] flex-wrap gap-1">
                {r.administrator ? <Badge tone="warning">{t('people.administrator')}</Badge> : null}
                {levels.ready
                  ? r.accessLevels
                      .filter(levels.isApp)
                      .slice(0, 4)
                      .map((l) => (
                        <Badge key={l} tone="neutral">
                          {levels.label(l)}
                        </Badge>
                      ))
                  : null}
              </span>
              <span className="flex items-center gap-2 text-sm text-muted-foreground">
                {r.builtIn ? (
                  <Badge tone="neutral">{t('roles.builtIn')}</Badge>
                ) : (
                  <Badge tone="info">{t('roles.custom')}</Badge>
                )}
                {t('roles.holders', { count: r.holders })}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <NewRoleDialog
        api={api}
        roles={roles.data?.roles ?? []}
        open={creating}
        onOpenChange={setCreating}
        onCreated={(code) => {
          setCreating(false);
          void roles.refetch();
          setOpen(code);
        }}
      />
      {open === null ? null : <RoleDialog api={api} code={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
