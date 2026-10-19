/**
 * The gantt (timeline) view: records as bars from their start to their stop date over a day / week / month scale,
 * in rows by a group field (e.g. the responsible), with progress inside the bar. Opening a bar opens the record.
 */
import { Alert, Button, Spinner, useKosh, useRowNames, type ViewProps } from '@kosh/ui';
import type { GanttView as GanttDefinition } from '@kosh/views';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { and } from './shared.js';

const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const SPAN = { day: 1, week: 7, month: 31 } as const;

/** The window shown for a scale: a day, a week (Monday first) or a month. */
export function windowOf(anchor: Date, scale: 'day' | 'week' | 'month'): { from: Date; to: Date } {
  if (scale === 'month')
    return {
      from: new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1)),
      to: new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 1)),
    };
  if (scale === 'week') {
    const from = new Date(anchor.getTime() - ((anchor.getUTCDay() + 6) % 7) * DAY);
    return { from, to: new Date(from.getTime() + 7 * DAY) };
  }
  return { from: anchor, to: new Date(anchor.getTime() + DAY) };
}

export function GanttView(props: ViewProps): ReactElement {
  const { api, format } = useKosh();
  const { t } = useTranslation('reporting');
  const view = props.served.view as GanttDefinition;
  const fields = props.served.fields[view.model] ?? {};
  const scale = view.scale ?? 'month';
  const [anchor, setAnchor] = useState(() => {
    const n = new Date();
    return new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()));
  });
  const { from, to } = windowOf(anchor, scale);
  const where = and(
    props.where,
    { [view.dateStart]: { lt: iso(to) } },
    { [view.dateStop]: { gte: iso(from) } },
  );
  const keys = [
    ...new Set([
      'id',
      view.dateStart,
      view.dateStop,
      view.title,
      ...(view.groupBy === undefined ? [] : [view.groupBy]),
      ...(view.progress === undefined ? [] : [view.progress]),
    ]),
  ];
  const records = useQuery({
    queryKey: ['list', view.model, where, keys, 'gantt'],
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
  const display = (key: string, value: unknown): string => {
    const field = fields[key];
    if (value === null || value === undefined) return t('none');
    if (field?.kind === 'many2one')
      return names.get(field.target ?? '')?.get(Number(value)) ?? `#${String(value)}`;
    return field?.options?.find((o) => o.value === value)?.label ?? String(value);
  };
  const groups = new Map<string, typeof items>();
  for (const r of items) {
    const key = view.groupBy === undefined ? '' : JSON.stringify(r[view.groupBy] ?? null);
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const total = to.getTime() - from.getTime();
  const ticks = Math.round(total / DAY);
  const move = (n: number) =>
    setAnchor((a) =>
      scale === 'month'
        ? new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth() + n, 1))
        : new Date(a.getTime() + n * SPAN[scale] * DAY),
    );
  const heading = `${format.date(iso(from))} – ${format.date(iso(new Date(to.getTime() - DAY)))}`;

  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-2">
        <Button size="icon" aria-label={t('prev')} onClick={() => move(-1)}>
          <ChevronLeft className="rtl:-scale-x-100" aria-hidden />
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
      <div className="overflow-x-auto rounded-lg border bg-surface">
        <div className="min-w-[48rem]">
          <div className="grid grid-cols-[12rem_1fr] border-b bg-muted text-xs text-muted-foreground">
            <div className="px-2 py-1">
              {view.groupBy === undefined ? '' : (fields[view.groupBy]?.label ?? view.groupBy)}
            </div>
            <div className="grid" style={{ gridTemplateColumns: `repeat(${ticks}, 1fr)` }}>
              {Array.from({ length: ticks }, (_, i) => new Date(from.getTime() + i * DAY)).map(
                (tick) => (
                  <div key={iso(tick)} className="border-s px-1 py-1 text-center">
                    {tick.getUTCDate()}
                  </div>
                ),
              )}
            </div>
          </div>
          {[...groups].map(([key, rows]) => (
            <div key={key} className="grid grid-cols-[12rem_1fr] border-b">
              <div className="px-2 py-2 text-sm font-medium">
                {view.groupBy === undefined ? '' : display(view.groupBy, rows[0]?.[view.groupBy])}
              </div>
              <ul
                className="relative grid gap-1 py-1"
                aria-label={
                  view.groupBy === undefined
                    ? undefined
                    : display(view.groupBy, rows[0]?.[view.groupBy])
                }
              >
                {rows.map((r) => {
                  const start = Math.max(
                    from.getTime(),
                    new Date(`${String(r[view.dateStart]).slice(0, 10)}T00:00:00Z`).getTime(),
                  );
                  const end = Math.min(
                    to.getTime(),
                    new Date(
                      `${String(r[view.dateStop] ?? r[view.dateStart]).slice(0, 10)}T00:00:00Z`,
                    ).getTime() + DAY,
                  );
                  const progress =
                    view.progress === undefined
                      ? null
                      : Math.max(0, Math.min(100, Number(r[view.progress] ?? 0)));
                  return (
                    <li key={r.id} className="relative h-7">
                      <button
                        type="button"
                        onClick={() => props.onOpen(r.id)}
                        className="absolute inset-y-0 overflow-hidden rounded bg-primary/20 text-start text-xs text-foreground hover:bg-primary/30"
                        style={{
                          insetInlineStart: `${((start - from.getTime()) / total) * 100}%`,
                          width: `${Math.max(1, ((end - start) / total) * 100)}%`,
                        }}
                        title={`${display(view.title, r[view.title])}: ${format.date(String(r[view.dateStart]))} – ${format.date(String(r[view.dateStop] ?? r[view.dateStart]))}`}
                      >
                        {progress === null ? null : (
                          <span
                            aria-hidden
                            className="absolute inset-y-0 start-0 bg-primary/40"
                            style={{ width: `${progress}%` }}
                          />
                        )}
                        <span className="relative truncate px-1">
                          {display(view.title, r[view.title])}
                          {progress === null ? '' : ` · ${progress}%`}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
          {items.length === 0 && !records.isPending ? (
            <p className="p-6 text-sm text-muted-foreground">{t('empty')}</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
