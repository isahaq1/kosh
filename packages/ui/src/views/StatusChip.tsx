/**
 * A record's state as one chip in its meaning's tone (RFC 0018 §4.2), instead of a row of every state: it opens the
 * whole workflow — the states passed, the current one, the ones a transition leads to next. The server serves the
 * transitions; the chip only shows them.
 */
import { Check, ChevronDown, Circle } from 'lucide-react';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { ViewField } from '../api.js';
import {
  badgeVariants,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '../components/primitives.js';
import { cn } from '../lib/cn.js';
import { toneOf } from './widgets.js';

export function StatusChip({
  field,
  value,
  transitions,
}: {
  readonly field: ViewField;
  readonly value: unknown;
  readonly transitions: readonly { readonly from: readonly string[]; readonly to: string }[];
}): ReactElement {
  const { t } = useTranslation();
  const options = field.options ?? [];
  const index = options.findIndex((o) => o.value === value);
  const current = options[index];
  const next = new Set(
    transitions.filter((tr) => tr.from.includes(String(value))).map((tr) => tr.to),
  );
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t('views.statusOf', { field: field.label, state: current?.label ?? '—' })}
          className={cn(
            badgeVariants({ tone: toneOf(String(value ?? '')) }),
            'gap-1.5 px-2.5 py-1 hover:brightness-95 focus-visible:outline-2',
          )}
        >
          <span className="size-1.5 rounded-full bg-current" aria-hidden />
          {current?.label ?? '—'}
          <ChevronDown className="size-3.5 opacity-70" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64">
        <p className="mb-2 px-2 text-xs font-medium text-muted-foreground">{field.label}</p>
        <ol className="grid gap-0.5">
          {options.map((o, i) => {
            const isCurrent = i === index;
            return (
              <li
                key={o.value}
                aria-current={isCurrent ? 'step' : undefined}
                className={cn(
                  'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm',
                  isCurrent ? 'bg-accent font-medium text-accent-foreground' : 'text-foreground',
                  i > index && !next.has(o.value) && 'text-muted-foreground',
                )}
              >
                {i < index ? (
                  <Check className="size-3.5 text-success" aria-hidden />
                ) : (
                  <Circle className={cn('size-3.5', isCurrent && 'fill-current')} aria-hidden />
                )}
                <span className="flex-1">{o.label}</span>
                {next.has(o.value) ? (
                  <span className="text-xs text-muted-foreground">{t('views.nextState')}</span>
                ) : null}
              </li>
            );
          })}
        </ol>
      </PopoverContent>
    </Popover>
  );
}
