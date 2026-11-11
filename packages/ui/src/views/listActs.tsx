/**
 * Lists that act (RFC 0033 §3.4): filter by a cell's value, set a field for every selected row, and add a record
 * from a row at the foot of the list. Each goes through the existing, permission-checked routes — the server
 * decides; these only save clicks.
 */
import type { Condition, FieldNode } from '@kosh/views';
import { Filter } from 'lucide-react';
import { type ReactElement, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { KoshApi, Row, ViewField } from '../api.js';
import { ApiError } from '../api.js';
import { Alert, Button, Dialog, Label } from '../components/primitives.js';
import { useKosh } from '../context.js';

/** The kinds a cell can be filtered by: one clear value each. */
const FILTERABLE = new Set(['many2one', 'selection', 'state', 'boolean']);
/** The kinds a field can be set to for many rows at once, or typed into a quick-add row. */
const SETTABLE = new Set([
  'char',
  'text',
  'integer',
  'decimal',
  'boolean',
  'date',
  'selection',
  'many2one',
]);

const scalar = (value: unknown): unknown =>
  typeof value === 'object' && value !== null && 'id' in value
    ? (value as { id: unknown }).id
    : value;

/** "Only this value": a small button beside a cell that narrows the list to the rows sharing its value. */
export function FilterByCell({
  field,
  value,
  onFilter,
}: {
  readonly field: ViewField;
  readonly value: unknown;
  readonly onFilter: (domain: Condition, label?: string) => void;
}): ReactElement | null {
  const { t } = useTranslation();
  if (!FILTERABLE.has(field.kind) || value === null || value === undefined || value === '')
    return null;
  const label = t('views.filterByThis', { field: field.label });
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-kosh-filter-cell
      tabIndex={-1}
      className="ms-1 inline-flex rounded p-0.5 text-muted-foreground opacity-0 transition-opacity duration-[var(--motion-fast)] hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover/cell:opacity-100"
      onClick={(e) => {
        e.stopPropagation();
        onFilter({ [field.key]: scalar(value) } as Condition, field.label);
      }}
    >
      <Filter className="size-3" aria-hidden />
    </button>
  );
}

/** The fields of `nodes` a user may set by hand. */
export function settable(
  nodes: readonly FieldNode[],
  fields: Readonly<Record<string, ViewField>>,
): FieldNode[] {
  return nodes.filter((n) => {
    const f = fields[n.field];
    return f !== undefined && !f.readonly && SETTABLE.has(f.kind);
  });
}

/**
 * "Set a field" for the selected rows: choose a column, give the value with the field's own editor, see what will
 * change, apply. One update per record (each checked and audited by the server).
 */
export function SetFieldDialog({
  open,
  onOpenChange,
  count,
  columns,
  fields,
  model,
  onApply,
  busy,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly count: number;
  readonly columns: readonly FieldNode[];
  readonly fields: Readonly<Record<string, ViewField>>;
  readonly model: string;
  readonly onApply: (key: string, value: unknown) => void;
  readonly busy: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const { registry } = useKosh();
  const id = useId();
  const choices = settable(columns, fields);
  const [key, setKey] = useState<string>(choices[0]?.field ?? '');
  const [value, setValue] = useState<unknown>(null);
  const node = choices.find((c) => c.field === key);
  const field = fields[key];
  const Widget =
    node === undefined || field === undefined ? undefined : registry.widget(node, field);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('views.setField.title', { count })}
      description={t('views.setField.description')}
      footer={
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {t('views.cancel')}
          </Button>
          <Button
            type="button"
            variant="primary"
            busy={busy}
            disabled={field === undefined}
            onClick={() => onApply(key, scalar(value))}
          >
            {t('views.setField.apply', { count })}
          </Button>
        </div>
      }
    >
      <div className="grid gap-3">
        <div className="grid gap-1">
          <Label htmlFor={`${id}-field`}>{t('views.setField.field')}</Label>
          <select
            id={`${id}-field`}
            className="h-9 rounded-md border bg-background px-2 text-sm"
            value={key}
            onChange={(e) => {
              setKey(e.target.value);
              setValue(null);
            }}
          >
            {choices.map((c) => (
              <option key={c.field} value={c.field}>
                {fields[c.field]?.label ?? c.field}
              </option>
            ))}
          </select>
        </div>
        {Widget === undefined || node === undefined || field === undefined ? null : (
          <div className="grid gap-1">
            <Label htmlFor={`${id}-value`}>{t('views.setField.value')}</Label>
            <Widget
              id={`${id}-value`}
              node={node}
              field={field}
              value={value}
              record={{ [key]: value }}
              model={model}
              readonly={false}
              onChange={setValue}
            />
          </div>
        )}
        {field === undefined ? null : (
          <p className="text-sm text-muted-foreground">
            {t('views.setField.preview', { count, field: field.label })}
          </p>
        )}
      </div>
    </Dialog>
  );
}

/**
 * A row at the foot of a list that adds a record: the list's `quickAdd` fields, Tab between them, Enter creates
 * and starts the next one. The server refuses what it must (required fields, rights) and the row says why.
 */
export function QuickAdd({
  api,
  model,
  keys,
  fields,
  onCreated,
}: {
  readonly api: KoshApi;
  readonly model: string;
  readonly keys: readonly string[];
  readonly fields: Readonly<Record<string, ViewField>>;
  readonly onCreated: (row: Row) => void;
}): ReactElement | null {
  const { t } = useTranslation();
  const { registry } = useKosh();
  const id = useId();
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const usable = keys.filter((k) => {
    const f = fields[k];
    return f !== undefined && !f.readonly && SETTABLE.has(f.kind);
  });
  if (usable.length === 0) return null;
  const add = async (): Promise<void> => {
    const payload = Object.fromEntries(
      Object.entries(values)
        .filter(([, v]) => v !== null && v !== undefined && v !== '')
        .map(([k, v]) => [k, scalar(v)]),
    );
    if (Object.keys(payload).length === 0) return;
    setBusy(true);
    try {
      const made = await api.create(model, payload);
      setValues({});
      setError(null);
      onCreated(made.record);
      document.getElementById(`${id}-${usable[0]}`)?.focus();
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      aria-label={t('views.quickAdd.label')}
      data-kosh-quick-add
      className="grid gap-2 border-t px-3 py-2"
      onSubmit={(e) => {
        e.preventDefault();
        void add();
      }}
    >
      <div className="flex flex-wrap items-end gap-2">
        {usable.map((k) => {
          const field = fields[k] as ViewField;
          const node: FieldNode = { kind: 'field', id: `quick-${k}`, field: k };
          const Widget = registry.widget(node, field);
          return (
            <div key={k} className="grid min-w-40 flex-1 gap-1">
              <Label htmlFor={`${id}-${k}`} className="text-xs text-muted-foreground">
                {field.label}
              </Label>
              {Widget === undefined ? null : (
                <Widget
                  id={`${id}-${k}`}
                  node={node}
                  field={field}
                  value={values[k] ?? null}
                  record={values}
                  model={model}
                  readonly={false}
                  onChange={(v) => setValues((current) => ({ ...current, [k]: v }))}
                />
              )}
            </div>
          );
        })}
        <Button type="submit" size="sm" variant="secondary" busy={busy}>
          {t('views.quickAdd.add')}
        </Button>
      </div>
      {error === null ? null : <Alert tone="danger">{error}</Alert>}
    </form>
  );
}
