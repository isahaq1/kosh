/**
 * Settings › App settings › an app › Numbering (RFC 0020 §3.3), for Administrators: each sequence the app declares
 * — the document it numbers, what its numbers look like, when the counter restarts, the next number —, with the
 * next number previewed as a document will carry it while it is typed. The server works the preview out, checks
 * every change, refuses a number already issued, and audits what was changed.
 */
import { ApiError, Badge, Button, Input, type KoshApi, Label, Select } from '@kosh/ui';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactElement, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

const RESETS = ['never', 'yearly', 'monthly', 'daily'] as const;
interface Format {
  readonly prefix: string;
  readonly suffix: string;
  readonly padding: number;
  readonly reset: (typeof RESETS)[number];
}
export interface NumberedSequence {
  readonly code: string;
  readonly label: string;
  readonly gapless: boolean;
  readonly declared: Format;
  readonly format: Format;
  readonly changed: boolean;
  readonly period: string;
  readonly next: number;
  readonly preview: string;
}
export interface NumberingApp {
  readonly app: string;
  readonly label: string;
  readonly icon: string | null;
  readonly sequences: readonly NumberedSequence[];
}
export const NUMBERING = '/api/v1/settings/numbering';

const message = (e: unknown): string => (e instanceof ApiError ? e.message : String(e));

function SequenceRow({
  api,
  sequence,
}: {
  readonly api: KoshApi;
  readonly sequence: NumberedSequence;
}): ReactElement {
  const { t } = useTranslation('settings');
  const id = useId();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Format>(sequence.format);
  const [next, setNext] = useState(String(sequence.next));
  const dirty =
    JSON.stringify(draft) !== JSON.stringify(sequence.format) || next !== String(sequence.next);
  const body = { format: draft, next: next.trim() === '' ? undefined : Number(next) };
  // What the next document would carry, worked out by the server as it is typed.
  const preview = useQuery({
    queryKey: ['settings', 'numbering', 'preview', sequence.code, draft, next],
    queryFn: () =>
      api.call<NumberedSequence>(
        'POST',
        `${NUMBERING}/${encodeURIComponent(sequence.code)}/preview`,
        body,
      ),
    enabled: dirty,
    placeholderData: keepPreviousData,
    retry: false,
  });
  const done = (saved: NumberedSequence): void => {
    setDraft(saved.format);
    setNext(String(saved.next));
    void queryClient.invalidateQueries({ queryKey: ['settings', 'numbering'] });
  };
  const save = useMutation({
    mutationFn: () =>
      api.call<NumberedSequence>('PUT', `${NUMBERING}/${encodeURIComponent(sequence.code)}`, body),
    onSuccess: done,
  });
  const reset = useMutation({
    mutationFn: () =>
      api.call<NumberedSequence>('PUT', `${NUMBERING}/${encodeURIComponent(sequence.code)}`, {
        format: null,
      }),
    onSuccess: done,
  });
  const problem = save.error ?? reset.error ?? (dirty ? preview.error : null);
  const shown = dirty && preview.data !== undefined && preview.error === null;
  return (
    <li className="grid gap-3 border-t pt-3 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium">{sequence.label}</h3>
        {sequence.changed ? <Badge tone="info">{t('numbering.changed')}</Badge> : null}
        {sequence.gapless ? <Badge tone="neutral">{t('numbering.gapless')}</Badge> : null}
      </div>
      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (dirty) save.mutate();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-5">
          <div className="grid gap-1 sm:col-span-2">
            <Label htmlFor={`${id}-prefix`}>{t('numbering.prefix')}</Label>
            <Input
              id={`${id}-prefix`}
              maxLength={60}
              value={draft.prefix}
              onChange={(e) => setDraft({ ...draft, prefix: e.target.value })}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor={`${id}-padding`}>{t('numbering.padding')}</Label>
            <Input
              id={`${id}-padding`}
              type="number"
              min={0}
              max={20}
              value={String(draft.padding)}
              onChange={(e) =>
                setDraft({ ...draft, padding: Number.parseInt(e.target.value, 10) || 0 })
              }
            />
          </div>
          <div className="grid gap-1 sm:col-span-2">
            <Label htmlFor={`${id}-suffix`}>{t('numbering.suffix')}</Label>
            <Input
              id={`${id}-suffix`}
              maxLength={60}
              value={draft.suffix}
              onChange={(e) => setDraft({ ...draft, suffix: e.target.value })}
            />
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-5">
          <div className="grid gap-1 sm:col-span-2">
            <Label htmlFor={`${id}-reset`}>{t('numbering.reset')}</Label>
            <Select
              id={`${id}-reset`}
              label={t('numbering.reset')}
              value={draft.reset}
              options={RESETS.map((r) => ({ value: r, label: t(`numbering.resets.${r}`) }))}
              onChange={(v) => setDraft({ ...draft, reset: v as Format['reset'] })}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor={`${id}-next`}>{t('numbering.next')}</Label>
            <Input
              id={`${id}-next`}
              type="number"
              min={sequence.next}
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          </div>
          <div className="grid gap-1 sm:col-span-2">
            <span className="text-sm font-medium">{t('numbering.preview')}</span>
            <output
              htmlFor={`${id}-prefix ${id}-padding ${id}-suffix ${id}-reset ${id}-next`}
              aria-live="polite"
              className="rounded-md border bg-muted px-2 py-1.5 font-mono text-sm"
            >
              {shown ? preview.data.preview : sequence.preview}
            </output>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{t('numbering.hint')}</p>
        {problem === null ? null : (
          <p role="alert" className="text-sm text-danger">
            {message(problem)}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={!dirty || preview.error !== null}
            busy={save.isPending}
          >
            {t('numbering.save')}
          </Button>
          {sequence.changed ? (
            <Button size="sm" variant="ghost" busy={reset.isPending} onClick={() => reset.mutate()}>
              {t('numbering.back')}
            </Button>
          ) : null}
        </div>
      </form>
    </li>
  );
}

/** The Numbering card of an app: its sequences, each with its format and next number. */
export function NumberingCard({
  api,
  entry,
}: {
  readonly api: KoshApi;
  readonly entry: NumberingApp;
}): ReactElement {
  const { t } = useTranslation('settings');
  return (
    <section
      aria-labelledby={`numbering-${entry.app}`}
      className="grid gap-4 rounded-lg border bg-surface p-4"
    >
      <header>
        <h2 id={`numbering-${entry.app}`} className="font-semibold">
          {t('numbering.title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('numbering.intro')}</p>
      </header>
      <ul className="grid gap-4">
        {entry.sequences.map((s) => (
          // The row keeps what is typed until the server's values change.
          <SequenceRow
            key={`${s.code}-${s.next}-${JSON.stringify(s.format)}`}
            api={api}
            sequence={s}
          />
        ))}
      </ul>
    </section>
  );
}
