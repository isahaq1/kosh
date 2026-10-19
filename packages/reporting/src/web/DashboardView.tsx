/**
 * Dashboards (`report.dashboard` records): a 12-column grid of cards, each a live report query within the viewer's
 * rules: a KPI (with the change against the previous period or last year), a chart, a small pivot, or top records.
 * Editing adds, removes, resizes and reorders cards (drag-and-drop, keyboard too) and saves the layout as data.
 * Clicking a chart point or pivot row shows the records behind it.
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
import {
  Alert,
  Button,
  Dialog,
  Input,
  Label,
  Spinner,
  useKosh,
  type ViewProps,
} from '@isahaq/kosh-ui';
import type { Condition, MeasureNode, MeasureSpec } from '@isahaq/kosh-views';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GripVertical, Plus, Trash2 } from 'lucide-react';
import { type ReactElement, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ReportChart } from './GraphView.js';
import { change, formatValue, headerLabel, type ReportQuery, useReport } from './shared.js';

/** A dashboard card. */
export interface Card {
  readonly id: string;
  readonly title: string;
  readonly kind: 'kpi' | 'chart' | 'pivot' | 'list';
  readonly model: string;
  /** `count`, or `op:field` (`sum:amountTotal`). */
  readonly measure: string;
  readonly groupBy?: string;
  readonly filter?: Condition;
  /** KPI comparison over this date field: this month against the previous one (or last year). */
  readonly comparison?: { readonly field: string; readonly mode: 'previous' | 'yoy' };
  readonly chart?: 'bar' | 'line' | 'area' | 'pie';
  readonly w: 3 | 4 | 6 | 12;
}

export function measureOf(text: string): MeasureSpec {
  const [op, field] = text.split(':');
  return op === 'count' || field === undefined
    ? 'count'
    : ({ [op as string]: field } as MeasureSpec);
}

function thisMonth(): { from: string; to: string } {
  const now = new Date();
  const from = new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1));
  const to = new Date(Date.UTC(now.getFullYear(), now.getMonth() + 1, 1));
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

function Records({
  model,
  domain,
  onClose,
}: {
  readonly model: string;
  readonly domain: Condition;
  readonly onClose: () => void;
}): ReactElement {
  const { api } = useKosh();
  const { t } = useTranslation('reporting');
  const rows = useQuery({
    queryKey: ['names', model, 'drill', domain],
    queryFn: () =>
      api.list(model, { filter: domain, fields: ['displayName'], limit: 50, count: true }),
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('open')}
      description={`${rows.data?.count ?? ''}`}
    >
      {rows.isPending ? <Spinner label="…" /> : null}
      <ul className="grid max-h-80 gap-1 overflow-auto text-sm">
        {(rows.data?.items ?? []).map((r) => (
          <li key={r.id}>{String(r['displayName'] ?? r.id)}</li>
        ))}
      </ul>
    </Dialog>
  );
}

