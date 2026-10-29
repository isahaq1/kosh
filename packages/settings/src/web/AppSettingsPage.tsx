/**
 * Settings › App settings (RFC 0020): the apps' own settings, declared in their manifests. The apps you may see on
 * the left; an app's sections as cards — each setting with its help, a mark when it differs from the default with
 * *Reset*, and *Save* per section, sending only what changed. Company settings name the company they apply to. The
 * server checks every value and who may change it, and audits each change.
 */
import {
  Alert,
  ApiError,
  AppIcon,
  Badge,
  Button,
  Checkbox,
  DateField,
  Input,
  Label,
  type PageProps,
  Select,
  Textarea,
  useKosh,
} from '@kosh/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcw } from 'lucide-react';
import { type ReactElement, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

type Value = string | number | boolean | null;
interface Setting {
  readonly key: string;
  readonly type: 'boolean' | 'integer' | 'decimal' | 'char' | 'text' | 'selection' | 'date';
  readonly label: string;
  readonly help: string | null;
  readonly default: Value;
  readonly min: number | null;
  readonly max: number | null;
  readonly options: readonly { readonly value: string; readonly label: string }[] | null;
  readonly visibleWhen: { readonly key: string; readonly equals: Value } | null;
  readonly value: Value;
  readonly changed: boolean;
}
interface Section {
  readonly key: string;
  readonly label: string;
  readonly description: string | null;
  readonly scope: 'company' | 'installation';
  readonly editable: boolean;
  readonly settings: readonly Setting[];
}
interface AppSettings {
  readonly app: string;
  readonly label: string;
  readonly icon: string | null;
  readonly sections: readonly Section[];
}
interface AppEntry {
  readonly app: string;
  readonly label: string;
  readonly icon: string | null;
  readonly sections: readonly { readonly key: string; readonly label: string }[];
}

const BASE = '/api/v1/settings/app-settings';
const message = (error: unknown) => (error instanceof ApiError ? error.message : String(error));

/** The app shown: `?app=` in the address, else the first. */
function useChosenApp(apps: readonly AppEntry[]): [string | undefined, (app: string) => void] {
  const [chosen, setChosen] = useState(
    () => new URLSearchParams(window.location.search).get('app') ?? undefined,
  );
  const set = (app: string) => {
    setChosen(app);
    const url = new URL(window.location.href);
    url.searchParams.set('app', app);
    window.history.replaceState(window.history.state, '', url);
  };
  return [apps.some((a) => a.app === chosen) ? chosen : apps[0]?.app, set];
}

function Control({
  setting,
  value,
  disabled,
  onChange,
}: {
  readonly setting: Setting;
  readonly value: Value;
  readonly disabled: boolean;
  readonly onChange: (value: Value) => void;
}): ReactElement {
  const id = `setting-${setting.key}`;
  const { t } = useTranslation('settings');
  switch (setting.type) {
    case 'boolean':
      return (
        <Checkbox
          id={id}
          checked={value === true}
          disabled={disabled}
          onCheckedChange={(on) => onChange(on === true)}
        />
      );
    case 'selection':
      return (
        <Select
          id={id}
          label={setting.label}
          value={typeof value === 'string' ? value : 'none'}
          disabled={disabled}
          options={[{ value: 'none', label: t('appSettings.notSet') }, ...(setting.options ?? [])]}
          onChange={(v) => onChange(v === 'none' ? null : v)}
        />
      );
    case 'text':
      return (
        <Textarea
          id={id}
          rows={4}
          disabled={disabled}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'date':
      return disabled ? (
        <Input
          id={id}
          disabled
          className="w-48"
          value={typeof value === 'string' ? value : ''}
          readOnly
        />
      ) : (
        <DateField id={id} value={typeof value === 'string' ? value : null} onChange={onChange} />
      );
    default:
      return (
        <Input
          id={id}
          className={setting.type === 'char' ? undefined : 'w-48'}
          disabled={disabled}
          type={setting.type === 'integer' ? 'number' : 'text'}
          inputMode={setting.type === 'decimal' ? 'decimal' : undefined}
          min={setting.min ?? undefined}
          max={setting.max ?? undefined}
          value={value === null ? '' : String(value)}
          onChange={(e) => {
            const raw = e.target.value;
            onChange(
              setting.type === 'integer'
                ? raw === ''
                  ? null
                  : Number.parseInt(raw, 10)
                : raw === ''
                  ? null
                  : raw,
            );
          }}
        />
      );
  }
}

function SectionCard({
  api,
  app,
  section,
}: PageProps & { readonly app: string; readonly section: Section }): ReactElement {
  const { t } = useTranslation('settings');
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Record<string, Value>>({});
  // biome-ignore lint/correctness/useExhaustiveDependencies: a reloaded section starts a clean draft
  useEffect(() => setDraft({}), [section]);
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ['settings', 'app-settings', app] });
  const save = useMutation({
    mutationFn: () => api.call('PATCH', `${BASE}/${app}/${section.key}`, { values: draft }),
    onSuccess: refresh,
  });
  const reset = useMutation({
    mutationFn: (key: string) =>
      api.call('POST', `${BASE}/${app}/${section.key}/reset`, { keys: [key] }),
    onSuccess: refresh,
  });
  const currentOf = (s: Setting) => (s.key in draft ? (draft[s.key] as Value) : s.value);
  const dirty = Object.keys(draft).length > 0;
  return (
    <section
      id={`section-${section.key}`}
      aria-labelledby={`section-${section.key}-title`}
      className="grid gap-4 rounded-lg border bg-surface p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id={`section-${section.key}-title`} className="font-semibold">
            {section.label}
          </h2>
          {section.description === null ? null : (
            <p className="text-sm text-muted-foreground">{section.description}</p>
          )}
        </div>
        <Badge tone="neutral">
          {section.scope === 'company' ? t('appSettings.perCompany') : t('appSettings.everywhere')}
        </Badge>
      </div>
      <div className="grid gap-5">
        {section.settings
          .filter((s) => {
            if (s.visibleWhen === null) return true;
            const other = section.settings.find((x) => x.key === s.visibleWhen?.key);
            return other !== undefined && currentOf(other) === s.visibleWhen.equals;
          })
          .map((s) => (
            <div key={s.key} className="grid gap-1.5 sm:grid-cols-[16rem_1fr] sm:gap-6">
              <div className="grid content-start gap-1">
                <Label htmlFor={`setting-${s.key}`} className="flex flex-wrap items-center gap-2">
                  {s.label}
                  {s.changed && !(s.key in draft) ? (
                    <Badge tone="info">{t('appSettings.changed')}</Badge>
                  ) : null}
                </Label>
                {s.help === null ? null : <p className="text-xs text-muted-foreground">{s.help}</p>}
              </div>
              <div className="flex flex-wrap items-start gap-2">
                <div className="min-w-0 flex-1">
                  <Control
                    setting={s}
                    value={currentOf(s)}
                    disabled={!section.editable}
                    onChange={(v) => setDraft((d) => ({ ...d, [s.key]: v }))}
                  />
                </div>
                {s.changed && section.editable && !(s.key in draft) ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    busy={reset.isPending && reset.variables === s.key}
                    aria-label={t('appSettings.resetOne', { setting: s.label })}
                    title={t('appSettings.defaultIs', {
                      value: s.default === null || s.default === '' ? '—' : String(s.default),
                    })}
                    onClick={() => reset.mutate(s.key)}
                  >
                    <RotateCcw aria-hidden />
                    {t('appSettings.reset')}
                  </Button>
                ) : null}
              </div>
            </div>
          ))}
      </div>
      {save.error === null && reset.error === null ? null : (
        <Alert tone="danger">{message(save.error ?? reset.error)}</Alert>
      )}
      {section.editable ? (
        <div className="flex items-center justify-end gap-2">
          {save.isSuccess && !dirty ? (
            <span className="text-sm text-muted-foreground">{t('appSettings.saved')}</span>
          ) : null}
          {dirty ? (
            <Button variant="ghost" onClick={() => setDraft({})}>
              {t('appSettings.discard')}
            </Button>
          ) : null}
          <Button
            variant="primary"
            disabled={!dirty}
            busy={save.isPending}
            onClick={() => save.mutate()}
          >
            {t('appSettings.save')}
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{t('appSettings.readOnly')}</p>
      )}
    </section>
  );
}

