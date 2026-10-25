/**
 * The list renderer (RFC 0007 §5): server-side order, paging and totals, grouping (one level, expandable), inline
 * edit of `inlineEdit` columns with compare-and-set, and row virtualization (TanStack Virtual) so large pages scroll
 * smoothly. Rows are a semantic table: keyboard users move with Tab and open with Enter.
 */
import { type Condition, type FieldNode, holds } from '@kosh/views';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper, tableFeatures, useTable } from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, ChevronRight } from 'lucide-react';
import { type ReactElement, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, type Row, type ViewField } from '../api.js';
import { Alert, Button, Spinner } from '../components/primitives.js';
import { useKosh } from '../context.js';
import { cn } from '../lib/cn.js';
import type { ViewProps } from '../registry.js';
import { rememberList } from './listMemory.js';
import { PrefetchedNames, useRowNames } from './widgets.js';

const ROW_HEIGHT = 40;
const features = tableFeatures({});
const helper = createColumnHelper<typeof features, Row>();

const and = (a: Condition | undefined, b: Condition): Condition =>
  a === undefined ? b : { and: [a, b] };

/** The If-Match value of a row loaded with `updatedAt` (the API's ETag format). */
function etagOf(row: Row): string | null {
  const at = row['updatedAt'];
  return typeof at === 'string' ? `"${Date.parse(at)}"` : null;
}

function Cell({
  node,
  field,
  row,
  editable,
  model,
}: {
  readonly node: FieldNode;
  readonly field: ViewField;
  readonly row: Row;
  readonly editable: boolean;
  readonly model: string;
}): ReactElement {
  const { registry, api, uid, companyId } = useKosh();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<unknown>(row[node.field]);
  const [error, setError] = useState<string | null>(null);
  const Widget = registry.widget(node, field);
  const save = useMutation({
    mutationFn: (value: unknown) => api.update(model, row.id, { [node.field]: value }, etagOf(row)),
    onSuccess: async () => {
      setEditing(false);
      await queryClient.invalidateQueries({ queryKey: ['list', model] });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : String(e)),
  });
  const readonly = field.readonly || holds(node.readonlyWhen, row, { uid, companyId });
  if (editable && !readonly && editing)
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: commits the edit when focus leaves the cell
      <div
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) save.mutate(draft);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save.mutate(draft);
          if (e.key === 'Escape') setEditing(false);
          e.stopPropagation();
        }}
      >
        <Widget
          id={`${row.id}-${node.id}`}
          node={node}
          field={field}
          value={draft}
          record={row}
          readonly={false}
          onChange={setDraft}
          invalid={error !== null}
        />
        {error === null ? null : <p className="mt-1 text-xs text-danger">{error}</p>}
      </div>
    );
  return (
    <div
      className={cn(editable && !readonly && 'cursor-text rounded px-1 hover:bg-muted')}
      {...(editable && !readonly
        ? {
            onClick: (e: { stopPropagation(): void }) => {
              e.stopPropagation();
              setDraft(row[node.field]);
              setEditing(true);
            },
          }
        : {})}
    >
      <Widget
        id={`${row.id}-${node.id}`}
        node={node}
        field={field}
        value={row[node.field]}
        record={row}
        readonly
      />
    </div>
  );
}

