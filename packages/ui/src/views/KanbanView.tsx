/**
 * The kanban renderer (RFC 0007 §5, RFC 0010 §3.7): one column per value of the group-by field (selection or state
 * options, or the groups the server returns for a many2one), cards from the view's card spec, drag-and-drop with
 * dnd-kit (keyboard too: Space to pick up, arrows, Space to drop). Moving a card between state columns runs the
 * transition that leads there; other fields are written. The server refuses moves the user may not make. A move
 * confirms with a toast that undoes it while the reverse is possible. Column headers show the count and the
 * view's `total`; empty columns fold to a strip (click to open) so the board stays readable.
 */

import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { Condition, FieldNode } from '@kosh/views';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactElement, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, type Row, type ServedView, type ViewField } from '../api.js';
import { Avatar } from '../components/Avatar.js';
import { Alert, Input, Skeleton } from '../components/primitives.js';
import { useKosh } from '../context.js';
import { cn } from '../lib/cn.js';
import { useLiveModel } from '../live.js';
import type { ViewProps } from '../registry.js';
import { useToast } from '../shell/toast.js';
import { PrefetchedNames, useRowNames } from './widgets.js';

interface Column {
  readonly key: string;
  readonly value: unknown;
  readonly label: string;
}

const and = (a: Condition | undefined, b: Condition): Condition =>
  a === undefined ? b : { and: [a, b] };

/** How many records of a many2one target become columns of their own (the rest group as the data has them). */
const EXPANDED_COLUMNS = 50;

/** The plain amount of an aggregate (Money comes back as `{ amount, currency }`). */
function amountOf(v: unknown): string {
  if (typeof v === 'object' && v !== null && 'amount' in v)
    return String((v as { amount: unknown }).amount);
  return v === null || v === undefined ? '0' : String(v);
}

const idOfValue = (v: unknown): number | null =>
  typeof v === 'number'
    ? v
    : typeof v === 'object' && v !== null && 'id' in v
      ? Number((v as { id: unknown }).id)
      : null;
const nameOfValue = (v: unknown): string | null =>
  typeof v === 'object' && v !== null && 'displayName' in v
    ? String((v as { displayName: unknown }).displayName)
    : typeof v === 'string'
      ? v
      : null;
/** A stable tint for a value (a stage, a tag): a hue from its text, in the theme's saturation. */
export const tintOf = (v: unknown): string => {
  const key = String(nameOfValue(v) ?? idOfValue(v) ?? v ?? '');
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `oklch(0.7 0.14 ${h})`;
};

