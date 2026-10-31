/**
 * Settings › App settings (RFC 0020): the apps' own settings, declared in their manifests. The apps you may see on
 * the left; an app's sections as cards — each setting with its help, a mark when it differs from the default with
 * *Reset*, and *Save* per section, sending only what changed. Company settings name the company they apply to. The
 * server checks every value and who may change it, and audits each change. Each setting opens its history (who, when,
 * old → new); administrators copy a company's settings to another, export them as a file and import one, every one
 * of those previewed before anything is written.
 */
import {
  Alert,
  ApiError,
  AppIcon,
  Badge,
  Button,
  Checkbox,
  DateField,
  Dialog,
  Input,
  Label,
  type PageProps,
  Select,
  Textarea,
  useKosh,
} from '@kosh/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Download, History, RotateCcw, Upload } from 'lucide-react';
import { type ReactElement, useEffect, useRef, useState } from 'react';
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
interface HistoryEvent {
  readonly at: string;
  readonly actor: { readonly id: number; readonly name: string } | null;
  readonly how: 'changed' | 'copied' | 'imported';
  readonly changes: readonly {
    readonly key: string;
    readonly label: string;
    readonly from: Value;
    readonly to: Value;
  }[];
}
/** What a copy or an import would change (or changed), per section. */
interface SectionChanges {
  readonly app: string;
  readonly appLabel: string;
  readonly section: string;
  readonly label: string;
  readonly changes: readonly {
    readonly key: string;
    readonly label: string;
    readonly from: Value;
    readonly to: Value;
  }[];
}
interface Preview {
  readonly preview: boolean;
  readonly sections: readonly SectionChanges[];
  readonly skipped?: readonly string[];
}

const shown = (value: Value): string =>
  value === null || value === ''
    ? '—'
    : value === true
      ? '✓'
      : value === false
        ? '✗'
        : String(value);

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

/** Who changed a setting, when, from what to what — the audit log of this section, newest first. */
function HistoryDialog({
  api,
  app,
  section,
  setting,
  onClose,
}: PageProps & {
  readonly app: string;
  readonly section: Section;
  readonly setting: Setting | null;
  readonly onClose: () => void;
}): ReactElement {
  const { t } = useTranslation('settings');
  const { format } = useKosh();
  const history = useQuery({
    queryKey: ['settings', 'app-settings', app, section.key, 'history', setting?.key],
    queryFn: () =>
      api.call<{ events: HistoryEvent[] }>(
        'GET',
        `${BASE}/${app}/${section.key}/history?key=${encodeURIComponent(setting?.key ?? '')}`,
      ),
    enabled: setting !== null,
  });
  return (
    <Dialog
      open={setting !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('appSettings.historyOf', { setting: setting?.label ?? '' })}
    >
      {history.error !== null ? (
        <Alert tone="danger">{message(history.error)}</Alert>
      ) : history.data === undefined ? (
        <p className="text-sm text-muted-foreground">…</p>
      ) : history.data.events.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('appSettings.neverChanged')}</p>
      ) : (
        <ol className="grid gap-2 text-sm">
          {history.data.events.map((e) => (
            <li key={e.at} className="grid gap-0.5 rounded-md border p-2">
              <span className="text-xs text-muted-foreground">
                {format.datetime(e.at)} · {e.actor?.name ?? t('appSettings.system')} ·{' '}
                {t(`appSettings.how.${e.how}`)}
              </span>
              {e.changes.map((c) => (
                <span key={c.key} className="tabular-nums">
                  <s className="text-muted-foreground">{shown(c.from)}</s> → <b>{shown(c.to)}</b>
                </span>
              ))}
            </li>
          ))}
        </ol>
      )}
    </Dialog>
  );
}

