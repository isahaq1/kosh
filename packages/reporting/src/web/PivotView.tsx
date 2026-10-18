/**
 * The pivot view (RFC 0005): rows × columns × measures from one report query, multi-level headers that collapse and
 * expand without another query (every level is in the result), totals, a heat map, period comparison, flip, measure
 * selection, drill-down to the records of any cell, and XLSX / CSV downloads (the server formats them).
 */
import {
  Alert,
  Button,
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuTrigger,
  Spinner,
  useKosh,
  type ViewProps,
} from '@kosh/ui';
import type { MeasureNode, PivotView as PivotDefinition } from '@kosh/views';
import { ArrowLeftRight, ChevronDown, ChevronRight, Download } from 'lucide-react';
import { type ReactElement, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  and,
  change,
  formatValue,
  type Header,
  headerLabel,
  numeric,
  type ReportQuery,
  saveDownload,
  useReport,
  visibleLeaves,
  yearToDate,
} from './shared.js';

const NS = 'reporting';

function measureLabel(
  m: MeasureNode,
  labels: Readonly<Record<string, { label: string }>>,
  count: string,
): string {
  if (m.label !== undefined) return m.label;
  if (m.measure === 'count') return count;
  const field = Object.values(m.measure)[0] as string;
  return labels[field]?.label ?? field;
}

