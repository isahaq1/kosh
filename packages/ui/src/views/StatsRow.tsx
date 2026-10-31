/**
 * A row of stat tiles on a record page (RFC 0022 §3.1): how many — or how much — of another model relate to this
 * record, computed by the server with the user's rights (`aggregate`), live with the record's version, each tile a
 * jump to that list filtered the same way. Other modules append their tiles to the row (view extensions).
 */
import {
  type Condition,
  type ConditionEnv,
  holds,
  resolveRecord,
  type StatsNode,
} from '@kosh/views';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { useKosh } from '../context.js';
import { cn } from '../lib/cn.js';

// The badge's tones (primitives), on the figure only.
const TONES = {
  neutral: 'text-foreground',
  info: 'text-primary',
  success: 'text-success',
  warning: 'text-warning-text',
  danger: 'text-danger',
} as const;

/** The measure's value as the aggregate route returns it: a count, a decimal string, or amounts per currency. */
function textOf(
  raw: unknown,
  format: ReturnType<typeof useKosh>['format'],
): { text: string; currency?: string } {
  if (raw === null || raw === undefined) return { text: '0' };
  if (typeof raw === 'number') return { text: format.number(raw) };
  if (typeof raw === 'string') return { text: format.decimal(raw) };
  if (Array.isArray(raw)) {
    const [first] = raw as { amount?: unknown; currency?: unknown }[];
    if (first === undefined) return { text: '0' };
    return {
      text: format.decimal(String(first.amount ?? '0')),
      ...(typeof first.currency === 'string' ? { currency: first.currency } : {}),
    };
  }
  if (typeof raw === 'object' && 'amount' in raw) {
    const a = raw as { amount: unknown; currency?: unknown };
    return {
      text: format.decimal(String(a.amount)),
      ...(typeof a.currency === 'string' ? { currency: a.currency } : {}),
    };
  }
  return { text: String(raw) };
}

export function StatsRow({
  node,
  values,
  env,
  version,
}: {
  readonly node: StatsNode;
  readonly values: Readonly<Record<string, unknown>>;
  readonly env: ConditionEnv;
  /** The record's version: tiles refetch when it changes. */
  readonly version: string | null;
}): ReactElement | null {
  const { api, format } = useKosh();
  const navigate = useNavigate();
  const routes = useQuery({ queryKey: ['routes'], queryFn: () => api.routes() });
  const tiles = node.children.filter(
    (tile) => tile.visibleWhen === undefined || holds(tile.visibleWhen, values, env),
  );
  const wheres = tiles.map((tile) => resolveRecord(tile.where, values));
  const results = useQueries({
    queries: tiles.map((tile, i) => ({
      queryKey: ['stat', tile.model, wheres[i], tile.measure ?? 'count', version],
      queryFn: async () => {
        const [row] = await api.aggregate(tile.model, {
          where: wheres[i] as Condition,
          measures: { value: tile.measure ?? 'count' },
        });
        return row?.['value'] ?? null;
      },
    })),
  });
  if (tiles.length === 0) return null;
  const open = (i: number): void => {
    const tile = tiles[i];
    if (tile === undefined) return;
    const route = routes.data?.[tile.model];
    const action = tile.action ?? route?.action;
    if (action === undefined || route?.app === undefined) return;
    void navigate({
      to: '/$app/a/$action',
      params: { app: route.app, action },
      search: { q: JSON.stringify({ c: wheres[i], cl: tile.label }) } as never,
    });
  };
  return (
    <section
      aria-label={node.id}
      className="col-span-full grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4"
    >
      {tiles.map((tile, i) => {
        const result = results[i];
        const value = textOf(result?.data, format);
        const clickable = routes.data?.[tile.model]?.app !== undefined;
        const body = (
          <>
            <span className="text-xs font-medium text-muted-foreground">{tile.label}</span>
            <span
              className={cn(
                'text-xl font-semibold tabular-nums leading-tight',
                TONES[tile.tone ?? 'neutral'],
              )}
            >
              {result?.isPending === true ? '…' : value.text}
              {value.currency === undefined ? null : (
                <span className="ms-1 text-xs font-normal text-muted-foreground">
                  {value.currency}
                </span>
              )}
            </span>
          </>
        );
        const className =
          'grid gap-0.5 rounded-lg border bg-surface px-3 py-2 text-start transition-colors';
        return clickable ? (
          <button
            key={tile.id}
            type="button"
            className={cn(className, 'hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring')}
            onClick={() => open(i)}
          >
            {body}
          </button>
        ) : (
          <div key={tile.id} className={className}>
            {body}
          </div>
        );
      })}
    </section>
  );
}
