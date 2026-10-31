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
import {
  type CSSProperties,
  type ReactElement,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
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
  MenuSeparator,
  MenuTrigger,
  Skeleton,
} from '../components/primitives.js';
import { useKosh } from '../context.js';
import { useDesign } from '../design.js';
import { cn } from '../lib/cn.js';
import { useLiveModel } from '../live.js';
import type { ViewProps } from '../registry.js';
import { useToast } from '../shell/toast.js';
import {
  type CellRef,
  cellText,
  coerce,
  inRange,
  parseClipboard,
  type Resolve,
  rangeOf,
  toClipboard,
} from './grid.js';
import { rememberList } from './listMemory.js';
import { PrefetchedNames, useRowNames } from './widgets.js';

const features = tableFeatures({});
const helper = createColumnHelper<typeof features, Row>();
type Density = import('../context.js').Density;
const HEIGHTS: Record<Density, number> = { comfortable: 40, compact: 32 };
/** The record's page in a new tab: the list's address with the record's id (`/<app>/a/<action>/<id>`). */
/** A decorated row (RFC 0022 §3.3): its text in the tone; `neutral` mutes it (done, cancelled). */
const ROW_TONES = {
  danger: 'text-danger',
  warning: 'text-warning-text',
  success: 'text-success',
  info: 'text-primary',
  neutral: 'text-muted-foreground',
} as const;

function openInNewTab(id: number): void {
  const path = window.location.pathname.replace(/\/$/, '');
  window.open(`${path}/${id}`, '_blank', 'noopener');
}

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

const MIN_WIDTH = 64;
const MAX_WIDTH = 960;
const DEFAULT_WIDTH = 160;
const SELECT_WIDTH = 40;

/**
 * The handle at a header cell's end (RFC 0022 §3.5): drag it to resize the column, double-click to reset; with the
 * keyboard, the arrows change the width by 16 px and Home resets it.
 */
function ResizeHandle({
  label,
  width,
  onResize,
  onReset,
}: {
  readonly label: string;
  readonly width: number | null;
  readonly onResize: (width: number) => void;
  readonly onReset: () => void;
}): ReactElement {
  const drag = useRef<{ x: number; width: number } | null>(null);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a separator is the role of a column resizer
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width ?? undefined}
      tabIndex={0}
      className="absolute inset-y-0 end-0 w-2 cursor-col-resize touch-none select-none hover:bg-primary/30 focus-visible:bg-primary/40 focus-visible:outline-none"
      onPointerDown={(e) => {
        const cell = (e.currentTarget as HTMLElement).parentElement;
        if (cell === null) return;
        drag.current = { x: e.clientX, width: cell.getBoundingClientRect().width };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        e.preventDefault();
      }}
      onPointerMove={(e) => {
        if (drag.current === null) return;
        onResize(
          drag.current.width + (e.clientX - drag.current.x) * (document.dir === 'rtl' ? -1 : 1),
        );
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        const cell = (e.currentTarget as HTMLElement).parentElement;
        const current = width ?? cell?.getBoundingClientRect().width ?? DEFAULT_WIDTH;
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          const grow = (e.key === 'ArrowRight') !== (document.dir === 'rtl');
          onResize(current + (grow ? 16 : -16));
          e.preventDefault();
        } else if (e.key === 'Home') {
          onReset();
          e.preventDefault();
        }
      }}
    />
  );
}

