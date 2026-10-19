/**
 * The calendar view: records on a month or week grid by their start (and stop) date, within the search; previous /
 * next / today navigation; multi-day records on every day they span; colours by a field's value. Opening an event
 * opens the record.
 */
import { Alert, Button, Spinner, useKosh, useRowNames, type ViewProps } from '@isahaq/kosh-ui';
import type { CalendarView as CalendarDefinition } from '@isahaq/kosh-views';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { and } from './shared.js';

const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const COLORS = [
  'bg-primary/15 text-primary',
  'bg-success/15 text-success',
  'bg-warning/20 text-warning',
  'bg-danger/15 text-danger',
  'bg-accent text-accent-foreground',
];

function colorOf(value: unknown): string {
  const text = String(value ?? '');
  let hash = 0;
  for (const c of text) hash = (hash * 31 + c.charCodeAt(0)) | 0;
  return COLORS[Math.abs(hash) % COLORS.length] as string;
}

/** The days shown: whole weeks (Monday first) covering the month, or one week. */
export function gridDays(anchor: Date, mode: 'month' | 'week'): Date[] {
  const start =
    mode === 'month'
      ? new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1))
      : new Date(anchor);
  const offset = (start.getUTCDay() + 6) % 7;
  const first = new Date(start.getTime() - offset * DAY);
  const count =
    mode === 'week'
      ? 7
      : Math.ceil(
          (offset +
            new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 0)).getUTCDate()) /
            7,
        ) * 7;
  return Array.from({ length: count }, (_, i) => new Date(first.getTime() + i * DAY));
}

export function CalendarView(props: ViewProps): ReactElement {
  const { api, format } = useKosh();
  const { t } = useTranslation('reporting');
  const view = props.served.view as CalendarDefinition;
  const fields = props.served.fields[view.model] ?? {};
  const mode = view.mode ?? 'month';
  const [anchor, setAnchor] = useState(() => {
    const now = new Date();
    return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  });
  const days = gridDays(anchor, mode);
  const from = iso(days[0] as Date);
  const to = iso(new Date((days[days.length - 1] as Date).getTime() + DAY));
  const stop = view.dateStop ?? view.dateStart;
  const where = and(props.where, { [view.dateStart]: { lt: to } }, { [stop]: { gte: from } });
  const keys = [
    ...new Set([
      'id',
      view.dateStart,
      stop,
      view.title,
      ...(view.color === undefined ? [] : [view.color]),
    ]),
  ];
  const records = useQuery({
    queryKey: ['list', view.model, where, keys, 'calendar'],
    queryFn: () =>
      api.list(view.model, {
        filter: where,
        fields: keys,
        limit: 500,
        order: [`${view.dateStart} asc`],
      }),
  });
  const items = records.data?.items ?? [];
  const names = useRowNames(items, Object.values(fields));
  const move = (n: number) =>
    setAnchor((a) =>
      mode === 'month'
        ? new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth() + n, 1))
        : new Date(a.getTime() + n * 7 * DAY),
    );
  const title = (row: Record<string, unknown>) => {
    const value = row[view.title];
    const field = fields[view.title];
    if (field?.kind === 'many2one' && typeof value === 'number')
      return names.get(field.target ?? '')?.get(value) ?? `#${value}`;
    return String(value ?? `#${String(row['id'])}`);
  };
  const heading = new Intl.DateTimeFormat(
    format.locale,
    mode === 'month'
      ? { month: 'long', year: 'numeric', timeZone: 'UTC' }
      : { dateStyle: 'medium', timeZone: 'UTC' },
  ).format(mode === 'month' ? anchor : (days[0] as Date));
  const weekdays = days
    .slice(0, 7)
    .map((d) =>
      new Intl.DateTimeFormat(format.locale, { weekday: 'short', timeZone: 'UTC' }).format(d),
    );
  const today = iso(new Date());

  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-2">
        <Button size="icon" aria-label={t('prev')} onClick={() => move(-1)}>
          <ChevronLeft className="rtl:-scale-x-100" aria-hidden />
        </Button>
        <Button size="sm" onClick={() => setAnchor(new Date(`${today}T00:00:00Z`))}>
          {t('today')}
        </Button>
        <Button size="icon" aria-label={t('next')} onClick={() => move(1)}>
          <ChevronRight className="rtl:-scale-x-100" aria-hidden />
        </Button>
        <h2 className="ms-2 text-base font-semibold" aria-live="polite">
          {heading}
        </h2>
      </div>
      {records.isError ? <Alert>{records.error.message}</Alert> : null}
      {records.isPending ? <Spinner label="…" /> : null}
      <table
        aria-label={heading}
        className="w-full table-fixed border-collapse overflow-hidden rounded-lg border bg-surface"
      >
        <thead>
          <tr>
            {weekdays.map((d) => (
              <th
                key={d}
                scope="col"
                className="border-b bg-muted px-2 py-1 text-start text-xs font-medium text-muted-foreground"
              >
                {d}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: days.length / 7 }, (_, w) => days.slice(w * 7, w * 7 + 7)).map(
            (week) => (
              <tr key={iso(week[0] as Date)}>
                {week.map((day) => {
                  const key = iso(day);
                  const events = items.filter((r) => {
                    const start = String(r[view.dateStart] ?? '').slice(0, 10);
                    const end = String(r[stop] ?? start).slice(0, 10);
                    return start !== '' && start <= key && key <= end;
                  });
                  const outside = mode === 'month' && day.getUTCMonth() !== anchor.getUTCMonth();
                  return (
                    <td
                      key={key}
                      className={`h-24 border-b border-e p-1 align-top ${outside ? 'bg-muted/40 text-muted-foreground' : ''}`}
                    >
                      <div
                        className={`mb-1 text-xs ${key === today ? 'inline-block rounded-full bg-primary px-1.5 text-primary-foreground' : ''}`}
                      >
                        <span className="sr-only">{format.date(key)}</span>
                        <span aria-hidden>{day.getUTCDate()}</span>
                      </div>
                      <ul className="grid gap-0.5">
                        {events.slice(0, 4).map((r) => (
                          <li key={r.id}>
                            <button
                              type="button"
                              className={`w-full truncate rounded px-1 text-start text-xs ${colorOf(view.color === undefined ? undefined : r[view.color])}`}
                              onClick={() => props.onOpen(r.id)}
                            >
                              {title(r)}
                            </button>
                          </li>
                        ))}
                        {events.length > 4 ? (
                          <li className="px-1 text-xs text-muted-foreground">
                            +{events.length - 4}
                          </li>
                        ) : null}
                      </ul>
                    </td>
                  );
                })}
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}
