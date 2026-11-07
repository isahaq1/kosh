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
  readonly approvers: readonly number[];
  readonly backups: readonly number[];
  readonly comment: string | null;
  readonly startedAt: string | null;
  readonly decidedAt: string | null;
  readonly explanation: string | null;
}
interface Event {
  readonly id: number;
  readonly request: number;
  readonly at: string;
  readonly kind: string;
  readonly note: string | null;
}

/** Whole hours between two instants (to now when `to` is null). */
const hoursBetween = (from: string, to: string | null): number =>
  Math.max(
    0,
    Math.round(((to === null ? Date.now() : Date.parse(to)) - Date.parse(from)) / 3_600_000),
  );

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

function Round({
  requests,
  events = [],
}: {
  readonly requests: readonly Request[];
  readonly events?: readonly Event[];
}): ReactElement {
  const { t, i18n } = useTranslation('approvalPanel');
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
            {r.state === 'pending' && r.startedAt !== null ? (
              <span className="text-xs text-muted-foreground">
                {t('since', { hours: hoursBetween(r.startedAt, null) })}
              </span>
            ) : null}
            {r.explanation === null && !events.some((e) => e.request === r.id) ? null : (
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">{t('how')}</summary>
                {r.explanation === null ? null : <p className="mt-1">{r.explanation}</p>}
                <ul className="mt-1 grid gap-0.5" aria-label={t('log')}>
                  {events
                    .filter((e) => e.request === r.id)
                    .map((e) => (
                      <li key={e.id}>
                        <time dateTime={e.at}>{new Date(e.at).toLocaleString(i18n.language)}</time>{' '}
                        · {t(`event.${e.kind}`)}
                        {e.note === null || e.kind === 'created' ? '' : ` — ${e.note}`}
                      </li>
                    ))}
                </ul>
              </details>
            )}
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
      api.call<{ requests: Request[]; events?: Event[]; manage?: boolean }>(
        'GET',
        `/api/v1/approvals/${model}/${recordId}`,
      ),
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
  const [reassigning, setReassigning] = useState(false);
  const [chosen, setChosen] = useState<number[]>([]);
  const [mode, setMode] = useState<'replace' | 'add'>('replace');
  const [reason, setReason] = useState('');
  const people = useQuery({
    queryKey: ['approvals', 'people'],
    queryFn: () =>
      api.call<{ items: { id: number; name: string }[] }>(
        'GET',
        '/api/v1/models/res.users?fields=id,name&limit=200&order=name',
      ),
    enabled: reassigning,
  });
  const reassign = useMutation({
    mutationFn: (request: number) =>
      api.call('POST', `/api/v1/approvals/requests/${request}/reassign`, {
        users: chosen,
        mode,
        reason: reason.trim(),
      }),
    onSuccess: async () => {
      setReassigning(false);
      setChosen([]);
      setReason('');
      await done();
    },
  });
  const tell = useMutation({
    mutationFn: (request: number) =>
      api.call('POST', `/api/v1/approvals/requests/${request}/notify-backups`, {}),
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
  const error = decide.error ?? withdraw.error ?? reassign.error ?? tell.error;
  const manage = requests.data?.manage === true;
  // The waiting request whose turn it is (the first, when levels decide side by side).
  const waiting = current.find((r) => r.state === 'pending' && r.startedAt !== null);
  const mayTell =
    waiting !== undefined &&
    waiting.backups.length > 0 &&
    (manage || waiting.approvers.includes(me.data?.id ?? -1));
  return (
    <section aria-labelledby={`${id}-title`} className="rounded-lg border bg-surface p-4">
      <h2 id={`${id}-title`} className="mb-3 flex items-center gap-2 text-sm font-semibold">
        {t('title')}
        {last > 1 ? <Badge tone="neutral">{t('round', { n: last })}</Badge> : null}
      </h2>
      {current.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('withdrawn')}</p>
      ) : (
        <Round requests={current} events={requests.data?.events ?? []} />
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
      {waiting !== undefined && (manage || mayTell) ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {manage ? (
            <Button variant="ghost" onClick={() => setReassigning((v) => !v)}>
              {t('reassign')}
            </Button>
          ) : null}
          {mayTell ? (
            <Button
              variant="ghost"
              disabled={tell.isPending}
              onClick={() => tell.mutate(waiting.id)}
            >
              {t('tellBackups')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {reassigning && waiting !== undefined ? (
        <fieldset className="mt-3 grid gap-2 rounded-md border p-3">
          <legend className="px-1 text-sm font-medium">
            {t('reassignLevel', { level: waiting.levelName })}
          </legend>
          <label htmlFor={`${id}-people`} className="text-sm">
            {t('newApprovers')}
          </label>
          <select
            id={`${id}-people`}
            multiple
            className="min-h-24 rounded-md border bg-surface p-1 text-sm"
            value={chosen.map(String)}
            onChange={(e) => setChosen([...e.target.selectedOptions].map((o) => Number(o.value)))}
          >
            {(people.data?.items ?? [])
              .filter((u) => u.id !== waiting.requestedBy)
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
          </select>
          <div className="flex flex-wrap gap-3 text-sm">
            {(['replace', 'add'] as const).map((m) => (
              <label key={m} className="flex items-center gap-1">
                <input
                  type="radio"
                  name={`${id}-mode`}
                  checked={mode === m}
                  onChange={() => setMode(m)}
                />
                {t(`mode.${m}`)}
              </label>
            ))}
          </div>
          <label htmlFor={`${id}-reason`} className="text-sm">
            {t('reason')}
          </label>
          <Textarea
            id={`${id}-reason`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <div>
            <Button
              variant="primary"
              disabled={reassign.isPending || chosen.length === 0 || reason.trim() === ''}
              onClick={() => reassign.mutate(waiting.id)}
            >
              {t('reassignConfirm')}
            </Button>
          </div>
        </fieldset>
      ) : null}
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
