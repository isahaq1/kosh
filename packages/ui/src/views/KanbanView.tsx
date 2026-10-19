/**
 * The kanban renderer (RFC 0007 §5): one column per value of the group-by field (selection or state options, or
 * the groups the server returns for a many2one), cards from the view's card spec, drag-and-drop with dnd-kit
 * (keyboard too: Space to pick up, arrows, Space to drop). Moving a card between state columns runs the transition
 * that leads there; other fields are written. The server refuses moves the user may not make.
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
import type { Condition, FieldNode } from '@isahaq/kosh-views';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactElement, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, type Row, type ServedView, type ViewField } from '../api.js';
import { Alert, Input, Spinner } from '../components/primitives.js';
import { useKosh } from '../context.js';
import { cn } from '../lib/cn.js';
import type { ViewProps } from '../registry.js';
import { PrefetchedNames, useRowNames } from './widgets.js';

interface Column {
  readonly key: string;
  readonly value: unknown;
  readonly label: string;
}

const and = (a: Condition | undefined, b: Condition): Condition =>
  a === undefined ? b : { and: [a, b] };

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
      style={
        transform === null
          ? undefined
          : { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
      }
      className={cn(
        'rounded-md border bg-surface p-3 text-sm shadow-sm',
        isDragging && 'opacity-70 shadow-lg',
      )}
    >
      <div className="flex items-start justify-between gap-2">
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
    </li>
  );
}

function ColumnView({
  column,
  props,
  keys,
  groupField,
}: {
  readonly column: Column;
  readonly props: ViewProps;
  readonly keys: readonly string[];
  readonly groupField: ViewField;
}): ReactElement {
  const { api } = useKosh();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const view = props.served.view;
  const { setNodeRef, isOver } = useDroppable({ id: column.key, data: { column } });
  const [quick, setQuick] = useState('');
  const where = and(props.where, { [groupField.key]: column.value });
  const rows = useQuery({
    queryKey: ['list', view.model, where, keys, 'kanban'],
    queryFn: () => api.list(view.model, { filter: where, fields: keys, limit: 100, count: true }),
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
    },
  });
  // New records start in the initial state, so quick create applies to columns of other fields only.
  const quickCreate =
    view.type === 'kanban' &&
    view.quickCreate === true &&
    props.served.operations.create &&
    groupField.kind !== 'state';
  return (
    <section
      ref={setNodeRef}
      aria-label={column.label}
      className={cn(
        'flex w-72 shrink-0 flex-col rounded-lg bg-muted/50 p-2',
        isOver && 'ring-2 ring-ring',
      )}
    >
      <h2 className="flex items-center justify-between px-1 pb-2 text-sm font-semibold">
        <span>{column.label}</span>
        <span className="text-xs font-normal text-muted-foreground">
          {rows.data?.count ?? items.length}
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
        <Spinner label={t('app.loading')} />
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
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor),
  );
  const view = props.served.view;
  const fields = view.type === 'kanban' ? (props.served.fields[view.model] ?? {}) : {};
  const groupField = view.type === 'kanban' ? fields[view.groupBy] : undefined;
  const groups = useQuery({
    queryKey: ['groups', view.model, props.where, groupField?.key],
    queryFn: () =>
      api.aggregate(view.model, {
        where: props.where,
        groupBy: [groupField?.key as string],
        measures: { n: 'count' },
      }),
    enabled: groupField !== undefined && groupField.options === undefined,
  });
  const groupNames = useRowNames(
    (groups.data ?? []).map((g) => ({ [groupField?.key ?? '']: g[groupField?.key ?? ''] })),
    groupField === undefined ? [] : [groupField],
  );
  const move = useMutation({
    mutationFn: async ({ row, to }: { row: Row; to: Column }) => {
      if (groupField === undefined) return;
      if (groupField.kind === 'state') {
        const from = String(row[groupField.key]);
        const transition = props.served.transitions.find(
          (tr) => tr.field === groupField.key && tr.to === to.value && tr.from.includes(from),
        );
        if (transition === undefined) throw new Error(t('views.moveRefused'));
        await api.transition(view.model, row.id, transition.name);
      } else await api.update(view.model, row.id, { [groupField.key]: to.value });
    },
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['list', view.model] });
    },
    onError: (e) =>
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e)),
  });
  if (view.type !== 'kanban' || groupField === undefined)
    return (
      <Alert>{`The kanban needs the field ${view.type === 'kanban' ? view.groupBy : ''}.`}</Alert>
    );

  const columns: Column[] =
    groupField.options !== undefined
      ? groupField.options.map((o) => ({ key: o.value, value: o.value, label: o.label }))
      : (groups.data ?? []).map((g) => {
          const value = g[groupField.key] ?? null;
          const label =
            value === null
              ? t('views.none')
              : groupField.kind === 'many2one'
                ? (groupNames.get(groupField.target ?? '')?.get(Number(value)) ??
                  `#${String(value)}`)
                : String(value);
          return { key: JSON.stringify(value), value, label };
        });
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
        <div className="flex gap-3 overflow-x-auto pb-2">
          {columns.map((column) => (
            <ColumnView
              key={column.key}
              column={column}
              props={props}
              keys={keys}
              groupField={groupField}
            />
          ))}
        </div>
      </DndContext>
    </div>
  );
}