export function PivotView(props: ViewProps): ReactElement {
  const { api, format } = useKosh();
  const { t } = useTranslation(NS);
  const view = props.served.view as PivotDefinition;
  const fields = props.served.fields[view.model] ?? {};
  const [flipped, setFlipped] = useState(false);
  const [selected, setSelected] = useState<readonly string[]>(view.measures.map((m) => m.id));
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [comparison, setComparison] = useState<'none' | 'previous' | 'yoy'>('none');
  const [range, setRange] = useState(yearToDate);
  const [busy, setBusy] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const baseRows = props.groupBy.length > 0 ? [...props.groupBy] : [...view.rows];
  const rows = flipped ? [...view.cols] : baseRows;
  const cols = flipped ? baseRows : [...view.cols];
  const measures = view.measures.filter((m) => selected.includes(m.id));
  const inputs = JSON.stringify([
    rows,
    cols,
    measures.map((m) => [m.id, m.measure]),
    props.where ?? null,
    comparison === 'none' || view.comparison === undefined
      ? null
      : { field: view.comparison.field, mode: comparison, ...range },
  ]);
  const query = useMemo<ReportQuery | null>(() => {
    const [r, c, ms, where, cmp] = JSON.parse(inputs) as [
      string[],
      string[],
      [string, ReportQuery['measures'][string]][],
      Record<string, unknown> | null,
      NonNullable<ReportQuery['comparison']> | null,
    ];
    if (ms.length === 0) return null;
    return {
      rows: r,
      cols: c,
      measures: Object.fromEntries(ms),
      ...(where === null ? {} : { where }),
      ...(cmp === null ? {} : { comparison: cmp }),
    };
  }, [inputs]);
  const report = useReport(api, view.model, query);

  const toggle = (key: string) =>
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const toolbar = (
    <div className="flex flex-wrap items-center gap-2">
      <Menu>
        <MenuTrigger asChild>
          <Button size="sm">{t('measures')}</Button>
        </MenuTrigger>
        <MenuContent align="start">
          {view.measures.map((m) => (
            <MenuCheckboxItem
              key={m.id}
              checked={selected.includes(m.id)}
              onSelect={(e) => e.preventDefault()}
              onCheckedChange={() =>
                setSelected((s) => (s.includes(m.id) ? s.filter((x) => x !== m.id) : [...s, m.id]))
              }
            >
              {measureLabel(m, fields, t('count'))}
            </MenuCheckboxItem>
          ))}
        </MenuContent>
      </Menu>
      <Button size="sm" onClick={() => setFlipped((f) => !f)} aria-pressed={flipped}>
        <ArrowLeftRight aria-hidden />
        {t('flip')}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setCollapsed(new Set())}>
        {t('expandAll')}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() =>
          setCollapsed(
            new Set(
              [...(report.data?.rows.children ?? []), ...(report.data?.cols.children ?? [])].map(
                (h) => h.key,
              ),
            ),
          )
        }
      >
        {t('collapseAll')}
      </Button>
      {view.comparison === undefined ? null : (
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">{t('compare')}</span>
          <select
            className="h-8 rounded-md border border-input bg-surface px-2 text-sm"
            value={comparison}
            onChange={(e) => setComparison(e.target.value as never)}
          >
            <option value="none">{t('noComparison')}</option>
            <option value="previous">{t('previous')}</option>
            <option value="yoy">{t('yoy')}</option>
          </select>
          {comparison === 'none' ? null : (
            <>
              <input
                aria-label={t('from')}
                type="date"
                className="h-8 rounded-md border border-input bg-surface px-2 text-sm"
                value={range.from}
                onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
              />
              <input
                aria-label={t('to')}
                type="date"
                className="h-8 rounded-md border border-input bg-surface px-2 text-sm"
                value={range.to}
                onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
              />
            </>
          )}
        </label>
      )}
      <Menu>
        <MenuTrigger asChild>
          <Button size="sm" busy={busy !== null}>
            <Download aria-hidden />
            {t('download')}
          </Button>
        </MenuTrigger>
        <MenuContent>
          <MenuLabel>{t('download')}</MenuLabel>
          {(['xlsx', 'csv'] as const).map((f) => (
            <MenuItem
              key={f}
              disabled={query === null}
              onSelect={async () => {
                setBusy(f);
                setDownloadError(null);
                try {
                  await saveDownload(api, `/api/v1/models/${view.model}/report/export`, {
                    ...query,
                    format: f,
                    title: view.label ?? view.model,
                  });
                } catch (e) {
                  setDownloadError(e instanceof Error ? e.message : String(e));
                } finally {
                  setBusy(null);
                }
              }}
            >
              {t(f)}
            </MenuItem>
          ))}
        </MenuContent>
      </Menu>
    </div>
  );

  if (report.isError)
    return (
      <div className="grid gap-3">
        {toolbar}
        <Alert>{report.error.message}</Alert>
      </div>
    );
  if (query === null) return <div className="grid gap-3">{toolbar}</div>;
  if (report.data === undefined)
    return (
      <div className="grid gap-3">
        {toolbar}
        <Spinner label="…" />
      </div>
    );
  const data = report.data;
  if (data.rows.children.length === 0 && data.cells[data.rows.key] === undefined)
    return (
      <div className="grid gap-3">
        {toolbar}
        <p className="p-6 text-sm text-muted-foreground">{t('empty')}</p>
      </div>
    );

  // Columns: the visible leaves of the column tree, then the grand total.
  const leaves = visibleLeaves(data.cols, collapsed);
  const columns = [...leaves, data.cols];
  const depth = Math.max(1, ...leaves.map((l) => l.depth));
  const label = (h: Header) => headerLabel(h, format.locale, t('none'));
  const max = Object.fromEntries(
    measures.map((m) => [
      m.id,
      Math.max(
        1,
        ...Object.values(data.cells).flatMap((byCol) =>
          Object.values(byCol).map((c) => numeric(c[m.id])),
        ),
      ),
    ]),
  );

  // Header rows: one per column depth (colspans over visible leaves), then the measure row.
  const headerRows: ReactElement[] = [];
  const span = (node: Header): number =>
    node.children.length === 0 || collapsed.has(node.key)
      ? 1
      : node.children.reduce((n, c) => n + span(c), 0);
  for (let level = 1; level <= depth; level++) {
    const cells: ReactElement[] = [];
    const walk = (node: Header) => {
      for (const child of node.children) {
        if (child.depth === level)
          cells.push(
            <th
              key={child.key}
              scope="colgroup"
              colSpan={span(child) * measures.length}
              rowSpan={
                child.children.length === 0 || collapsed.has(child.key) ? depth - level + 1 : 1
              }
              className="border-b border-e px-2 py-1 text-start font-medium"
            >
              {child.children.length === 0 ? (
                label(child)
              ) : (
                <button
                  type="button"
                  className="inline-flex items-center gap-1"
                  aria-expanded={!collapsed.has(child.key)}
                  onClick={() => toggle(child.key)}
                >
                  {collapsed.has(child.key) ? (
                    <ChevronRight className="size-3 rtl:-scale-x-100" aria-hidden />
                  ) : (
                    <ChevronDown className="size-3" aria-hidden />
                  )}
                  {label(child)}
                </button>
              )}
            </th>,
          );
        else if (child.depth < level && child.children.length > 0 && !collapsed.has(child.key))
          walk(child);
      }
    };
    walk(data.cols);
    headerRows.push(
      <tr key={`h${level}`}>
        {level === 1 ? (
          <th
            rowSpan={depth + (measures.length > 1 ? 1 : 0)}
            className="border-b border-e"
            aria-label="Rows"
          />
        ) : null}
        {cells}
        {level === 1 ? (
          <th
            scope="colgroup"
            colSpan={measures.length}
            rowSpan={depth}
            className="border-b px-2 py-1 text-start font-semibold"
          >
            {t('total')}
          </th>
        ) : null}
      </tr>,
    );
  }
  if (measures.length > 1)
    headerRows.push(
      <tr key="measures">
        {columns.flatMap((c) =>
          measures.map((m) => (
            <th
              key={`${c.key}-${m.id}`}
              scope="col"
              className="border-b border-e px-2 py-1 text-end text-xs font-medium text-muted-foreground"
            >
              {measureLabel(m, fields, t('count'))}
            </th>
          )),
        )}
      </tr>,
    );

  const bodyRows: ReactElement[] = [];
  const renderRow = (row: Header) => {
    const isTotal = row === data.rows;
    const open = !collapsed.has(row.key);
    bodyRows.push(
      <tr key={row.key} className={isTotal ? 'border-t-2 font-semibold' : ''}>
        <th
          scope="row"
          className="whitespace-nowrap border-e px-2 py-1 text-start font-normal"
          style={{ paddingInlineStart: `${0.5 + Math.max(0, row.depth - 1) * 1.25}rem` }}
        >
          {isTotal ? (
            <span className="font-semibold">{t('total')}</span>
          ) : row.children.length === 0 ? (
            label(row)
          ) : (
            <button
              type="button"
              className="inline-flex items-center gap-1 font-medium"
              aria-expanded={open}
              onClick={() => toggle(row.key)}
            >
              {open ? (
                <ChevronDown className="size-3" aria-hidden />
              ) : (
                <ChevronRight className="size-3 rtl:-scale-x-100" aria-hidden />
              )}
              {label(row)}
            </button>
          )}
        </th>
        {columns.flatMap((col) =>
          measures.map((m) => {
            const value = data.cells[row.key]?.[col.key]?.[m.id];
            const previous = data.comparison?.cells[row.key]?.[col.key]?.[m.id];
            const delta = data.comparison === undefined ? null : change(value, previous);
            const heat =
              view.heatmap === true && !isTotal && col !== data.cols
                ? numeric(value) / (max[m.id] ?? 1)
                : 0;
            const text = formatValue(value, format);
            return (
              <td
                key={`${col.key}-${m.id}`}
                className="border-e p-0 text-end tabular-nums"
                style={
                  heat > 0
                    ? {
                        backgroundColor: `color-mix(in oklch, var(--primary) ${Math.round(heat * 45)}%, transparent)`,
                      }
                    : undefined
                }
              >
                {text === '' ? null : (
                  <button
                    type="button"
                    className="block w-full px-2 py-1 text-end hover:bg-muted/60"
                    title={t('open')}
                    onClick={() =>
                      props.onDrill?.(
                        and(row.domain, col.domain) ?? {},
                        `${label(row)} ${label(col)}`,
                      )
                    }
                  >
                    {text}
                    {delta === null ? null : (
                      <span className={`ms-1 text-xs ${delta.up ? 'text-success' : 'text-danger'}`}>
                        {delta.text}
                      </span>
                    )}
                  </button>
                )}
              </td>
            );
          }),
        )}
      </tr>,
    );
    if (open && !isTotal) for (const child of row.children) renderRow(child);
  };
  for (const child of data.rows.children) renderRow(child);
  renderRow(data.rows);

  return (
    <div className="grid gap-3">
      {toolbar}
      {downloadError === null ? null : <Alert>{downloadError}</Alert>}
      <div className="max-h-[calc(100vh-15rem)] overflow-auto rounded-lg border bg-surface">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">{view.label ?? view.model}</caption>
          <thead className="sticky top-0 bg-muted">{headerRows}</thead>
          <tbody>{bodyRows}</tbody>
        </table>
      </div>
    </div>
  );
}
