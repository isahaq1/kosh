/**
 * "Summarize" and "Draft reply" in a record's chatter (RFC 0013 §5.5): the answer streams in as it is written. A
 * summary is read and closed; a draft goes into the message composer for the user to edit and send — nothing is
 * posted by the assistant. Hidden when the assistant is off or the user has no access to it.
 */
import { ApiError, Button, type ChatterAssistProps, Input } from '@kosh/ui';
import { useQuery } from '@tanstack/react-query';
import { MessageSquareText, Sparkles, X } from 'lucide-react';
import { type ReactElement, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AssistantStatus } from './AskButton.js';

type Mode = 'summary' | 'reply';

export function ChatterAssist({
  api,
  model,
  id,
  onDraft,
}: ChatterAssistProps): ReactElement | null {
  const { t } = useTranslation('assistant');
  const inputId = useId();
  const status = useQuery({
    queryKey: ['assistant', 'status'],
    queryFn: () => api.call<AssistantStatus>('GET', '/api/v1/assistant'),
    retry: false,
    staleTime: 60_000,
  });
  const [mode, setMode] = useState<Mode | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [usedModel, setUsedModel] = useState<string | null>(null);
  const [instruction, setInstruction] = useState('');
  const run = useRef(0);

  if (status.data === undefined || !status.data.available || !status.data.enabled) return null;

  const start = async (next: Mode, how = '') => {
    const mine = ++run.current;
    setMode(next);
    setText('');
    setProblem(null);
    setUsedModel(null);
    setBusy(true);
    try {
      await api.stream(
        `/api/v1/assistant/${next}`,
        {
          model,
          id,
          ...(next === 'reply' && how.trim() !== '' ? { instruction: how.trim() } : {}),
        },
        (event, data) => {
          if (mine !== run.current) return; // a newer request replaced this one
          const d = (data ?? {}) as {
            text?: string;
            model?: string;
            refused?: boolean;
            detail?: string;
          };
          if (event === 'message' && typeof d.text === 'string') setText((v) => v + d.text);
          else if (event === 'done') {
            setUsedModel(d.model ?? null);
            if (d.refused === true) setProblem(t('refusedText'));
          } else if (event === 'error') setProblem(d.detail ?? t('failed'));
        },
      );
    } catch (error) {
      if (mine === run.current)
        setProblem(error instanceof ApiError ? error.message : String(error));
    } finally {
      if (mine === run.current) setBusy(false);
    }
  };

  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        busy={busy && mode === 'summary'}
        onClick={() => void start('summary')}
      >
        <Sparkles aria-hidden />
        {t('summarize')}
      </Button>
      <Button
        size="sm"
        variant="secondary"
        busy={busy && mode === 'reply'}
        onClick={() => void start('reply')}
      >
        <MessageSquareText aria-hidden />
        {t('draftReply')}
      </Button>
      {mode === null ? null : (
        <section
          aria-label={mode === 'summary' ? t('summaryTitle') : t('draftTitle')}
          aria-busy={busy}
          className="basis-full space-y-2 rounded-md border border-primary/30 bg-accent/40 p-3 text-sm"
        >
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-semibold">
              {mode === 'summary' ? t('summaryTitle') : t('draftTitle')}
            </h3>
            <Button
              size="icon"
              variant="ghost"
              aria-label={t('close')}
              onClick={() => {
                run.current += 1;
                setMode(null);
                setBusy(false);
              }}
            >
              <X aria-hidden />
            </Button>
          </div>
          <p aria-live="polite" className="whitespace-pre-wrap">
            {text}
            {busy ? <span className="animate-pulse">▍</span> : null}
          </p>
          {problem === null ? null : (
            <p role="alert" className="text-danger">
              {problem}
            </p>
          )}
          {mode === 'reply' && !busy ? (
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void start('reply', instruction);
              }}
            >
              <label htmlFor={inputId} className="sr-only">
                {t('howToAnswer')}
              </label>
              <Input
                id={inputId}
                className="h-8 min-w-48 flex-1"
                maxLength={500}
                placeholder={t('howToAnswer')}
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
              />
              <Button type="submit" size="sm" variant="ghost">
                {t('redraft')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="primary"
                disabled={text.trim() === ''}
                onClick={() => {
                  onDraft(text.trim());
                  setMode(null);
                }}
              >
                {t('useDraft')}
              </Button>
            </form>
          ) : null}
          {usedModel === null ? null : (
            <p className="text-xs text-muted-foreground">
              {t('generatedText', { model: usedModel })}
            </p>
          )}
        </section>
      )}
    </>
  );
}
