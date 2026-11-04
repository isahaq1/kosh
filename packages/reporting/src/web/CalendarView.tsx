/**
 * The calendar view: records by their start (and stop) within the search, as a **month** grid, or a **week** or
 * **day** time grid — hours down the side, each timed record placed from its start to its end, records that overlap
 * side by side, all-day and date-only records in a band on top. Previous / next / today; the mode is switched on
 * screen (the view's own is the start, remembered per view). Colours by a field's value. Opening an event opens its
 * record; clicking an empty day or hour starts a new record there; "+N more" on a month day opens that day.
 */
import { Alert, Button, Spinner, useKosh, useRowNames, type ViewProps } from '@kosh/ui';
import type { CalendarView as CalendarDefinition } from '@kosh/views';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { and } from './shared.js';

const DAY = 86_400_000;
const HOUR_PX = 48;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const COLORS = [
  'bg-primary/15 text-primary border-primary/40',
  'bg-success/15 text-success border-success/40',
  'bg-warning/20 text-warning-text border-warning/50',
  'bg-danger/15 text-danger border-danger/40',
  'bg-accent text-accent-foreground border-border',
];

type Mode = 'month' | 'week' | 'day';
type Row = Record<string, unknown> & { id: number };

function colorOf(value: unknown): string {
  const text = String(value ?? '');
  let hash = 0;
  for (const c of text) hash = (hash * 31 + c.charCodeAt(0)) | 0;
  return COLORS[Math.abs(hash) % COLORS.length] as string;
}

