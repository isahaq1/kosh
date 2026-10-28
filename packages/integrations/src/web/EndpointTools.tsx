/**
 * On an inbound webhook's form (RFC 0017 §5.4): the URL to give the provider, a new secret, and the endpoints the
 * installed modules offer. The server checks every call; the panel shows what it answers.
 */
import { Alert, ApiError, Button, type NodeComponentProps } from '@kosh/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';

interface InboundHook {
  readonly hook: string;
  readonly label: string;
}

export function EndpointTools({ api, record, reload }: NodeComponentProps): ReactElement {
  const { t } = useTranslation('integrations');
  const id = record?.['id'];
  const token = record?.['token'];
  const hooks = useQuery({
    queryKey: ['integrations', 'hooks'],
    queryFn: () => api.call<{ hooks: InboundHook[] }>('GET', '/api/v1/webhooks/hooks'),
  });
  const rotate = useMutation({
    mutationFn: () => api.call('POST', `/api/v1/webhooks/endpoints/${id}/rotate-secret`),
    onSuccess: () => reload(),
  });
  const url =
    typeof token === 'string' && token !== ''
      ? `${window.location.origin}/api/v1/hooks/${token}`
      : null;
  return (
    <section className="grid gap-3 rounded-lg border p-4" aria-label={t('endpoint.title')}>
      {url === null ? null : (
        <div className="grid gap-1">
          <span className="text-sm font-medium">{t('endpoint.url')}</span>
          <code
            className="break-all rounded bg-muted px-2 py-1 font-mono text-xs"
            data-testid="endpoint-url"
          >
            {url}
          </code>
          <p className="text-xs text-muted-foreground">{t('endpoint.urlHint')}</p>
        </div>
      )}
      {typeof id !== 'number' ? null : (
        <div>
          <Button variant="secondary" busy={rotate.isPending} onClick={() => rotate.mutate()}>
            {t('endpoint.rotate')}
          </Button>
        </div>
      )}
      {rotate.error === null ? null : (
        <Alert tone="danger">
          {rotate.error instanceof ApiError ? rotate.error.message : String(rotate.error)}
        </Alert>
      )}
      <details open={typeof id !== 'number'}>
        <summary className="cursor-pointer text-sm">{t('endpoint.hooks')}</summary>
        <p className="mt-2 text-xs text-muted-foreground">{t('endpoint.hooksHint')}</p>
        <ul className="mt-2 grid gap-1 text-sm">
          {(hooks.data?.hooks ?? []).map((h) => (
            <li key={h.hook}>
              <code className="font-mono text-xs">{h.hook}</code>{' '}
              <span className="text-muted-foreground">{h.label}</span>
            </li>
          ))}
        </ul>
        {hooks.data !== undefined && hooks.data.hooks.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">{t('endpoint.none')}</p>
        ) : null}
      </details>
    </section>
  );
}
