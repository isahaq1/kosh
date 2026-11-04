/**
 * A project's schedule (RFC 0026 step 5), a node component of the project form: its tasks as bars over the weeks from
 * the project's start to its end, the baseline as a thin bar beneath each, the critical path in red, arrows from each
 * task to what waits for it, milestones as diamonds. "Move waiting tasks" puts tasks that start before what they wait
 * for is finished after it, keeping their length (`POST /api/v1/projects/:id/schedule/apply`). Read as the user.
 */
import { Alert, Button, type NodeComponentProps, useKosh } from '@kosh/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { type ReactElement, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface Row {
  readonly id: number;
  readonly name: string;
  readonly start: string | null;
  readonly end: string | null;
  readonly earlyStart: string;
  readonly earlyFinish: string;
  readonly baselineStart: string | null;
  readonly baselineEnd: string | null;
  readonly float: number;
  readonly critical: boolean;
  readonly done: boolean;
  readonly milestone: boolean;
  readonly progress: number;
  readonly predecessors: readonly { readonly id: number; readonly lag: number }[];
}

const DAY = 86_400_000;
const ROW = 32;
const LABEL = 200;
const dayOf = (iso: string) => Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY);

export function Schedule({
  api,
  record,
  version,
  reload,
}: NodeComponentProps): ReactElement | null {
  const { t } = useTranslation('project');
  const { format } = useKosh();
  const [error, setError] = useState<string | null>(null);
  const [moved, setMoved] = useState<number | null>(null);
  const id = typeof record?.id === 'number' ? record.id : null;
  const data = useQuery({
    queryKey: ['project.schedule', id, version],
    enabled: id !== null,
    queryFn: () =>
      api.call<{ start: string; end: string; tasks: Row[] }>(
        'GET',
        `/api/v1/projects/${String(id)}/schedule`,
      ),
  });
  const apply = useMutation({
    mutationFn: () =>
      api.call<{ moved: unknown[] }>('POST', `/api/v1/projects/${String(id)}/schedule/apply`, {}),
    onSuccess: (r) => {
      setError(null);
      setMoved(r.moved.length);
      void data.refetch();
      reload();
    },
    onError: (e) => setError(e.message),
  });
  if (id === null) return null;
  if (data.isPending)
    return <p className="text-sm text-muted-foreground">{t('schedule.loading')}</p>;
  if (data.isError) return <Alert tone="danger">{data.error.message}</Alert>;
  const { tasks } = data.data;
  if (tasks.length === 0) return null;

  // The span shown: the project's tasks, their baselines and their earliest dates.
  const days = tasks.flatMap((r) =>
    [r.start, r.end, r.baselineStart, r.baselineEnd, r.earlyStart, r.earlyFinish].flatMap((d) =>
      d === null ? [] : [dayOf(d)],
    ),
  );
  const first = Math.min(...days);
  const last = Math.max(...days);
  const span = Math.max(last - first + 1, 7);
  const pct = (day: number) => ((day - first) / span) * 100;
  const index = new Map(tasks.map((r, i) => [r.id, i]));
  const barOf = (r: Row) => {
    const s = dayOf(r.start ?? r.earlyStart);
    const e = dayOf(r.end ?? r.earlyFinish);
    return { left: pct(s), width: Math.max(((e - s + 1) / span) * 100, 0.8) };
  };
  const late = tasks.filter((r) => r.start !== null && r.start < r.earlyStart && !r.done).length;
  const critical = tasks.filter((r) => r.critical).length;
  const weeks: number[] = [];
  for (let d = first - ((first + 3) % 7); d <= last; d += 7) weeks.push(d); // Mondays

  return (
    <section aria-label={t('schedule.title')} className="grid gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">{t('schedule.title')}</h3>
          <p className="text-xs text-muted-foreground">
            {t('schedule.summary', { critical, late, count: late })}
          </p>
        </div>
        <Button busy={apply.isPending} disabled={late === 0} onClick={() => apply.mutate()}>
          {t('schedule.apply')}
        </Button>
      </div>
      {error === null ? null : <Alert tone="danger">{error}</Alert>}
      {moved === null ? null : (
        <p role="status" className="text-xs text-muted-foreground">
          {t('schedule.moved', { count: moved })}
        </p>
      )}
      <div className="overflow-x-auto rounded-md border border-border">
        <div className="relative min-w-[720px]" style={{ height: (tasks.length + 1) * ROW }}>
          {/* The weeks */}
          <div className="absolute inset-y-0 end-0" style={{ insetInlineStart: LABEL }}>
            {weeks.map((w) => (
              <div
                key={w}
                className="absolute inset-y-0 border-s border-border/60 ps-1 text-[10px] text-muted-foreground"
                style={{ insetInlineStart: `${pct(w)}%` }}
              >
                {format.date(new Date(w * DAY).toISOString().slice(0, 10))}
              </div>
            ))}
          </div>
          <ul>
            {tasks.map((r, i) => {
              const bar = barOf(r);
              const base =
                r.baselineStart !== null && r.baselineEnd !== null
                  ? {
                      left: pct(dayOf(r.baselineStart)),
                      width: ((dayOf(r.baselineEnd) - dayOf(r.baselineStart) + 1) / span) * 100,
                    }
                  : null;
              const label = t(r.critical ? 'schedule.barCritical' : 'schedule.bar', {
                name: r.name,
                start: format.date(r.start ?? r.earlyStart),
                end: format.date(r.end ?? r.earlyFinish),
                float: r.float,
              });
              return (
                <li
                  key={r.id}
                  className="absolute inset-x-0 flex items-center"
                  style={{ top: (i + 1) * ROW, height: ROW }}
                >
                  <span className="truncate px-2 text-xs" style={{ width: LABEL }} title={r.name}>
                    {r.name}
                  </span>
                  <span className="relative h-full flex-1">
                    {base === null ? null : (
                      <span
                        aria-hidden="true"
                        className="absolute bottom-1 h-1 rounded bg-muted-foreground/40"
                        style={{ insetInlineStart: `${base.left}%`, width: `${base.width}%` }}
                      />
                    )}
                    {r.milestone ? (
                      <span
                        role="img"
                        aria-label={label}
                        className={`absolute top-2 size-3 rotate-45 ${r.critical ? 'bg-danger' : 'bg-primary'}`}
                        style={{ insetInlineStart: `${bar.left}%` }}
                      />
                    ) : (
                      <span
                        role="img"
                        aria-label={label}
                        className={`absolute top-1.5 h-4 overflow-hidden rounded ${
                          r.critical ? 'bg-danger/80' : 'bg-primary/70'
                        } ${r.done ? 'opacity-50' : ''}`}
                        style={{ insetInlineStart: `${bar.left}%`, width: `${bar.width}%` }}
                      >
                        <span
                          className="block h-full bg-black/20"
                          style={{ width: `${Math.max(0, Math.min(100, r.progress))}%` }}
                        />
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
          {/* Arrows from each task to what waits for it */}
          <svg
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 end-0 overflow-visible"
            style={{ insetInlineStart: LABEL, width: `calc(100% - ${LABEL}px)` }}
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
          >
            {tasks.flatMap((r) =>
              r.predecessors.flatMap((p) => {
                const from = tasks[index.get(p.id) ?? -1];
                if (from === undefined) return [];
                const a = barOf(from);
                const b = barOf(r);
                const height = (tasks.length + 1) * ROW;
                const y1 = (((index.get(p.id) ?? 0) + 1.5) * ROW * 100) / height;
                const y2 = (((index.get(r.id) ?? 0) + 1.5) * ROW * 100) / height;
                const x1 = a.left + a.width;
                const x2 = b.left;
                return [
                  <path
                    key={`${p.id}-${r.id}`}
                    d={`M ${x1} ${y1} H ${Math.max(x1, x2 - 0.6)} V ${y2} H ${x2}`}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1}
                    vectorEffect="non-scaling-stroke"
                    className={
                      r.critical && from.critical ? 'text-danger' : 'text-muted-foreground'
                    }
                  />,
                ];
              }),
            )}
          </svg>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{t('schedule.legend')}</p>
    </section>
  );
}
