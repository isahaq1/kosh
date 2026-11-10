/**
 * What the reporting views share: the report query hook, header labels (date buckets per granularity, localized),
 * value formatting (counts, exact decimals, amounts per currency), and file downloads.
 */
import type { Formatter, KoshApi } from '@kosh/ui';
import type { Condition } from '@kosh/views';
import { type UseQueryResult, useQuery } from '@tanstack/react-query';
import type { Amount, Header, ReportQuery, ReportResult, Value } from '../pivot.js';

export type { Amount, Header, ReportQuery, ReportResult, Value };

/** Runs a report query (cached per query by TanStack Query). */
export function useReport(
  api: KoshApi,
  model: string,
  query: ReportQuery | null,
): UseQueryResult<ReportResult> {
  return useQuery({
    queryKey: ['report', model, query],
    queryFn: () =>
      api.call<ReportResult>('POST', `/api/v1/models/${encodeURIComponent(model)}/report`, query),
    enabled: query !== null,
  });
}

/** `undefined` and empty domains are dropped. */
export function and(...parts: (Condition | undefined)[]): Condition | undefined {
  const kept = parts.filter((p): p is Condition => p !== undefined && Object.keys(p).length > 0);
  return kept.length === 0 ? undefined : kept.length === 1 ? kept[0] : { and: kept };
}

/** The label of a header: dates by their granularity (`Sep 2026`, `Q3 2026`), the server's label otherwise. */
export function headerLabel(header: Header, locale: string, empty: string): string {
  if (header.group === null) return '';
  const granularity = /:(day|week|month|quarter|year)$/.exec(header.group)?.[1];
  if (granularity === undefined || typeof header.value !== 'string')
    return header.label === '' ? empty : header.label;
  const date = new Date(`${header.value}T00:00:00Z`);
  switch (granularity) {
    case 'year':
      return String(date.getUTCFullYear());
    case 'quarter':
      return `Q${Math.floor(date.getUTCMonth() / 3) + 1} ${date.getUTCFullYear()}`;
    case 'month':
      return new Intl.DateTimeFormat(locale, {
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      }).format(date);
    default:
      return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(date);
  }
}

/** A number for charts and heat maps (the first currency of amounts). */
/** A record's field as a card shows it: a Money value is one amount, a relation its display name. */
export type CardValue =
  | Value
  | Amount
  | { readonly id?: unknown; readonly displayName?: string | null }
  | boolean
  | undefined;

const isAmount = (v: unknown): v is Amount =>
  typeof v === 'object' && v !== null && 'amount' in v && 'currency' in v;

export function numeric(value: CardValue): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (Array.isArray(value)) return Number((value as readonly Amount[])[0]?.amount ?? 0);
  return isAmount(value) ? Number(value.amount) : 0;
}

/** A value as text in the user's locale (amounts per currency, one amount, a relation's name, a decimal). */
export function formatValue(value: CardValue, format: Formatter): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'number') return format.number(value);
  if (typeof value === 'string') return format.decimal(value);
  if (typeof value === 'boolean') return value ? '✓' : '';
  if (Array.isArray(value))
    return (value as readonly Amount[])
      .map((a: Amount) => `${format.decimal(a.amount, 2)} ${a.currency}`)
      .join(' · ');
  if (isAmount(value)) return `${format.decimal(value.amount, 2)} ${value.currency}`;
  const related = value as { readonly id?: unknown; readonly displayName?: string | null };
  return String(related.displayName ?? related.id ?? '');
}

/** Relative change (`+12.5%`), or `''` when there is nothing to compare. */
export function change(
  current: Value | undefined,
  previous: Value | undefined,
): { text: string; up: boolean } | null {
  const a = numeric(current);
  const b = numeric(previous);
  if (previous === undefined || previous === null || b === 0) return null;
  const pct = ((a - b) / Math.abs(b)) * 100;
  return { text: `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`, up: pct >= 0 };
}

/** Saves a downloaded file in the browser. */
export async function saveDownload(
  api: KoshApi,
  path: string,
  body?: unknown,
  method: 'GET' | 'POST' = 'POST',
): Promise<void> {
  const { blob, filename } = await api.download(path, body, method);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** Leaves of a header tree under `collapsed` keys (a collapsed header counts as a leaf). */
export function visibleLeaves(root: Header, collapsed: ReadonlySet<string>): Header[] {
  const walk = (node: Header): Header[] =>
    node.children.length === 0 || collapsed.has(node.key) ? [node] : node.children.flatMap(walk);
  return root.children.length === 0 ? [] : root.children.flatMap(walk);
}

/** The first and exclusive-last day of the year to date (a default comparison range). */
export function yearToDate(today: Date = new Date()): { from: string; to: string } {
  const tomorrow = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1),
  );
  return { from: `${today.getUTCFullYear()}-01-01`, to: tomorrow.toISOString().slice(0, 10) };
}