/** The days shown: whole weeks (Monday first) covering the month, one week, or the day. */
export function gridDays(anchor: Date, mode: Mode): Date[] {
  if (mode === 'day') return [new Date(anchor)];
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

/** Lanes for overlapping timed events: each gets its lane and the number of lanes of its cluster. */
export function lanesOf(
  events: readonly { readonly id: number; readonly start: number; readonly end: number }[],
): Map<number, { lane: number; lanes: number }> {
  const sorted = [...events].sort((a, b) => a.start - b.start || b.end - a.end);
  const out = new Map<number, { lane: number; lanes: number }>();
  let cluster: { id: number; end: number; lane: number }[] = [];
  let clusterEnd = -Infinity;
  const close = () => {
    const lanes = Math.max(1, ...cluster.map((c) => c.lane + 1));
    for (const c of cluster) out.set(c.id, { lane: c.lane, lanes });
    cluster = [];
  };
  for (const e of sorted) {
    if (e.start >= clusterEnd && cluster.length > 0) close();
    const used = new Set(cluster.filter((c) => c.end > e.start).map((c) => c.lane));
    let lane = 0;
    while (used.has(lane)) lane += 1;
    cluster.push({ id: e.id, end: e.end, lane });
    clusterEnd = Math.max(clusterEnd, e.end);
  }
  close();
  return out;
}

const storageKey = (id: string) => `kosh.calendar.mode.${id}`;
function savedMode(id: string, fallback: Mode): Mode {
  try {
    const v = localStorage.getItem(storageKey(id));
    return v === 'month' || v === 'week' || v === 'day' ? v : fallback;
  } catch {
    return fallback;
  }
}

export function CalendarView(props: ViewProps): ReactElement {
  const { api, format } = useKosh();
  const { t } = useTranslation('reporting');
  const view = props.served.view as CalendarDefinition;
  const fields = props.served.fields[view.model] ?? {};
  const viewKey = `${view.model}.${view.dateStart}`;
  const [mode, setModeState] = useState<Mode>(() => savedMode(viewKey, view.mode ?? 'month'));
  const setMode = (m: Mode) => {
    setModeState(m);
    try {
      localStorage.setItem(storageKey(viewKey), m);
    } catch {
      // storage unavailable
    }
  };
  const [anchor, setAnchor] = useState(() => {
    const now = new Date();
    return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  });
  const days = gridDays(anchor, mode);
  const from = iso(days[0] as Date);
  const to = iso(new Date((days[days.length - 1] as Date).getTime() + DAY));
  const stop = view.dateStop ?? view.dateStart;
  const timed = fields[view.dateStart]?.kind === 'datetime';
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
        limit: 1000,
        order: [`${view.dateStart} asc`],
      }),
  });
  const items = (records.data?.items ?? []) as Row[];
  const names = useRowNames(items, Object.values(fields));
  const move = (n: number) =>
    setAnchor((a) =>
      mode === 'month'
        ? new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth() + n, 1))
        : new Date(a.getTime() + n * (mode === 'week' ? 7 : 1) * DAY),
    );
  const title = (row: Row) => {
    const value = row[view.title];
    const field = fields[view.title];
    if (field?.kind === 'many2one' && typeof value === 'number')
      return names.get(field.target ?? '')?.get(value) ?? `#${value}`;
    return String(value ?? `#${String(row.id)}`);
  };
  const colour = (r: Row) => colorOf(view.color === undefined ? undefined : r[view.color]);
  const heading = new Intl.DateTimeFormat(
    format.locale,
    mode === 'month'
      ? { month: 'long', year: 'numeric', timeZone: 'UTC' }
      : mode === 'week'
        ? { dateStyle: 'medium', timeZone: 'UTC' }
        : { dateStyle: 'full', timeZone: 'UTC' },
  ).format(mode === 'month' ? anchor : (days[0] as Date));
  const today = iso(new Date());

  /** A record's span as local times (a date-only value is the whole day). */
  const spanOf = (r: Row): { start: Date; end: Date; allDay: boolean } | null => {
    const s = r[view.dateStart];
    if (s === null || s === undefined || s === '') return null;
    const e = r[stop] ?? s;
    if (!timed) {
      const sd = String(s).slice(0, 10);
      const ed = String(e).slice(0, 10);
      return {
        start: new Date(`${sd}T00:00:00`),
        end: new Date(new Date(`${ed}T00:00:00`).getTime() + DAY),
        allDay: true,
      };
    }
    const start = new Date(String(s));
    const end0 = new Date(String(e));
    const end = end0.getTime() > start.getTime() ? end0 : new Date(start.getTime() + 30 * 60_000);
    return { start, end, allDay: end.getTime() - start.getTime() >= DAY };
  };
  const localDay = (d: Date) => new Date(`${iso(d)}T00:00:00`); // the grid's day, at local midnight
  const onDay = (r: Row, day: Date) => {
    const span = spanOf(r);
    if (span === null) return false;
    const a = localDay(day).getTime();
    return span.start.getTime() < a + DAY && span.end.getTime() > a;
  };
  const create = (day: Date, hour?: number) => {
    const at =
      hour === undefined
        ? iso(day)
        : new Date(localDay(day).getTime() + hour * 3_600_000).toISOString();
    props.onOpen('new', {
      [view.dateStart]: timed ? (hour === undefined ? `${iso(day)}T09:00:00` : at) : iso(day),
    });
  };

  const modes: Mode[] = ['month', 'week', 'day'];
  const toolbar = (
    <div className="flex flex-wrap items-center gap-2">
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
      <fieldset className="ms-auto inline-flex overflow-hidden rounded-md border">
        <legend className="sr-only">{t('calendarMode')}</legend>
        {modes.map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={mode === m}
            onClick={() => setMode(m)}
            className={`px-3 py-1 text-sm ${mode === m ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
          >
            {t(`mode_${m}`)}
          </button>
        ))}
      </fieldset>
    </div>
  );

  return (
    <div className="grid gap-3">
      {toolbar}
      {records.isError ? <Alert>{records.error.message}</Alert> : null}
      {records.isPending ? <Spinner label="…" /> : null}
      {mode === 'month' ? (
        <MonthGrid
          days={days}
          anchor={anchor}
          heading={heading}
          today={today}
          items={items}
          onDay={onDay}
          title={title}
          colour={colour}
          onOpen={(id) => props.onOpen(id)}
          onCreate={(day) => create(day)}
          onShowDay={(day) => {
            setAnchor(day);
            setMode('day');
          }}
          weekday={(d) =>
            new Intl.DateTimeFormat(format.locale, { weekday: 'short', timeZone: 'UTC' }).format(d)
          }
          more={(n) => t('more', { count: n })}
          dateLabel={(key) => format.date(key)}
          newLabel={(key) => t('newOn', { date: format.date(key) })}
        />
      ) : (
        <TimeGrid
          days={days}
          heading={heading}
          today={today}
          items={items}
          spanOf={spanOf}
          onDay={onDay}
          localDay={localDay}
          title={title}
          colour={colour}
          onOpen={(id) => props.onOpen(id)}
          onCreate={create}
          dayLabel={(d) =>
            new Intl.DateTimeFormat(format.locale, {
              weekday: 'short',
              day: 'numeric',
              timeZone: 'UTC',
            }).format(d)
          }
          hourLabel={(h) =>
            new Intl.DateTimeFormat(format.locale, { hour: 'numeric' }).format(
              new Date(2000, 0, 1, h),
            )
          }
          timeLabel={(d) =>
            new Intl.DateTimeFormat(format.locale, { hour: 'numeric', minute: '2-digit' }).format(d)
          }
          allDayLabel={t('allDay')}
          newLabel={(key, h) => t('newAt', { date: format.date(key), hour: h })}
        />
      )}
    </div>
  );
}

function MonthGrid(p: {
  days: Date[];
  anchor: Date;
  heading: string;
  today: string;
  items: Row[];
  onDay: (r: Row, day: Date) => boolean;
  title: (r: Row) => string;
  colour: (r: Row) => string;
  onOpen: (id: number) => void;
  onCreate: (day: Date) => void;
  onShowDay: (day: Date) => void;
  weekday: (d: Date) => string;
  more: (n: number) => string;
  dateLabel: (key: string) => string;
  newLabel: (key: string) => string;
}): ReactElement {
  return (
    <table
      aria-label={p.heading}
      className="w-full table-fixed border-collapse overflow-hidden rounded-lg border bg-surface"
    >
      <thead>
        <tr>
          {p.days.slice(0, 7).map((d) => (
            <th
              key={iso(d)}
              scope="col"
              className="border-b bg-muted px-2 py-1 text-start text-xs font-medium text-muted-foreground"
            >
              {p.weekday(d)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: p.days.length / 7 }, (_, w) => p.days.slice(w * 7, w * 7 + 7)).map(
          (week) => (
            <tr key={iso(week[0] as Date)}>
              {week.map((day) => {
                const key = iso(day);
                const events = p.items.filter((r) => p.onDay(r, day));
                const outside = day.getUTCMonth() !== p.anchor.getUTCMonth();
                return (
                  <td
                    key={key}
                    className={`group h-28 border-b border-e p-1 align-top ${outside ? 'bg-muted/40 text-muted-foreground' : ''}`}
                  >
                    <div className="mb-1 flex items-center justify-between">
                      <span
                        className={`text-xs ${key === p.today ? 'inline-block rounded-full bg-primary px-1.5 text-primary-foreground' : ''}`}
                      >
                        <span className="sr-only">{p.dateLabel(key)}</span>
                        <span aria-hidden>{day.getUTCDate()}</span>
                      </span>
                      <button
                        type="button"
                        aria-label={p.newLabel(key)}
                        className="rounded px-1 text-xs text-muted-foreground opacity-0 hover:bg-muted focus:opacity-100 group-hover:opacity-100"
                        onClick={() => p.onCreate(day)}
                      >
                        +
                      </button>
                    </div>
                    <ul className="grid gap-0.5">
                      {events.slice(0, 3).map((r) => (
                        <li key={r.id}>
                          <button
                            type="button"
                            className={`w-full truncate rounded border-s-2 px-1 text-start text-xs ${p.colour(r)}`}
                            onClick={() => p.onOpen(r.id)}
                          >
                            {p.title(r)}
                          </button>
                        </li>
                      ))}
                      {events.length > 3 ? (
                        <li>
                          <button
                            type="button"
                            className="px-1 text-xs text-muted-foreground hover:underline"
                            onClick={() => p.onShowDay(day)}
                          >
                            {p.more(events.length - 3)}
                          </button>
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
  );
}

function TimeGrid(p: {
  days: Date[];
  heading: string;
  today: string;
  items: Row[];
  spanOf: (r: Row) => { start: Date; end: Date; allDay: boolean } | null;
  onDay: (r: Row, day: Date) => boolean;
  localDay: (d: Date) => Date;
  title: (r: Row) => string;
  colour: (r: Row) => string;
  onOpen: (id: number) => void;
  onCreate: (day: Date, hour?: number) => void;
  dayLabel: (d: Date) => string;
  hourLabel: (h: number) => string;
  timeLabel: (d: Date) => string;
  allDayLabel: string;
  newLabel: (key: string, hour: string) => string;
}): ReactElement {
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Open on the working day (from 7 in the morning).
    if (scroller.current !== null) scroller.current.scrollTop = 7 * HOUR_PX;
  }, []);
  const hours = Array.from({ length: 24 }, (_, h) => h);
  const allDay = (day: Date) =>
    p.items.filter((r) => p.spanOf(r)?.allDay === true && p.onDay(r, day));
  const timedOn = (day: Date) => {
    const base = p.localDay(day).getTime();
    return p.items
      .map((r) => ({ r, span: p.spanOf(r) }))
      .filter(({ r, span }) => span !== null && !span.allDay && p.onDay(r, day))
      .map(({ r, span }) => {
        const s = Math.max(span?.start.getTime() ?? base, base);
        const e = Math.min(span?.end.getTime() ?? base, base + DAY);
        return { r, start: (s - base) / 60_000, end: (e - base) / 60_000, span };
      });
  };
  const columns = `4rem repeat(${p.days.length}, minmax(0, 1fr))`;
  return (
    <section aria-label={p.heading} className="overflow-hidden rounded-lg border bg-surface">
      {/* Day headings and the all-day band */}
      <div className="grid border-b" style={{ gridTemplateColumns: columns }}>
        <div className="border-e bg-muted" />
        {p.days.map((d) => (
          <div
            key={iso(d)}
            className={`border-e bg-muted px-2 py-1 text-xs font-medium ${iso(d) === p.today ? 'text-primary' : 'text-muted-foreground'}`}
          >
            {p.dayLabel(d)}
          </div>
        ))}
        <div className="border-e px-1 py-1 text-[10px] text-muted-foreground">{p.allDayLabel}</div>
        {p.days.map((d) => (
          <ul key={`all-${iso(d)}`} className="grid min-h-6 content-start gap-0.5 border-e p-0.5">
            {allDay(d).map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  className={`w-full truncate rounded border-s-2 px-1 text-start text-xs ${p.colour(r)}`}
                  onClick={() => p.onOpen(r.id)}
                >
                  {p.title(r)}
                </button>
              </li>
            ))}
          </ul>
        ))}
      </div>
      {/* Hours */}
      <div ref={scroller} className="max-h-[36rem] overflow-y-auto">
        <div className="grid" style={{ gridTemplateColumns: columns }}>
          <div className="border-e">
            {hours.map((h) => (
              <div
                key={h}
                className="relative border-b text-end text-[10px] text-muted-foreground"
                style={{ height: HOUR_PX }}
              >
                <span className="absolute -top-2 end-1 bg-surface px-0.5">
                  {h === 0 ? '' : p.hourLabel(h)}
                </span>
              </div>
            ))}
          </div>
          {p.days.map((day) => {
            const events = timedOn(day);
            const lanes = lanesOf(events.map((e) => ({ id: e.r.id, start: e.start, end: e.end })));
            const key = iso(day);
            const now = new Date();
            const nowMinutes = key === p.today ? now.getHours() * 60 + now.getMinutes() : null;
            return (
              <div key={key} className="relative border-e">
                {hours.map((h) => (
                  <button
                    key={h}
                    type="button"
                    aria-label={p.newLabel(key, p.hourLabel(h))}
                    className="block w-full border-b hover:bg-muted/50 focus:bg-muted/50"
                    style={{ height: HOUR_PX }}
                    onClick={() => p.onCreate(day, h)}
                  />
                ))}
                {nowMinutes === null ? null : (
                  <div
                    aria-hidden
                    className="pointer-events-none absolute inset-x-0 border-t-2 border-danger"
                    style={{ top: (nowMinutes / 60) * HOUR_PX }}
                  />
                )}
                {events.map(({ r, start, end, span }) => {
                  const lane = lanes.get(r.id) ?? { lane: 0, lanes: 1 };
                  const width = 100 / lane.lanes;
                  return (
                    <button
                      key={r.id}
                      type="button"
                      className={`absolute overflow-hidden rounded border-s-2 px-1 text-start text-xs shadow-sm ${p.colour(r)}`}
                      style={{
                        top: (start / 60) * HOUR_PX,
                        height: Math.max(((end - start) / 60) * HOUR_PX - 2, 18),
                        insetInlineStart: `calc(${lane.lane * width}% + 1px)`,
                        width: `calc(${width}% - 3px)`,
                      }}
                      onClick={() => p.onOpen(r.id)}
                    >
                      <span className="block truncate font-medium">{p.title(r)}</span>
                      {span === null ? null : (
                        <span className="block truncate opacity-80">
                          {p.timeLabel(span.start)} – {p.timeLabel(span.end)}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
