/**
 * The document designer (RFC 0005 §5): templates are `report.template` records; the editor arranges blocks
 * (heading, text, fields, table, columns, divider, page break, signatures) by drag-and-drop (dnd-kit, keyboard too),
 * edits their bindings, and previews the real document (the server renders the unsaved layout for a sample record
 * as HTML; the PDF is the same HTML printed). Saving validates every binding on the server.
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
  ApiError,
  Button,
  Input,
  Label,
  Select,
  Spinner,
  Textarea,
  useKosh,
  type ViewProps,
} from '@kosh/ui';
import type { Block, Layout } from '@kosh/views';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GripVertical, Plus, Trash2 } from 'lucide-react';
import { type ReactElement, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

const KINDS = [
  'heading',
  'text',
  'field',
  'fields',
  'table',
  'columns',
  'divider',
  'pageBreak',
  'signature',
  'qr',
] as const;

function newBlock(kind: Block['kind'], n: number): Block {
  const id = `${kind}_${n}`;
  switch (kind) {
    case 'heading':
      return { kind, id, text: 'Title {{name}}' };
    case 'text':
      return { kind, id, text: '' };
    case 'field':
      return { kind, id, bind: 'name' };
    case 'fields':
      return { kind, id, items: [{ bind: 'name' }] };
    case 'table':
      return { kind, id, bind: '$records', columns: [{ bind: 'name' }] };
    case 'columns':
      return { kind, id, left: [], right: [] };
    case 'signature':
      return { kind, id, labels: ['Prepared by', 'Approved by'] };
    case 'qr':
      return { kind, id, bind: 'name' };
    default:
      return { kind, id } as Block;
  }
}

function BlockEditor({
  block,
  onChange,
}: {
  readonly block: Block;
  readonly onChange: (b: Block) => void;
}): ReactElement | null {
  const { t } = useTranslation('reporting');
  const id = useId();
  const text = (label: string, value: string, set: (v: string) => void, multi = false) => (
    <div className="grid gap-1">
      <Label htmlFor={`${id}-${label}`}>{label}</Label>
      {multi ? (
        <Textarea id={`${id}-${label}`} value={value} onChange={(e) => set(e.target.value)} />
      ) : (
        <Input id={`${id}-${label}`} value={value} onChange={(e) => set(e.target.value)} />
      )}
    </div>
  );
  switch (block.kind) {
    case 'heading':
      return (
        <div className="grid gap-2">
          {text(t('designer.text'), block.text, (v) => onChange({ ...block, text: v }))}
          <Select
            label="Level"
            value={String(block.level ?? 1)}
            options={['1', '2', '3'].map((l) => ({ value: l, label: `H${l}` }))}
            onChange={(v) => onChange({ ...block, level: Number(v) as 1 | 2 | 3 })}
          />
        </div>
      );
    case 'text':
      return text(t('designer.text'), block.text, (v) => onChange({ ...block, text: v }), true);
    case 'qr':
      return (
        <div className="grid gap-2">
          {text(t('designer.bind'), block.bind, (v) => onChange({ ...block, bind: v }))}
          {text(t('designer.label'), block.label ?? '', (v) =>
            onChange({ ...block, label: v === '' ? undefined : v } as Block),
          )}
        </div>
      );
    case 'field':
      return (
        <div className="grid gap-2">
          {text(t('designer.bind'), block.bind, (v) => onChange({ ...block, bind: v }))}
          {text(t('designer.label'), block.label ?? '', (v) =>
            onChange({ ...block, label: v === '' ? undefined : v } as Block),
          )}
        </div>
      );
    case 'fields':
      return (
        <div className="grid gap-2">
          {text(
            t('designer.bindings'),
            block.items
              .map((i) => (i.label === undefined ? i.bind : `${i.bind} as ${i.label}`))
              .join('\n'),
            (v) =>
              onChange({
                ...block,
                items: v
                  .split('\n')
                  .filter((l) => l.trim() !== '')
                  .map((l) => {
                    const [bind = '', label] = l.split(/\s+as\s+/);
                    return label === undefined
                      ? { bind: bind.trim() }
                      : { bind: bind.trim(), label: label.trim() };
                  }),
              }),
            true,
          )}
          <Select
            label={t('designer.columns')}
            value={String(block.columns ?? 2)}
            options={['2', '3'].map((c) => ({ value: c, label: c }))}
            onChange={(v) => onChange({ ...block, columns: Number(v) as 2 | 3 })}
          />
        </div>
      );
    case 'table':
      return (
        <div className="grid gap-2">
          {text(t('designer.tableBind'), block.bind, (v) => onChange({ ...block, bind: v }))}
          {text(
            t('designer.bindings'),
            block.columns
              .map(
                (c) =>
                  `${c.bind}${c.label === undefined ? '' : ` as ${c.label}`}${c.sum === true ? ' sum' : ''}`,
              )
              .join('\n'),
            (v) =>
              onChange({
                ...block,
                columns: v
                  .split('\n')
                  .filter((l) => l.trim() !== '')
                  .map((l) => {
                    const sum = /\ssum$/.test(l.trim());
                    const [bind = '', label] = l.replace(/\ssum$/, '').split(/\s+as\s+/);
                    return {
                      bind: bind.trim(),
                      ...(label === undefined ? {} : { label: label.trim() }),
                      ...(sum ? { sum: true } : {}),
                    };
                  }),
              }),
            true,
          )}
        </div>
      );
    case 'signature':
      return text(
        t('designer.labels'),
        block.labels.join('\n'),
        (v) => onChange({ ...block, labels: v.split('\n').filter((l) => l.trim() !== '') }),
        true,
      );
    default:
      return null;
  }
}

function BlockCard({
  block,
  selected,
  onSelect,
  onRemove,
}: {
  readonly block: Block;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly onRemove: () => void;
}): ReactElement {
  const { t } = useTranslation('reporting');
  const drag = useDraggable({ id: block.id });
  const drop = useDroppable({ id: block.id });
  const summary =
    block.kind === 'heading' || block.kind === 'text'
      ? block.text
      : block.kind === 'field'
        ? block.bind
        : block.kind === 'fields'
          ? block.items.map((i) => i.bind).join(', ')
          : block.kind === 'table'
            ? `${block.bind}: ${block.columns.map((c) => c.bind).join(', ')}`
            : '';
  return (
    <li
      ref={(n) => {
        drag.setNodeRef(n);
        drop.setNodeRef(n);
      }}
      className={`flex items-center gap-2 rounded-md border bg-surface px-2 py-1.5 text-sm ${selected ? 'ring-2 ring-ring' : ''} ${drop.isOver ? 'border-primary' : ''}`}
      style={
        drag.transform === null
          ? undefined
          : { transform: `translate3d(${drag.transform.x}px, ${drag.transform.y}px, 0)` }
      }
    >
      <button
        type="button"
        className="cursor-grab rounded p-0.5 hover:bg-muted"
        aria-label={`Move ${block.kind} ${block.id}`}
        {...drag.attributes}
        {...drag.listeners}
      >
        <GripVertical className="size-4" aria-hidden />
      </button>
      <button
        type="button"
        className="flex-1 truncate text-start"
        aria-pressed={selected}
        onClick={onSelect}
      >
        <span className="font-medium">{t(`designer.kinds.${block.kind}`)}</span>
        {summary === '' ? null : <span className="ms-2 text-muted-foreground">{summary}</span>}
      </button>
      <Button
        size="icon"
        variant="ghost"
        aria-label={`${t('remove')} ${block.id}`}
        onClick={onRemove}
      >
        <Trash2 aria-hidden />
      </Button>
    </li>
  );
}

function Editor({
  id,
  onBack,
}: {
  readonly id: number;
  readonly onBack: () => void;
}): ReactElement {
  const { api } = useKosh();
  const { t } = useTranslation('reporting');
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Layout | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [sample, setSample] = useState<number | null>(null);
  const [preview, setPreview] = useState<string>('');
  const [previewError, setPreviewError] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor),
  );
  const record = useQuery({
    queryKey: ['record', 'report.template', id],
    queryFn: () => api.get('report.template', id, ['name', 'targetModel', 'layout', 'scope']),
  });
  const model = record.data === undefined ? undefined : String(record.data.record['targetModel']);
  const samples = useQuery({
    queryKey: ['names', model, 'sample'],
    queryFn: () => api.list(model as string, { fields: ['displayName'], limit: 20 }),
    enabled: model !== undefined,
  });
  const layout: Layout = draft ??
    (record.data?.record['layout'] as Layout | undefined) ?? { blocks: [] };
  const sampleId = sample ?? samples.data?.items[0]?.id ?? null;

  useEffect(() => {
    if (model === undefined || (sampleId === null && record.data?.record['scope'] !== 'list'))
      return;
    let alive = true;
    const timer = setTimeout(() => {
      void api
        .download(`/api/v1/models/${model}/documents/${id}?format=html`, {
          ids: sampleId === null ? [] : [sampleId],
          layout,
        })
        .then(async ({ blob }) => {
          if (!alive) return;
          setPreview(await blob.text());
          setPreviewError(null);
        })
        .catch(
          (e: unknown) => alive && setPreviewError(e instanceof ApiError ? e.message : String(e)),
        );
    }, 400);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [api, model, id, sampleId, layout, record.data]);

  const save = useMutation({
    mutationFn: () => api.update('report.template', id, { layout }, record.data?.etag ?? null),
    onSuccess: async () => {
      setDraft(null);
      await queryClient.invalidateQueries({ queryKey: ['record', 'report.template', id] });
    },
  });
  if (record.isError) return <Alert>{record.error.message}</Alert>;
  if (record.data === undefined) return <Spinner label="…" />;
  const blocks = layout.blocks;
  const update = (next: readonly Block[]) => setDraft({ ...layout, blocks: next });
  const current = blocks.find((b) => b.id === selected);
  const onDragEnd = (e: DragEndEvent) => {
    if (e.over === null || e.over.id === e.active.id) return;
    const from = blocks.findIndex((b) => b.id === e.active.id);
    const to = blocks.findIndex((b) => b.id === e.over?.id);
    if (from < 0 || to < 0) return;
    const next = [...blocks];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved as Block);
    update(next);
  };

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" onClick={onBack}>
          ←
        </Button>
        <h2 className="text-base font-semibold">{String(record.data.record['name'])}</h2>
        <span className="text-sm text-muted-foreground">{model}</span>
        <div className="ms-auto flex items-center gap-2">
          {samples.data !== undefined && samples.data.items.length > 0 ? (
            <Select
              label={t('designer.sample')}
              className="w-56"
              value={sampleId === null ? null : String(sampleId)}
              options={samples.data.items.map((r) => ({
                value: String(r.id),
                label: String(r['displayName'] ?? r.id),
              }))}
              onChange={(v) => setSample(Number(v))}
            />
          ) : null}
          <Button
            size="sm"
            variant="primary"
            disabled={draft === null}
            busy={save.isPending}
            onClick={() => save.mutate()}
          >
            {t('save')}
          </Button>
        </div>
      </div>
      {save.error === null ? null : <Alert>{save.error.message}</Alert>}
      <div className="grid gap-3 lg:grid-cols-[22rem_1fr]">
        <div className="grid content-start gap-3">
          <div className="flex flex-wrap gap-1">
            {KINDS.map((kind) => (
              <Button
                key={kind}
                size="sm"
                variant="ghost"
                onClick={() => update([...blocks, newBlock(kind, blocks.length + 1)])}
              >
                <Plus aria-hidden />
                {t(`designer.kinds.${kind}`)}
              </Button>
            ))}
          </div>
          <DndContext sensors={sensors} onDragEnd={onDragEnd}>
            <ul aria-label={t('designer.blocks')} className="grid gap-1">
              {blocks.map((b) => (
                <BlockCard
                  key={b.id}
                  block={b}
                  selected={b.id === selected}
                  onSelect={() => setSelected(b.id)}
                  onRemove={() => update(blocks.filter((x) => x.id !== b.id))}
                />
              ))}
            </ul>
          </DndContext>
          {current === undefined ? null : (
            <div className="rounded-md border bg-surface p-3">
              <BlockEditor
                block={current}
                onChange={(b) => update(blocks.map((x) => (x.id === b.id ? b : x)))}
              />
            </div>
          )}
          <div className="grid gap-2 rounded-md border bg-surface p-3">
            <Label htmlFor="layout-header">{t('designer.header')}</Label>
            <Input
              id="layout-header"
              value={layout.header ?? ''}
              onChange={(e) =>
                setDraft({ ...layout, header: e.target.value || undefined } as Layout)
              }
            />
            <Label htmlFor="layout-footer">{t('designer.footer')}</Label>
            <Input
              id="layout-footer"
              value={layout.footer ?? ''}
              onChange={(e) =>
                setDraft({ ...layout, footer: e.target.value || undefined } as Layout)
              }
            />
            <Select
              label={t('designer.orientation')}
              value={layout.orientation ?? 'portrait'}
              options={[
                { value: 'portrait', label: t('designer.portrait') },
                { value: 'landscape', label: t('designer.landscape') },
              ]}
              onChange={(v) => setDraft({ ...layout, orientation: v as 'portrait' | 'landscape' })}
            />
          </div>
        </div>
        <div className="grid gap-2">
          {previewError === null ? null : <Alert>{previewError}</Alert>}
          <iframe
            title={t('designer.preview')}
            srcDoc={preview}
            className="h-[70vh] w-full rounded-lg border bg-white"
            sandbox=""
          />
        </div>
      </div>
    </div>
  );
}

export function DesignerView(_props: ViewProps): ReactElement {
  const { api } = useKosh();
  const { t } = useTranslation('reporting');
  const queryClient = useQueryClient();
  const [open, setOpen] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [model, setModel] = useState('');
  const templates = useQuery({
    queryKey: ['list', 'report.template'],
    queryFn: () =>
      api.list('report.template', {
        fields: ['name', 'targetModel', 'scope', 'key'],
        order: ['targetModel asc', 'name asc'],
      }),
  });
  const create = useMutation({
    mutationFn: () =>
      api.create('report.template', {
        name,
        targetModel: model,
        layout: { blocks: [{ kind: 'heading', id: 'title', text: '{{displayName}}' }] },
      }),
    onSuccess: async (r) => {
      setName('');
      await queryClient.invalidateQueries({ queryKey: ['list', 'report.template'] });
      setOpen(r.record.id);
    },
  });
  if (open !== null) return <Editor id={open} onBack={() => setOpen(null)} />;
  return (
    <div className="grid gap-3">
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() !== '' && model.trim() !== '') create.mutate();
        }}
      >
        <Input
          aria-label={t('name')}
          placeholder={t('name')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="max-w-xs"
        />
        <Input
          aria-label={t('model')}
          placeholder="purchase.order"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="max-w-xs"
        />
        <Button type="submit" size="sm" variant="primary" busy={create.isPending}>
          <Plus aria-hidden />
          {t('designer.new')}
        </Button>
      </form>
      {create.error === null ? null : <Alert>{create.error.message}</Alert>}
      <ul className="grid gap-1">
        {(templates.data?.items ?? []).map((tpl) => (
          <li key={tpl.id} className="flex items-center gap-3 text-sm">
            <Button variant="link" onClick={() => setOpen(tpl.id)}>
              {String(tpl['name'])}
            </Button>
            <span className="text-muted-foreground">{String(tpl['targetModel'])}</span>
            {tpl['key'] === null ? null : (
              <span className="rounded bg-muted px-1.5 text-xs">{String(tpl['key'])}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
