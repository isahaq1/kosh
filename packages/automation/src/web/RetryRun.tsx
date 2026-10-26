/** A failed run's "Try again" (the `automation.RetryRun` component node of the run form). */
import { Alert, Button, type NodeComponentProps } from '@kosh/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RotateCcw } from 'lucide-react';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';

export function RetryRun({ record, api, reload }: NodeComponentProps): ReactElement | null {
  const { t } = useTranslation('automation');
  const queryClient = useQueryClient();
  const retry = useMutation({
    mutationFn: () =>
      api.call<{ outcomes: unknown }>(
        'POST',
        `/api/v1/automation/runs/${String(record?.['id'])}/retry`,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['list', 'automation.run'] });
      reload();
    },
  });
  if (record === null || record['state'] !== 'failed') return null;
  return (
    <div className="grid gap-2">
      <Button
        size="sm"
        variant="secondary"
        className="justify-self-start"
        busy={retry.isPending}
        onClick={() => retry.mutate()}
      >
        <RotateCcw aria-hidden /> {t('runs.retry')}
      </Button>
      {retry.error === null ? null : <Alert>{retry.error.message}</Alert>}
      {retry.isSuccess ? <Alert tone="info">{t('runs.retried')}</Alert> : null}
    </div>
  );
}
