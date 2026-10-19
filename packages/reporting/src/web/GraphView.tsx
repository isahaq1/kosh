/**
 * Charts (ECharts, loaded on demand): bar, line, area, stacked or pie over the report query, a series per value of
 * the second group, the comparison period as dashed series, theme colours from the design tokens, and a click on any
 * point drills down to its records. A visually hidden table gives screen readers the same data. `ReportChart` is
 * shared by the graph view and dashboard cards.
 */
import { Alert, Spinner, useKosh, type ViewProps } from '@isahaq/kosh-ui';
import type { Condition, GraphView as GraphDefinition, MeasureNode } from '@isahaq/kosh-views';
import { type ReactElement, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  and,
  formatValue,
  type Header,
  headerLabel,
  numeric,
  type ReportQuery,
  type ReportResult,
  useReport,
} from './shared.js';

type ECharts = {
  setOption(o: unknown, notMerge?: boolean): void;
  resize(): void;
  dispose(): void;
  on(e: string, h: (p: { dataIndex: number; seriesIndex: number }) => void): void;
};

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
}

/** Series of a chart from a report (rows = categories, columns = series). */
/** The categories and series of a chart. */
export interface ChartData {
  readonly categories: readonly Header[];
  readonly labels: readonly string[];
  readonly series: readonly {
    readonly header: Header;
    readonly name: string;
    readonly values: readonly number[];
    readonly previous: readonly number[] | undefined;
  }[];
}

export function chartData(
  report: ReportResult,
  measure: string,
  locale: string,
  none: string,
): ChartData {
  const categories = report.rows.children;
  const series = report.cols.children.length === 0 ? [report.cols] : report.cols.children;
  return {
    categories,
    labels: categories.map((c) => headerLabel(c, locale, none)),
    series: series.map((s) => ({
      header: s,
      name: s === report.cols ? '' : headerLabel(s, locale, none),
      values: categories.map((c) => numeric(report.cells[c.key]?.[s.key]?.[measure])),
      previous:
        report.comparison === undefined
          ? undefined
          : categories.map((c) => numeric(report.comparison?.cells[c.key]?.[s.key]?.[measure])),
    })),
  };
}

export interface ReportChartProps {
  readonly model: string;
  readonly chart: GraphDefinition['chart'];
  readonly groupBy: readonly string[];
  readonly measure: MeasureNode;
  readonly where: Condition | undefined;
  readonly title: string;
  readonly height?: number;
  readonly onDrill?: (domain: Condition) => void;
}

