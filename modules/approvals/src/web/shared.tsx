/**
 * What the Approvals pages share (RFC 0025 §3.1): the card the server sends, its query, the steps of a round (each
 * level with its state and votes), how long a request has waited, said in the user's language.
 */
import type { KoshApi } from '@kosh/ui';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';

export interface Step {
  readonly id: number;
  readonly levelName: string;
  readonly sequence: number;
  readonly state: 'pending' | 'approved' | 'rejected' | 'sent_back' | 'cancelled';
  readonly approvals: number;
  readonly required: number;
}

export interface Card {
  readonly id: number;
  readonly levelName: string;
  readonly state: Step['state'];
  readonly round: number;
  readonly approvals: number;
  readonly required: number;
  readonly waitingSince: string;
  readonly decidedAt: string | null;
  readonly comment: string | null;
  readonly record: {
    readonly model: string;
    readonly id: number;
    readonly name: string;
    readonly label: string;
  };
  readonly requester: { readonly id: number; readonly name: string } | null;
  readonly steps: readonly Step[];
}

/** The cards of a list: `inbox` (to decide), `mine` (asked by me), `history` (decided by me). */
export const cardsQuery = (api: KoshApi, list: 'inbox' | 'mine' | 'history') => ({
  queryKey: ['approvals', list],
  queryFn: async () =>
    (await api.call<{ cards: Card[] }>('GET', `/api/v1/approvals/cards?list=${list}`)).cards,
});

/** How long ago `iso` was, in `locale` ("3 hours ago", "৩ ঘণ্টা আগে"). */
export function ago(locale: string, iso: string, now: number = Date.now()): string {
  const seconds = Math.round((Date.parse(iso) - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ];
  for (const [unit, size] of units)
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  return rtf.format(seconds, 'second');
}

/** Amber after a day, red after three. */
export function waitedTone(
  card: Pick<Card, 'waitingSince'>,
  now: number = Date.now(),
): 'neutral' | 'warning' | 'danger' {
  const hours = (now - Date.parse(card.waitingSince)) / 3_600_000;
  return hours >= 72 ? 'danger' : hours >= 24 ? 'warning' : 'neutral';
}

/** A state's badge tone. */
export const TONE = {
  pending: 'warning',
  approved: 'success',
  rejected: 'danger',
  sent_back: 'danger',
  cancelled: 'neutral',
} as const;

const DOT: Record<Step['state'], string> = {
  pending: 'border-warning bg-warning/20',
  approved: 'border-success bg-success',
  rejected: 'border-danger bg-danger',
  sent_back: 'border-danger bg-danger/40',
  cancelled: 'border-muted-foreground bg-muted',
};

/** The levels of a round as steps: done, waiting, refused — with their votes. */
export function Steps({ steps }: { readonly steps: readonly Step[] }): ReactElement {
  const { t } = useTranslation('approvals');
  return (
    <ol className="flex flex-wrap items-center gap-2" aria-label={t('steps')}>
      {steps.map((s, i) => (
        <li key={s.id} className="flex items-center gap-2 text-xs">
          {i === 0 ? null : <span aria-hidden="true" className="h-px w-4 bg-border" />}
          <span aria-hidden="true" className={`size-3 rounded-full border-2 ${DOT[s.state]}`} />
          <span>
            <span className="font-medium">{s.levelName}</span>{' '}
            <span className="text-muted-foreground">
              {t(`state.${s.state}`)}
              {s.required > 1 ? ` · ${s.approvals}/${s.required}` : ''}
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}
