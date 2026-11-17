/**
 * Accounting › Configuration › Start from your figures (RFC 0036 §2.1): the opening-balance kit on screen, for
 * Administrators. Download the workbook, fill it, check it — every error with its sheet and row, then the proof —
 * load it when every check is equal, and undo it until the first posting after it. The server decides everything;
 * this page shows its answers.
 */
import { Badge, Button, Dialog, Input, Label, type PageProps, useKosh } from '@kosh/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactElement, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly summary: string;
  readonly differences: readonly {
    readonly what: string;
    readonly workbook: string;
    readonly kosh: string;
  }[];
}
interface Report {
  readonly cutoff: string | null;
  readonly status: 'loaded' | 'checked' | 'refused' | 'already';
  readonly errors: readonly {
    readonly sheet: string;
    readonly row: number;
    readonly message: string;
  }[];
  readonly entryLines: number;
  readonly documents: number;
  readonly adjustments: number;
  readonly checks: readonly Check[];
  readonly ok: boolean;
}
interface Opening {
  readonly id: number;
  readonly cutoff: string;
  readonly status: 'loaded' | 'undone';
  readonly loadedBy: string | null;
  readonly loadedAt: string | null;
  readonly entryLines: number;
  readonly documents: number;
  readonly adjustments: number;
  readonly workbookHash: string | null;
  readonly checks: readonly Check[];
  readonly undoneBy: string | null;
  readonly undoneAt: string | null;
  readonly undoReason: string | null;
}
interface State {
  readonly openings: readonly Opening[];
  readonly canUndo: boolean;
  readonly postedAfter: number;
}

