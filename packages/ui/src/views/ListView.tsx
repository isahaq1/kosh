/**
 * The list renderer (RFC 0007 §5, RFC 0010 §3.5): server-side order, paging and totals, grouping (one level,
 * expandable), inline edit of `inlineEdit` columns with compare-and-set, row virtualization (TanStack Virtual) so
 * large pages scroll smoothly, selection with a bulk bar (archive and delete with Undo, export, the transitions every
 * selected record allows), export to CSV and Excel, a column chooser and density remembered per user, skeleton rows
 * while loading and an empty state that offers the next step. Rows are a semantic table: keyboard users move with
 * Tab and open with Enter. Every bulk action is one request per record to the existing, permission-checked routes.
 */
import { type Condition, type FieldNode, holds } from '@kosh/views';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper, tableFeatures, useTable } from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  Archive,
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Columns3,
  Download,
  Inbox,
  Plus,
  Rows3,
  Trash2,
  X,
} from 'lucide-react';
import { type ReactElement, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, type Row, type ServedView, type ViewField } from '../api.js';
import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuTrigger,
  Skeleton,
} from '../components/primitives.js';
import { useKosh } from '../context.js';
import { cn } from '../lib/cn.js';
import { useLiveModel } from '../live.js';
import type { ViewProps } from '../registry.js';
import { useToast } from '../shell/toast.js';
import { rememberList } from './listMemory.js';
import { PrefetchedNames, useRowNames } from './widgets.js';

const features = tableFeatures({});
const helper = createColumnHelper<typeof features, Row>();
type Density = 'comfortable' | 'compact';
const HEIGHTS: Record<Density, number> = { comfortable: 40, compact: 32 };
/** Requests a bulk action sends at once. */
const PARALLEL = 6;
/** How long a bulk delete waits for Undo before it runs. */
const UNDO_MS = 8000;

const and = (a: Condition | undefined, b: Condition): Condition =>
  a === undefined ? b : { and: [a, b] };

/** The If-Match value of a row loaded with `updatedAt` (the API's ETag format). */
function etagOf(row: Row): string | null {
  const at = row['updatedAt'];
  return typeof at === 'string' ? `"${Date.parse(at)}"` : null;
}

/** Runs `fn` for every id, a few at a time; reports how many failed and the first reason. */
async function each(
  ids: readonly number[],
  fn: (id: number) => Promise<unknown>,
): Promise<{ done: number; failed: number; reason: string | null }> {
  let done = 0;
  let failed = 0;
  let reason: string | null = null;
  for (let i = 0; i < ids.length; i += PARALLEL) {
    const results = await Promise.allSettled(ids.slice(i, i + PARALLEL).map(fn));
    for (const r of results) {
      if (r.status === 'fulfilled') done += 1;
      else {
        failed += 1;
        reason ??= r.reason instanceof Error ? r.reason.message : String(r.reason);
      }
    }
  }
  return { done, failed, reason };
}

const stored = {
  get<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : (JSON.parse(raw) as T);
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown): void {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // storage unavailable: the choice lasts for the page
    }
  },
};

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

interface Selection {
  readonly selected: ReadonlySet<number>;
  readonly onToggle: (id: number, range: boolean) => void;
  readonly onToggleAll: (ids: readonly number[]) => void;
}

const SKELETON_CELLS = ['name', 'second', 'third', 'fourth', 'fifth', 'sixth'] as const;

