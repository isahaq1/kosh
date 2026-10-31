/**
 * Default field widgets (RFC 0007 §5): one per field kind, plus named ones (`badge`, `money`). Each renders the
 * value read-only (lists, cards, read-only forms) or as a control when `onChange` is given. Exact decimals stay
 * strings end to end; many2one values are ids whose names come from the name-search endpoint.
 */
import { useQueries, useQuery } from '@tanstack/react-query';
import { Popover } from 'radix-ui';
import {
  type Context,
  createContext,
  type ReactElement,
  useContext,
  useId,
  useMemo,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Avatar } from '../components/Avatar.js';
import { Badge, Button, Checkbox, Input, Select, Textarea } from '../components/primitives.js';
import { useKosh } from '../context.js';
import { cn } from '../lib/cn.js';
import type { Registry, WidgetProps } from '../registry.js';
import { DateField } from './DateField.js';

const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

function CharWidget({ id, value, readonly, onChange, field, invalid }: WidgetProps): ReactElement {
  if (onChange === undefined || readonly) return <span>{text(value)}</span>;
  return (
    <Input
      id={id}
      value={text(value)}
      required={field.required}
      aria-invalid={invalid === true ? true : undefined}
      onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
    />
  );
}

function TextWidget({ id, value, readonly, onChange, invalid }: WidgetProps): ReactElement {
  if (onChange === undefined || readonly)
    return <span className="whitespace-pre-wrap">{text(value)}</span>;
  return (
    <Textarea
      id={id}
      value={text(value)}
      aria-invalid={invalid === true ? true : undefined}
      onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
    />
  );
}

function IntegerWidget({ id, value, readonly, onChange, invalid }: WidgetProps): ReactElement {
  const { format } = useKosh();
  if (onChange === undefined || readonly)
    return (
      <span className="tabular-nums">
        {format.number(typeof value === 'number' ? value : null)}
      </span>
    );
  return (
    <Input
      id={id}
      inputMode="numeric"
      value={text(value)}
      aria-invalid={invalid === true ? true : undefined}
      onChange={(e) => {
        const raw = e.target.value.trim();
        if (raw === '') onChange(null);
        else if (/^-?\d+$/.test(raw)) onChange(Number(raw));
      }}
    />
  );
}

/** Decimal and monetary amounts as exact strings (`'750000.00'`), formatted for the locale. */
function DecimalWidget({ id, value, readonly, onChange, invalid }: WidgetProps): ReactElement {
  const { format } = useKosh();
  const amount =
    typeof value === 'object' && value !== null && 'amount' in value
      ? String((value as { amount: unknown }).amount)
      : text(value);
  if (onChange === undefined || readonly)
    return <span className="tabular-nums">{format.decimal(amount)}</span>;
  return (
    <Input
      id={id}
      inputMode="decimal"
      className="text-end tabular-nums"
      value={amount}
      aria-invalid={invalid === true ? true : undefined}
      onChange={(e) => {
        const raw = e.target.value.trim().replace(',', '.');
        if (raw === '') onChange(null);
        else if (/^-?\d*(\.\d*)?$/.test(raw)) onChange(raw);
      }}
    />
  );
}

function BooleanWidget({ id, value, readonly, onChange, field }: WidgetProps): ReactElement {
  const { t } = useTranslation();
  if (onChange === undefined) return <span>{value === true ? t('views.yes') : t('views.no')}</span>;
  return (
    <Checkbox
      id={id}
      checked={value === true}
      disabled={readonly}
      aria-label={field.label}
      onCheckedChange={(c) => onChange(c === true)}
    />
  );
}

function DateWidget({ id, value, readonly, onChange, field, invalid }: WidgetProps): ReactElement {
  const { format } = useKosh();
  if (onChange === undefined || readonly)
    return <span>{format.date(value === null || value === undefined ? null : String(value))}</span>;
  return (
    <DateField
      id={id}
      value={
        value === null || value === undefined || value === '' ? null : text(value).slice(0, 10)
      }
      onChange={onChange}
      required={field.required}
      {...(invalid === undefined ? {} : { invalid })}
    />
  );
}

function DatetimeWidget({ id, value, readonly, onChange }: WidgetProps): ReactElement {
  const { format } = useKosh();
  if (onChange === undefined || readonly)
    return (
      <span>{format.datetime(value === null || value === undefined ? null : String(value))}</span>
    );
  const local = value === null || value === undefined ? '' : toLocalInput(new Date(String(value)));
  return (
    <Input
      id={id}
      type="datetime-local"
      value={local}
      onChange={(e) =>
        onChange(e.target.value === '' ? null : new Date(e.target.value).toISOString())
      }
    />
  );
}

function toLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function SelectionWidget({ id, value, readonly, onChange, field }: WidgetProps): ReactElement {
  const options = field.options ?? [];
  const label = options.find((o) => o.value === value)?.label ?? text(value);
  if (onChange === undefined || readonly || field.kind === 'state') return <span>{label}</span>;
  return (
    <Select
      id={id}
      label={field.label}
      value={value === null || value === undefined ? null : String(value)}
      options={options}
      onChange={onChange}
    />
  );
}

type Tone = 'info' | 'success' | 'danger' | 'warning' | 'neutral';
/** What a state's value means, by the words ERP states use (`posted`, `to_approve`, `cancel`…). */
const MEANINGS: readonly (readonly [RegExp, Tone])[] = [
  [
    /(^|_)(cancel|cancelled|canceled|failed|refused|rejected|lost|blocked|overdue|error|bounced)($|_)/,
    'danger',
  ],
  [
    /(^|_)(to|not|partial|partially|pending|waiting|wait|hold|review|approve|quarantine)($|_)/,
    'warning',
  ],
  [
    /(^|_)(done|paid|posted|sale|confirmed|approved|won|delivered|validated|completed|complete|reconciled|invoiced|handled|active|accepted|signed|locked)($|_)/,
    'success',
  ],
  [/(^|_)(sent|open|progress|received|in|scheduled|running|purchase|ordered)($|_)/, 'info'],
];
export function toneOf(value: string): Tone {
  const v = value.toLowerCase();
  return MEANINGS.find(([pattern]) => pattern.test(v))?.[1] ?? 'neutral';
}

function BadgeWidget({ value, field }: WidgetProps): ReactElement | null {
  if (value === null || value === undefined || value === '') return null;
  const label = (field.options ?? []).find((o) => o.value === value)?.label ?? text(value);
  return <Badge tone={toneOf(text(value))}>{label}</Badge>;
}

/** Display names a list or kanban loaded in one batch per model, so cells do not query one by one. */
export const PrefetchedNames: Context<ReadonlyMap<string, ReadonlyMap<number, string>>> =
  createContext<ReadonlyMap<string, ReadonlyMap<number, string>>>(new Map());

/** Display names of ids: from {@link PrefetchedNames}, else batched through the name-search endpoint (cached). */
export function useDisplayNames(
  model: string | undefined,
  ids: readonly number[],
): ReadonlyMap<number, string> {
  const { api } = useKosh();
  const prefetched = useContext(PrefetchedNames).get(model ?? '');
  const key = [...new Set(ids)].sort((a, b) => a - b);
  const missing = key.filter((id) => prefetched?.has(id) !== true);
  const query = useQuery({
    queryKey: ['names', model, missing],
    queryFn: () => api.names(model as string, { ids: missing }),
    enabled: model !== undefined && missing.length > 0,
    staleTime: 60_000,
  });
  return useMemo(
    () =>
      new Map([
        ...(prefetched ?? []),
        ...(query.data ?? []).map((r) => [r.id, r.displayName] as const),
      ]),
    [prefetched, query.data],
  );
}

/** Loads the display names of the many2one / many2many values of `rows` for `fields`, one request per model. */
export function useRowNames(
  rows: readonly Readonly<Record<string, unknown>>[],
  fields: readonly { readonly key: string; readonly kind: string; readonly target?: string }[],
): ReadonlyMap<string, ReadonlyMap<number, string>> {
  const { api } = useKosh();
  const byModel = new Map<string, Set<number>>();
  for (const f of fields) {
    if ((f.kind !== 'many2one' && f.kind !== 'many2many') || f.target === undefined) continue;
    const set = byModel.get(f.target) ?? new Set<number>();
    for (const row of rows) {
      const v = row[f.key];
      for (const id of Array.isArray(v) ? v : [v]) {
        const n = idOf(id);
        if (n !== null) set.add(n);
      }
    }
    byModel.set(f.target, set);
  }
  const entries = [...byModel].map(
    ([model, ids]) => [model, [...ids].sort((a, b) => a - b)] as const,
  );
  const queries = useQueries({
    queries: entries.map(([model, ids]) => ({
      queryKey: ['names', model, ids],
      queryFn: () => api.names(model, { ids }),
      enabled: ids.length > 0,
      staleTime: 60_000,
    })),
  });
  const data = queries.map((q) => q.data);
  // biome-ignore lint/correctness/useExhaustiveDependencies: recomputed when any batch arrives
  return useMemo(
    () =>
      new Map(
        entries.map(([model], i) => [
          model,
          new Map((data[i] ?? []).map((r) => [r.id, r.displayName] as const)),
        ]),
      ),
    [JSON.stringify(entries), ...data],
  );
}

