/**
 * The approval panel (RFC 0004 §6, RFC 0007): the web contribution of `@isahaq/kosh-permissions`, registered as the node
 * component `approvals.Panel` and placed in a form by a view extension. Shows the record's approval levels and lets
 * the current user decide the requests they may decide now (the server checks order, role, company and separation
 * of duties).
 */
import { ApiError, Badge, Button, type NodeComponentProps, Textarea } from '@isahaq/kosh-ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactElement, useId, useState } from 'react';

interface Request {
  readonly id: number;
  readonly levelName: string;
  readonly sequence: number;
  readonly approverRole: string;
  readonly state: 'pending' | 'approved' | 'rejected' | 'cancelled';
  readonly decidedBy: number | null;
  readonly comment: string | null;
}

const TONE = {
  pending: 'warning',
  approved: 'success',
  rejected: 'danger',
  cancelled: 'neutral',
} as const;

export function ApprovalPanel({
  record,
  model,
  api,
  version,
  reload,
}: NodeComponentProps): ReactElement | null {
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
  const decide = useMutation({
    mutationFn: ({ request, decision }: { request: number; decision: 'approve' | 'reject' }) =>
      api.call(
        'POST',
        `/api/v1/approvals/requests/${request}/${decision}`,
        comment.trim() === '' ? {} : { comment: comment.trim() },
      ),
    onSuccess: async () => {
      setComment('');
      await queryClient.invalidateQueries({ queryKey: ['approvals'] });
      reload();
    },
  });
  if (recordId === undefined) return null;
  const current = (requests.data?.requests ?? []).filter((r) => r.state !== 'cancelled');
  if (current.length === 0) return null;
  const mine = new Set((inbox.data?.requests ?? []).map((r) => r.id));
  const actionable = current.find((r) => mine.has(r.id));
  return (
    <section aria-labelledby={`${id}-title`} className="rounded-lg border bg-surface p-4">
      <h2 id={`${id}-title`} className="mb-3 text-sm font-semibold">
        Approvals
      </h2>
      <ol className="grid gap-2">
        {current.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span>
              <span className="font-medium">{r.levelName}</span>
              <span className="text-muted-foreground"> · {r.approverRole}</span>
              {r.comment === null ? null : (
                <span className="block text-xs text-muted-foreground">“{r.comment}”</span>
              )}
            </span>
            <Badge tone={TONE[r.state]}>{r.state}</Badge>
          </li>
        ))}
      </ol>
      {actionable === undefined ? null : (
        <div className="mt-4 grid gap-2">
          <label htmlFor={`${id}-comment`} className="text-sm text-muted-foreground">
            Comment
          </label>
          <Textarea
            id={`${id}-comment`}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
          {decide.error === null ? null : (
            <p role="alert" className="text-sm text-danger">
              {decide.error instanceof ApiError ? decide.error.message : String(decide.error)}
            </p>
          )}
          <div className="flex gap-2">
            <Button
              variant="primary"
              size="sm"
              busy={decide.isPending}
              onClick={() => decide.mutate({ request: actionable.id, decision: 'approve' })}
            >
              Approve {actionable.levelName}
            </Button>
            <Button
              variant="danger"
              size="sm"
              busy={decide.isPending}
              onClick={() => decide.mutate({ request: actionable.id, decision: 'reject' })}
            >
              Reject
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
