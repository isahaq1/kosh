/**
 * The cohort view (RFC 0005 §6): records grouped by when they started (rows), and how many periods later they
 * stopped (columns), as a share of the cohort still open (`retention`) or closed (`churn`). One report query:
 * start buckets × stop buckets; the periods are computed from the two buckets.
 */
import { Alert, Spinner, useKosh, type ViewProps } from '@kosh/ui';
import type { CohortView as CohortDefinition } from '@kosh/views';
import { type ReactElement, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type Header,
  headerLabel,
  numeric,
  type ReportQuery,
  type ReportResult,
  useReport,
} from './shared.js';

/** Whole periods between two bucket starts. */
export function periodsBetween(
  start: string,
  stop: string,
  interval: 'day' | 'week' | 'month',
): number {
  const a = new Date(`${start}T00:00:00Z`);
  const b = new Date(`${stop}T00:00:00Z`);
  if (interval === 'month')
    return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  return Math.round((b.getTime() - a.getTime()) / 86_400_000 / (interval === 'week' ? 7 : 1));
}

/** The cohort table: per start bucket, its size and the share open (or closed) after 0..n periods. */
/** One cohort: its start bucket, size, and share per period. */
export interface CohortRow {
  readonly row: Header;
  readonly size: number;
  readonly shares: readonly number[];
}

export function cohortTable(
  report: ReportResult,
  interval: 'day' | 'week' | 'month',
  mode: 'retention' | 'churn',
): CohortRow[] {
  // Records without a start date belong to no cohort.
  const starts = report.rows.children.filter((row) => row.value !== null);
  const offsets = starts.flatMap((row) =>
    report.cols.children
      .filter((c) => c.value !== null)
      .map((c) => periodsBetween(String(row.value), String(c.value), interval)),
  );
  const width = Math.max(0, ...offsets.filter(Number.isFinite)) + 1;
  return starts.map((row) => {
    const size = numeric(report.cells[row.key]?.[report.cols.key]?.['n']);
    const closedAt = new Array<number>(width).fill(0);
    for (const col of report.cols.children) {
      if (col.value === null) continue; // never closed
      const k = Math.max(0, periodsBetween(String(row.value), String(col.value), interval));
      if (k < width)
        closedAt[k] = (closedAt[k] ?? 0) + numeric(report.cells[row.key]?.[col.key]?.['n']);
    }
    let closed = 0;
    const shares = closedAt.map((c) => {
      closed += c;
      return size === 0 ? 0 : mode === 'churn' ? closed / size : (size - closed) / size;
    });
    return { row, size, shares };
  });
}

export function CohortView(props: ViewProps): ReactElement {
  const { api, format } = useKosh();
  const { t } = useTranslation('reporting');
  const view = props.served.view as CohortDefinition;
  const mode = view.mode ?? 'retention';
  const inputs = JSON.stringify([props.where, view.dateStart, view.dateStop, view.interval]);
  const query = useMemo<ReportQuery>(() => {
    const [where, start, stop, interval] = JSON.parse(inputs) as [
      Record<string, unknown> | null, // undefined → null in JSON
      string,
      string,
      string,
    ];
    return {
      rows: [`${start}:${interval}`],
      cols: [`${stop}:${interval}`],
      measures: { n: 'count' },
      ...(where === null ? {} : { where }),
    };
  }, [inputs]);
  const report = useReport(api, view.model, query);
  if (report.isError) return <Alert>{report.error.message}</Alert>;
  if (report.data === undefined) return <Spinner label="…" />;
  const table = cohortTable(report.data, view.interval, mode);
  const width = Math.max(1, ...table.map((r) => r.shares.length));
  const periods = Array.from({ length: width }, (_, k) => k);
  if (table.length === 0) return <p className="p-6 text-sm text-muted-foreground">{t('empty')}</p>;
  return (
    <div className="overflow-auto rounded-lg border bg-surface">
      <table className="w-full border-collapse text-sm">
        <caption className="px-3 py-2 text-start text-sm text-muted-foreground">{t(mode)}</caption>
        <thead className="bg-muted">
          <tr>
            <th scope="col" className="px-2 py-1 text-start">
              {t('cohort')}
            </th>
            <th scope="col" className="px-2 py-1 text-end">
              {t('size')}
            </th>
            {periods.map((k) => (
              <th key={k} scope="col" className="px-2 py-1 text-end font-medium">
                {t('period', { n: k })}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.map(({ row, size, shares }) => (
            <tr key={row.key} className="border-t">
              <th scope="row" className="px-2 py-1 text-start font-normal">
                <button
                  type="button"
                  className="hover:underline"
                  onClick={() => props.onDrill?.(row.domain)}
                >
                  {headerLabel(row, format.locale, t('none'))}
                </button>
              </th>
              <td className="px-2 py-1 text-end tabular-nums">{format.number(size)}</td>
              {periods.map((k) => {
                const share = shares[k];
                return (
                  <td
                    key={k}
                    className="px-2 py-1 text-end tabular-nums"
                    style={
                      share === undefined
                        ? undefined
                        : {
                            backgroundColor: `color-mix(in oklch, var(--primary) ${Math.round(share * 50)}%, transparent)`,
                          }
                    }
                  >
                    {share === undefined ? '' : `${(share * 100).toFixed(0)}%`}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