function idOf(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'object' && value !== null && 'id' in value)
    return Number((value as { id: unknown }).id);
  return null;
}

/** A searchable picker for one related record (combobox pattern: input + listbox). */
function Many2oneWidget({
  id,
  value,
  readonly,
  onChange,
  field,
  invalid,
}: WidgetProps): ReactElement {
  const { api } = useKosh();
  const { t } = useTranslation();
  const current = idOf(value);
  const names = useDisplayNames(field.target, current === null ? [] : [current]);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const listId = useId();
  const results = useQuery({
    queryKey: ['name-search', field.target, q],
    queryFn: () => api.names(field.target as string, { q, limit: 8 }),
    enabled: open && field.target !== undefined,
  });
  const label = current === null ? '' : (names.get(current) ?? `#${current}`);
  if (onChange === undefined || readonly) return <span>{label}</span>;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          id={id}
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-invalid={invalid === true ? true : undefined}
          className="flex h-[var(--control-h)] w-full items-center justify-between rounded-md border border-input bg-surface px-3 text-start text-sm aria-invalid:border-danger"
        >
          <span className={cn(current === null && 'text-muted-foreground')}>
            {current === null ? t('views.choose') : label}
          </span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          className="z-50 w-[var(--radix-popover-trigger-width)] rounded-md border bg-surface p-1 shadow-lg"
        >
          <Input
            autoFocus
            aria-label={field.label}
            placeholder={t('search.placeholder')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <div
            id={listId}
            role="listbox"
            aria-label={field.label}
            className="mt-1 max-h-60 overflow-auto"
          >
            {field.required ? null : (
              <button
                type="button"
                role="option"
                aria-selected={current === null}
                className="w-full rounded-sm px-2 py-1.5 text-start text-sm text-muted-foreground hover:bg-muted"
                onClick={() => {
                  onChange(null);
                  setOpen(false);
                }}
              >
                {t('views.none')}
              </button>
            )}
            {(results.data ?? []).map((r) => (
              <button
                key={r.id}
                type="button"
                role="option"
                aria-selected={r.id === current}
                className="w-full rounded-sm px-2 py-1.5 text-start text-sm hover:bg-muted"
                onClick={() => {
                  onChange(r.id);
                  setOpen(false);
                }}
              >
                {r.displayName}
              </button>
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Tags of related records; editing replaces the set (`{ set: ids }`). */
function Many2manyWidget({ value, readonly, onChange, field, id }: WidgetProps): ReactElement {
  const ids = Array.isArray(value)
    ? (value as unknown[]).map(idOf).filter((v): v is number => v !== null)
    : [];
  const names = useDisplayNames(field.target, ids);
  const [adding, setAdding] = useState<unknown>(null);
  return (
    <div className="flex flex-wrap items-center gap-1">
      {ids.map((i) => (
        <Badge key={i} tone="info">
          {names.get(i) ?? `#${i}`}
          {onChange === undefined || readonly ? null : (
            <button
              type="button"
              aria-label={`Remove ${names.get(i) ?? i}`}
              className="ms-1"
              onClick={() => onChange(ids.filter((x) => x !== i))}
            >
              ×
            </button>
          )}
        </Badge>
      ))}
      {onChange === undefined || readonly ? null : (
        <div className="min-w-40">
          <Many2oneWidget
            id={id}
            node={{ kind: 'field', id, field: field.key }}
            field={{ ...field, required: false }}
            value={adding}
            record={{}}
            readonly={false}
            onChange={(v) => {
              const next = idOf(v);
              if (next !== null && !ids.includes(next)) onChange([...ids, next]);
              setAdding(null);
            }}
          />
        </div>
      )}
    </div>
  );
}

function One2manyWidget({ value }: WidgetProps): ReactElement {
  const count = Array.isArray(value) ? value.length : 0;
  return <span className="text-muted-foreground">{count}</span>;
}

/** JSON values (settings, queries, layouts): pretty-printed; edited as text, applied once it parses. */
function JsonWidget({ id, value, readonly, onChange, invalid }: WidgetProps): ReactElement {
  const pretty = value === null || value === undefined ? '' : JSON.stringify(value, null, 2);
  const [text, setText] = useState(pretty);
  const [broken, setBroken] = useState(false);
  // A new record or a reload replaces the draft; the user's own edits do not.
  const [seen, setSeen] = useState(pretty);
  if (pretty !== seen) {
    setSeen(pretty);
    setText(pretty);
    setBroken(false);
  }
  if (onChange === undefined || readonly)
    return <pre className="whitespace-pre-wrap font-mono text-xs">{pretty}</pre>;
  return (
    <Textarea
      id={id}
      className="font-mono text-xs"
      value={text}
      aria-invalid={broken || invalid === true ? true : undefined}
      onChange={(e) => {
        const next = e.target.value;
        setText(next);
        if (next.trim() === '') {
          setBroken(false);
          onChange(null);
          return;
        }
        try {
          onChange(JSON.parse(next));
          setBroken(false);
        } catch {
          setBroken(true);
        }
      }}
    />
  );
}

/** Registers the default widgets. */

// ---- Richer widgets (RFC 0022 §3.3) ------------------------------------------------------------------------

const idOfValue = (v: unknown): number | null =>
  typeof v === 'number'
    ? v
    : typeof v === 'object' && v !== null && 'id' in v
      ? Number((v as { id: unknown }).id)
      : null;

/** A link in display, the text input otherwise: `mailto:`, `tel:` or the address itself. */
function linkWidget(kind: 'email' | 'phone' | 'url') {
  return function LinkWidget(props: WidgetProps): ReactElement {
    const value = text(props.value);
    if (props.onChange !== undefined && !props.readonly) return <CharWidget {...props} />;
    if (value === '') return <span />;
    const href =
      kind === 'email'
        ? `mailto:${value}`
        : kind === 'phone'
          ? `tel:${value.replace(/[^\d+]/g, '')}`
          : /^https?:\/\//i.test(value)
            ? value
            : `https://${value}`;
    return (
      <a
        href={href}
        className="text-primary underline-offset-2 hover:underline"
        {...(kind === 'url' ? { target: '_blank', rel: 'noreferrer' } : {})}
        onClick={(e) => e.stopPropagation()}
      >
        {kind === 'url' ? value.replace(/^https?:\/\//i, '') : value}
      </a>
    );
  };
}

/** 0–100 as a bar with the number; the integer input to edit. */
function ProgressWidget(props: WidgetProps): ReactElement {
  const { format } = useKosh();
  if (props.onChange !== undefined && !props.readonly) return <IntegerWidget {...props} />;
  const n = typeof props.value === 'number' ? Math.max(0, Math.min(100, props.value)) : null;
  if (n === null) return <span />;
  return (
    <span className="inline-flex w-full max-w-40 items-center gap-2">
      <span
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={n}
        aria-label={props.field.label}
        className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
      >
        <span className="block h-full rounded-full bg-primary" style={{ width: `${n}%` }} />
      </span>
      <span className="tabular-nums text-xs text-muted-foreground">{format.number(n)}%</span>
    </span>
  );
}

/** A number as a percentage. */
function PercentageWidget(props: WidgetProps): ReactElement {
  const { format } = useKosh();
  if (props.onChange !== undefined && !props.readonly) return <DecimalWidget {...props} />;
  const v =
    typeof props.value === 'number'
      ? props.value
      : typeof props.value === 'string' && props.value !== ''
        ? Number(props.value)
        : null;
  return (
    <span className="tabular-nums">
      {v === null || Number.isNaN(v) ? '' : `${format.number(v)}%`}
    </span>
  );
}

/** Stars in a row: read-only as one image, editable as radios (a visually hidden input under each star). */
function Stars({
  label,
  options,
  selected,
  editable,
  onPick,
}: {
  readonly label: string;
  readonly options: readonly { readonly key: string; readonly label: string }[];
  readonly selected: number;
  readonly editable: boolean;
  readonly onPick: (index: number) => void;
}): ReactElement {
  const group = useId();
  if (!editable)
    return (
      <span role="img" aria-label={label} className="inline-flex gap-0.5 text-warning-text">
        {options.map((o, i) => (
          <span key={o.key} aria-hidden>
            {i <= selected ? '★' : '☆'}
          </span>
        ))}
      </span>
    );
  return (
    <fieldset className="inline-flex gap-0.5 text-warning-text">
      <legend className="sr-only">{label}</legend>
      {options.map((o, i) => (
        <label key={o.key} className="cursor-pointer leading-none" title={o.label}>
          <input
            type="radio"
            name={group}
            className="sr-only"
            checked={i === selected}
            onChange={() => onPick(i)}
          />
          <span aria-hidden>{i <= selected ? '★' : '☆'}</span>
          <span className="sr-only">{o.label}</span>
        </label>
      ))}
    </fieldset>
  );
}

/** Stars out of five for a 0–5 number; click a star to set it. */
function RatingWidget({ value, readonly, onChange, field }: WidgetProps): ReactElement {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : 0;
  const rounded = Number.isNaN(n) ? 0 : Math.round(n);
  return (
    <Stars
      label={`${field.label}: ${Number.isNaN(n) ? 0 : n} / 5`}
      options={[1, 2, 3, 4, 5].map((s) => ({ key: String(s), label: `${s} / 5` }))}
      selected={rounded - 1}
      editable={onChange !== undefined && !readonly}
      onPick={(i) => onChange?.(i + 1)}
    />
  );
}

/** A selection shown as stars (its options in order: the first is one star); click to set it. */
function PriorityWidget({ value, readonly, onChange, field }: WidgetProps): ReactElement {
  const options = field.options ?? [];
  const index = options.findIndex((o) => o.value === value);
  return (
    <Stars
      label={`${field.label}: ${options[index]?.label ?? ''}`}
      options={options.map((o) => ({ key: o.value, label: o.label }))}
      selected={index}
      editable={onChange !== undefined && !readonly}
      onPick={(i) => onChange?.(options[i]?.value ?? null)}
    />
  );
}

/** A stable tint for a value (a stage, a tag): a hue from its text. */
export const tintOf = (key: string): string => {
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `oklch(0.7 0.14 ${h})`;
};

/** A selection or text as a coloured dot with its label; the select to edit. */
function ColorWidget(props: WidgetProps): ReactElement {
  if (props.onChange !== undefined && !props.readonly)
    return props.field.kind === 'selection' ? (
      <SelectionWidget {...props} />
    ) : (
      <CharWidget {...props} />
    );
  const value = text(props.value);
  if (value === '') return <span />;
  const label = (props.field.options ?? []).find((o) => o.value === value)?.label ?? value;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className="size-2.5 rounded-full" style={{ background: tintOf(value) }} />
      {label}
    </span>
  );
}

/** A date as "in 3 days" / "2 days late", toned; the date field to edit. */
function DaysLeftWidget(props: WidgetProps): ReactElement {
  const { t } = useTranslation();
  const { format } = useKosh();
  if (props.onChange !== undefined && !props.readonly) return <DateWidget {...props} />;
  const value = text(props.value);
  if (value === '') return <span />;
  const day = new Date(`${value.slice(0, 10)}T00:00:00Z`).getTime();
  const today = new Date();
  const now = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const days = Math.round((day - now) / 86_400_000);
  const label =
    days === 0
      ? t('views.daysLeft.today')
      : days > 0
        ? t('views.daysLeft.in', { count: days })
        : t('views.daysLeft.late', { count: -days });
  return (
    <span
      title={format.date(value)}
      className={cn(
        'tabular-nums',
        days < 0 ? 'text-danger' : days <= 3 ? 'text-warning-text' : 'text-muted-foreground',
      )}
    >
      {label}
    </span>
  );
}

/** Many2many chips tinted by their name; the picker to edit. */
function TagsWidget(props: WidgetProps): ReactElement {
  const ids = Array.isArray(props.value)
    ? (props.value as unknown[]).map(idOf).filter((v): v is number => v !== null)
    : [];
  const names = useDisplayNames(props.field.target, ids);
  if (props.onChange !== undefined && !props.readonly) return <Many2manyWidget {...props} />;
  return (
    <span className="flex flex-wrap gap-1">
      {ids.map((i) => {
        const name = names.get(i) ?? `#${i}`;
        return (
          <span
            key={i}
            className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs"
          >
            <span
              aria-hidden
              className="size-2 rounded-full"
              style={{ background: tintOf(name) }}
            />
            {name}
          </span>
        );
      })}
    </span>
  );
}

/** Draws `file` at most `max` pixels wide or high, as a WebP blob. */
async function shrinkTo(file: Blob, max: number): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('No canvas');
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b === null ? reject(new Error('No image')) : resolve(b)),
      'image/webp',
      0.86,
    ),
  );
}

/**
 * An image kept as an attachment of the record (RFC 0022 §3.3): shown from its 256 px thumbnail, uploaded from a
 * file the browser first shrinks (at most 1600 px, and the thumbnail), both attached to the record; the field then
 * holds the image. A new record has to be saved first (its attachments need it).
 */
function imageWidget(shape: 'image' | 'avatar') {
  return function ImageWidget({
    value,
    readonly,
    onChange,
    field,
    record,
    model,
  }: WidgetProps): ReactElement {
    const { api } = useKosh();
    const { t } = useTranslation();
    const inputId = useId();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const id = idOfValue(value);
    const recordId = typeof record['id'] === 'number' ? record['id'] : null;
    const src = id === null ? null : `/api/v1/attachments/${id}/download?inline=true&w=256`;
    const name = String(record['displayName'] ?? record['name'] ?? '');
    const editable = onChange !== undefined && !readonly;
    const pick = async (file: File): Promise<void> => {
      if (model === undefined || recordId === null) return setError(t('views.image.saveFirst'));
      setBusy(true);
      setError(null);
      try {
        const [full, thumb] = await Promise.all([shrinkTo(file, 1600), shrinkTo(file, 256)]);
        const path = `/api/v1/attachments/${model}/${recordId}`;
        const stem = file.name.replace(/\.[^.]+$/, '') || field.label;
        const made = await api.upload<{ id: number }>(path, full, `${stem}.webp`);
        await api.upload(path, thumb, `${stem}-256.webp`, {
          'x-variant-of': String(made.id),
          'x-width': '256',
        });
        onChange?.(made.id);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    };
    const picture =
      shape === 'avatar' ? (
        <Avatar name={name} src={src} shape="circle" />
      ) : src === null ? (
        <span className="grid size-24 place-items-center rounded-md border border-dashed text-xs text-muted-foreground">
          {t('views.image.none')}
        </span>
      ) : (
        <img src={src} alt={name} className="size-24 rounded-md border object-cover" />
      );
    if (!editable) return picture;
    return (
      <span className="inline-flex items-center gap-3">
        {picture}
        <span className="grid gap-1">
          <input
            id={inputId}
            type="file"
            accept="image/*"
            className="sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file !== undefined) void pick(file);
              e.target.value = '';
            }}
          />
          <Button asChild size="sm" variant="secondary" busy={busy}>
            <label htmlFor={inputId}>{t('views.image.choose')}</label>
          </Button>
          {id === null ? null : (
            <Button type="button" size="sm" variant="ghost" onClick={() => onChange?.(null)}>
              {t('views.image.remove')}
            </Button>
          )}
          {error === null ? null : (
            <span role="alert" className="text-xs text-danger">
              {error}
            </span>
          )}
        </span>
      </span>
    );
  };
}

export function registerDefaultWidgets(registry: Registry): Registry {
  for (const [name, widget] of [
    ['char', CharWidget],
    ['text', TextWidget],
    ['html', TextWidget],
    ['integer', IntegerWidget],
    ['bigint', IntegerWidget],
    ['float', DecimalWidget],
    ['decimal', DecimalWidget],
    ['monetary', DecimalWidget],
    ['money', DecimalWidget],
    ['quantity', DecimalWidget],
    ['boolean', BooleanWidget],
    ['date', DateWidget],
    ['datetime', DatetimeWidget],
    ['selection', SelectionWidget],
    ['state', SelectionWidget],
    ['badge', BadgeWidget],
    ['json', JsonWidget],
    ['many2one', Many2oneWidget],
    ['many2many', Many2manyWidget],
    ['one2many', One2manyWidget],
    ['email', linkWidget('email')],
    ['phone', linkWidget('phone')],
    ['url', linkWidget('url')],
    ['progress', ProgressWidget],
    ['percentage', PercentageWidget],
    ['rating', RatingWidget],
    ['priority', PriorityWidget],
    ['color', ColorWidget],
    ['daysLeft', DaysLeftWidget],
    ['tags', TagsWidget],
    ['image', imageWidget('image')],
    ['avatar', imageWidget('avatar')],
  ] as const)
    registry.registerWidget(name, widget);
  return registry;
}