function SkeletonRows({ columns, height }: { readonly columns: number; readonly height: number }) {
  return (
    <div className="grid gap-px p-3" aria-busy>
      {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
        <div key={i} className="flex items-center gap-6" style={{ height }}>
          {SKELETON_CELLS.slice(0, Math.max(1, Math.min(columns, 6))).map((cell) => (
            <Skeleton key={cell} className={cn('h-4', cell === 'name' ? 'w-1/4' : 'w-1/6')} />
          ))}
        </div>
      ))}
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
  height,
  selection,
  hiddenIds,
  onCount,
  onRows,
  filtered,
}: {
  readonly props: ViewProps;
  readonly where: Condition | undefined;
  readonly columns: readonly FieldNode[];
  readonly fields: Readonly<Record<string, ViewField>>;
  readonly offset: number;
  readonly limit: number;
  readonly height: number;
  readonly selection?: Selection;
  /** Rows kept out of sight (a delete waiting for Undo). */
  readonly hiddenIds?: ReadonlySet<number>;
  readonly onCount?: (count: number) => void;
  readonly onRows?: (rows: readonly Row[]) => void;
  /** The user has a search active (the empty state says so). */
  readonly filtered?: boolean;
}): ReactElement {
  const { api } = useKosh();
  const { t } = useTranslation();
  const view = props.served.view;
  const model = view.model;
  const keys = useMemo(
    () => [
      ...new Set([
        'id',
        'updatedAt',
        'displayName',
        ...props.served.transitions.map((tr) => tr.field),
        ...columns.map((c) => c.field),
      ]),
    ],
    [columns, props.served.transitions],
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
  const all = query.data?.items ?? [];
  const items = useMemo(
    () => (hiddenIds === undefined ? all : all.filter((r) => !hiddenIds.has(r.id))),
    [all, hiddenIds],
  );
  useEffect(() => {
    if (query.data !== undefined) onRows?.(query.data.items);
  }, [query.data, onRows]);
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
    estimateSize: () => height,
    overscan: 12,
  });
  if (query.isPending) return <SkeletonRows columns={columns.length} height={height} />;
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
    return (
      <EmptyState
        icon={<Inbox aria-hidden />}
        title={filtered === true ? t('views.emptyFiltered') : t('views.emptyTitle')}
        {...(filtered === true ? {} : { description: t('views.emptyHint') })}
        {...(props.served.operations.create && offset === 0
          ? {
              action: (
                <Button variant="primary" size="sm" onClick={() => props.onOpen('new')}>
                  <Plus aria-hidden />
                  {t('views.createFirst')}
                </Button>
              ),
            }
          : {})}
      />
    );
  const virtual = virtualizer.getVirtualItems();
  const top = virtual[0]?.start ?? 0;
  const bottom = virtualizer.getTotalSize() - (virtual[virtual.length - 1]?.end ?? 0);
  const toggleOrder = (key: string) => {
    const current = order[0]?.split(' ');
    const next = current?.[0] === key && current[1] !== 'desc' ? `${key} desc` : `${key} asc`;
    props.onOrder?.([next]);
  };
  const pageIds = items.map((r) => r.id);
  const selectedOnPage =
    selection === undefined ? 0 : pageIds.filter((id) => selection.selected.has(id)).length;
  const span = columns.length + (selection === undefined ? 0 : 1);
  const cellPad = height <= 32 ? 'px-3 py-0.5' : 'px-3 py-1.5';
  return (
    <PrefetchedNames.Provider value={names}>
      <div ref={scroller} className="max-h-[calc(100vh-16rem)] overflow-auto">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-muted">
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {selection === undefined ? null : (
                  <th scope="col" className="w-10 px-3 py-2">
                    <Checkbox
                      aria-label={t('views.selectAll')}
                      checked={
                        selectedOnPage === 0
                          ? false
                          : selectedOnPage === pageIds.length
                            ? true
                            : 'indeterminate'
                      }
                      onCheckedChange={() => selection.onToggleAll(pageIds)}
                    />
                  </th>
                )}
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
                <td style={{ height: top }} colSpan={span} />
              </tr>
            ) : null}
            {virtual.map((v) => {
              const row = rows[v.index];
              if (row === undefined) return null;
              const id = row.original.id;
              const isSelected = selection?.selected.has(id) === true;
              return (
                <tr
                  key={row.id}
                  tabIndex={0}
                  aria-selected={selection === undefined ? undefined : isSelected}
                  style={{ height }}
                  className={cn(
                    'cursor-pointer border-b hover:bg-muted/60 focus-visible:bg-muted',
                    isSelected && 'bg-accent/60 hover:bg-accent/70',
                  )}
                  onClick={() => props.onOpen(id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') props.onOpen(id);
                    // Space on the row itself selects it (the checkbox handles its own keys).
                    if (e.key === ' ' && selection !== undefined && e.target === e.currentTarget) {
                      e.preventDefault();
                      selection.onToggle(id, e.shiftKey);
                    }
                  }}
                >
                  {selection === undefined ? null : (
                    <td className={cn('w-10', cellPad)}>
                      <Checkbox
                        aria-label={t('views.selectRow', {
                          name: String(row.original['displayName'] ?? id),
                        })}
                        checked={isSelected}
                        onClick={(e) => {
                          e.stopPropagation(); // not the row's open
                          selection.onToggle(id, e.shiftKey);
                        }}
                        onKeyDown={(e) => e.stopPropagation()}
                      />
                    </td>
                  )}
                  {row.getAllCells().map((cell) => (
                    <td key={cell.id} className={cellPad}>
                      <table.FlexRender cell={cell} />
                    </td>
                  ))}
                </tr>
              );
            })}
            {bottom > 0 ? (
              <tr aria-hidden>
                <td style={{ height: bottom }} colSpan={span} />
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
  height,
}: {
  readonly props: ViewProps;
  readonly columns: readonly FieldNode[];
  readonly fields: Readonly<Record<string, ViewField>>;
  readonly height: number;
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
  if (query.isPending) return <SkeletonRows columns={columns.length} height={height} />;
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
                height={height}
              />
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

/** Saves a downloaded file. */
function saveFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The default list renderer. */
export function ListView(props: ViewProps): ReactElement {
  const { api, uid } = useKosh();
  const { t } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const view = props.served.view;
  const served: ServedView = props.served;
  if (view.type !== 'list') throw new Error(`ListView renders list views, not ${view.type}.`);
  const model = view.model;
  useLiveModel(model);
  const pageSize = view.pageSize ?? 80;
  const fields = served.fields[model] ?? {};
  const allColumns = view.columns.filter((c) => fields[c.field] !== undefined);
  const columnsKey = `kosh.columns.${uid}.${view.id}`;
  const [hidden, setHidden] = useState<ReadonlySet<string>>(
    () => new Set(stored.get<string[]>(columnsKey, [])),
  );
  const [density, setDensity] = useState<Density>(() =>
    stored.get<Density>('kosh.density', 'comfortable'),
  );
  const height = HEIGHTS[density];
  const columns = allColumns.filter((c) => !hidden.has(c.id));
  const [offset, setOffset] = useState(0);
  const [count, setCount] = useState<number | null>(null);
  const [pageRows, setPageRows] = useState<readonly Row[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const lastToggled = useRef<number | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ReadonlySet<number>>(new Set());
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const deleteTimer = useRef<{ ids: number[]; timer: ReturnType<typeof setTimeout> } | null>(null);
  const meta = useQuery({ queryKey: ['meta', model], queryFn: () => api.meta(model) });
  const archivable =
    meta.data?.fields.some((f) => f.key === 'active' && !f.readonly) === true &&
    served.operations.write;
  const canExport = meta.data?.operations.export === true;
  const filtered = props.where !== undefined;

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['list', model] });
  const toggle = (id: number, range: boolean) => {
    setSelected((s) => {
      const next = new Set(s);
      const last = lastToggled.current;
      const ids = pageRows.map((r) => r.id);
      if (range && last !== null && ids.includes(last) && ids.includes(id)) {
        const [from, to] = [ids.indexOf(last), ids.indexOf(id)].sort((a, b) => a - b);
        for (const x of ids.slice(from, (to as number) + 1)) next.add(x);
      } else if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    lastToggled.current = id;
  };
  const toggleAll = (ids: readonly number[]) =>
    setSelected((s) => {
      const next = new Set(s);
      if (ids.every((id) => next.has(id))) for (const id of ids) next.delete(id);
      else for (const id of ids) next.add(id);
      return next;
    });
  const ids = [...selected];
  const selectedRows = pageRows.filter((r) => selected.has(r.id));
  // Transitions every selected record allows (only when every selected record is on this page).
  const transitions =
    selectedRows.length === ids.length
      ? served.transitions.filter((tr) =>
          selectedRows.every((r) => tr.from.includes(String(r[tr.field]))),
        )
      : [];
  const report = (
    action: string,
    result: { done: number; failed: number; reason: string | null },
    undo?: () => void,
  ) => {
    if (result.done > 0)
      toast({
        title: t('views.bulkDone', { action, count: result.done }),
        ...(undo === undefined ? {} : { action: { label: t('views.undo'), run: undo } }),
      });
    if (result.failed > 0)
      toast({
        title: t('views.bulkFailed', { count: result.failed, reason: result.reason ?? '' }),
        tone: 'danger',
      });
  };
  const archive = useMutation({
    mutationFn: (what: readonly number[]) =>
      each(what, (id) => api.update(model, id, { active: false })),
    onSuccess: async (result, what) => {
      setSelected(new Set());
      await refresh();
      report(
        t('views.archive'),
        result,
        () =>
          void each(what, (id) => api.update(model, id, { active: true }))
            .then(refresh)
            .then(() => toast({ title: t('views.unarchived'), tone: 'info' })),
      );
    },
  });
  const transition = useMutation({
    mutationFn: ({ name, what }: { name: string; what: readonly number[] }) =>
      each(what, (id) => api.transition(model, id, name)),
    onSuccess: async (result, { name }) => {
      setSelected(new Set());
      await refresh();
      report(name, result);
    },
  });
  const runDeletes = async (what: number[]) => {
    deleteTimer.current = null;
    const result = await each(what, (id) => api.remove(model, id));
    setPendingDelete(new Set());
    await refresh();
    if (result.failed > 0) report(t('views.delete'), result);
  };
  const deleteLater = (what: number[]) => {
    setSelected(new Set());
    setPendingDelete(new Set(what));
    const timer = setTimeout(() => void runDeletes(what), UNDO_MS);
    deleteTimer.current = { ids: what, timer };
    toast({
      title: t('views.deletedMany', { count: what.length }),
      duration: UNDO_MS,
      action: {
        label: t('views.undo'),
        run: () => {
          if (deleteTimer.current !== null) clearTimeout(deleteTimer.current.timer);
          deleteTimer.current = null;
          setPendingDelete(new Set());
          toast({ title: t('views.undone'), tone: 'info' });
        },
      },
    });
  };
  // Leaving the list runs a delete that is still waiting: Undo was the toast's offer, not a way to lose the action.
  useEffect(
    () => () => {
      const pending = deleteTimer.current;
      if (pending !== null) {
        clearTimeout(pending.timer);
        void each(pending.ids, (id) => api.remove(model, id)).then(() =>
          queryClient.invalidateQueries({ queryKey: ['list', model] }),
        );
      }
    },
    [api, model, queryClient],
  );
  const exportAs = useMutation({
    mutationFn: async (format: 'csv' | 'xlsx') => {
      const where = ids.length === 0 ? props.where : and(props.where, { id: { in: ids } });
      const keys = columns.map((c) => c.field);
      const file =
        format === 'csv'
          ? await api.download(`/api/v1/models/${encodeURIComponent(model)}/export`, {
              format: 'csv',
              ...(where === undefined ? {} : { filter: where }),
              ...(props.order.length === 0 ? {} : { order: props.order }),
            })
          : await api.download(`/api/v1/models/${encodeURIComponent(model)}/export/xlsx`, {
              fields: keys,
              ...(where === undefined ? {} : { filter: where }),
            });
      saveFile(file.blob, file.filename);
    },
    onError: (e) =>
      toast({
        title: t('views.exportFailed', { reason: e instanceof Error ? e.message : String(e) }),
        tone: 'danger',
      }),
  });

  const toolbar =
    ids.length > 0 ? (
      <div
        role="toolbar"
        aria-label={t('views.selected', { count: ids.length })}
        className="flex flex-wrap items-center gap-2 border-b bg-accent/40 px-3 py-2 text-sm"
      >
        <span className="font-medium">{t('views.selected', { count: ids.length })}</span>
        <Button
          size="sm"
          variant="ghost"
          aria-label={t('views.clearSelection')}
          onClick={() => setSelected(new Set())}
        >
          <X aria-hidden />
        </Button>
        <span className="flex-1" />
        {transitions.map((tr) => (
          <Button
            key={tr.name}
            size="sm"
            busy={transition.isPending && transition.variables?.name === tr.name}
            onClick={() => transition.mutate({ name: tr.name, what: ids })}
          >
            {tr.name.charAt(0).toUpperCase() + tr.name.slice(1).replace(/_/g, ' ')}
          </Button>
        ))}
        {archivable ? (
          <Button size="sm" busy={archive.isPending} onClick={() => archive.mutate(ids)}>
            <Archive aria-hidden />
            {t('views.archive')}
          </Button>
        ) : null}
        {served.operations.unlink ? (
          <Button size="sm" variant="danger" onClick={() => setConfirmingDelete(true)}>
            <Trash2 aria-hidden />
            {t('views.delete')}
          </Button>
        ) : null}
        {canExport ? (
          <Button size="sm" busy={exportAs.isPending} onClick={() => exportAs.mutate('csv')}>
            <Download aria-hidden />
            {t('views.export')}
          </Button>
        ) : null}
      </div>
    ) : (
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-1.5 text-sm">
        <span className="text-muted-foreground">
          {count === null ? (
            <Skeleton className="inline-block h-4 w-20" />
          ) : (
            t('views.records', { count })
          )}
        </span>
        <span className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          aria-label={t('views.density')}
          aria-pressed={density === 'compact'}
          title={density === 'compact' ? t('views.comfortable') : t('views.compact')}
          onClick={() => {
            const next: Density = density === 'compact' ? 'comfortable' : 'compact';
            setDensity(next);
            stored.set('kosh.density', next);
          }}
        >
          <Rows3 aria-hidden />
        </Button>
        <Menu>
          <MenuTrigger asChild>
            <Button size="sm" variant="ghost" aria-label={t('views.columns')}>
              <Columns3 aria-hidden />
            </Button>
          </MenuTrigger>
          <MenuContent align="end">
            <MenuLabel>{t('views.columns')}</MenuLabel>
            {allColumns.map((c) => (
              <MenuCheckboxItem
                key={c.id}
                checked={!hidden.has(c.id)}
                onCheckedChange={(checked) => {
                  const next = new Set(hidden);
                  if (checked) next.delete(c.id);
                  else if (next.size < allColumns.length - 1) next.add(c.id);
                  setHidden(next);
                  stored.set(columnsKey, [...next]);
                }}
              >
                {c.label ?? fields[c.field]?.label ?? c.field}
              </MenuCheckboxItem>
            ))}
          </MenuContent>
        </Menu>
        {canExport ? (
          <Menu>
            <MenuTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                aria-label={t('views.export')}
                busy={exportAs.isPending}
              >
                <Download aria-hidden />
              </Button>
            </MenuTrigger>
            <MenuContent align="end">
              <MenuLabel>{t('views.export')}</MenuLabel>
              <MenuItem onSelect={() => exportAs.mutate('csv')}>{t('views.exportCsv')}</MenuItem>
              <MenuItem onSelect={() => exportAs.mutate('xlsx')}>{t('views.exportXlsx')}</MenuItem>
            </MenuContent>
          </Menu>
        ) : null}
      </div>
    );

  return (
    <div className="rounded-lg border bg-surface">
      {props.groupBy.length > 0 ? (
        <Groups props={props} columns={columns} fields={fields} height={height} />
      ) : (
        <>
          {toolbar}
          <Rows
            props={props}
            where={props.where}
            columns={columns}
            fields={fields}
            offset={offset}
            limit={pageSize}
            height={height}
            selection={{ selected, onToggle: toggle, onToggleAll: toggleAll }}
            hiddenIds={pendingDelete}
            onCount={setCount}
            onRows={setPageRows}
            filtered={filtered}
          />
          {count !== null && count > pageSize ? (
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
      <Dialog
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        title={t('views.deleteMany', { count: ids.length })}
        description={t('views.deleteManyHint')}
        footer={
          <>
            <Button onClick={() => setConfirmingDelete(false)}>{t('views.cancel')}</Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmingDelete(false);
                deleteLater(ids);
              }}
            >
              {t('views.delete')}
            </Button>
          </>
        }
      />
    </div>
  );
}
