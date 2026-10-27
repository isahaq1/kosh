/**
 * "Ask" next to the search box (RFC 0013 §5.5): a sentence becomes the search's filters, shown as a chip the user
 * removes like any other. Hidden for users without the assistant, and when it is off for the company; the server
 * decides and checks every filter.
 */
import { ApiError, Button, Input, type SearchAssistProps } from '@kosh/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { Popover } from 'radix-ui';
import { type ReactElement, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

export interface AssistantStatus {
  readonly available: boolean;
  readonly enabled: boolean;
  readonly model: string | null;
  readonly usage: { readonly tokens: number; readonly budget: number };
}

export function AskButton({ api, model, onDomain }: SearchAssistProps): ReactElement | null {
  const { t } = useTranslation('assistant');
  const id = useId();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const status = useQuery({
    queryKey: ['assistant', 'status'],
    queryFn: () => api.call<AssistantStatus>('GET', '/api/v1/assistant'),
    retry: false,
    staleTime: 60_000,
  });
  const ask = useMutation({
    mutationFn: (sentence: string) =>
      api.call<{ where?: Record<string, unknown>; unsupported?: string; refused?: boolean }>(
        'POST',
        '/api/v1/assistant/search',
        { model, text: sentence },
      ),
    onSuccess: (answer, sentence) => {
      if (answer.where === undefined) return;
      onDomain(answer.where, sentence);
      if (answer.unsupported === undefined || answer.unsupported === '') setOpen(false);
    },
  });
  if (status.data === undefined || !status.data.available || !status.data.enabled) return null;
  const problem =
    ask.data?.refused === true
      ? t('refused')
      : ask.error instanceof ApiError
        ? ask.error.message
        : ask.error === null
          ? null
          : String(ask.error);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button size="sm" variant="ghost" aria-label={t('ask')} title={t('askHint')}>
          <Sparkles aria-hidden />
          <span className="hidden sm:inline">{t('ask')}</span>
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          className="z-40 w-[min(26rem,calc(100vw-1rem))] space-y-2 rounded-lg border bg-surface p-3 text-surface-foreground shadow-xl"
        >
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (text.trim() !== '') ask.mutate(text.trim());
            }}
          >
            <label htmlFor={id} className="sr-only">
              {t('askLabel')}
            </label>
            <Input
              id={id}
              autoFocus
              maxLength={500}
              placeholder={t('askPlaceholder')}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <Button type="submit" variant="primary" size="sm" busy={ask.isPending}>
              {t('go')}
            </Button>
          </form>
          {problem === null ? null : (
            <p role="alert" className="text-xs text-danger">
              {problem}
            </p>
          )}
          {ask.data?.unsupported === undefined || ask.data.unsupported === '' ? null : (
            <p role="status" className="text-xs text-muted-foreground">
              {t('unsupported', { what: ask.data.unsupported })}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            {t('generated', { model: status.data.model ?? '' })}
          </p>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
