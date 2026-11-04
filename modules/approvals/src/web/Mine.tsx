/**
 * My requests (RFC 0025 §3.1): what I asked to be approved, where each stands — every level as a step, since when —,
 * withdrawn while it waits.
 */
import { Alert, Badge, Button, EmptyState, type PageProps, useKosh } from '@kosh/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactElement, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ago, cardsQuery, Steps, TONE } from './shared.js';

export function Mine({ api }: PageProps): ReactElement {
  const { t } = useTranslation('approvals');
  const { format } = useKosh();
  const client = useQueryClient();
  const cards = useQuery(cardsQuery(api, 'mine'));
  const [message, setMessage] = useState<string | null>(null);
  const withdraw = useMutation({
    mutationFn: ({ model, id }: { model: string; id: number }) =>
      api.call('POST', `/api/v1/approvals/${model}/${id}/withdraw`),
    onSuccess: async () => {
      setMessage(t('done.withdrawn'));
      await client.invalidateQueries({ queryKey: ['approvals'] });
    },
    onError: (e) => setMessage(e.message),
  });
  const rows = cards.data ?? [];
  return (
    <div className="grid gap-4 p-4">
      <h1 className="text-xl font-semibold">{t('mine.title')}</h1>
      {message === null ? null : <Alert tone="info">{message}</Alert>}
      {rows.length === 0 ? (
        <EmptyState title={cards.isLoading ? t('loading') : t('mine.empty')} />
      ) : (
        <ul className="grid gap-3">
          {rows.map((c) => (
            <li
              key={`${c.record.model}:${c.record.id}`}
              className="grid gap-2 rounded-lg border bg-surface p-4"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{c.record.name}</span>
                <Badge tone="neutral">{c.record.label}</Badge>
                <Badge tone={TONE[c.state]}>{t(`state.${c.state}`)}</Badge>
                <span className="text-sm text-muted-foreground">
                  {t('asked', { since: ago(format.locale, c.waitingSince) })}
                </span>
              </div>
              <Steps steps={c.steps} />
              {c.comment === null ? null : (
                <p className="text-sm">
                  <span className="text-muted-foreground">{t('saidWhy')}</span> “{c.comment}”
                </p>
              )}
              {c.state !== 'pending' ? null : (
                <div>
                  <Button
                    disabled={withdraw.isPending}
                    onClick={() => withdraw.mutate({ model: c.record.model, id: c.record.id })}
                  >
                    {t('withdraw')}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
