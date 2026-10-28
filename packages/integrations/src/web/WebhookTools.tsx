/**
 * On a webhook's form (RFC 0017 §5.3): send a test event, rotate the signing secret, and the events this
 * installation offers. The server checks and sends; the panel shows what it answers.
 */
import { Alert, ApiError, Button, type NodeComponentProps } from '@kosh/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';

interface WebhookEvent {
  readonly event: string;
  readonly label: string;
}

export function WebhookTools({ api, record, reload }: NodeComponentProps): ReactElement | null {
  const { t } = useTranslation('integrations');
  const id = record?.['id'];
  const events = useQuery({
    queryKey: ['integrations', 'events'],
    queryFn: () => api.call<{ events: WebhookEvent[] }>('GET', '/api/v1/webhooks/events'),
  });
  const ping = useMutation({
    mutationFn: () => api.call('POST', `/api/v1/webhooks/subscriptions/${id}/ping`),
  });
  const rotate = useMutation({
    mutationFn: () => api.call('POST', `/api/v1/webhooks/subscriptions/${id}/rotate-secret`),
    onSuccess: () => reload(),
  });
  const error = ping.error ?? rotate.error;
  return (
    <section className="grid gap-3 rounded-lg border p-4" aria-label={t('tools.title')}>
      {typeof id !== 'number' ? null : (
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" busy={ping.isPending} onClick={() => ping.mutate()}>
            {t('tools.ping')}
          </Button>
          <Button variant="secondary" busy={rotate.isPending} onClick={() => rotate.mutate()}>
            {t('tools.rotate')}
          </Button>
        </div>
      )}
      {ping.isSuccess ? <Alert tone="info">{t('tools.pinged')}</Alert> : null}
      {error === null ? null : (
        <Alert tone="danger">{error instanceof ApiError ? error.message : String(error)}</Alert>
      )}
      <details>
        <summary className="cursor-pointer text-sm">{t('tools.events')}</summary>
        <p className="mt-2 text-xs text-muted-foreground">{t('tools.eventsHint')}</p>
        <ul className="mt-2 grid max-h-64 gap-1 overflow-auto text-sm sm:grid-cols-2">
          {(events.data?.events ?? []).map((e) => (
            <li key={e.event}>
              <code className="font-mono text-xs">{e.event}</code>{' '}
              <span className="text-muted-foreground">{e.label}</span>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