export function AppSettingsPage({ api }: PageProps): ReactElement {
  const { t } = useTranslation('settings');
  const { companyId } = useKosh();
  const list = useQuery({
    queryKey: ['settings', 'app-settings'],
    queryFn: () => api.call<{ apps: AppEntry[] }>('GET', BASE),
  });
  const apps = list.data?.apps ?? [];
  const [app, choose] = useChosenApp(apps);
  const settings = useQuery({
    queryKey: ['settings', 'app-settings', app, companyId],
    queryFn: () => api.call<AppSettings>('GET', `${BASE}/${app}`),
    enabled: app !== undefined,
  });
  if (list.error !== null) return <Alert tone="danger">{message(list.error)}</Alert>;
  return (
    <div className="mx-auto grid max-w-5xl gap-6">
      <header>
        <h1 className="text-xl font-semibold">{t('appSettings.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('appSettings.intro')}</p>
      </header>
      {list.data !== undefined && apps.length === 0 ? (
        <p className="rounded-lg border bg-surface p-6 text-center text-sm text-muted-foreground">
          {t('appSettings.none')}
        </p>
      ) : (
        <div className="grid gap-6 md:grid-cols-[13rem_1fr]">
          <nav aria-label={t('appSettings.apps')} className="md:sticky md:top-16 md:self-start">
            <ul className="flex gap-1 overflow-x-auto md:grid">
              {apps.map((a) => (
                <li key={a.app}>
                  <button
                    type="button"
                    aria-current={a.app === app ? 'page' : undefined}
                    onClick={() => choose(a.app)}
                    className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm hover:bg-muted ${
                      a.app === app ? 'bg-accent font-medium text-accent-foreground' : ''
                    }`}
                  >
                    <AppIcon
                      name={a.icon ?? a.app}
                      className="size-6 rounded-md [&_svg]:size-3.5"
                    />
                    {a.label}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
          <div className="grid gap-4">
            {settings.error !== null ? (
              <Alert tone="danger">{message(settings.error)}</Alert>
            ) : settings.data === undefined ? (
              <p className="text-sm text-muted-foreground">…</p>
            ) : (
              settings.data.sections.map((s) => (
                <SectionCard key={s.key} api={api} app={settings.data.app} section={s} />
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