/** A chart over a report query. */
export function ReportChart({
  model,
  chart: kindName,
  groupBy,
  measure,
  where,
  title,
  height = 420,
  onDrill,
}: ReportChartProps): ReactElement {
  const { api, format, theme } = useKosh();
  const { t } = useTranslation('reporting');
  const element = useRef<HTMLDivElement>(null);
  const chart = useRef<ECharts | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const inputs = JSON.stringify([groupBy, where, measure]);
  const query = useMemo<ReportQuery>(() => {
    const [g, w, m] = JSON.parse(inputs) as [string[], Condition | null, MeasureNode]; // undefined → null
    return {
      rows: [g[0] as string],
      cols: g.length > 1 ? [g[1] as string] : [],
      measures: { [m.id]: m.measure },
      ...(w === null ? {} : { where: w }),
    };
  }, [inputs]);
  const report = useReport(api, model, query);
  const none = t('none');
  const data = useMemo(
    () =>
      report.data === undefined ? null : chartData(report.data, measure.id, format.locale, none),
    [report.data, measure.id, format.locale, none],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: the chart is rebuilt for new data, theme or kind; labels and the drill handler are read as they are then
  useEffect(() => {
    if (data === null || element.current === null) return;
    let disposed = false;
    void import('echarts')
      .then((echarts) => {
        if (disposed || element.current === null) return;
        chart.current?.dispose();
        const instance = echarts.init(element.current, undefined, {
          renderer: 'svg',
        }) as unknown as ECharts;
        chart.current = instance;
        const fg = token('--foreground');
        const muted = token('--muted-foreground');
        const palette = [
          token('--primary'),
          token('--success'),
          token('--warning'),
          token('--danger'),
          muted,
        ];
        const kind =
          kindName === 'pie' ? 'pie' : kindName === 'line' || kindName === 'area' ? 'line' : 'bar';
        const series =
          kind === 'pie'
            ? [
                {
                  type: 'pie',
                  radius: ['35%', '70%'],
                  data: data.labels.map((name, i) => ({
                    name,
                    value: data.series[0]?.values[i] ?? 0,
                  })),
                  label: { color: fg },
                },
              ]
            : data.series.flatMap((s) => [
                {
                  type: kind,
                  name: s.name || measure.label || measure.id,
                  data: s.values,
                  stack: kindName === 'stacked' ? 'total' : undefined,
                  areaStyle: kindName === 'area' ? {} : undefined,
                },
                ...(s.previous === undefined
                  ? []
                  : [
                      {
                        type: kind,
                        name: `${s.name} (previous)`,
                        data: s.previous,
                        lineStyle: { type: 'dashed' },
                        itemStyle: { opacity: 0.5 },
                      },
                    ]),
              ]);
        instance.setOption(
          {
            color: palette,
            backgroundColor: 'transparent',
            textStyle: { color: fg },
            tooltip: { trigger: kind === 'pie' ? 'item' : 'axis' },
            legend:
              data.series.length > 1 || kind === 'pie' ? { textStyle: { color: fg } } : undefined,
            grid: { left: 48, right: 16, top: 32, bottom: 48, containLabel: true },
            xAxis:
              kind === 'pie'
                ? undefined
                : { type: 'category', data: data.labels, axisLabel: { color: muted } },
            yAxis:
              kind === 'pie'
                ? undefined
                : {
                    type: 'value',
                    axisLabel: { color: muted },
                    splitLine: { lineStyle: { color: token('--border') } },
                  },
            series,
            aria: { enabled: true },
          },
          true,
        );
        instance.on('click', ({ dataIndex, seriesIndex }) => {
          const category = data.categories[dataIndex] as Header | undefined;
          const perSeries = data.series[0]?.previous === undefined ? 1 : 2;
          const serie = data.series[kind === 'pie' ? 0 : Math.floor(seriesIndex / perSeries)];
          if (category !== undefined) onDrill?.(and(category.domain, serie?.header.domain) ?? {});
        });
      })
      .catch((e: unknown) => setFailed(e instanceof Error ? e.message : String(e)));
    const resize = () => chart.current?.resize();
    window.addEventListener('resize', resize);
    return () => {
      disposed = true;
      window.removeEventListener('resize', resize);
    };
  }, [data, theme, kindName]);
  useEffect(() => () => chart.current?.dispose(), []);

  if (report.isError) return <Alert>{report.error.message}</Alert>;
  if (failed !== null) return <Alert>{failed}</Alert>;
  if (data === null) return <Spinner label="…" />;
  if (data.categories.length === 0)
    return <p className="p-6 text-sm text-muted-foreground">{t('empty')}</p>;
  return (
    <figure>
      <div ref={element} className="w-full" style={{ height }} role="img" aria-label={title} />
      <table className="sr-only">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col" />
            {data.series.map((s) => (
              <th key={s.header.key} scope="col">
                {s.name || t('total')}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.labels.map((label, i) => (
            <tr key={data.categories[i]?.key}>
              <th scope="row">{label}</th>
              {data.series.map((s) => (
                <td key={s.header.key}>
                  {formatValue(
                    report.data?.cells[data.categories[i]?.key ?? '']?.[s.header.key]?.[measure.id],
                    format,
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

/** The graph view. */
export function GraphView(props: ViewProps): ReactElement {
  const view = props.served.view as GraphDefinition;
  return (
    <div className="rounded-lg border bg-surface p-3">
      <ReportChart
        model={view.model}
        chart={view.chart}
        groupBy={props.groupBy.length > 0 ? props.groupBy : view.groupBy}
        measure={view.measure}
        where={props.where}
        title={view.label ?? view.model}
        {...(props.onDrill === undefined ? {} : { onDrill: props.onDrill })}
      />
    </div>
  );
}