/** A file as base64, as the API takes the workbook. */
async function base64Of(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function Checks({ checks }: { readonly checks: readonly Check[] }): ReactElement {
  const { t } = useTranslation('accounting');
  return (
    <ul className="grid gap-2">
      {checks.map((c) => (
        <li key={c.name} className="rounded-md border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={c.ok ? 'success' : 'danger'}>
              {c.ok ? t('opening.equal') : t('opening.differs')}
            </Badge>
            <span className="font-medium">
              {t(`opening.check.${c.name}`, { defaultValue: c.name })}
            </span>
            <span className="text-sm text-muted-foreground">{c.summary}</span>
          </div>
          {c.differences.length > 0 ? (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted">
                  <tr>
                    <th className="px-2 py-1 text-start">{t('opening.what')}</th>
                    <th className="px-2 py-1 text-end">{t('opening.inWorkbook')}</th>
                    <th className="px-2 py-1 text-end">{t('opening.inBooks')}</th>
                  </tr>
                </thead>
                <tbody>
                  {c.differences.map((d) => (
                    <tr key={d.what} className="border-b">
                      <td className="px-2 py-1">{d.what}</td>
                      <td className="px-2 py-1 text-end tabular-nums">{d.workbook}</td>
                      <td className="px-2 py-1 text-end tabular-nums">{d.kosh}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function OpeningPage({ api }: PageProps): ReactElement {
  const { t } = useTranslation('accounting');
  const { format } = useKosh();
  const client = useQueryClient();
  const id = useId();
  const [file, setFile] = useState<File | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [reason, setReason] = useState('');
  // What just happened, said on the page (and to screen readers).
  const [notice, setNotice] = useState<{
    readonly tone: 'success' | 'danger';
    readonly title: string;
    readonly description?: string;
  } | null>(null);
  const toast = setNotice;

  const state = useQuery({
    queryKey: ['accounting', 'opening'],
    queryFn: () => api.call<State>('GET', '/api/v1/accounting/opening'),
    retry: false,
  });
  const failed = (error: unknown) =>
    toast({
      title: t('opening.failed'),
      description: error instanceof Error ? error.message : String(error),
      tone: 'danger',
    });
  const template = useMutation({
    mutationFn: () => api.download('/api/v1/accounting/opening/template', undefined, 'GET'),
    onSuccess: ({ blob, filename }) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    },
    onError: failed,
  });
  const run = useMutation({
    mutationFn: async (commit: boolean) =>
      api.call<Report>('POST', `/api/v1/accounting/opening/${commit ? 'load' : 'check'}`, {
        content: await base64Of(file as File),
      }),
    onSuccess: (answer) => {
      setReport(answer);
      setConfirming(false);
      if (answer.status === 'loaded') {
        toast({ title: t('opening.loadedToast', { date: answer.cutoff }), tone: 'success' });
        void client.invalidateQueries({ queryKey: ['accounting', 'opening'] });
      }
    },
    onError: (error) => {
      setConfirming(false);
      failed(error);
    },
  });
  const undo = useMutation({
    mutationFn: () =>
      api.call<{ cutoff: string; reversed: number; returned: number }>(
        'POST',
        '/api/v1/accounting/opening/undo',
        { reason },
      ),
    onSuccess: (done) => {
      setUndoing(false);
      setReason('');
      setReport(null);
      toast({
        title: t('opening.undoneToast', { date: done.cutoff }),
        description: t('opening.undoneDetail', {
          reversed: done.reversed,
          returned: done.returned,
        }),
        tone: 'success',
      });
      void client.invalidateQueries({ queryKey: ['accounting', 'opening'] });
    },
    onError: (error) => {
      setUndoing(false);
      failed(error);
    },
  });

  if (state.isError)
    return (
      <div className="grid gap-2 p-4">
        <h1 className="text-xl font-semibold">{t('opening.title')}</h1>
        <p role="alert" className="text-sm text-muted-foreground">
          {t('opening.administrators')}
        </p>
      </div>
    );
  const loaded = state.data?.openings.find((o) => o.status === 'loaded');
  const undone = (state.data?.openings ?? []).filter((o) => o.status === 'undone');
  const when = (at: string | null) => (at === null ? '' : format.datetime(at));

  return (
    <div className="mx-auto grid max-w-4xl gap-6 p-4">
      <header className="grid gap-1">
        <h1 className="text-xl font-semibold">{t('opening.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('opening.intro')}</p>
      </header>

      {notice !== null ? (
        <div
          role={notice.tone === 'danger' ? 'alert' : 'status'}
          className="flex flex-wrap items-center gap-2 rounded-md border p-3 text-sm"
        >
          <Badge tone={notice.tone}>{notice.title}</Badge>
          {notice.description === undefined ? null : <span>{notice.description}</span>}
        </div>
      ) : null}

      {loaded !== undefined ? (
        <section aria-labelledby={`${id}-loaded`} className="grid gap-3 rounded-lg border p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id={`${id}-loaded`} className="font-semibold">
              {t('opening.loadedTitle', { date: format.date(loaded.cutoff) })}
            </h2>
            <Badge tone="success">{t('opening.status.loaded')}</Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            {t('opening.loadedBy', { name: loaded.loadedBy ?? '—', at: when(loaded.loadedAt) })}
            {' · '}
            {t('opening.made', {
              lines: loaded.entryLines,
              documents: loaded.documents,
              adjustments: loaded.adjustments,
            })}
          </p>
          <Checks checks={loaded.checks} />
          {loaded.workbookHash !== null ? (
            <p className="break-all text-xs text-muted-foreground">
              {t('opening.hash')}: <code>{loaded.workbookHash}</code>
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="secondary"
              disabled={state.data?.canUndo !== true}
              onClick={() => setUndoing(true)}
            >
              {t('opening.undo')}
            </Button>
            <p className="text-sm text-muted-foreground">
              {state.data?.canUndo === true
                ? t('opening.undoHint')
                : t('opening.undoOver', { count: state.data?.postedAfter ?? 0 })}
            </p>
          </div>
        </section>
      ) : (
        <>
          <section aria-labelledby={`${id}-one`} className="grid gap-2 rounded-lg border p-4">
            <h2 id={`${id}-one`} className="font-semibold">
              {t('opening.step1')}
            </h2>
            <p className="text-sm text-muted-foreground">{t('opening.step1Hint')}</p>
            <div>
              <Button
                variant="secondary"
                busy={template.isPending}
                onClick={() => template.mutate()}
              >
                {t('opening.download')}
              </Button>
            </div>
          </section>

          <section aria-labelledby={`${id}-two`} className="grid gap-3 rounded-lg border p-4">
            <h2 id={`${id}-two`} className="font-semibold">
              {t('opening.step2')}
            </h2>
            <p className="text-sm text-muted-foreground">{t('opening.step2Hint')}</p>
            <div className="grid gap-1">
              <Label htmlFor={`${id}-file`}>{t('opening.file')}</Label>
              <input
                id={`${id}-file`}
                type="file"
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                onChange={(e) => {
                  setFile(e.target.files?.[0] ?? null);
                  setReport(null);
                }}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                disabled={file === null}
                busy={run.isPending && run.variables === false}
                onClick={() => run.mutate(false)}
              >
                {t('opening.checkIt')}
              </Button>
              <Button
                variant="secondary"
                disabled={file === null || report?.status !== 'checked'}
                onClick={() => setConfirming(true)}
              >
                {t('opening.load')}
              </Button>
            </div>
            {report?.status !== 'checked' && file !== null ? (
              <p className="text-sm text-muted-foreground">{t('opening.loadHint')}</p>
            ) : null}
          </section>
        </>
      )}

      {report !== null && report.status !== 'loaded' ? (
        <section aria-labelledby={`${id}-report`} aria-live="polite" className="grid gap-3">
          <h2 id={`${id}-report`} className="font-semibold">
            {t(`opening.result.${report.status}`, { date: report.cutoff ?? '' })}
          </h2>
          {report.errors.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted">
                  <tr>
                    <th className="px-2 py-1 text-start">{t('opening.sheet')}</th>
                    <th className="px-2 py-1 text-end">{t('opening.row')}</th>
                    <th className="px-2 py-1 text-start">{t('opening.problem')}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.errors.map((e) => (
                    <tr key={`${e.sheet}:${e.row}:${e.message}`} className="border-b">
                      <td className="px-2 py-1">{e.sheet}</td>
                      <td className="px-2 py-1 text-end tabular-nums">{e.row > 0 ? e.row : ''}</td>
                      <td className="px-2 py-1">{e.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t('opening.made', {
                lines: report.entryLines,
                documents: report.documents,
                adjustments: report.adjustments,
              })}
            </p>
          )}
          <Checks checks={report.checks} />
        </section>
      ) : null}

      {undone.length > 0 ? (
        <section aria-labelledby={`${id}-history`} className="grid gap-2">
          <h2 id={`${id}-history`} className="font-semibold">
            {t('opening.history')}
          </h2>
          <ul className="grid gap-2">
            {undone.map((o) => (
              <li key={o.id} className="rounded-md border p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="neutral">{t('opening.status.undone')}</Badge>
                  <span className="font-medium">{format.date(o.cutoff)}</span>
                </div>
                <p className="text-muted-foreground">
                  {t('opening.undoneBy', { name: o.undoneBy ?? '—', at: when(o.undoneAt) })}
                  {o.undoReason === null ? '' : ` — ${o.undoReason}`}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <Dialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('opening.confirmTitle', { date: report?.cutoff ?? '' })}
        description={t('opening.confirmText')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              {t('opening.cancel')}
            </Button>
            <Button variant="primary" busy={run.isPending} onClick={() => run.mutate(true)}>
              {t('opening.load')}
            </Button>
          </>
        }
      />
      <Dialog
        open={undoing}
        onOpenChange={setUndoing}
        title={t('opening.undoTitle')}
        description={t('opening.undoText')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setUndoing(false)}>
              {t('opening.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={reason.trim() === ''}
              busy={undo.isPending}
              onClick={() => undo.mutate()}
            >
              {t('opening.undo')}
            </Button>
          </>
        }
      >
        <div className="grid gap-1">
          <Label htmlFor={`${id}-reason`}>{t('opening.reason')}</Label>
          <Input id={`${id}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
      </Dialog>
    </div>
  );
}