/** Column widths and pinned columns of a list, per user and view (RFC 0022 §3.5). */
interface ColumnLayout {
  readonly widths: Readonly<Record<string, number>>;
  readonly pinned: readonly string[];
  readonly setWidth: (id: string, width: number | null) => void;
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

/** Where the active cell goes after a save. */
type Next = 'down' | 'right' | 'left' | 'stay' | 'cancel';

/** The editor's first value when editing started with a typed character. */
function seeded(field: ViewField, seed: string, current: unknown): unknown {
  switch (field.kind) {
    case 'char':
    case 'text':
    case 'html':
      return seed;
    case 'integer':
      return /^\d$/.test(seed) ? Number(seed) : current;
    case 'decimal':
    case 'float':
    case 'monetary':
      return /^[\d.]$/.test(seed) ? seed : current;
    default:
      return current;
  }
}

/**
 * The editor of one cell, mounted when editing starts: its first value is the row's (or the typed character that
 * started it), set before the first render so that no keystroke can race it. Saves with the row's version and
 * tells the grid where to go next.
 */
function CellEditor({
  node,
  field,
  row,
  model,
  seed,
  onDone,
}: {
  readonly node: FieldNode;
  readonly field: ViewField;
  readonly row: Row;
  readonly model: string;
  readonly seed: string | undefined;
  readonly onDone: (next: Next) => void;
}): ReactElement {
  const { registry, api } = useKosh();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<unknown>(() =>
    seed === undefined ? row[node.field] : seeded(field, seed, row[node.field]),
  );
  const [error, setError] = useState<string | null>(null);
  const next = useRef<Next>('stay');
  const editor = useRef<HTMLDivElement>(null);
  const Widget = registry.widget(node, field);
  useEffect(() => {
    editor.current?.querySelector<HTMLElement>('input, select, textarea, button')?.focus();
  }, []);
  const save = useMutation({
    mutationFn: (value: unknown) => api.update(model, row.id, { [node.field]: value }, etagOf(row)),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['list', model] });
      onDone(next.current);
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : String(e)),
  });
  const commit = (direction: Next) => {
    if (save.isPending) return;
    if (draft === row[node.field] || (draft === null && row[node.field] === undefined)) {
      onDone(direction === 'stay' ? 'cancel' : direction);
      return;
    }
    next.current = direction;
    save.mutate(draft);
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: commits the edit when focus leaves the cell
    <div
      ref={editor}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) commit('stay');
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit(e.shiftKey ? 'stay' : 'down');
        } else if (e.key === 'Tab') {
          e.preventDefault();
          commit(e.shiftKey ? 'left' : 'right');
        } else if (e.key === 'Escape') onDone('cancel');
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
}

