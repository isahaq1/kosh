/**
 * Workload (RFC 0026 step 3): people × weeks, each cell the person's highest total allocation that week across their
 * projects, tinted by how full it is — over 100 % in red, with the projects behind it in the cell's title. Projects
 * managers see everyone; others see themselves (the server decides). Earlier and later move by the span shown.
 */
import { Button, EmptyState, type PageProps, useKosh } from '@kosh/ui';
import { useQuery } from '@tanstack/react-query';
import { type ReactElement, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface Row {
  readonly user: number;
  readonly name: string;
  readonly weeks: readonly number[];
  readonly projects: readonly {
    readonly id: number;
    readonly name: string;
    readonly allocation: number;
    readonly from: string | null;
    readonly to: string | null;
  }[];
}

const WEEKS = 12;
const DAY = 86_400_000;
const today = () => new Date().toISOString().slice(0, 10);
const shift = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

/** The cell's tint: empty, partly booked, full, over. */
function tone(percent: number): string {
  if (percent === 0) return 'text-muted-foreground';
  if (percent > 100) return 'bg-danger/20 font-semibold text-danger';
  if (percent >= 80) return 'bg-primary/25';
  return 'bg-primary/10';
}

export function Workload({ api }: PageProps): ReactElement {
  const { t } = useTranslation('project');
  const { format } = useKosh();
  const [from, setFrom] = useState(today);
  const data = useQuery({
    queryKey: ['project.workload', from],
    queryFn: () =>
      api.call<{ weeks: string[]; people: Row[] }>(
        'GET',
        `/api/v1/projects/workload?from=${from}&weeks=${WEEKS}`,
      ),
  });
  const weeks = data.data?.weeks ?? [];
  const people = data.data?.people ?? [];
  const over = people.filter((p) => p.weeks.some((w) => w > 100)).length;
  return (
    <div className="grid gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">{t('workload.title')}</h1>
          <p className="text-sm text-muted-foreground">
            {over === 0 ? t('workload.noneOver') : t('workload.over', { count: over })}
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => setFrom(shift(from, -7 * WEEKS))}>{t('workload.earlier')}</Button>
          <Button onClick={() => setFrom(today())}>{t('workload.today')}</Button>
          <Button onClick={() => setFrom(shift(from, 7 * WEEKS))}>{t('workload.later')}</Button>
        </div>
      </div>
      {data.isError ? (
        <p className="text-sm text-danger">{data.error.message}</p>
      ) : people.length === 0 ? (
        <EmptyState title={data.isLoading ? t('workload.loading') : t('workload.empty')} />
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-sm">
            <caption className="sr-only">{t('workload.caption')}</caption>
            <thead className="bg-muted">
              <tr>
                <th scope="col" className="sticky start-0 bg-muted px-2 py-1 text-start">
                  {t('workload.person')}
                </th>
                {weeks.map((w) => (
                  <th key={w} scope="col" className="px-2 py-1 text-end font-normal tabular-nums">
                    {format.date(w)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {people.map((p) => (
                <tr key={p.user} className="border-t border-border">
                  <th scope="row" className="sticky start-0 bg-background px-2 py-1 text-start">
                    <span className="font-medium">{p.name}</span>
                    <span className="block text-xs font-normal text-muted-foreground">
                      {p.projects
                        .map((x) => `${x.name} ${format.number(x.allocation)}%`)
                        .join(' · ')}
                    </span>
                  </th>
                  {p.weeks.map((value, i) => (
                    <td
                      key={weeks[i]}
                      className={`px-2 py-1 text-end tabular-nums ${tone(value)}`}
                      aria-label={t('workload.cell', {
                        name: p.name,
                        week: format.date(weeks[i] ?? ''),
                        percent: format.number(value),
                      })}
                    >
                      {value === 0 ? '·' : `${format.number(value)}%`}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
