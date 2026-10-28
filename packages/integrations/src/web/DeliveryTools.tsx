/** On a delivery's form (RFC 0017 §5.3): send it again (the same event, for receivers that deduplicate by its id). */
import { Alert, ApiError, Button, type NodeComponentProps } from '@kosh/ui';
import { useMutation } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';

export function DeliveryTools({ api, record }: NodeComponentProps): ReactElement | null {
  const { t } = useTranslation('integrations');
  const id = record?.['id'];
  const replay = useMutation({
    mutationFn: () =>
      api.call<{ delivery: number }>('POST', `/api/v1/webhooks/deliveries/${id}/replay`),
  });
  if (typeof id !== 'number') return null;
  return (
    <div className="grid gap-2">
      <div>
        <Button variant="secondary" busy={replay.isPending} onClick={() => replay.mutate()}>
          {t('tools.replay')}
        </Button>
      </div>
      {replay.isSuccess ? <Alert tone="info">{t('tools.replayed')}</Alert> : null}
      {replay.error === null ? null : (
        <Alert tone="danger">
          {replay.error instanceof ApiError ? replay.error.message : String(replay.error)}
        </Alert>
      )}
    </div>
  );
}