function Card({
  row,
  served,
  onOpen,
}: {
  readonly row: Row;
  readonly served: ServedView;
  readonly onOpen: (id: number) => void;
}): ReactElement {
  const { registry } = useKosh();
  const view = served.view;
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: row.id,
    data: { row },
  });
  if (view.type !== 'kanban') throw new Error('kanban');
  const fields = served.fields[view.model] ?? {};
  const show = (node: FieldNode) => {
    const field = fields[node.field];
    if (field === undefined) return null;
    const Widget = registry.widget(node, field);
    return (
      <Widget
        key={node.id}
        id={`${row.id}-${node.id}`}
        node={node}
        field={field}
        value={row[node.field]}
        record={row}
        readonly
      />
    );
  };
  const text = (key: string | undefined) => {
    if (key === undefined) return null;
    const field = fields[key];
    return field === undefined ? null : show({ kind: 'field', id: key, field: key });
  };
  return (
    <li
      ref={setNodeRef}
      className={cn(
        'rounded-md border bg-surface p-3 text-sm shadow-sm transition-shadow hover:shadow-md',
        isDragging && 'opacity-70 shadow-lg',
        view.card.color !== undefined && 'border-s-4',
      )}
      style={{
        ...(transform === null
          ? {}
          : { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }),
        ...(view.card.color === undefined
          ? {}
          : { borderInlineStartColor: tintOf(row[view.card.color]) }),
      }}
    >
      {view.card.image === undefined || idOfValue(row[view.card.image]) === null ? null : (
        <img
          src={`/api/v1/attachments/${idOfValue(row[view.card.image])}/download?inline=true&w=256`}
          alt=""
          className="mb-2 aspect-[4/3] w-full rounded object-cover"
        />
      )}
      <div className="flex items-start justify-between gap-2">
        {view.card.avatar === undefined ? null : (
          <Avatar
            name={String(nameOfValue(row[view.card.avatar]) ?? '')}
            src={null}
            className="mt-0.5"
          />
        )}
        <button
          type="button"
          className="text-start font-medium hover:underline"
          onClick={() => onOpen(row.id)}
        >
          {text(view.card.title)}
        </button>
        <button
          type="button"
          className="cursor-grab rounded px-1 text-muted-foreground hover:bg-muted"
          aria-label={`Move ${String(row['displayName'] ?? row[view.card.title] ?? row.id)}`}
          {...attributes}
          {...listeners}
        >
          ⠿
        </button>
      </div>
      {view.card.subtitle === undefined ? null : (
        <div className="text-muted-foreground">{text(view.card.subtitle)}</div>
      )}
      {(view.card.badges ?? []).length === 0 ? null : (
        <div className="mt-2 flex flex-wrap gap-1">{(view.card.badges ?? []).map(show)}</div>
      )}
      {(view.card.footer ?? []).length === 0 ? null : (
        <div className="mt-2 flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
          {(view.card.footer ?? []).map(show)}
        </div>
      )}
      {view.card.progress === undefined || typeof row[view.card.progress] !== 'number' ? null : (
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={row[view.card.progress] as number}
          className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted"
        >
          <div
            className="h-full rounded-full bg-primary"
            style={{ width: `${Math.max(0, Math.min(100, row[view.card.progress] as number))}%` }}
          />
        </div>
      )}
    </li>
  );
}

function ColumnView({
  column,
  props,
  keys,
  groupField,
  stats,
  folded,
  onUnfold,
}: {
  readonly column: Column;
  readonly props: ViewProps;
  readonly keys: readonly string[];
  readonly groupField: ViewField;
  /** The server's count and total for the column (undefined while loading). */
  readonly stats: { readonly count: number; readonly total: string | null } | undefined;
  readonly folded: boolean;
  readonly onUnfold: () => void;
}): ReactElement {
  const { api, format } = useKosh();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const view = props.served.view;
  const { setNodeRef, isOver } = useDroppable({ id: column.key, data: { column } });
  const [quick, setQuick] = useState('');
  const where = and(props.where, { [groupField.key]: column.value });
  const rows = useQuery({
    queryKey: ['list', view.model, where, keys, 'kanban'],
    queryFn: () => api.list(view.model, { filter: where, fields: keys, limit: 100, count: true }),
    enabled: !folded,
  });
  const items = rows.data?.items ?? [];
  const names = useRowNames(items, Object.values(props.served.fields[view.model] ?? {}));
  const create = useMutation({
    mutationFn: (name: string) =>
      api.create(view.model, {
        [view.type === 'kanban' ? view.card.title : 'name']: name,
        ...(groupField.kind === 'state' ? {} : { [groupField.key]: column.value }),
      }),
    onSuccess: async () => {
      setQuick('');
      await queryClient.invalidateQueries({ queryKey: ['list', view.model] });
      await queryClient.invalidateQueries({ queryKey: ['kanban-stats', view.model] });
    },
  });
  // New records start in the initial state, so quick create applies to columns of other fields only.
  const quickCreate =
    view.type === 'kanban' &&
    view.quickCreate === true &&
    props.served.operations.create &&
    groupField.kind !== 'state';
  const count = stats?.count ?? rows.data?.count ?? items.length;
  if (folded)
    return (
      <section
        ref={setNodeRef}
        aria-label={column.label}
        className={cn(
          'flex w-10 shrink-0 flex-col items-center rounded-lg bg-muted/50 py-2',
          isOver && 'ring-2 ring-ring',
        )}
      >
        <button
          type="button"
          className="flex flex-1 flex-col items-center gap-2 rounded px-1 text-sm hover:bg-muted"
          aria-label={t('views.unfold', { column: column.label, count })}
          onClick={onUnfold}
        >
          <span className="text-xs text-muted-foreground">{count}</span>
          <span className="font-semibold [writing-mode:vertical-rl]">{column.label}</span>
        </button>
      </section>
    );
  return (
    <section
      ref={setNodeRef}
      aria-label={column.label}
      className={cn(
        'flex w-72 shrink-0 flex-col rounded-lg bg-muted/50 p-2',
        isOver && 'ring-2 ring-ring',
      )}
    >
      <h2 className="flex items-baseline justify-between gap-2 px-1 pb-2 text-sm font-semibold">
        <span className="truncate">{column.label}</span>
        <span className="flex shrink-0 items-baseline gap-2 text-xs font-normal text-muted-foreground">
          {stats?.total === null || stats?.total === undefined ? null : (
            <span className="tabular-nums" title={t('views.columnTotal')}>
              {format.decimal(stats.total)}
            </span>
          )}
          <span className="rounded-full bg-muted px-1.5">{count}</span>
        </span>
      </h2>
      {quickCreate ? (
        <form
          className="mb-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (quick.trim() !== '') create.mutate(quick.trim());
          }}
        >
          <Input
            aria-label={`${t('views.quickCreate')}: ${column.label}`}
            placeholder={t('views.quickCreate')}
            value={quick}
            onChange={(e) => setQuick(e.target.value)}
          />
        </form>
      ) : null}
      {rows.isPending ? (
        <div className="grid gap-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
      ) : (
        <PrefetchedNames.Provider value={names}>
          <ul className="grid gap-2">
            {items.map((row) => (
              <Card key={row.id} row={row} served={props.served} onOpen={props.onOpen} />
            ))}
          </ul>
        </PrefetchedNames.Provider>
      )}
    </section>
  );
}

