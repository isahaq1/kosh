/** On an inbound call's form (RFC 0017 §5.4): handle a verified call again (after fixing what made it fail). */
import { Alert, ApiError, Button, type NodeComponentProps } from '@kosh/ui';
import { useMutation } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';

export function InboundTools({ api, record }: NodeComponentProps): ReactElement | null {
  const { t } = useTranslation('integrations');
  const id = record?.['id'];
  const replay = useMutation({
    mutationFn: () => api.call('POST', `/api/v1/webhooks/inbound/${id}/replay`),
  });
  if (typeof id !== 'number' || record?.['verified'] !== true) return null;
  return (
    <div className="grid gap-2">
      <div>
        <Button variant="secondary" busy={replay.isPending} onClick={() => replay.mutate()}>
          {t('inbound.replay')}
        </Button>
      </div>
      {replay.isSuccess ? <Alert tone="info">{t('inbound.replayed')}</Alert> : null}
      {replay.error === null ? null : (
        <Alert tone="danger">
          {replay.error instanceof ApiError ? replay.error.message : String(replay.error)}
        </Alert>
      )}
    </div>
  );
}