function Cell({
  node,
  field,
  row,
  editable,
  model,
  editing,
  seed,
  onStart,
  onDone,
}: {
  readonly node: FieldNode;
  readonly field: ViewField;
  readonly row: Row;
  readonly editable: boolean;
  readonly model: string;
  /** The grid says this cell is being edited. */
  readonly editing: boolean;
  readonly seed: string | undefined;
  readonly onStart: () => void;
  readonly onDone: (next: Next) => void;
}): ReactElement {
  const { registry } = useKosh();
  const Widget = registry.widget(node, field);
  if (editable && editing)
    return (
      <CellEditor node={node} field={field} row={row} model={model} seed={seed} onDone={onDone} />
    );
  return (
    <div
      className={cn(editable && 'cursor-text rounded px-1 hover:bg-muted')}
      {...(editable
        ? {
            onClick: (e: { stopPropagation(): void }) => {
              e.stopPropagation();
              onStart();
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
  layout,
}: {
  readonly props: ViewProps;
  readonly layout: ColumnLayout;
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
  const { api, uid, companyId } = useKosh();
  const { widths, pinned, setWidth } = layout;
  // A column's cells: its width, and when pinned, stuck to the start after the pinned ones before it.
  const colStyle = (id: string): CSSProperties => {
    const width = widths[id];
    const style: CSSProperties =
      width === undefined ? {} : { width, minWidth: width, maxWidth: width };
    if (!pinned.includes(id)) return style;
    let left = selection === undefined ? 0 : SELECT_WIDTH;
    for (const c of columns) {
      if (c.id === id) break;
      if (pinned.includes(c.id)) left += widths[c.id] ?? DEFAULT_WIDTH;
    }
    return { ...style, position: 'sticky', left, zIndex: 1 };
  };
  const pinnedClass = (id: string): string | undefined =>
    pinned.includes(id) ? 'bg-surface shadow-[1px_0_0_0_var(--border)]' : undefined;
  // Row decorations (RFC 0022 §3.3): the first tone whose condition holds on the row, danger first.
  const decorations = props.served.view.type === 'list' ? props.served.view.decorations : undefined;
  const rowTone = (row: Readonly<Record<string, unknown>>): string | undefined => {
    if (decorations === undefined) return undefined;
    for (const tone of ['danger', 'warning', 'success', 'info', 'neutral'] as const)
      if (holds(decorations[tone], row, { uid, companyId })) return ROW_TONES[tone];
    return undefined;
  };
  const { t } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
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
  // From the data, not the fetch: a search answered from the cache (back to All) has its count too.
  useEffect(() => {
    if (query.data !== undefined) onCount?.(query.data.count ?? query.data.items.length);
  }, [query.data, onCount]);
  const names = useRowNames(items, Object.values(fields));
  const tableColumns = useMemo(
    () =>
      helper.columns(
        columns.map((node) =>
          helper.accessor((row: Row) => row[node.field], {
            id: node.id,
            header: () => node.label ?? fields[node.field]?.label ?? node.field,
          }),
        ),
      ),
    [columns, fields],
  );
  const table = useTable({ features, columns: tableColumns, data: items });
  const scroller = useRef<HTMLDivElement>(null);
  const rows = table.getRowModel().rows;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => height,
    overscan: 12,
  });

  // ---- the grid (RFC 0010 Phase B): an active cell, a range, keyboard editing, paste, fill down, copy
  const inline = useMemo(
    () => new Set(view.type === 'list' ? (view.inlineEdit ?? []) : []),
    [view],
  );
  const [active, setActive] = useState<CellRef | null>(null);
  const [anchor, setAnchor] = useState<CellRef | null>(null);
  const [editing, setEditing] = useState<{ cell: CellRef; seed?: string } | null>(null);
  const focusWanted = useRef(false);
  const range = active === null ? null : rangeOf(anchor ?? active, active);
  const editableAt = (row: Row, node: FieldNode): boolean =>
    inline.has(node.field) &&
    props.served.operations.write &&
    fields[node.field]?.readonly !== true &&
    !holds(node.readonlyWhen, row, { uid, companyId });
  const move = (cell: CellRef, extend: boolean) => {
    if (items.length === 0 || columns.length === 0) return;
    const clamped = {
      row: Math.max(0, Math.min(items.length - 1, cell.row)),
      col: Math.max(0, Math.min(columns.length - 1, cell.col)),
    };
    setAnchor(extend ? (anchor ?? active) : null);
    setActive(clamped);
    focusWanted.current = true;
    virtualizer.scrollToIndex(clamped.row, { align: 'auto' });
  };
  useEffect(() => {
    if (!focusWanted.current || active === null) return;
    let tries = 0;
    const focus = () => {
      const el = scroller.current?.querySelector<HTMLElement>(
        `[data-row="${active.row}"][data-col="${active.col}"]`,
      );
      if (el !== null && el !== undefined) {
        focusWanted.current = false;
        el.focus({ preventScroll: true });
      } else if (tries < 5) {
        tries += 1;
        requestAnimationFrame(focus); // the row is not rendered yet (virtualized): once more
      }
    };
    focus();
  }, [active]);
  const plain = (value: unknown): unknown =>
    typeof value === 'object' && value !== null && 'id' in value
      ? (value as { id: unknown }).id
      : value;
  /** Writes several rows (a few at a time), refreshes, and offers to put the previous values back. */
  const writeCells = async (
    changes: ReadonlyMap<number, Record<string, unknown>>,
    what: 'pasted' | 'filled' | 'cleared',
  ) => {
    const entries = [...changes].filter(([, v]) => Object.keys(v).length > 0);
    if (entries.length === 0) return;
    const previous = entries.map(([i, v]) => ({
      id: (items[i] as Row).id,
      values: Object.fromEntries(Object.keys(v).map((k) => [k, plain(items[i]?.[k]) ?? null])),
    }));
    const result = await each(
      entries.map(([i]) => i),
      (i) => api.update(model, (items[i] as Row).id, changes.get(i) ?? {}, etagOf(items[i] as Row)),
    );
    await queryClient.invalidateQueries({ queryKey: ['list', model] });
    const cells = entries.reduce((n, [, v]) => n + Object.keys(v).length, 0);
    if (result.done > 0)
      toast({
        title: t(`views.${what}`, { count: cells }),
        action: {
          label: t('views.undo'),
          run: () => {
            void each(
              previous.map((_, k) => k),
              (k) => {
                const p = previous[k] as { id: number; values: Record<string, unknown> };
                return api.update(model, p.id, p.values, null);
              },
            ).then(() => queryClient.invalidateQueries({ queryKey: ['list', model] }));
          },
        },
      });
    if (result.failed > 0)
      toast({
        title: t('views.bulkFailed', { count: result.failed, reason: result.reason ?? '' }),
        tone: 'danger',
      });
  };
  const pasteBlock = async (start: CellRef, block: readonly (readonly string[])[]) => {
    const changes = new Map<number, Record<string, unknown>>();
    let skipped = 0;
    let reason: string | null = null;
    const resolve: Resolve = (target, q) => api.names(target, { q, limit: 10 });
    const messages = (key: string, params?: Record<string, unknown>) =>
      t(`views.paste.${key}`, params ?? {});
    for (let i = 0; i < block.length; i += 1) {
      const row = items[start.row + i];
      if (row === undefined) break;
      const line = block[i] as readonly string[];
      for (let j = 0; j < line.length; j += 1) {
        const node = columns[start.col + j];
        if (node === undefined) break;
        const field = fields[node.field];
        if (field === undefined || !editableAt(row, node)) {
          skipped += 1;
          reason ??= messages('readonly', { column: node.label ?? field?.label ?? node.field });
          continue;
        }
        const coerced = await coerce(field, line[j] as string, resolve, messages);
        if (!coerced.ok) {
          skipped += 1;
          reason ??= coerced.reason;
          continue;
        }
        const values = changes.get(start.row + i) ?? {};
        values[node.field] = coerced.value;
        changes.set(start.row + i, values);
      }
    }
    if (block.length > 0) {
      setAnchor(start);
      setActive({
        row: Math.min(items.length - 1, start.row + block.length - 1),
        col: Math.min(columns.length - 1, start.col + Math.max(...block.map((l) => l.length)) - 1),
      });
    }
    await writeCells(changes, 'pasted');
    if (skipped > 0)
      toast({
        title: t('views.pasteSkipped', { count: skipped, reason: reason ?? '' }),
        tone: 'danger',
      });
  };
  const fillDown = async () => {
    if (range === null || range.bottom === range.top) {
      toast({ title: t('views.fillNeedsRange'), tone: 'info' });
      return;
    }
    const changes = new Map<number, Record<string, unknown>>();
    for (let c = range.left; c <= range.right; c += 1) {
      const node = columns[c] as FieldNode;
      const source = plain(items[range.top]?.[node.field]) ?? null;
      for (let r = range.top + 1; r <= range.bottom; r += 1) {
        const row = items[r];
        if (row === undefined || !editableAt(row, node)) continue;
        const values = changes.get(r) ?? {};
        values[node.field] = source;
        changes.set(r, values);
      }
    }
    await writeCells(changes, 'filled');
  };
  const clearRange = async () => {
    if (range === null) return;
    const changes = new Map<number, Record<string, unknown>>();
    for (let r = range.top; r <= range.bottom; r += 1)
      for (let c = range.left; c <= range.right; c += 1) {
        const row = items[r];
        const node = columns[c] as FieldNode;
        if (row === undefined || !editableAt(row, node)) continue;
        const values = changes.get(r) ?? {};
        values[node.field] = fields[node.field]?.kind === 'boolean' ? false : null;
        changes.set(r, values);
      }
    await writeCells(changes, 'cleared');
  };
  const onGridKey = (e: ReactKeyboardEvent<HTMLTableElement>) => {
    if (editing !== null) return;
    const target = e.target as HTMLElement;
    // Keys inside a control (a checkbox, a button) are its own.
    if (target.closest('input, select, textarea, button, [role="checkbox"]') !== null) return;
    const rowOf = target.closest<HTMLElement>('[data-row]');
    const cell: CellRef | null =
      active ?? (rowOf === null ? null : { row: Number(rowOf.dataset['row']), col: 0 });
    if (cell === null) return;
    const mod = e.ctrlKey || e.metaKey;
    const rtl = document.documentElement.dir === 'rtl';
    const row = items[cell.row];
    const node = columns[cell.col];
    const editable = row !== undefined && node !== undefined && editableAt(row, node);
    const onCell = target.matches('td[data-row]');
    switch (e.key) {
      case 'ArrowUp':
        move({ row: cell.row - 1, col: cell.col }, e.shiftKey);
        break;
      case 'ArrowDown':
        move({ row: cell.row + 1, col: cell.col }, e.shiftKey);
        break;
      case 'ArrowLeft':
        move({ row: cell.row, col: cell.col + (rtl ? 1 : -1) }, e.shiftKey);
        break;
      case 'ArrowRight':
        move({ row: cell.row, col: cell.col + (rtl ? -1 : 1) }, e.shiftKey);
        break;
      case 'Home':
        move({ row: mod ? 0 : cell.row, col: 0 }, e.shiftKey);
        break;
      case 'End':
        move({ row: mod ? items.length - 1 : cell.row, col: columns.length - 1 }, e.shiftKey);
        break;
      case 'Tab': {
        if (!onCell) return;
        const col = cell.col + (e.shiftKey ? -1 : 1);
        if (col < 0 || col >= columns.length) return; // leaves the table
        move({ row: cell.row, col }, false);
        break;
      }
      case 'Enter':
        if (!onCell) return; // the row opens itself
        if (editable) setEditing({ cell });
        else if (row !== undefined) props.onOpen(row.id);
        break;
      case 'F2':
        if (!editable) return;
        setEditing({ cell });
        break;
      case 'Escape':
        if (anchor === null) return;
        setAnchor(null);
        break;
      case 'Delete':
      case 'Backspace':
        if (!onCell) return;
        void clearRange();
        break;
      default:
        if (mod && e.key.toLowerCase() === 'd') {
          void fillDown();
          break;
        }
        if (onCell && editable && !mod && !e.altKey && e.key.length === 1) {
          setEditing({ cell, seed: e.key });
          break;
        }
        return;
    }
    e.preventDefault();
  };
  const onCopy = (e: {
    clipboardData: DataTransfer;
    preventDefault(): void;
    target: EventTarget;
  }) => {
    if (editing !== null || range === null) return;
    if ((e.target as HTMLElement).closest('input, textarea') !== null) return;
    const yesNo: readonly [string, string] = [t('views.yes'), t('views.no')];
    const lines: string[][] = [];
    for (let r = range.top; r <= range.bottom; r += 1) {
      const row = items[r];
      if (row === undefined) continue;
      lines.push(
        columns.slice(range.left, range.right + 1).map((node) => {
          const field = fields[node.field];
          return field === undefined
            ? ''
            : cellText(field, row[node.field], (target, id) => names.get(target)?.get(id), yesNo);
        }),
      );
    }
    e.clipboardData.setData('text/plain', toClipboard(lines));
    e.preventDefault();
  };
  const onPaste = (e: {
    clipboardData: DataTransfer;
    preventDefault(): void;
    target: EventTarget;
  }) => {
    if (editing !== null || active === null) return;
    if ((e.target as HTMLElement).closest('input, textarea') !== null) return;
    const block = parseClipboard(e.clipboardData.getData('text/plain'));
    if (block.length === 0) return;
    e.preventDefault();
    void pasteBlock(active, block);
  };
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
        title={
          filtered === true
            ? t('views.emptyFiltered')
            : props.served.view.label === undefined
              ? t('views.emptyTitle')
              : t('views.emptyNamed', { name: props.served.view.label.toLocaleLowerCase() })
        }
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
        <table
          className="w-full border-collapse text-sm"
          onKeyDown={onGridKey}
          onCopy={onCopy}
          onPaste={onPaste}
        >
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
                      style={colStyle(node.id)}
                      aria-sort={
                        direction === 'asc'
                          ? 'ascending'
                          : direction === 'desc'
                            ? 'descending'
                            : 'none'
                      }
                      className={cn(
                        'relative px-3 py-2 text-start font-medium text-muted-foreground',
                        pinnedClass(node.id),
                      )}
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
                      <ResizeHandle
                        label={t('views.resize', {
                          column: node.label ?? fields[node.field]?.label ?? node.field,
                        })}
                        width={widths[node.id] ?? null}
                        onResize={(w) => setWidth(node.id, w)}
                        onReset={() => setWidth(node.id, null)}
                      />
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
                    rowTone(row.original),
                  )}
                  // Ctrl / Cmd + click or the middle button: the record in a new tab, the list stays.
                  onClick={(e) => {
                    if (e.ctrlKey || e.metaKey) openInNewTab(id);
                    else props.onOpen(id);
                  }}
                  onAuxClick={(e) => {
                    if (e.button === 1) openInNewTab(id);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) openInNewTab(id);
                    else if (e.key === 'Enter') props.onOpen(id);
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
                  {columns.map((node, colIndex) => {
                    const field = fields[node.field];
                    const ref = { row: v.index, col: colIndex };
                    const isActive = active?.row === v.index && active.col === colIndex;
                    const inSelection = range !== null && anchor !== null && inRange(range, ref);
                    const isEditing =
                      editing?.cell.row === v.index && editing.cell.col === colIndex;
                    return (
                      <td
                        key={node.id}
                        data-row={v.index}
                        data-col={colIndex}
                        tabIndex={isActive ? 0 : -1}
                        style={colStyle(node.id)}
                        className={cn(
                          cellPad,
                          'outline-none',
                          pinnedClass(node.id),
                          isActive && 'outline-2 -outline-offset-2 outline-primary',
                          inSelection && 'bg-accent/40',
                        )}
                        onFocus={() => {
                          if (isActive) return;
                          setAnchor(null); // a click or Tab starts a new selection
                          setActive(ref);
                        }}
                        onMouseDown={(e) => {
                          if (e.shiftKey && active !== null) {
                            e.preventDefault();
                            move(ref, true);
                          }
                        }}
                      >
                        {field === undefined ? null : (
                          <Cell
                            node={node}
                            field={field}
                            row={row.original}
                            editable={editableAt(row.original, node)}
                            model={model}
                            editing={isEditing}
                            seed={isEditing ? editing?.seed : undefined}
                            onStart={() => {
                              setAnchor(null);
                              setActive(ref);
                              setEditing({ cell: ref });
                            }}
                            onDone={(next) => {
                              if (!isEditing) return; // another cell took over meanwhile
                              setEditing(null);
                              if (next === 'down') move({ row: v.index + 1, col: colIndex }, false);
                              else if (next === 'right')
                                move({ row: v.index, col: colIndex + 1 }, false);
                              else if (next === 'left')
                                move({ row: v.index, col: colIndex - 1 }, false);
                              else {
                                focusWanted.current = true;
                                setActive(ref);
                              }
                            }}
                          />
                        )}
                      </td>
                    );
                  })}
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
              {totalLabel(t('views.total'), c.label ?? fields[c.field]?.label ?? c.field)}
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
  layout,
}: {
  readonly props: ViewProps;
  readonly columns: readonly FieldNode[];
  readonly fields: Readonly<Record<string, ViewField>>;
  readonly height: number;
  readonly layout: ColumnLayout;
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
                layout={layout}
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
/** A sum's label: "Total Credit limit", but "Total" alone for a column already called "Total" (no "Total Total"). */
export function totalLabel(word: string, label: string): string {
  return label.toLocaleLowerCase().startsWith(word.toLocaleLowerCase())
    ? label
    : `${word} ${label}`;
}

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
  // RFC 0022 §3.5: column widths (dragged or set with the keyboard) and pinned columns, per user and view.
  const widthsKey = `kosh.widths.${uid}.${view.id}`;
  const pinnedKey = `kosh.pinned.${uid}.${view.id}`;
  const [widths, setWidths] = useState<Readonly<Record<string, number>>>(() =>
    stored.get<Record<string, number>>(widthsKey, {}),
  );
  const [pinned, setPinned] = useState<readonly string[]>(() =>
    stored.get<string[]>(pinnedKey, []),
  );
  const setWidth = (id: string, width: number | null): void => {
    const next = { ...widths };
    if (width === null) delete next[id];
    else next[id] = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(width)));
    setWidths(next);
    stored.set(widthsKey, next);
  };
  const togglePin = (id: string): void => {
    const next = pinned.includes(id) ? pinned.filter((p) => p !== id) : [...pinned, id];
    setPinned(next);
    stored.set(pinnedKey, next);
  };
  const { density, setDensity } = useKosh();
  const height = HEIGHTS[density];
  const columns = allColumns.filter((c) => !hidden.has(c.id));
  const layout: ColumnLayout = { widths, pinned, setWidth };
  const design = useDesign();
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
    mutationFn: async (format: 'csv' | 'xlsx' | 'pdf') => {
      const where = ids.length === 0 ? props.where : and(props.where, { id: { in: ids } });
      const keys = columns.map((c) => c.field);
      const file =
        format === 'csv'
          ? await api.download(`/api/v1/models/${encodeURIComponent(model)}/export`, {
              format: 'csv',
              ...(where === undefined ? {} : { filter: where }),
              ...(props.order.length === 0 ? {} : { order: props.order }),
            })
          : await api.download(`/api/v1/models/${encodeURIComponent(model)}/export/${format}`, {
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

  // Selected rows: a floating bar at the bottom of the screen (RFC 0018 §4.3); the list's own toolbar stays put.
  const floating =
    ids.length > 0 ? (
      <div
        role="toolbar"
        aria-label={t('views.selected', { count: ids.length })}
        data-kosh-selection-bar
        className="fixed inset-x-0 bottom-4 z-30 mx-auto flex w-fit max-w-[calc(100vw-2rem)] flex-wrap items-center gap-2 rounded-xl border bg-surface px-3 py-2 text-sm shadow-lg"
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
    ) : null;
  const toolbar = (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-1.5 text-sm">
        <span className="text-muted-foreground">
          {count === null ? (
            <Skeleton className="inline-block h-4 w-20" />
          ) : (
            t('views.records', { count })
          )}
        </span>
        <span className="flex-1" />
        {design.active ? (
          <Button
            size="sm"
            variant="ghost"
            className="border border-dashed border-primary/50 text-primary"
            onClick={() =>
              design.choose({
                kind: 'list',
                view: view.id,
                model,
                after: allColumns.at(-1)?.id ?? '',
                shown: allColumns.map((c) => c.field),
              })
            }
          >
            <Plus aria-hidden />
            {t('views.design.addColumn')}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          aria-label={t('views.density')}
          aria-pressed={density === 'compact'}
          title={density === 'compact' ? t('views.comfortable') : t('views.compact')}
          onClick={() => {
            const next: Density = density === 'compact' ? 'comfortable' : 'compact';
            setDensity(next);
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
            <MenuSeparator />
            <MenuLabel>{t('views.pinned')}</MenuLabel>
            {columns.map((c) => (
              <MenuCheckboxItem
                key={`pin-${c.id}`}
                checked={pinned.includes(c.id)}
                onCheckedChange={() => togglePin(c.id)}
              >
                {c.label ?? fields[c.field]?.label ?? c.field}
              </MenuCheckboxItem>
            ))}
            {Object.keys(widths).length === 0 ? null : (
              <>
                <MenuSeparator />
                <MenuItem
                  onSelect={() => {
                    setWidths({});
                    stored.set(widthsKey, {});
                  }}
                >
                  {t('views.resetWidths')}
                </MenuItem>
              </>
            )}
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
              <MenuItem onSelect={() => exportAs.mutate('pdf')}>{t('views.exportPdf')}</MenuItem>
            </MenuContent>
          </Menu>
        ) : null}
      </div>
      {floating}
    </>
  );

  return (
    <div className="rounded-lg border bg-surface">
      {props.groupBy.length > 0 ? (
        <Groups props={props} columns={columns} fields={fields} height={height} layout={layout} />
      ) : (
        <>
          {toolbar}
          <Rows
            props={props}
            where={props.where}
            layout={layout}
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
