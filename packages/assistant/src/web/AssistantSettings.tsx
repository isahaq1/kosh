/**
 * Settings → AI assistant (RFC 0013 §5.1, §5.6): an administrator switches the assistant on or off for the company
 * (its data goes to the Anthropic API only once it is on), sees the month's usage against the budget, and the latest
 * calls — who, what for, which model, the tokens; never what was asked.
 */
import { Alert, Badge, Button, Card, EmptyState, type PageProps, Spinner, useKosh } from '@kosh/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { AssistantStatus } from './AskButton.js';

interface CallRow {
  readonly id: number;
  readonly user: number | null;
  readonly feature: string;
  readonly llm: string;
  readonly resModel: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
  readonly durationMs: number;
  readonly refused: boolean;
  readonly error: string | null;
  readonly createdAt: string;
}

export function AssistantSettings({ api, label }: PageProps): ReactElement {
  const { t } = useTranslation('assistant');
  const { format } = useKosh();
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: ['assistant', 'status'],
    queryFn: () => api.call<AssistantStatus>('GET', '/api/v1/assistant'),
    retry: false,
  });
  const calls = useQuery({
    queryKey: ['assistant', 'calls'],
    queryFn: () => api.call<{ calls: CallRow[] }>('GET', '/api/v1/assistant/calls'),
    retry: false,
  });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.call('PUT', '/api/v1/assistant/config', { enabled }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['assistant'] }),
  });
  if (status.isPending) return <Spinner label={t('settingsTitle')} />;
  if (status.data === undefined)
    return (
      <Alert>{status.error instanceof Error ? status.error.message : t('settingsTitle')}</Alert>
    );
  const s = status.data;
  const share = s.usage.budget === 0 ? 1 : Math.min(1, s.usage.tokens / s.usage.budget);
  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">{label ?? t('settingsTitle')}</h1>
        <p className="text-sm text-muted-foreground">{t('settingsIntro')}</p>
      </header>
      {!s.available ? <Alert tone="warning">{t('noKey')}</Alert> : null}
      <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="space-y-1">
          <div className="font-medium">
            {s.enabled ? t('onForCompany') : t('offForCompany')}{' '}
            <Badge tone={s.enabled ? 'success' : 'neutral'}>{s.enabled ? t('on') : t('off')}</Badge>
          </div>
          <div className="text-sm text-muted-foreground">
            {t('modelUsed', { model: s.model ?? '—' })}
          </div>
        </div>
        <Button
          variant={s.enabled ? 'secondary' : 'primary'}
          busy={toggle.isPending}
          disabled={!s.available && !s.enabled}
          onClick={() => toggle.mutate(!s.enabled)}
        >
          {s.enabled ? t('switchOff') : t('switchOn')}
        </Button>
      </Card>
      {toggle.isError ? (
        <Alert>{toggle.error instanceof Error ? toggle.error.message : String(toggle.error)}</Alert>
      ) : null}
      <section className="space-y-2" aria-labelledby="assistant-usage">
        <h2 id="assistant-usage" className="text-base font-semibold">
          {t('usage')}
        </h2>
        <meter
          className="h-2 w-full"
          aria-label={t('usage')}
          min={0}
          max={Math.max(s.usage.budget, 1)}
          value={Math.min(s.usage.tokens, Math.max(s.usage.budget, 1))}
        />
        <span className="sr-only">{`${Math.round(share * 100)}%`}</span>
        <p className="text-sm text-muted-foreground">
          {t('usageText', {
            used: format.number(s.usage.tokens),
            budget: format.number(s.usage.budget),
          })}
        </p>
      </section>
      <section className="space-y-2" aria-labelledby="assistant-calls">
        <h2 id="assistant-calls" className="text-base font-semibold">
          {t('calls')}
        </h2>
        {(calls.data?.calls ?? []).length === 0 ? (
          <EmptyState title={t('noCalls')} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th scope="col" className="py-2 pe-2 text-start font-medium">
                    {t('when')}
                  </th>
                  <th scope="col" className="px-2 py-2 text-start font-medium">
                    {t('feature')}
                  </th>
                  <th scope="col" className="px-2 py-2 text-start font-medium">
                    {t('about')}
                  </th>
                  <th scope="col" className="px-2 py-2 text-end font-medium">
                    {t('tokens')}
                  </th>
                  <th scope="col" className="px-2 py-2 text-start font-medium">
                    {t('outcome')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {(calls.data?.calls ?? []).map((c) => (
                  <tr key={c.id} className="border-b last:border-0">
                    <td className="py-2 pe-2">{format.datetime(c.createdAt)}</td>
                    <td className="px-2 py-2">
                      {t(`features.${c.feature}`, { defaultValue: c.feature })}
                    </td>
                    <td className="px-2 py-2 font-mono text-xs">{c.resModel ?? ''}</td>
                    <td className="px-2 py-2 text-end">
                      {format.number(c.inputTokens + c.outputTokens + c.cachedTokens)}
                    </td>
                    <td className="px-2 py-2">
                      {c.refused
                        ? t('outcomeRefused')
                        : c.error !== null
                          ? t('outcomeUnused')
                          : t('outcomeUsed')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
