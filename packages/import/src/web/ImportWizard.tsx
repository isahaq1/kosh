/**
 * The import screen (RFC 0014 §5.8): three steps in a wide dialog. The file (with a sample workbook to start from);
 * the columns (each with its first values and the field it fills, the mode and key, what to do with errors, saved
 * mappings); the result (counts, the errors with their row and column, the rejected rows, undo). Large files run
 * in the background and the dialog follows their progress. The server reads, converts and checks everything; the
 * screen only shows what it says.
 */
import {
  Alert,
  ApiError,
  Button,
  Checkbox,
  Dialog,
  Input,
  type KoshApi,
  Label,
  Select,
} from '@kosh/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Save, Undo2, Upload } from 'lucide-react';
import { type ReactElement, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

const ACCEPT =
  '.csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const SKIP = '__skip';

interface Field {
  readonly key: string;
  readonly kind: string;
  readonly label: string;
  readonly required: boolean;
  readonly keyable: boolean;
  readonly line?: string;
}
interface Options {
  readonly mode?: 'create' | 'update' | 'upsert';
  readonly key?: string;
  readonly onError?: 'stop' | 'skip';
  readonly dateOrder?: 'dmy' | 'mdy' | 'ymd';
  readonly decimal?: '.' | ',';
}
interface RowError {
  readonly row: number;
  readonly column: number | null;
  readonly code: string;
  readonly message: string;
}
interface Result {
  readonly rows: number;
  readonly created: readonly number[];
  readonly updated: readonly number[];
  readonly wouldCreate: number;
  readonly wouldUpdate: number;
  readonly skipped: number;
  readonly errors: readonly RowError[];
}
export interface ImportSession {
  readonly id: number;
  readonly model: string;
  readonly fileName: string;
  readonly state: 'draft' | 'running' | 'done' | 'undone';
  readonly rowCount: number;
  readonly background: boolean;
  readonly headers: readonly string[];
  readonly sample: readonly (readonly unknown[])[];
  readonly columns: readonly { readonly index: number; readonly field: string | null }[];
  readonly options: Options;
  readonly fields: readonly Field[];
  readonly progress: { readonly done: number; readonly total: number } | null;
  readonly result: Result | null;
  readonly resultDry: boolean;
  readonly failure: string | null;
  readonly undoUntil: string | null;
  readonly rejected: number;
  readonly applied?: { readonly id: string; readonly name: string } | null;
}
interface SavedMapping {
  readonly id: string;
  readonly name: string;
  readonly template: boolean;
}
interface UndoResult {
  readonly deleted: number;
  readonly restored: number;
  readonly changed: readonly number[];
}

function saveFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const message = (error: unknown) => (error instanceof ApiError ? error.message : String(error));
const cell = (value: unknown) =>
  value === null || value === undefined ? '' : typeof value === 'string' ? value : String(value);

export function ImportWizard({
  api,
  model,
  open,
  onOpenChange,
}: {
  readonly api: KoshApi;
  readonly model: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): ReactElement {
  const { t } = useTranslation('import');
  const id = useId();
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [session, setSession] = useState<ImportSession | null>(null);
  const [step, setStep] = useState<'file' | 'columns' | 'result'>('file');
  const [errorColumn, setErrorColumn] = useState<string>('all');
  const [mappingName, setMappingName] = useState('');
  const [share, setShare] = useState(false);
  const [savedName, setSavedName] = useState<string | null>(null);
  const [undone, setUndone] = useState<UndoResult | null>(null);

  const mappings = useQuery({
    queryKey: ['import', 'mappings', model],
    queryFn: () =>
      api.call<{ mappings: SavedMapping[] }>(
        'GET',
        `/api/v1/import-mappings?model=${encodeURIComponent(model)}`,
      ),
    enabled: open,
  });
  // A background run: follow it until it ends.
  const running = session?.state === 'running';
  useQuery({
    queryKey: ['import', 'session', session?.id],
    queryFn: async () => {
      const next = await api.call<ImportSession>('GET', `/api/v1/imports/${session?.id}`);
      setSession(next);
      if (next.state !== 'running') {
        setStep('result');
        if (next.state === 'done') void queryClient.invalidateQueries();
      }
      return next;
    },
    enabled: running,
    refetchInterval: running ? 1000 : false,
  });

  const reset = () => {
    setFile(null);
    setSession(null);
    setStep('file');
    setUndone(null);
    setErrorColumn('all');
  };
  const upload = useMutation({
    mutationFn: (chosen: File) =>
      api.upload<ImportSession>(
        `/api/v1/imports?model=${encodeURIComponent(model)}`,
        chosen,
        chosen.name,
      ),
    onSuccess: (created) => {
      setSession(created);
      setStep('columns');
    },
  });
  const map = useMutation({
    mutationFn: (change: { columns?: ImportSession['columns']; options?: Options }) =>
      api.call<ImportSession>('PUT', `/api/v1/imports/${session?.id}/mapping`, {
        columns: (change.columns ?? session?.columns ?? []).map((c) => ({
          index: c.index,
          field: c.field,
        })),
        options: change.options ?? session?.options ?? {},
      }),
    onSuccess: setSession,
  });
  const apply = useMutation({
    mutationFn: (mapping: string) =>
      api.call<ImportSession>('POST', `/api/v1/imports/${session?.id}/apply-mapping`, { mapping }),
    onSuccess: setSession,
  });
  const save = useMutation({
    mutationFn: () =>
      api.call('POST', `/api/v1/imports/${session?.id}/save-mapping`, {
        name: mappingName.trim(),
        shared: share,
      }),
    onSuccess: () => {
      setSavedName(mappingName.trim());
      setMappingName('');
      void mappings.refetch();
    },
  });
  const run = useMutation({
    mutationFn: async (dry: boolean) => {
      const path = `/api/v1/imports/${session?.id}/${dry ? 'dry-run' : 'commit'}`;
      try {
        return { dry, answer: await api.call<Result | ImportSession>('POST', path, {}) };
      } catch (error) {
        // A commit that stopped on errors answers 422 with its result.
        if (error instanceof ApiError && error.status === 422 && !dry) {
          const again = await api.call<ImportSession>('GET', `/api/v1/imports/${session?.id}`);
          return { dry, answer: again };
        }
        throw error;
      }
    },
    onSuccess: ({ answer }) => {
      if ('state' in answer) {
        setSession(answer);
        if (answer.state !== 'running') setStep('result');
        return;
      }
      void api.call<ImportSession>('GET', `/api/v1/imports/${session?.id}`).then((next) => {
        setSession(next);
        setStep('result');
        if (next.state === 'done') void queryClient.invalidateQueries();
      });
    },
  });
  const undo = useMutation({
    mutationFn: () => api.call<UndoResult>('POST', `/api/v1/imports/${session?.id}/undo`, {}),
    onSuccess: async (result) => {
      setUndone(result);
      setSession(await api.call<ImportSession>('GET', `/api/v1/imports/${session?.id}`));
      void queryClient.invalidateQueries();
    },
  });
  const download = useMutation({
    mutationFn: async (path: string) => {
      const { blob, filename } = await api.download(path, undefined, 'GET');
      saveFile(blob, filename);
    },
  });

  const fields = session?.fields ?? [];
  const mapped = new Set(
    (session?.columns ?? []).flatMap((c) => (c.field === null ? [] : [c.field])),
  );
  const options = session?.options ?? {};
  const mode = options.mode ?? 'create';
  const missing =
    mode === 'create'
      ? fields.filter((f) => f.required && f.line === undefined && !mapped.has(f.key))
      : [];
  const keyChoices = fields.filter((f) => f.keyable && mapped.has(f.key));
  const needsKey = mode !== 'create' && (options.key === undefined || !mapped.has(options.key));
  const result = session?.result ?? null;
  const fieldOptions = [
    { value: SKIP, label: t('skip') },
    ...fields.map((f) => ({
      value: f.key,
      label: `${f.line === undefined ? '' : `${t('lineFields')}: `}${f.label}${f.required ? ` (${t('required')})` : ''}`,
    })),
  ];
  const setOption = (change: { readonly [K in keyof Options]?: Options[K] | undefined }) =>
    map.mutate({
      options: Object.fromEntries(
        Object.entries({ ...options, ...change }).filter(([, v]) => v !== undefined),
      ) as Options,
    });
  const busy = map.isPending || apply.isPending || run.isPending;
  const error = upload.error ?? map.error ?? apply.error ?? run.error ?? save.error ?? undo.error;
  const shownErrors = (result?.errors ?? []).filter(
    (e) =>
      errorColumn === 'all' ||
      (errorColumn === 'row' ? e.column === null : String(e.column) === errorColumn),
  );

  const footer =
    step === 'file' ? (
      <Button
        variant="primary"
        busy={upload.isPending}
        disabled={file === null}
        onClick={() => file !== null && upload.mutate(file)}
      >
        <Upload aria-hidden />
        {t('upload')}
      </Button>
    ) : step === 'columns' ? (
      <>
        <Button variant="ghost" disabled={busy || running} onClick={reset}>
          {t('back')}
        </Button>
        <Button
          disabled={busy || running || missing.length > 0 || needsKey}
          busy={run.isPending && run.variables === true}
          onClick={() => run.mutate(true)}
        >
          {t('check')}
        </Button>
        <Button
          variant="primary"
          disabled={busy || running || missing.length > 0 || needsKey}
          busy={run.isPending && run.variables === false}
          onClick={() => run.mutate(false)}
        >
          {t('run')}
        </Button>
      </>
    ) : (
      <>
        {session?.state === 'draft' ? (
          <Button variant="ghost" onClick={() => setStep('columns')}>
            {t('back')}
          </Button>
        ) : null}
        <Button onClick={reset}>{t('another')}</Button>
        <Button
          variant="primary"
          onClick={() => {
            onOpenChange(false);
            reset();
          }}
        >
          {t('done')}
        </Button>
      </>
    );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next && !running) reset();
      }}
      title={t('title')}
      description={t('intro')}
      wide
      footer={footer}
    >
      <div className="space-y-4">
        <ol className="flex gap-4 text-sm" aria-label={t('title')}>
          {(['file', 'columns', 'result'] as const).map((s, i) => (
            <li
              key={s}
              aria-current={step === s ? 'step' : undefined}
              className={step === s ? 'font-semibold text-foreground' : 'text-muted-foreground'}
            >
              {i + 1}. {t(`step${s[0]?.toUpperCase()}${s.slice(1)}`)}
            </li>
          ))}
        </ol>
        {error === null ? null : <Alert>{message(error)}</Alert>}

        {step === 'file' ? (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor={`${id}-file`}>{t('chooseFile')}</Label>
              <input
                id={`${id}-file`}
                type="file"
                accept={ACCEPT}
                className="block w-full text-sm"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="ghost"
                busy={download.isPending}
                onClick={() =>
                  download.mutate(`/api/v1/import-templates/${encodeURIComponent(model)}`)
                }
              >
                <Download aria-hidden />
                {t('template')}
              </Button>
              {(mappings.data?.mappings ?? [])
                .filter((m) => m.template)
                .map((m) => (
                  <Button
                    key={m.id}
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      download.mutate(
                        `/api/v1/import-templates/${encodeURIComponent(model)}?mapping=${encodeURIComponent(m.id)}`,
                      )
                    }
                  >
                    <Download aria-hidden />
                    {t('templateOf', { name: m.name })}
                  </Button>
                ))}
            </div>
          </div>
        ) : null}

        {step === 'columns' && session !== null ? (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {session.fileName} · {t('rows', { count: session.rowCount })}
            </p>
            {session.applied ? (
              <Alert tone="info">{t('applied', { name: session.applied.name })}</Alert>
            ) : null}
            {session.background ? <Alert tone="info">{t('background')}</Alert> : null}
            {running ? (
              <Alert tone="info">
                {session.progress === null || session.progress.done === 0
                  ? t('queued')
                  : t('running', session.progress)}
              </Alert>
            ) : null}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-start text-muted-foreground">
                    <th className="py-1.5 pe-3 text-start font-medium">{t('column')}</th>
                    <th className="py-1.5 pe-3 text-start font-medium">{t('sample')}</th>
                    <th className="py-1.5 text-start font-medium">{t('field')}</th>
                  </tr>
                </thead>
                <tbody>
                  {session.columns.map((c) => (
                    <tr key={c.index} className="border-b last:border-0">
                      <td className="py-1.5 pe-3 font-medium">{session.headers[c.index] ?? ''}</td>
                      <td className="max-w-48 truncate py-1.5 pe-3 text-muted-foreground">
                        {session.sample
                          .slice(0, 2)
                          .map((r) => cell(r[c.index]))
                          .filter((v) => v !== '')
                          .join(' · ')}
                      </td>
                      <td className="py-1.5">
                        <Select
                          label={`${t('field')}: ${session.headers[c.index] ?? ''}`}
                          value={c.field ?? SKIP}
                          options={fieldOptions}
                          disabled={busy || running}
                          onChange={(value) =>
                            map.mutate({
                              columns: session.columns.map((other) =>
                                other.index === c.index
                                  ? { ...other, field: value === SKIP ? null : value }
                                  : value !== SKIP && other.field === value
                                    ? { ...other, field: null }
                                    : other,
                              ),
                            })
                          }
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {missing.length > 0 ? (
              <Alert tone="warning">
                {t('missing', { fields: missing.map((f) => f.label).join(', ') })}
              </Alert>
            ) : null}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor={`${id}-mode`}>{t('mode')}</Label>
                <Select
                  id={`${id}-mode`}
                  value={mode}
                  disabled={busy || running}
                  options={[
                    { value: 'create', label: t('modeCreate') },
                    { value: 'update', label: t('modeUpdate') },
                    { value: 'upsert', label: t('modeUpsert') },
                  ]}
                  onChange={(value) => setOption({ mode: value as Options['mode'] })}
                />
              </div>
              {mode === 'create' && options.key !== 'externalId' ? null : (
                <div className="space-y-1">
                  <Label htmlFor={`${id}-key`}>{t('key')}</Label>
                  <Select
                    id={`${id}-key`}
                    value={options.key ?? null}
                    placeholder={t('noKey')}
                    disabled={busy || running}
                    options={keyChoices.map((f) => ({ value: f.key, label: f.label }))}
                    onChange={(value) => setOption({ key: value })}
                  />
                </div>
              )}
              <div className="space-y-1">
                <Label htmlFor={`${id}-errors`}>{t('onError')}</Label>
                <Select
                  id={`${id}-errors`}
                  value={options.onError ?? 'stop'}
                  disabled={busy || running}
                  options={[
                    { value: 'stop', label: t('stop') },
                    { value: 'skip', label: t('skipErrors') },
                  ]}
                  onChange={(value) => setOption({ onError: value as Options['onError'] })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${id}-dates`}>{t('dateOrder')}</Label>
                <Select
                  id={`${id}-dates`}
                  value={options.dateOrder ?? 'dmy'}
                  disabled={busy || running}
                  options={[
                    { value: 'dmy', label: '31/12/2026' },
                    { value: 'mdy', label: '12/31/2026' },
                    { value: 'ymd', label: '2026/12/31' },
                  ]}
                  onChange={(value) => setOption({ dateOrder: value as Options['dateOrder'] })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${id}-decimal`}>{t('decimal')}</Label>
                <Select
                  id={`${id}-decimal`}
                  value={options.decimal ?? '.'}
                  disabled={busy || running}
                  options={[
                    { value: '.', label: t('decimalDot') },
                    { value: ',', label: t('decimalComma') },
                  ]}
                  onChange={(value) => setOption({ decimal: value as Options['decimal'] })}
                />
              </div>
              {(mappings.data?.mappings ?? []).length === 0 ? null : (
                <div className="space-y-1">
                  <Label htmlFor={`${id}-apply`}>{t('savedMappings')}</Label>
                  <Select
                    id={`${id}-apply`}
                    value={null}
                    placeholder={t('applyMapping')}
                    disabled={busy || running}
                    options={(mappings.data?.mappings ?? []).map((m) => ({
                      value: m.id,
                      label: m.name,
                    }))}
                    onChange={(value) => apply.mutate(value)}
                  />
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-end gap-3 border-t pt-3">
              <div className="min-w-48 flex-1 space-y-1">
                <Label htmlFor={`${id}-name`}>{t('mappingName')}</Label>
                <Input
                  id={`${id}-name`}
                  value={mappingName}
                  maxLength={100}
                  onChange={(e) => setMappingName(e.target.value)}
                />
              </div>
              <div className="flex items-center gap-2 pb-2">
                <Checkbox
                  id={`${id}-share`}
                  checked={share}
                  onCheckedChange={(v) => setShare(v === true)}
                />
                <Label htmlFor={`${id}-share`}>{t('shareMapping')}</Label>
              </div>
              <Button
                size="sm"
                busy={save.isPending}
                disabled={mappingName.trim() === '' || mapped.size === 0}
                onClick={() => save.mutate()}
              >
                <Save aria-hidden />
                {t('saveMapping')}
              </Button>
              {savedName === null ? null : (
                <p role="status" className="w-full text-sm text-muted-foreground">
                  {t('saved')}
                </p>
              )}
            </div>
          </div>
        ) : null}

        {step === 'result' && session !== null ? (
          <div className="space-y-3" aria-live="polite">
            {session.failure === null ? null : (
              <Alert>{t('failure', { reason: session.failure })}</Alert>
            )}
            {result === null ? null : session.resultDry ? (
              <Alert tone="info">
                {t('checked', { create: result.wouldCreate, update: result.wouldUpdate })}
              </Alert>
            ) : session.state === 'done' || session.state === 'undone' ? (
              <Alert tone="info">
                {t('imported', { created: result.created.length, updated: result.updated.length })}{' '}
                {result.skipped > 0 ? t('skippedRows', { count: result.skipped }) : null}
              </Alert>
            ) : null}
            {undone === null ? null : (
              <Alert tone="info">
                {t('undone', { deleted: undone.deleted, restored: undone.restored })}{' '}
                {undone.changed.length > 0
                  ? t('changedSince', { count: undone.changed.length })
                  : null}
              </Alert>
            )}
            <div className="flex flex-wrap gap-2">
              {session.rejected > 0 ? (
                <Button
                  size="sm"
                  busy={download.isPending}
                  onClick={() => download.mutate(`/api/v1/imports/${session.id}/rejected`)}
                >
                  <Download aria-hidden />
                  {t('rejected')}
                </Button>
              ) : null}
              {session.undoUntil === null ? null : (
                <Button
                  size="sm"
                  variant="danger"
                  busy={undo.isPending}
                  onClick={() => undo.mutate()}
                >
                  <Undo2 aria-hidden />
                  {t('undo')}
                </Button>
              )}
            </div>
            {result === null ? null : result.errors.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('noErrors')}</p>
            ) : (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold">
                    {t('errors', { count: result.errors.length })}
                  </h3>
                  <Select
                    label={t('errorColumn')}
                    className="w-56"
                    value={errorColumn}
                    onChange={setErrorColumn}
                    options={[
                      { value: 'all', label: t('allColumns') },
                      { value: 'row', label: t('wholeRow') },
                      ...[
                        ...new Set(
                          result.errors.flatMap((e) => (e.column === null ? [] : [e.column])),
                        ),
                      ]
                        .sort((a, b) => a - b)
                        .map((c) => ({ value: String(c), label: session.headers[c] ?? String(c) })),
                    ]}
                  />
                </div>
                <div className="max-h-72 overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-surface">
                      <tr className="border-b text-muted-foreground">
                        <th className="py-1.5 pe-3 text-start font-medium">{t('errorRow')}</th>
                        <th className="py-1.5 pe-3 text-start font-medium">{t('errorColumn')}</th>
                        <th className="py-1.5 text-start font-medium">{t('errorMessage')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shownErrors.map((e, i) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: errors are a fixed list for one result
                        <tr key={i} className="border-b last:border-0">
                          <td className="py-1.5 pe-3 tabular-nums">{e.row}</td>
                          <td className="py-1.5 pe-3">
                            {e.column === null ? t('wholeRow') : (session.headers[e.column] ?? '')}
                          </td>
                          <td className="py-1.5">{e.message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
