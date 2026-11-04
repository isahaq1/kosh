/**
 * The approval panel (RFC 0004 §6, RFC 0007, RFC 0025 §3.1): the web contribution of `@kosh/permissions`, registered as
 * the node component `approvals.Panel` and placed in a form by a view extension. The record's current round as steps —
 * each level with its state and votes, who decided and what they said —, earlier rounds behind a disclosure; the
 * user's decision when it is theirs (approve; reject or send back for changes with a reason) and, for the requester,
 * withdrawing. The server checks order, approvers, company and separation of duties.
 */
import { ApiError, Badge, Button, type NodeComponentProps, Textarea } from '@kosh/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactElement, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

type State = 'pending' | 'approved' | 'rejected' | 'sent_back' | 'cancelled';
interface Request {
  readonly id: number;
  readonly levelName: string;
  readonly sequence: number;
  readonly round: number;
  readonly approverRole: string;
  readonly approvals: number;
  readonly required: number;
  readonly state: State;
  readonly requestedBy: number | null;
  readonly comment: string | null;
}

const TONE = {
  pending: 'warning',
  approved: 'success',
  rejected: 'danger',
  sent_back: 'danger',
  cancelled: 'neutral',
} as const;
const DOT: Record<State, string> = {
  pending: 'border-warning bg-warning/20',
  approved: 'border-success bg-success',
  rejected: 'border-danger bg-danger',
  sent_back: 'border-danger bg-danger/40',
  cancelled: 'border-muted-foreground bg-muted',
};

function Round({ requests }: { readonly requests: readonly Request[] }): ReactElement {
  const { t } = useTranslation('approvalPanel');
  return (
    <ol className="grid gap-3">
      {requests.map((r) => (
        <li key={r.id} className="flex gap-3 text-sm">
          <span
            aria-hidden="true"
            className={`mt-1 size-3 shrink-0 rounded-full border-2 ${DOT[r.state]}`}
          />
          <span className="grid flex-1 gap-0.5">
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{r.levelName}</span>
              <Badge tone={TONE[r.state]}>{t(`state.${r.state}`)}</Badge>
              {r.required > 1 ? (
                <span className="text-xs text-muted-foreground">
                  {t('votes', { n: r.approvals, of: r.required })}
                </span>
              ) : null}
            </span>
            {r.approverRole === '' ? null : (
              <span className="text-xs text-muted-foreground">{r.approverRole}</span>
            )}
            {r.comment === null ? null : <span className="text-xs">“{r.comment}”</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function ApprovalPanel({
  record,
  model,
  api,
  version,
  reload,
}: NodeComponentProps): ReactElement | null {
  const { t } = useTranslation('approvalPanel');
  const queryClient = useQueryClient();
  const id = useId();
  const [comment, setComment] = useState('');
  const recordId = record?.id;
  const requests = useQuery({
    queryKey: ['approvals', model, recordId, version],
    queryFn: () =>
      api.call<{ requests: Request[] }>('GET', `/api/v1/approvals/${model}/${recordId}`),
    enabled: recordId !== undefined,
  });
  const inbox = useQuery({
    queryKey: ['approvals', 'inbox', version],
    queryFn: () => api.call<{ requests: { id: number }[] }>('GET', '/api/v1/approvals/inbox'),
    enabled: recordId !== undefined,
  });
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.me() });
  const done = async () => {
    setComment('');
    await queryClient.invalidateQueries({ queryKey: ['approvals'] });
    reload();
  };
  const decide = useMutation({
    mutationFn: ({
      request,
      decision,
    }: {
      request: number;
      decision: 'approve' | 'reject' | 'send-back';
    }) =>
      api.call(
        'POST',
        `/api/v1/approvals/requests/${request}/${decision}`,
        comment.trim() === '' ? {} : { comment: comment.trim() },
      ),
    onSuccess: done,
  });
  const withdraw = useMutation({
    mutationFn: () => api.call('POST', `/api/v1/approvals/${model}/${recordId}/withdraw`),
    onSuccess: done,
  });
  if (recordId === undefined) return null;
  const all = requests.data?.requests ?? [];
  if (all.length === 0) return null;
  const last = Math.max(...all.map((r) => r.round));
  const current = all.filter((r) => r.round === last && r.state !== 'cancelled');
  const earlier = all.filter((r) => r.round < last && r.state !== 'cancelled');
  const mine = new Set((inbox.data?.requests ?? []).map((r) => r.id));
  const actionable = current.find((r) => mine.has(r.id));
  const asked = current.some((r) => r.state === 'pending' && r.requestedBy === me.data?.id);
  const error = decide.error ?? withdraw.error;
  return (
    <section aria-labelledby={`${id}-title`} className="rounded-lg border bg-surface p-4">
      <h2 id={`${id}-title`} className="mb-3 flex items-center gap-2 text-sm font-semibold">
        {t('title')}
        {last > 1 ? <Badge tone="neutral">{t('round', { n: last })}</Badge> : null}
      </h2>
      {current.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('withdrawn')}</p>
      ) : (
        <Round requests={current} />
      )}
      {earlier.length === 0 ? null : (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-muted-foreground">
            {t('earlier', { count: earlier.length })}
          </summary>
          <div className="mt-2">
            <Round requests={earlier} />
          </div>
        </details>
      )}
      {actionable === undefined ? null : (
        <div className="mt-4 grid gap-2">
          <label htmlFor={`${id}-comment`} className="text-sm font-medium">
            {t('yourDecision', { level: actionable.levelName })}
          </label>
          <Textarea
            id={`${id}-comment`}
            placeholder={t('commentHint')}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              disabled={decide.isPending}
              onClick={() => decide.mutate({ request: actionable.id, decision: 'approve' })}
            >
              {t('approve')}
            </Button>
            <Button
              disabled={decide.isPending || comment.trim() === ''}
              onClick={() => decide.mutate({ request: actionable.id, decision: 'send-back' })}
            >
              {t('sendBack')}
            </Button>
            <Button
              variant="danger"
              disabled={decide.isPending || comment.trim() === ''}
              onClick={() => decide.mutate({ request: actionable.id, decision: 'reject' })}
            >
              {t('reject')}
            </Button>
          </div>
        </div>
      )}
      {asked ? (
        <div className="mt-3">
          <Button variant="ghost" disabled={withdraw.isPending} onClick={() => withdraw.mutate()}>
            {t('withdraw')}
          </Button>
        </div>
      ) : null}
      {error === null ? null : (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error instanceof ApiError ? error.message : String(error)}
        </p>
      )}
    </section>
  );
}
