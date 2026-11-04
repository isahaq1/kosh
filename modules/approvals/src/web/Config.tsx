/**
 * The policy and category editor's helpers (RFC 0025 step 4), node components of their forms:
 * - `approvals.PolicyPreview`: which of the last 50 records each level of the policy would have asked about, so a
 *   condition is checked before anyone submits;
 * - `approvals.CategoryPolicy`: a request category's approval policy — made on demand when it has none, opened when
 *   it has one (its levels are edited there).
 * Shown to Approvals managers (the server decides).
 */
import { Alert, Button, type NodeComponentProps } from '@kosh/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { type ReactElement, useState } from 'react';
import { useTranslation } from 'react-i18next';

export function PolicyPreview({ api, record, version }: NodeComponentProps): ReactElement | null {
  const { t } = useTranslation('approvals');
  const id = typeof record?.id === 'number' ? record.id : null;
  const preview = useQuery({
    queryKey: ['approvals.preview', id, version],
    enabled: id !== null,
    queryFn: () =>
      api.call<{ records: number; levels: { id: number; name: string; matched: number[] }[] }>(
        'GET',
        `/api/v1/approvals/policies/${String(id)}/preview`,
      ),
  });
  if (id === null || preview.isError) return null;
  if (preview.isPending) return <p className="text-sm text-muted-foreground">{t('loading')}</p>;
  const { records, levels } = preview.data;
  return (
    <section
      aria-label={t('preview.title')}
      className="grid gap-1 rounded-md border border-border p-3"
    >
      <h3 className="text-sm font-semibold">{t('preview.title')}</h3>
      <p className="text-xs text-muted-foreground">{t('preview.explain', { count: records })}</p>
      <ul className="grid gap-1 text-sm">
        {levels.map((l) => (
          <li key={l.id} className="flex items-center justify-between gap-2">
            <span>{l.name}</span>
            <span className="tabular-nums text-muted-foreground">
              {t('preview.matched', { matched: l.matched.length, count: records })}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function CategoryPolicy({ api, record, reload }: NodeComponentProps): ReactElement | null {
  const { t } = useTranslation('approvals');
  const [error, setError] = useState<string | null>(null);
  const id = typeof record?.id === 'number' ? record.id : null;
  const make = useMutation({
    mutationFn: () =>
      api.call<{ policy: number }>('POST', `/api/v1/approvals/categories/${String(id)}/policy`, {}),
    onSuccess: (r) => {
      setError(null);
      reload();
      window.location.assign(`/approvals/a/approvals.action_policies/${r.policy}`);
    },
    onError: (e) => setError(e.message),
  });
  if (id === null) return null;
  const policy = record?.['policy'];
  const policyId =
    typeof policy === 'number'
      ? policy
      : typeof policy === 'object' && policy !== null
        ? Number((policy as { id?: unknown }).id)
        : null;
  return (
    <div className="grid gap-2">
      {error === null ? null : <Alert tone="danger">{error}</Alert>}
      {policyId === null ? (
        <div>
          <Button busy={make.isPending} onClick={() => make.mutate()}>
            {t('category.setUp')}
          </Button>
        </div>
      ) : (
        <a
          className="text-sm text-primary underline"
          href={`/approvals/a/approvals.action_policies/${policyId}`}
        >
          {t('category.editLevels')}
        </a>
      )}
    </div>
  );
}