/** The changes a copy or an import would make, section by section. */
function ChangesList({ preview }: { readonly preview: Preview }): ReactElement {
  const { t } = useTranslation('settings');
  return (
    <div className="grid gap-3 text-sm">
      {preview.sections.length === 0 ? (
        <p className="text-muted-foreground">{t('appSettings.nothingToChange')}</p>
      ) : (
        preview.sections.map((s) => (
          <div key={`${s.app}.${s.section}`} className="grid gap-1">
            <span className="font-medium">
              {s.appLabel} › {s.label}
            </span>
            <ul className="grid gap-0.5 ps-4">
              {s.changes.map((c) => (
                <li key={c.key} className="tabular-nums">
                  {c.label}: <s className="text-muted-foreground">{shown(c.from)}</s> →{' '}
                  <b>{shown(c.to)}</b>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
      {(preview.skipped ?? []).length === 0 ? null : (
        <p className="text-xs text-muted-foreground">
          {t('appSettings.skipped', { what: (preview.skipped ?? []).join(', ') })}
        </p>
      )}
    </div>
  );
}

/** Administrators: copy this company's settings to another, export them, import a file — each previewed first. */
function Tools({ api, onDone }: PageProps & { readonly onDone: () => void }): ReactElement {
  const { t } = useTranslation('settings');
  const { companyId } = useKosh();
  const [copying, setCopying] = useState(false);
  const [to, setTo] = useState<string>('');
  const [importing, setImporting] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const companies = useQuery({
    queryKey: ['settings', 'companies'],
    queryFn: () =>
      api.call<{ companies: { id: number; name: string; member: boolean }[] }>(
        'GET',
        '/api/v1/settings/companies',
      ),
    enabled: copying,
  });
  const targets = (companies.data?.companies ?? []).filter((c) => c.id !== companyId && c.member);
  const copyPreview = useQuery({
    queryKey: ['settings', 'app-settings', 'copy', companyId, to],
    queryFn: () =>
      api.call<Preview>('POST', `${BASE}/copy`, { from: companyId, to: Number(to), preview: true }),
    enabled: copying && to !== '',
  });
  const copy = useMutation({
    mutationFn: () =>
      api.call<Preview>('POST', `${BASE}/copy`, { from: companyId, to: Number(to) }),
    onSuccess: (r) => {
      setCopying(false);
      setDone(t('appSettings.copied', { count: r.sections.length }));
      onDone();
    },
    onError: (e) => setError(message(e)),
  });
  const importPreview = useQuery({
    queryKey: ['settings', 'app-settings', 'import', importing],
    queryFn: () => api.call<Preview>('POST', `${BASE}/import`, { file: importing, preview: true }),
    enabled: importing !== null,
    retry: false,
  });
  const doImport = useMutation({
    mutationFn: () => api.call<Preview>('POST', `${BASE}/import`, { file: importing }),
    onSuccess: (r) => {
      setImporting(null);
      setDone(t('appSettings.imported', { count: r.sections.length }));
      onDone();
    },
    onError: (e) => setError(message(e)),
  });
  const exportFile = async (): Promise<void> => {
    try {
      const data = await api.call<{ company: { name: string } }>('GET', `${BASE}/export`);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `app-settings-${data.company.name.replaceAll(/[^\w-]+/g, '_')}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(message(e));
    }
  };
  const read = (f: File | undefined): void => {
    if (f === undefined) return;
    f.text().then(
      (text) => {
        try {
          setImporting(JSON.parse(text) as unknown);
          setError(null);
        } catch {
          setError(t('appSettings.notJson'));
        }
      },
      (e: unknown) => setError(message(e)),
    );
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="secondary" onClick={() => setCopying(true)}>
        <Copy aria-hidden />
        {t('appSettings.copyTo')}
      </Button>
      <Button size="sm" variant="secondary" onClick={() => void exportFile()}>
        <Download aria-hidden />
        {t('appSettings.export')}
      </Button>
      <Button size="sm" variant="secondary" onClick={() => file.current?.click()}>
        <Upload aria-hidden />
        {t('appSettings.import')}
      </Button>
      <input
        ref={file}
        type="file"
        accept="application/json,.json"
        className="sr-only"
        aria-label={t('appSettings.importFile')}
        onChange={(e) => {
          read(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      {done === null ? null : <span className="text-sm text-muted-foreground">{done}</span>}
      {error === null ? null : <Alert tone="danger">{error}</Alert>}
      <Dialog
        open={copying}
        onOpenChange={setCopying}
        title={t('appSettings.copyTitle')}
        description={t('appSettings.copyIntro')}
        footer={
          <Button
            variant="primary"
            disabled={to === '' || (copyPreview.data?.sections.length ?? 0) === 0}
            busy={copy.isPending}
            onClick={() => copy.mutate()}
          >
            {t('appSettings.copyNow')}
          </Button>
        }
      >
        <div className="grid gap-3">
          <Select
            id="copy-to"
            label={t('appSettings.toCompany')}
            value={to === '' ? 'none' : to}
            options={[
              { value: 'none', label: t('appSettings.chooseCompany') },
              ...targets.map((c) => ({ value: String(c.id), label: c.name })),
            ]}
            onChange={(v) => setTo(v === 'none' ? '' : v)}
          />
          {copyPreview.error !== null ? (
            <Alert tone="danger">{message(copyPreview.error)}</Alert>
          ) : copyPreview.data === undefined ? null : (
            <ChangesList preview={copyPreview.data} />
          )}
        </div>
      </Dialog>
      <Dialog
        open={importing !== null}
        onOpenChange={(open) => {
          if (!open) setImporting(null);
        }}
        title={t('appSettings.importTitle')}
        description={t('appSettings.importIntro')}
        footer={
          <Button
            variant="primary"
            disabled={(importPreview.data?.sections.length ?? 0) === 0}
            busy={doImport.isPending}
            onClick={() => doImport.mutate()}
          >
            {t('appSettings.importNow')}
          </Button>
        }
      >
        {importPreview.error !== null ? (
          <Alert tone="danger">{message(importPreview.error)}</Alert>
        ) : importPreview.data === undefined ? (
          <p className="text-sm text-muted-foreground">…</p>
        ) : (
          <ChangesList preview={importPreview.data} />
        )}
      </Dialog>
    </div>
  );
}

function SectionCard({
  api,
  app,
  section,
}: PageProps & { readonly app: string; readonly section: Section }): ReactElement {
  const { t } = useTranslation('settings');
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Record<string, Value>>({});
  const [history, setHistory] = useState<Setting | null>(null);
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
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={t('appSettings.historyOf', { setting: s.label })}
                  title={t('appSettings.history')}
                  onClick={() => setHistory(s)}
                >
                  <History aria-hidden />
                </Button>
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
      <HistoryDialog
        api={api}
        app={app}
        section={section}
        setting={history}
        onClose={() => setHistory(null)}
      />
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
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: ['settings', 'app-settings'],
    queryFn: () => api.call<{ administrator: boolean; apps: AppEntry[] }>('GET', BASE),
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
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{t('appSettings.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('appSettings.intro')}</p>
        </div>
        {list.data?.administrator === true ? (
          <Tools
            api={api}
            onDone={() =>
              void queryClient.invalidateQueries({ queryKey: ['settings', 'app-settings'] })
            }
          />
        ) : null}
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