/** The default kanban renderer. */
export function KanbanView(props: ViewProps): ReactElement {
  const { api } = useKosh();
  const { t } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor),
  );
  const view = props.served.view;
  useLiveModel(view.model);
  const fields = view.type === 'kanban' ? (props.served.fields[view.model] ?? {}) : {};
  const groupField = view.type === 'kanban' ? fields[view.groupBy] : undefined;
  const totalField =
    view.type === 'kanban' && view.total !== undefined && fields[view.total] !== undefined
      ? view.total
      : undefined;
  // One query for every column's count (and total): the columns of options, and the groups of a many2one.
  const stats = useQuery({
    queryKey: ['kanban-stats', view.model, props.where, groupField?.key, totalField],
    queryFn: () =>
      api.aggregate(view.model, {
        where: props.where,
        groupBy: [groupField?.key as string],
        measures: {
          n: 'count',
          ...(totalField === undefined ? {} : { total: { sum: totalField } }),
        },
      }),
    enabled: groupField !== undefined,
  });
  const groupNames = useRowNames(
    (stats.data ?? []).map((g) => ({ [groupField?.key ?? '']: g[groupField?.key ?? ''] })),
    groupField === undefined ? [] : [groupField],
  );
  // A many2one board shows every record of its target (stages, teams) as a column, empty ones included, in the
  // target's order; the groups the aggregate returns beyond those (None, or a target past the limit) follow.
  const expanded = useQuery({
    queryKey: ['kanban-columns', groupField?.target],
    queryFn: () => api.names(groupField?.target as string, { limit: EXPANDED_COLUMNS }),
    enabled: groupField?.kind === 'many2one' && groupField.target !== undefined,
  });
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['list', view.model] });
    await queryClient.invalidateQueries({ queryKey: ['kanban-stats', view.model] });
  };
  const move = useMutation({
    mutationFn: async ({ row, to }: { row: Row; to: Column }) => {
      if (groupField === undefined) return null;
      const from = row[groupField.key] ?? null;
      if (groupField.kind === 'state') {
        const transitions = props.served.transitions.filter((tr) => tr.field === groupField.key);
        const forward = transitions.find(
          (tr) => tr.to === to.value && tr.from.includes(String(from)),
        );
        if (forward === undefined) throw new Error(t('views.moveRefused'));
        await api.transition(view.model, row.id, forward.name);
        const back = transitions.find((tr) => tr.to === from && tr.from.includes(String(to.value)));
        return back === undefined ? null : () => api.transition(view.model, row.id, back.name);
      }
      await api.update(view.model, row.id, { [groupField.key]: to.value });
      return () => api.update(view.model, row.id, { [groupField.key]: from });
    },
    onSuccess: async (undo, { row, to }) => {
      setError(null);
      await refresh();
      const name = String(row['displayName'] ?? row.id);
      toast({
        title: t('views.moved', { name, column: to.label }),
        ...(undo === null
          ? {}
          : {
              action: {
                label: t('views.undo'),
                run: () =>
                  void undo()
                    .then(refresh)
                    .then(() => toast({ title: t('views.undone'), tone: 'info' }))
                    .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e))),
              },
            }),
      });
    },
    onError: (e) =>
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e)),
  });
  if (view.type !== 'kanban' || groupField === undefined)
    return (
      <Alert>{`The kanban needs the field ${view.type === 'kanban' ? view.groupBy : ''}.`}</Alert>
    );

  const grouped: Column[] = (stats.data ?? []).map((g) => {
    const value = g[groupField.key] ?? null;
    const label =
      value === null
        ? t('views.none')
        : groupField.kind === 'many2one'
          ? (groupNames.get(groupField.target ?? '')?.get(Number(value)) ?? `#${String(value)}`)
          : String(value);
    return { key: JSON.stringify(value), value, label };
  });
  const all: Column[] = (expanded.data ?? []).map((r) => ({
    key: JSON.stringify(r.id),
    value: r.id,
    label: r.displayName,
  }));
  const columns: Column[] =
    groupField.options !== undefined
      ? groupField.options.map((o) => ({ key: o.value, value: o.value, label: o.label }))
      : [...all, ...grouped.filter((g) => !all.some((c) => c.key === g.key))];
  const statsOf = (column: Column) => {
    if (stats.data === undefined) return undefined;
    const row = stats.data.find(
      (g) => JSON.stringify(g[groupField.key] ?? null) === JSON.stringify(column.value),
    );
    return {
      count: Number(row?.['n'] ?? 0),
      total: totalField === undefined || row === undefined ? null : amountOf(row['total']),
    };
  };
  const quickCreate = view.quickCreate === true && groupField.kind !== 'state';
  const keys = [
    ...new Set([
      'id',
      'displayName',
      view.groupBy,
      view.card.title,
      ...(view.card.subtitle === undefined ? [] : [view.card.subtitle]),
      ...(view.card.footer ?? []).map((f) => f.field),
      ...(view.card.badges ?? []).map((f) => f.field),
    ]),
  ].filter((k) => k === 'id' || fields[k] !== undefined);

  const onDragEnd = (event: DragEndEvent) => {
    const row = event.active.data.current?.['row'] as Row | undefined;
    const to = event.over?.data.current?.['column'] as Column | undefined;
    if (
      row === undefined ||
      to === undefined ||
      JSON.stringify(row[groupField.key] ?? null) === JSON.stringify(to.value)
    )
      return;
    move.mutate({ row, to });
  };

  return (
    <div className="grid gap-3">
      {error === null ? null : <Alert>{error}</Alert>}
      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        <div className="flex min-h-64 gap-3 overflow-x-auto pb-2">
          {columns.map((column) => {
            const s = statsOf(column);
            // Empty columns fold (when there are enough columns for it to matter), unless opened or creatable.
            const folded =
              s !== undefined &&
              s.count === 0 &&
              columns.length > 3 &&
              !quickCreate &&
              !unfolded.has(column.key);
            return (
              <ColumnView
                key={column.key}
                column={column}
                props={props}
                keys={keys}
                groupField={groupField}
                stats={s}
                folded={folded}
                onUnfold={() => setUnfolded((u) => new Set(u).add(column.key))}
              />
            );
          })}
        </div>
      </DndContext>
    </div>
  );
}