function Rows({
  props,
  where,
  columns,
  fields,
  offset,
  limit,
  onCount,
}: {
  readonly props: ViewProps;
  readonly where: Condition | undefined;
  readonly columns: readonly FieldNode[];
  readonly fields: Readonly<Record<string, ViewField>>;
  readonly offset: number;
  readonly limit: number;
  readonly onCount?: (count: number) => void;
}): ReactElement {
  const { api } = useKosh();
  const { t } = useTranslation();
  const view = props.served.view;
  const model = view.model;
  const keys = useMemo(
    () => [...new Set(['id', 'updatedAt', ...columns.map((c) => c.field)])],
    [columns],
  );
  const order =
    props.order.length > 0 ? props.order : view.type === 'list' ? (view.defaultOrder ?? []) : [];
  const query = useQuery({
    queryKey: ['list', model, where, order, keys, offset, limit],
    queryFn: async () => {
      const result = await api.list(model, {
        filter: where,
        order,
        fields: keys,
        limit,
        offset,
        count: true,
      });
      onCount?.(result.count ?? result.items.length);
      rememberList(
        model,
        result.items.map((r) => r.id),
        offset,
        result.count ?? result.items.length,
      );
      return result;
    },
  });
  const items = query.data?.items ?? [];
  const names = useRowNames(items, Object.values(fields));
  const tableColumns = useMemo(() => {
    const inline = new Set(view.type === 'list' ? (view.inlineEdit ?? []) : []);
    return helper.columns(
      columns.map((node) =>
        helper.accessor((row: Row) => row[node.field], {
          id: node.id,
          header: () => node.label ?? fields[node.field]?.label ?? node.field,
          cell: (info) => {
            const field = fields[node.field];
            return field === undefined ? null : (
              <Cell
                node={node}
                field={field}
                row={info.row.original}
                editable={inline.has(node.field) && props.served.operations.write}
                model={model}
              />
            );
          },
        }),
      ),
    );
  }, [columns, fields, model, view, props.served.operations.write]);
  const table = useTable({ features, columns: tableColumns, data: items });
  const scroller = useRef<HTMLDivElement>(null);
  const rows = table.getRowModel().rows;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });
  if (query.isPending) return <Spinner label={t('app.loading')} />;
  if (query.isError)
    return (
      <Alert
        action={
          <Button size="sm" onClick={() => void query.refetch()}>
            {t('app.retry')}
          </Button>
        }
      >
        {query.error instanceof ApiError ? query.error.message : t('app.error')}
      </Alert>
    );
  if (items.length === 0)
    return <p className="p-6 text-sm text-muted-foreground">{t('views.empty')}</p>;
  const virtual = virtualizer.getVirtualItems();
  const top = virtual[0]?.start ?? 0;
  const bottom = virtualizer.getTotalSize() - (virtual[virtual.length - 1]?.end ?? 0);
  const toggleOrder = (key: string) => {
    const current = order[0]?.split(' ');
    const next = current?.[0] === key && current[1] !== 'desc' ? `${key} desc` : `${key} asc`;
    props.onOrder?.([next]);
  };
  return (
    <PrefetchedNames.Provider value={names}>
      <div ref={scroller} className="max-h-[calc(100vh-14rem)] overflow-auto">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-muted">
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => {
                  const node = columns.find((c) => c.id === header.id) as FieldNode;
                  const direction = order[0]?.startsWith(`${node.field} `)
                    ? order[0].split(' ')[1]
                    : undefined;
                  return (
                    <th
                      key={header.id}
                      scope="col"
                      aria-sort={
                        direction === 'asc'
                          ? 'ascending'
                          : direction === 'desc'
                            ? 'descending'
                            : 'none'
                      }
                      className="px-3 py-2 text-start font-medium text-muted-foreground"
                    >
                      <button
                        type="button"
                        className="inline-flex items-center gap-1"
                        onClick={() => toggleOrder(node.field)}
                      >
                        <table.FlexRender header={header} />
                        {direction === 'asc' ? (
                          <ArrowUp className="size-3" aria-hidden />
                        ) : direction === 'desc' ? (
                          <ArrowDown className="size-3" aria-hidden />
                        ) : null}
                      </button>
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {top > 0 ? (
              <tr aria-hidden>
                <td style={{ height: top }} colSpan={columns.length} />
              </tr>
            ) : null}
            {virtual.map((v) => {
              const row = rows[v.index];
              if (row === undefined) return null;
              return (
                <tr
                  key={row.id}
                  tabIndex={0}
                  style={{ height: ROW_HEIGHT }}
                  className="cursor-pointer border-b hover:bg-muted/60 focus-visible:bg-muted"
                  onClick={() => props.onOpen(row.original.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') props.onOpen(row.original.id);
                  }}
                >
                  {row.getAllCells().map((cell) => (
                    <td key={cell.id} className="px-3 py-1.5">
                      <table.FlexRender cell={cell} />
                    </td>
                  ))}
                </tr>
              );
            })}
            {bottom > 0 ? (
              <tr aria-hidden>
                <td style={{ height: bottom }} colSpan={columns.length} />
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </PrefetchedNames.Provider>
  );
}

function Totals({
  props,
  columns,
  fields,
}: {
  readonly props: ViewProps;
  readonly columns: readonly FieldNode[];
  readonly fields: Readonly<Record<string, ViewField>>;
}): ReactElement | null {
  const { api, format } = useKosh();
  const { t } = useTranslation();
  const summed = columns.filter((c) => c.sum === true);
  const query = useQuery({
    queryKey: ['totals', props.served.view.model, props.where, summed.map((c) => c.field)],
    queryFn: async () =>
      (
        await api.aggregate(props.served.view.model, {
          where: props.where,
          measures: Object.fromEntries(summed.map((c) => [c.id, { sum: c.field }])),
        })
      )[0] ?? {},
    enabled: summed.length > 0,
  });
  if (summed.length === 0 || query.data === undefined) return null;
  return (
    <dl className="flex justify-end gap-6 border-t px-3 py-2 text-sm">
      {summed.map((c) => {
        const v = query.data[c.id];
        const amount =
          typeof v === 'object' && v !== null && 'amount' in v
            ? String((v as { amount: unknown }).amount)
            : v === null || v === undefined
              ? '0'
              : String(v);
        return (
          <div key={c.id} className="flex gap-2">
            <dt className="text-muted-foreground">
              {t('views.total')} {c.label ?? fields[c.field]?.label ?? c.field}
            </dt>
            <dd className="font-medium tabular-nums">{format.decimal(amount)}</dd>
          </div>
        );
      })}
    </dl>
  );
}

function Groups({
  props,
  columns,
  fields,
}: {
  readonly props: ViewProps;
  readonly columns: readonly FieldNode[];
  readonly fields: Readonly<Record<string, ViewField>>;
}): ReactElement {
  const { api } = useKosh();
  const { t } = useTranslation();
  const key = props.groupBy[0] as string;
  const field = key.split(':')[0] as string;
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const query = useQuery({
    queryKey: ['groups', props.served.view.model, props.where, key],
    queryFn: () =>
      api.aggregate(props.served.view.model, {
        where: props.where,
        groupBy: [key],
        measures: { __count: 'count' },
      }),
  });
  const meta = fields[field];
  const names = useRowNames(
    (query.data ?? []).map((g) => ({ [field]: g[key] ?? g[field] })),
    meta === undefined ? [] : [meta],
  );
  if (query.isPending) return <Spinner label={t('app.loading')} />;
  const label = (value: unknown): string => {
    if (value === null || value === undefined) return t('views.none');
    const option = meta?.options?.find((o) => o.value === value);
    if (option !== undefined) return option.label;
    if (meta?.kind === 'many2one')
      return names.get(meta.target ?? '')?.get(Number(value)) ?? `#${String(value)}`;
    return String(value);
  };
  return (
    <div className="divide-y">
      {(query.data ?? []).map((group) => {
        const value = group[key] ?? group[field] ?? null;
        const id = JSON.stringify(value);
        const expandable = !key.includes(':');
        const isOpen = open.has(id);
        return (
          <section key={id}>
            <button
              type="button"
              aria-expanded={expandable ? isOpen : undefined}
              disabled={!expandable}
              className="flex w-full items-center gap-2 bg-muted/40 px-3 py-2 text-start text-sm font-medium"
              onClick={() =>
                setOpen((s) => {
                  const next = new Set(s);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })
              }
            >
              {expandable ? (
                <ChevronRight
                  className={cn(
                    'size-4 transition-transform rtl:-scale-x-100',
                    isOpen && 'rotate-90',
                  )}
                  aria-hidden
                />
              ) : null}
              <span>{label(value)}</span>
              <span className="text-muted-foreground">({String(group['__count'] ?? 0)})</span>
            </button>
            {isOpen ? (
              <Rows
                props={props}
                where={and(props.where, { [field]: value })}
                columns={columns}
                fields={fields}
                offset={0}
                limit={200}
              />
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

/** The default list renderer. */
export function ListView(props: ViewProps): ReactElement {
  const { t } = useTranslation();
  const view = props.served.view;
  const pageSize = view.type === 'list' ? (view.pageSize ?? 80) : 80;
  const [offset, setOffset] = useState(0);
  const [count, setCount] = useState(0);
  if (view.type !== 'list') throw new Error(`ListView renders list views, not ${view.type}.`);
  const fields = props.served.fields[view.model] ?? {};
  const columns = view.columns.filter((c) => fields[c.field] !== undefined);
  return (
    <div className="rounded-lg border bg-surface">
      {props.groupBy.length > 0 ? (
        <Groups props={props} columns={columns} fields={fields} />
      ) : (
        <>
          <Rows
            props={props}
            where={props.where}
            columns={columns}
            fields={fields}
            offset={offset}
            limit={pageSize}
            onCount={setCount}
          />
          {count > pageSize ? (
            <nav
              aria-label="Pagination"
              className="flex items-center justify-end gap-2 border-t px-3 py-2 text-sm"
            >
              <span className="text-muted-foreground">
                {t('views.range', {
                  from: offset + 1,
                  to: Math.min(offset + pageSize, count),
                  total: count,
                })}
              </span>
              <Button
                size="sm"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - pageSize))}
              >
                {t('views.previous')}
              </Button>
              <Button
                size="sm"
                disabled={offset + pageSize >= count}
                onClick={() => setOffset(offset + pageSize)}
              >
                {t('views.next')}
              </Button>
            </nav>
          ) : null}
        </>
      )}
      <Totals props={props} columns={columns} fields={fields} />
    </div>
  );
}
