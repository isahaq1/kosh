/**
 * "Review changes" (RFC 0012 §5.6): what the server says the change does — the module's version, the diff of every
 * file and the migration's SQL — then Apply (write mode) or the patch to download (propose mode). The server plans
 * and checks everything; this dialog only shows its answer.
 */
import {
  Alert,
  ApiError,
  Button,
  cn,
  Dialog,
  type KoshApi,
  Spinner,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@kosh/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { StudioReview } from '../module.js';
import type { StudioSpec } from '../spec.js';

export type StudioMode = 'write' | 'propose';

export const message = (error: unknown): string =>
  error instanceof ApiError
    ? error.message
    : error instanceof Error
      ? error.message
      : String(error);

/** A unified diff, its added and removed lines tinted. */
function Diff({ text }: { readonly text: string }): ReactElement {
  return (
    <pre className="overflow-x-auto rounded-md border bg-muted/40 p-2 font-mono text-xs leading-5">
      {text.split('\n').map((line, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: the lines of a diff have no other identity
          key={i}
          className={cn(
            'block whitespace-pre',
            line.startsWith('+') && !line.startsWith('+++') && 'bg-success/10 text-success',
            line.startsWith('-') && !line.startsWith('---') && 'bg-danger/10 text-danger',
            line.startsWith('@@') && 'text-muted-foreground',
          )}
        >
          {line === '' ? ' ' : line}
        </span>
      ))}
    </pre>
  );
}

export function ReviewDialog({
  api,
  spec,
  mode,
  onClose,
  onApplied,
  retire,
  git,
}: {
  /** The repository proposals go to, when one is configured (propose mode). */
  readonly git?: { readonly provider: 'github' | 'gitlab'; readonly repository: string } | null;
  readonly api: KoshApi;
  readonly spec: StudioSpec;
  /** Rules moved into the module: archived once its copy is installed (from `/edit`). */
  readonly retire?: readonly number[];
  readonly mode: StudioMode;
  readonly onClose: () => void;
  readonly onApplied: () => void;
}): ReactElement {
  const { t } = useTranslation('studio');
  const review = useQuery({
    queryKey: ['studio', 'preview', JSON.stringify(spec)],
    queryFn: () => api.call<StudioReview>('POST', '/api/v1/studio/preview', { spec }),
    retry: false,
    gcTime: 0,
  });
  const apply = useMutation({
    mutationFn: (r: StudioReview) =>
      api.call<{ name: string; version: string }>('POST', '/api/v1/studio/apply', {
        spec,
        planId: r.planId,
        ...(retire === undefined || retire.length === 0 ? {} : { retire }),
      }),
    onSuccess: onApplied,
  });
  const propose = useMutation({
    mutationFn: () =>
      api.call<{ patch: string; spec: StudioSpec }>('POST', '/api/v1/studio/propose', { spec }),
    onSuccess: ({ patch, spec: proposed }) => {
      const url = URL.createObjectURL(new Blob([patch], { type: 'text/x-diff' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `${proposed.name}-${proposed.version}.patch`;
      link.click();
      URL.revokeObjectURL(url);
    },
  });
  const pull = useMutation({
    mutationFn: () =>
      api.call<{ pullRequest: { url: string; branch: string } }>('POST', '/api/v1/studio/propose', {
        spec,
        pullRequest: true,
      }),
  });
  const r = review.data;
  return (
    <Dialog
      open
      wide
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('reviewTitle', {
        name: r?.spec.label ?? spec.label,
        version: r?.spec.version ?? spec.version,
      })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('cancel')}
          </Button>
          {mode === 'write' ? (
            <Button
              variant="primary"
              disabled={r === undefined || r.destructive || apply.isSuccess}
              busy={apply.isPending}
              onClick={() => {
                if (r !== undefined) apply.mutate(r);
              }}
            >
              {t('apply')}
            </Button>
          ) : (
            <>
              <Button
                variant={git === null || git === undefined ? 'primary' : 'secondary'}
                disabled={r === undefined}
                busy={propose.isPending}
                onClick={() => propose.mutate()}
              >
                {t('propose')}
              </Button>
              {git === null || git === undefined ? null : (
                <Button
                  variant="primary"
                  disabled={r === undefined || pull.isSuccess}
                  busy={pull.isPending}
                  onClick={() => pull.mutate()}
                >
                  {t(git.provider === 'gitlab' ? 'openMergeRequest' : 'openPullRequest')}
                </Button>
              )}
            </>
          )}
        </>
      }
    >
      {review.isPending ? <Spinner label={t('review')} /> : null}
      {review.isError ? <Alert>{message(review.error)}</Alert> : null}
      {r === undefined ? null : (
        <div className="space-y-3">
          <p className="text-sm">
            {r.change === 'install'
              ? t('reviewInstall', { name: r.spec.name })
              : t('reviewUpgrade', { name: r.spec.name, from: r.from, to: r.spec.version })}
          </p>
          {r.destructive ? <Alert tone="warning">{t('destructive')}</Alert> : null}
          {mode === 'propose' ? <Alert tone="info">{t('proposeNote')}</Alert> : null}
          <Tabs defaultValue="code">
            <TabsList>
              <TabsTrigger value="code">{t('tabCode', { count: r.diff.length })}</TabsTrigger>
              <TabsTrigger value="sql">{t('tabSql', { count: r.statements.length })}</TabsTrigger>
            </TabsList>
            <TabsContent value="code" className="space-y-3">
              {r.diff.map((d) => (
                <section key={d.path} aria-label={d.path}>
                  <h3 className="mb-1 font-mono text-xs font-semibold">{d.path}</h3>
                  <Diff text={d.diff} />
                </section>
              ))}
            </TabsContent>
            <TabsContent value="sql">
              {r.statements.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('noSql')}</p>
              ) : (
                <pre className="overflow-x-auto rounded-md border bg-muted/40 p-2 font-mono text-xs leading-5">
                  {r.statements.map((s) => `${s};`).join('\n\n')}
                </pre>
              )}
            </TabsContent>
          </Tabs>
        </div>
      )}
      {apply.isError ? <Alert>{message(apply.error)}</Alert> : null}
      {propose.isError ? <Alert>{message(propose.error)}</Alert> : null}
      {pull.isError ? <Alert>{message(pull.error)}</Alert> : null}
      {pull.isSuccess ? (
        <Alert tone="info">
          {t('proposalOpened', { repository: git?.repository ?? '' })}{' '}
          <a
            className="font-medium underline"
            href={pull.data.pullRequest.url}
            target="_blank"
            rel="noreferrer"
          >
            {pull.data.pullRequest.url}
          </a>
        </Alert>
      ) : null}
      {apply.isSuccess ? (
        <Alert tone="info">
          {t('applied', { name: apply.data.name, version: apply.data.version })}
        </Alert>
      ) : null}
    </Dialog>
  );
}