function CardBody({
  card,
  onDrill,
}: {
  readonly card: Card;
  readonly onDrill: (domain: Condition) => void;
}): ReactElement {
  const { api, format } = useKosh();
  const { t } = useTranslation('reporting');
  const measure: MeasureNode = { id: 'v', measure: measureOf(card.measure), label: card.title };
  const kpiQuery: ReportQuery | null =
    card.kind === 'kpi' || card.kind === 'pivot'
      ? {
          rows: card.kind === 'pivot' && card.groupBy !== undefined ? [card.groupBy] : [],
          measures: { v: measure.measure },
          ...(card.filter === undefined ? {} : { where: card.filter }),
          ...(card.kind === 'kpi' && card.comparison !== undefined
            ? { comparison: { ...card.comparison, ...thisMonth() } }
            : {}),
        }
      : null;
  const report = useReport(api, card.model, kpiQuery);
  const top = useQuery({
    queryKey: ['list', card.model, 'top', card.filter, card.measure],
    queryFn: () => {
      const field = card.measure.split(':')[1];
      return api.list(card.model, {
        ...(card.filter === undefined ? {} : { filter: card.filter }),
        fields: ['displayName', ...(field === undefined ? [] : [field])],
        ...(field === undefined ? {} : { order: [`${field} desc`] }),
        limit: 5,
      });
    },
    enabled: card.kind === 'list',
  });
  if (card.kind === 'chart')
    return (
      <ReportChart
        model={card.model}
        chart={card.chart ?? 'bar'}
        groupBy={[card.groupBy ?? 'createdAt:month']}
        measure={measure}
        where={card.filter}
        title={card.title}
        height={220}
        onDrill={onDrill}
      />
    );
  if (card.kind === 'list') {
    if (top.isError) return <Alert>{top.error.message}</Alert>;
    const field = card.measure.split(':')[1];
    return (
      <ol className="grid gap-1 text-sm">
        {(top.data?.items ?? []).map((r) => (
          <li key={r.id} className="flex justify-between gap-2">
            <span className="truncate">{String(r['displayName'] ?? r.id)}</span>
            {field === undefined ? null : (
              <span className="tabular-nums text-muted-foreground">
                {formatValue(r[field] as never, format)}
              </span>
            )}
          </li>
        ))}
      </ol>
    );
  }
  if (report.isError) return <Alert>{report.error.message}</Alert>;
  if (report.data === undefined) return <Spinner label="…" />;
  const data = report.data;
  if (card.kind === 'kpi') {
    const value = data.cells['[]']?.['[]']?.['v'];
    const delta =
      data.comparison === undefined
        ? null
        : change(value, data.comparison.cells['[]']?.['[]']?.['v']);
    return (
      <div>
        <p className="text-3xl font-semibold tabular-nums">{formatValue(value ?? 0, format)}</p>
        {delta === null ? null : (
          <p className={`text-sm ${delta.up ? 'text-success' : 'text-danger'}`}>{delta.text}</p>
        )}
      </div>
    );
  }
  return (
    <table className="w-full text-sm">
      <tbody>
        {data.rows.children.map((row) => (
          <tr key={row.key} className="border-b">
            <th scope="row" className="py-1 text-start font-normal">
              <button type="button" className="hover:underline" onClick={() => onDrill(row.domain)}>
                {headerLabel(row, format.locale, t('none'))}
              </button>
            </th>
            <td className="py-1 text-end tabular-nums">
              {formatValue(data.cells[row.key]?.['[]']?.['v'], format)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const SPAN = {
  3: 'lg:col-span-3',
  4: 'lg:col-span-4',
  6: 'lg:col-span-6',
  12: 'lg:col-span-12',
} as const;

function CardFrame({
  card,
  editing,
  onRemove,
  onDrill,
}: {
  readonly card: Card;
  readonly editing: boolean;
  readonly onRemove: () => void;
  readonly onDrill: (domain: Condition) => void;
}): ReactElement {
  const { t } = useTranslation('reporting');
  const drag = useDraggable({ id: card.id, disabled: !editing });
  const drop = useDroppable({ id: card.id });
  return (
    <section
      ref={(node) => {
        drag.setNodeRef(node);
        drop.setNodeRef(node);
      }}
      aria-label={card.title}
      className={`col-span-12 rounded-lg border bg-surface p-4 ${SPAN[card.w]} ${drop.isOver ? 'ring-2 ring-ring' : ''}`}
      style={
        drag.transform === null
          ? undefined
          : { transform: `translate3d(${drag.transform.x}px, ${drag.transform.y}px, 0)` }
      }
    >
      <header className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-muted-foreground">{card.title}</h3>
        {editing ? (
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="cursor-grab rounded p-1 hover:bg-muted"
              aria-label={`Move ${card.title}`}
              {...drag.attributes}
              {...drag.listeners}
            >
              <GripVertical className="size-4" aria-hidden />
            </button>
            <Button
              size="icon"
              variant="ghost"
              aria-label={`${t('remove')} ${card.title}`}
              onClick={onRemove}
            >
              <Trash2 aria-hidden />
            </Button>
          </div>
        ) : null}
      </header>
      <CardBody card={card} onDrill={onDrill} />
    </section>
  );
}

function CardEditor({
  onAdd,
  onClose,
}: {
  readonly onAdd: (card: Card) => void;
  readonly onClose: () => void;
}): ReactElement {
  const { t } = useTranslation('reporting');
  const id = useId();
  const [card, setCard] = useState({
    title: '',
    kind: 'kpi',
    model: '',
    measure: 'count',
    groupBy: '',
    filter: '',
    w: '3',
  });
  const [error, setError] = useState<string | null>(null);
  const set = (key: keyof typeof card) => (e: { target: { value: string } }) =>
    setCard((c) => ({ ...c, [key]: e.target.value }));
  const field = (key: keyof typeof card, label: string) => (
    <div className="grid gap-1">
      <Label htmlFor={`${id}-${key}`}>{label}</Label>
      <Input id={`${id}-${key}`} value={card[key]} onChange={set(key)} />
    </div>
  );
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('addCard')}
      footer={
        <Button
          variant="primary"
          onClick={() => {
            let filter: Condition | undefined;
            try {
              filter =
                card.filter.trim() === '' ? undefined : (JSON.parse(card.filter) as Condition);
            } catch {
              setError(t('filter'));
              return;
            }
            if (card.title.trim() === '' || card.model.trim() === '')
              return setError(`${t('title')} / ${t('model')}`);
            onAdd({
              id: `c${Date.now().toString(36)}`,
              title: card.title.trim(),
              kind: card.kind as Card['kind'],
              model: card.model.trim(),
              measure: card.measure.trim() || 'count',
              ...(card.groupBy.trim() === '' ? {} : { groupBy: card.groupBy.trim() }),
              ...(filter === undefined ? {} : { filter }),
              w: Number(card.w) as Card['w'],
            });
          }}
        >
          {t('addCard')}
        </Button>
      }
    >
      <div className="grid gap-3">
        {error === null ? null : <Alert>{error}</Alert>}
        {field('title', t('title'))}
        <div className="grid gap-1">
          <Label htmlFor={`${id}-kind`}>{t('kind')}</Label>
          <select
            id={`${id}-kind`}
            className="h-9 rounded-md border border-input bg-surface px-2 text-sm"
            value={card.kind}
            onChange={set('kind')}
          >
            {(['kpi', 'chart', 'pivot', 'list'] as const).map((k) => (
              <option key={k} value={k}>
                {t(k)}
              </option>
            ))}
          </select>
        </div>
        {field('model', t('model'))}
        {field('measure', `${t('measure')} (count, sum:field)`)}
        {field('groupBy', `${t('groupBy')} (state, dateOrder:month)`)}
        {field('filter', t('filter'))}
        <div className="grid gap-1">
          <Label htmlFor={`${id}-w`}>{t('width')}</Label>
          <select
            id={`${id}-w`}
            className="h-9 rounded-md border border-input bg-surface px-2 text-sm"
            value={card.w}
            onChange={set('w')}
          >
            {['3', '4', '6', '12'].map((w) => (
              <option key={w} value={w}>
                {w}/12
              </option>
            ))}
          </select>
        </div>
      </div>
    </Dialog>
  );
}

function Board({ id, onBack }: { readonly id: number; readonly onBack: () => void }): ReactElement {
  const { api } = useKosh();
  const { t } = useTranslation('reporting');
  const queryClient = useQueryClient();
  const record = useQuery({
    queryKey: ['record', 'report.dashboard', id],
    queryFn: () => api.get('report.dashboard', id, ['name', 'items', 'shared']),
  });
  const [draft, setDraft] = useState<Card[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [drill, setDrill] = useState<{ model: string; domain: Condition } | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor),
  );
  const save = useMutation({
    mutationFn: (items: Card[]) =>
      api.update('report.dashboard', id, { items }, record.data?.etag ?? null),
    onSuccess: async () => {
      setDraft(null);
      setEditing(false);
      await queryClient.invalidateQueries({ queryKey: ['record', 'report.dashboard', id] });
    },
  });
  if (record.isError) return <Alert>{record.error.message}</Alert>;
  if (record.data === undefined) return <Spinner label="…" />;
  const cards = draft ?? (record.data.record['items'] as Card[] | null) ?? [];
  const onDragEnd = (e: DragEndEvent) => {
    if (e.over === null || e.over.id === e.active.id) return;
    const from = cards.findIndex((c) => c.id === e.active.id);
    const to = cards.findIndex((c) => c.id === e.over?.id);
    if (from < 0 || to < 0) return;
    const next = [...cards];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved as Card);
    setDraft(next);
  };
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" onClick={onBack}>
          ←
        </Button>
        <h2 className="text-base font-semibold">{String(record.data.record['name'])}</h2>
        <div className="ms-auto flex gap-2">
          {editing ? (
            <>
              <Button size="sm" onClick={() => setAdding(true)}>
                <Plus aria-hidden />
                {t('addCard')}
              </Button>
              <Button
                size="sm"
                variant="primary"
                busy={save.isPending}
                onClick={() => save.mutate(cards)}
              >
                {t('done')}
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={() => setEditing(true)}>
              {t('edit')}
            </Button>
          )}
        </div>
      </div>
      {save.error === null ? null : <Alert>{save.error.message}</Alert>}
      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        <div className="grid grid-cols-12 gap-3">
          {cards.map((card) => (
            <CardFrame
              key={card.id}
              card={card}
              editing={editing}
              onRemove={() => setDraft(cards.filter((c) => c.id !== card.id))}
              onDrill={(domain) =>
                setDrill({
                  model: card.model,
                  domain: card.filter === undefined ? domain : { and: [card.filter, domain] },
                })
              }
            />
          ))}
        </div>
      </DndContext>
      {adding ? (
        <CardEditor
          onClose={() => setAdding(false)}
          onAdd={(card) => {
            setDraft([...cards, card]);
            setAdding(false);
          }}
        />
      ) : null}
      {drill === null ? null : (
        <Records model={drill.model} domain={drill.domain} onClose={() => setDrill(null)} />
      )}
    </div>
  );
}

export function DashboardView(_props: ViewProps): ReactElement {
  const { api } = useKosh();
  const { t } = useTranslation('reporting');
  const queryClient = useQueryClient();
  const [open, setOpen] = useState<number | null>(null);
  const [name, setName] = useState('');
  const boards = useQuery({
    queryKey: ['list', 'report.dashboard'],
    queryFn: () => api.list('report.dashboard', { fields: ['name', 'shared'] }),
  });
  const create = useMutation({
    mutationFn: () => api.create('report.dashboard', { name, items: [] }),
    onSuccess: async (r) => {
      setName('');
      await queryClient.invalidateQueries({ queryKey: ['list', 'report.dashboard'] });
      setOpen(r.record.id);
    },
  });
  if (open !== null) return <Board id={open} onBack={() => setOpen(null)} />;
  return (
    <div className="grid gap-3">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() !== '') create.mutate();
        }}
      >
        <Input
          aria-label={t('name')}
          placeholder={t('newDashboard')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="max-w-xs"
        />
        <Button type="submit" size="sm" variant="primary" busy={create.isPending}>
          <Plus aria-hidden />
          {t('newDashboard')}
        </Button>
      </form>
      {(boards.data?.items ?? []).length === 0 && !boards.isPending ? (
        <p className="text-sm text-muted-foreground">{t('noDashboards')}</p>
      ) : null}
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3">
        {(boards.data?.items ?? []).map((b) => (
          <li key={b.id}>
            <button
              type="button"
              className="w-full rounded-lg border bg-surface p-4 text-start font-medium hover:bg-muted"
              onClick={() => setOpen(b.id)}
            >
              {String(b['name'])}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
