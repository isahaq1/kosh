/**
 * The rule editor (RFC 0011 §5.6): the form renderer of `automation.rule`. The trigger and what it watches, a
 * condition built row by row (or as a domain), the ordered actions with the fields, transitions, activity types
 * and module actions of the model, who the actions run as, a dry run on a record, and "run pending changes now".
 * The server owns the rules and the runs; this edits one record and reads what the model offers.
 */
import {
  Alert,
  Badge,
  Button,
  type FormProps,
  Input,
  Label,
  Select,
  Spinner,
  Textarea,
  useKosh,
} from '@kosh/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowLeft, ArrowUp, Play, Plus, Trash2 } from 'lucide-react';
import { type ReactElement, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

type Row = Record<string, unknown>;

interface ModelInfo {
  readonly model: string;
  readonly tracked: readonly string[];
  readonly transitions: readonly string[];
  readonly fields: readonly { key: string; label: string; kind: string; target: string | null }[];
}
interface ActionInfo {
  readonly key: string;
  readonly label: string;
  readonly model: string | null;
  readonly params: readonly { key: string; label: string; kind: string }[];
}
interface Rule {
  name: string;
  targetModel: string;
  trigger: string;
  watchFields: string[];
  fromValues: Row;
  toValues: Row;
  topic: string;
  condition: Row;
  actions: Row[];
  runAs: 'actor' | 'system';
  runAsUser: number | null;
  logOnRecord: boolean;
  enabled: boolean;
  sequence: number;
  description: string;
}

const TRIGGERS = ['created', 'updated', 'transition', 'deleted', 'event'] as const;
const KINDS = [
  'set',
  'transition',
  'activity',
  'notify',
  'note',
  'comment',
  'create',
  'action',
] as const;
const OPERATORS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'ilike', 'in', 'isNull'] as const;

const empty: Rule = {
  name: '',
  targetModel: '',
  trigger: 'created',
  watchFields: [],
  fromValues: {},
  toValues: {},
  topic: '',
  condition: {},
  actions: [],
  runAs: 'actor',
  runAsUser: null,
  logOnRecord: false,
  enabled: true,
  sequence: 10,
  description: '',
};

function ruleOf(record: Row): Rule {
  return {
    name: String(record['name'] ?? ''),
    targetModel: String(record['targetModel'] ?? ''),
    trigger: String(record['trigger'] ?? 'created'),
    watchFields: Array.isArray(record['watchFields']) ? (record['watchFields'] as string[]) : [],
    fromValues: (record['fromValues'] as Row | null) ?? {},
    toValues: (record['toValues'] as Row | null) ?? {},
    topic: String(record['topic'] ?? ''),
    condition: (record['condition'] as Row | null) ?? {},
    actions: Array.isArray(record['actions']) ? (record['actions'] as Row[]) : [],
    runAs: record['runAs'] === 'system' ? 'system' : 'actor',
    runAsUser: typeof record['runAsUser'] === 'number' ? record['runAsUser'] : null,
    logOnRecord: record['logOnRecord'] === true,
    enabled: record['enabled'] !== false,
    sequence: Number(record['sequence'] ?? 10),
    description: String(record['description'] ?? ''),
  };
}

/** The condition as rows: `{ field: { op: value } }` or `{ field: value }` (eq); anything else stays a domain. */
interface ConditionRow {
  field: string;
  op: (typeof OPERATORS)[number];
  value: string;
}
function rowsOf(domain: Row): ConditionRow[] | null {
  const out: ConditionRow[] = [];
  for (const [field, v] of Object.entries(domain)) {
    if (field === 'and' || field === 'or') return null;
    if (v === null || typeof v !== 'object') {
      out.push({ field, op: 'eq', value: v === null ? '' : String(v) });
      continue;
    }
    const entries = Object.entries(v as Row);
    if (entries.length !== 1) return null;
    const [op, value] = entries[0] as [string, unknown];
    if (!OPERATORS.includes(op as never)) return null;
    out.push({
      field,
      op: op as ConditionRow['op'],
      value: Array.isArray(value) ? value.join(', ') : String(value ?? ''),
    });
  }
  return out;
}
function domainOf(rows: readonly ConditionRow[]): Row {
  const out: Row = {};
  for (const r of rows) {
    if (r.field === '') continue;
    const value =
      r.op === 'in'
        ? r.value
            .split(',')
            .map((x) => x.trim())
            .filter((x) => x !== '')
        : r.op === 'isNull'
          ? r.value !== 'false'
          : /^(true|false)$/.test(r.value)
            ? r.value === 'true'
            : r.value;
    out[r.field] = r.op === 'eq' ? value : { [r.op]: value };
  }
  return out;
}

/** A search box with a listbox of names (users, records of a model). */
function NamePicker({
  model,
  label,
  onPick,
}: {
  readonly model: string;
  readonly label: string;
  readonly onPick: (item: { id: number; displayName: string }) => void;
}): ReactElement {
  const { api } = useKosh();
  const listId = useId();
  const [query, setQuery] = useState('');
  const names = useQuery({
    queryKey: ['names', model, query],
    queryFn: () => api.names(model, { q: query, limit: 8 }),
    enabled: model !== '',
  });
  return (
    <div className="grid gap-1">
      <Input
        role="combobox"
        aria-label={label}
        aria-autocomplete="list"
        aria-expanded={(names.data?.length ?? 0) > 0}
        aria-controls={listId}
        placeholder={label}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div id={listId} role="listbox" aria-label={label} className="grid max-h-40 overflow-y-auto">
        {(names.data ?? []).map((r) => (
          <div
            key={r.id}
            role="option"
            aria-selected={false}
            tabIndex={0}
            className="cursor-pointer rounded px-2 py-1 text-sm hover:bg-muted"
            onClick={() => {
              onPick(r);
              setQuery('');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onPick(r);
                setQuery('');
              }
            }}
          >
            {r.displayName}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Key / value rows (field values of the model, with templates). */
function ValuesEditor({
  label,
  values,
  fields,
  onChange,
}: {
  readonly label: string;
  readonly values: Row;
  readonly fields: ModelInfo['fields'];
  readonly onChange: (values: Row) => void;
}): ReactElement {
  const { t } = useTranslation('automation');
  const entries = Object.entries(values);
  const set = (list: [string, unknown][]) => onChange(Object.fromEntries(list));
  return (
    <fieldset className="grid gap-2">
      <legend className="text-sm font-medium">{label}</legend>
      {entries.map(([key, value], i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows are edited in place; a key that changed with the value would drop the input's focus
        <div key={`${key}-${i}`} className="flex flex-wrap items-end gap-2">
          <Select
            label={t('editor.field')}
            value={key}
            options={fields.map((f) => ({ value: f.key, label: `${f.label} (${f.key})` }))}
            onChange={(next) => set(entries.map((e, j) => (j === i ? [next, e[1]] : e)))}
            className="w-56"
          />
          <Input
            aria-label={`${t('editor.value')} ${key}`}
            value={typeof value === 'string' ? value : JSON.stringify(value)}
            onChange={(e) => set(entries.map((x, j) => (j === i ? [x[0], e.target.value] : x)))}
            className="w-64"
          />
          <Button
            size="icon"
            variant="ghost"
            aria-label={t('editor.remove')}
            onClick={() => set(entries.filter((_, j) => j !== i))}
          >
            <Trash2 aria-hidden />
          </Button>
        </div>
      ))}
      <Button
        size="sm"
        variant="secondary"
        className="justify-self-start"
        onClick={() => set([...entries, [fields[0]?.key ?? '', '']])}
      >
        <Plus aria-hidden /> {t('editor.addValue')}
      </Button>
    </fieldset>
  );
}

function ActionCard({
  action,
  index,
  count,
  info,
  moduleActions,
  activityTypes,
  onChange,
  onMove,
  onRemove,
}: {
  readonly action: Row;
  readonly index: number;
  readonly count: number;
  readonly info: ModelInfo | undefined;
  readonly moduleActions: readonly ActionInfo[];
  readonly activityTypes: readonly string[];
  readonly onChange: (action: Row) => void;
  readonly onMove: (delta: number) => void;
  readonly onRemove: () => void;
}): ReactElement {
  const { t } = useTranslation('automation');
  const kind = String(action['kind'] ?? 'set');
  const fields = info?.fields ?? [];
  const patch = (values: Row) => onChange({ ...action, ...values });
  const text = (key: string, label: string, rows = 2) => (
    <div className="grid gap-1">
      <Label htmlFor={`a${index}-${key}`}>{label}</Label>
      <Textarea
        id={`a${index}-${key}`}
        rows={rows}
        value={String(action[key] ?? '')}
        onChange={(e) => patch({ [key]: e.target.value })}
      />
    </div>
  );
  const users = (key: string) => (
    <div className="grid gap-1">
      <Label htmlFor={`a${index}-${key}`}>{t('editor.users')}</Label>
      <Input
        id={`a${index}-${key}`}
        placeholder={t('editor.usersHint')}
        value={
          Array.isArray(action[key])
            ? (action[key] as unknown[]).join(', ')
            : String(action[key] ?? '')
        }
        onChange={(e) =>
          patch({
            [key]: e.target.value
              .split(',')
              .map((x) => x.trim())
              .filter((x) => x !== '')
              .map((x) => (/^\d+$/.test(x) ? Number(x) : x)),
          })
        }
      />
    </div>
  );
  return (
    <li
      className="grid gap-3 rounded-lg border bg-surface p-3"
      aria-label={`${index + 1}. ${t(`kinds.${kind}`)}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="neutral">{index + 1}</Badge>
        <Select
          label={t('editor.kind')}
          value={kind}
          options={KINDS.map((k) => ({ value: k, label: t(`kinds.${k}`) }))}
          onChange={(next) => onChange({ kind: next })}
          className="w-56"
        />
        <span className="ms-auto flex gap-1">
          <Button
            size="icon"
            variant="ghost"
            aria-label={t('editor.moveUp')}
            disabled={index === 0}
            onClick={() => onMove(-1)}
          >
            <ArrowUp aria-hidden />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label={t('editor.moveDown')}
            disabled={index === count - 1}
            onClick={() => onMove(1)}
          >
            <ArrowDown aria-hidden />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label={t('editor.removeAction')}
            onClick={onRemove}
          >
            <Trash2 aria-hidden />
          </Button>
        </span>
      </div>
      {kind === 'set' ? (
        <ValuesEditor
          label={t('editor.values')}
          values={(action['values'] as Row | undefined) ?? {}}
          fields={fields}
          onChange={(values) => patch({ values })}
        />
      ) : null}
      {kind === 'transition' ? (
        <Select
          label={t('editor.transition')}
          value={String(action['name'] ?? '')}
          options={(info?.transitions ?? []).map((n) => ({ value: n, label: n }))}
          onChange={(name) => patch({ name })}
          className="w-56"
        />
      ) : null}
      {kind === 'activity' ? (
        <div className="grid gap-2">
          <Select
            label={t('editor.activityType')}
            value={String(action['type'] ?? activityTypes[0] ?? '')}
            options={activityTypes.map((n) => ({ value: n, label: n }))}
            onChange={(type) => patch({ type })}
            className="w-56"
          />
          <div className="grid gap-1">
            <Label htmlFor={`a${index}-summary`}>{t('editor.summary')}</Label>
            <Input
              id={`a${index}-summary`}
              value={String(action['summary'] ?? '')}
              onChange={(e) => patch({ summary: e.target.value })}
            />
          </div>
          {users('assignee')}
          <div className="grid gap-1">
            <Label htmlFor={`a${index}-days`}>{t('editor.inDays')}</Label>
            <Input
              id={`a${index}-days`}
              type="number"
              className="w-24"
              value={String(action['inDays'] ?? 0)}
              onChange={(e) => patch({ inDays: Number(e.target.value) })}
            />
          </div>
        </div>
      ) : null}
      {kind === 'notify' ? (
        <div className="grid gap-2">
          {users('users')}
          {text('text', t('editor.text'))}
        </div>
      ) : null}
      {kind === 'note' || kind === 'comment' ? text('text', t('editor.text'), 3) : null}
      {kind === 'create' ? (
        <div className="grid gap-2">
          <div className="grid gap-1">
            <Label htmlFor={`a${index}-model`}>{t('editor.model')}</Label>
            <Input
              id={`a${index}-model`}
              value={String(action['model'] ?? '')}
              onChange={(e) => patch({ model: e.target.value })}
              className="w-64"
            />
          </div>
          <ValuesEditor
            label={t('editor.values')}
            values={(action['values'] as Row | undefined) ?? {}}
            fields={fields}
            onChange={(values) => patch({ values })}
          />
        </div>
      ) : null}
      {kind === 'action' ? (
        <Select
          label={t('editor.moduleAction')}
          value={String(action['key'] ?? '')}
          options={moduleActions
            .filter((a) => a.model === null || a.model === info?.model)
            .map((a) => ({ value: a.key, label: `${a.label} (${a.key})` }))}
          onChange={(key) => patch({ key })}
          className="w-80"
        />
      ) : null}
    </li>
  );
}

export function RuleEditor({ recordId, onSaved, onBack, crumbs }: FormProps): ReactElement {
  const { t } = useTranslation('automation');
  const { api } = useKosh();
  const queryClient = useQueryClient();
  const id = useId();
  const [rule, setRule] = useState<Rule>(empty);
  const [etag, setEtag] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(recordId === 'new');
  const [conditionRows, setConditionRows] = useState<ConditionRow[] | null>([]);
  const [conditionJson, setConditionJson] = useState('{}');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [testRecord, setTestRecord] = useState<{ id: number; displayName: string } | null>(null);
  const [testResult, setTestResult] = useState<{ matches: boolean; actions: Row[] } | null>(null);
  const [userName, setUserName] = useState<string>('');

  const record = useQuery({
    queryKey: ['automation', 'rule', recordId],
    queryFn: () => api.get('automation.rule', recordId as number),
    enabled: recordId !== 'new',
  });
  useEffect(() => {
    if (record.data === undefined) return;
    const r = ruleOf(record.data.record);
    setRule(r);
    setEtag(record.data.etag);
    const rows = rowsOf(r.condition);
    setConditionRows(rows);
    setConditionJson(JSON.stringify(r.condition, null, 2));
    setLoaded(true);
  }, [record.data]);
  const routes = useQuery({ queryKey: ['routes'], queryFn: () => api.routes() });
  const info = useQuery({
    queryKey: ['automation', 'model', rule.targetModel],
    queryFn: () =>
      api.call<ModelInfo>(
        'GET',
        `/api/v1/automation/models/${encodeURIComponent(rule.targetModel)}`,
      ),
    enabled: rule.targetModel !== '',
  });
  const moduleActions = useQuery({
    queryKey: ['automation', 'actions'],
    queryFn: () => api.call<{ actions: ActionInfo[] }>('GET', '/api/v1/automation/actions'),
  });
  const activityTypes = useQuery({
    queryKey: ['activities', 'types'],
    queryFn: () => api.call<{ types: { name: string }[] }>('GET', '/api/v1/activities/types'),
  });
  useEffect(() => {
    if (rule.runAsUser === null) {
      setUserName('');
      return;
    }
    void api
      .names('res.users', { ids: [rule.runAsUser] })
      .then((r) => setUserName(r[0]?.displayName ?? ''));
  }, [api, rule.runAsUser]);

  const condition = (): Row => {
    if (conditionRows !== null) return domainOf(conditionRows);
    try {
      return JSON.parse(conditionJson) as Row;
    } catch {
      return rule.condition;
    }
  };
  const payload = (): Row => ({
    name: rule.name,
    targetModel: rule.targetModel,
    trigger: rule.trigger,
    watchFields: rule.watchFields,
    fromValues: rule.fromValues,
    toValues: rule.toValues,
    topic: rule.topic === '' ? null : rule.topic,
    condition: condition(),
    actions: rule.actions,
    runAs: rule.runAs,
    runAsUser: rule.runAsUser,
    logOnRecord: rule.logOnRecord,
    enabled: rule.enabled,
    sequence: rule.sequence,
    description: rule.description === '' ? null : rule.description,
  });
  const save = useMutation({
    mutationFn: () =>
      recordId === 'new'
        ? api.create('automation.rule', payload())
        : api.update('automation.rule', recordId, payload(), etag),
    onSuccess: (saved) => {
      setError(null);
      setEtag(saved.etag);
      setNotice(t('editor.saved'));
      void queryClient.invalidateQueries({ queryKey: ['list', 'automation.rule'] });
      void queryClient.invalidateQueries({ queryKey: ['automation', 'rule'] });
      onSaved(saved.record['id'] as number);
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  });
  const test = useMutation({
    mutationFn: () =>
      api.call<{ matches: boolean; actions: Row[] }>(
        'POST',
        `/api/v1/automation/rules/${String(recordId)}/test`,
        {
          record: testRecord?.id,
        },
      ),
    onSuccess: setTestResult,
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  });
  const runNow = useMutation({
    mutationFn: () =>
      api.call<{ changes: number; events: number; runs: number }>(
        'POST',
        '/api/v1/automation/poll',
      ),
    onSuccess: (r) => {
      setNotice(t('editor.ran', { runs: r.runs, changes: r.changes + r.events }));
      void queryClient.invalidateQueries({ queryKey: ['list', 'automation.run'] });
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  });

  if (!loaded) return <Spinner label={t('editor.title')} />;
  const fields = info.data?.fields ?? [];
  const tracked = info.data?.tracked ?? [];
  const models = Object.keys(routes.data ?? {}).sort();
  const setActions = (actions: Row[]) => setRule({ ...rule, actions });
  return (
    <div className="grid gap-4" data-kosh-form>
      <header className="flex flex-wrap items-center gap-2">
        <Button
          size="icon"
          variant="ghost"
          aria-label={t('editor.back')}
          onClick={onBack}
          data-kosh-back
        >
          <ArrowLeft aria-hidden />
        </Button>
        <nav aria-label={t('editor.breadcrumbs')} className="text-sm text-muted-foreground">
          {(crumbs ?? []).map((c) => (
            <span key={c.label}>
              <button type="button" className="hover:underline" onClick={c.onClick}>
                {c.label}
              </button>
              {' › '}
            </span>
          ))}
        </nav>
        <h1 className="text-xl font-semibold">
          {recordId === 'new' ? t('editor.new') : rule.name}
        </h1>
        <span className="ms-auto flex gap-2">
          <Button variant="secondary" busy={runNow.isPending} onClick={() => runNow.mutate()}>
            <Play aria-hidden /> {t('editor.runNow')}
          </Button>
          <Button
            variant="primary"
            busy={save.isPending}
            disabled={rule.name.trim() === '' || rule.targetModel === ''}
            onClick={() => save.mutate()}
            data-kosh-save
          >
            {t('editor.save')}
          </Button>
        </span>
      </header>
      {error === null ? null : <Alert>{error}</Alert>}
      {notice === null ? null : <Alert tone="info">{notice}</Alert>}

      <section
        aria-label={t('editor.when')}
        className="grid gap-3 rounded-lg border bg-surface p-4"
      >
        <h2 className="text-base font-semibold">{t('editor.when')}</h2>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="grid gap-1">
            <Label htmlFor={`${id}-name`}>{t('editor.name')}</Label>
            <Input
              id={`${id}-name`}
              value={rule.name}
              onChange={(e) => setRule({ ...rule, name: e.target.value })}
            />
          </div>
          <Select
            id={`${id}-model`}
            label={t('editor.model')}
            value={rule.targetModel === '' ? null : rule.targetModel}
            placeholder={t('editor.pickModel')}
            options={models.map((m) => ({ value: m, label: m }))}
            onChange={(targetModel) =>
              setRule({ ...rule, targetModel, watchFields: [], actions: rule.actions })
            }
          />
          <Select
            id={`${id}-trigger`}
            label={t('editor.trigger')}
            value={rule.trigger}
            options={TRIGGERS.map((tr) => ({ value: tr, label: t(`triggers.${tr}`) }))}
            onChange={(trigger) => setRule({ ...rule, trigger })}
          />
          <div className="flex items-end gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={rule.enabled}
                onChange={(e) => setRule({ ...rule, enabled: e.target.checked })}
              />
              {t('editor.enabled')}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={rule.logOnRecord}
                onChange={(e) => setRule({ ...rule, logOnRecord: e.target.checked })}
              />
              {t('editor.logOnRecord')}
            </label>
          </div>
        </div>
        {rule.trigger === 'updated' ? (
          <fieldset className="grid gap-2">
            <legend className="text-sm font-medium">{t('editor.watchFields')}</legend>
            {tracked.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('editor.noTracked')}</p>
            ) : (
              <div className="flex flex-wrap gap-3">
                {tracked.map((key) => (
                  <label key={key} className="flex items-center gap-1 text-sm">
                    <input
                      type="checkbox"
                      checked={rule.watchFields.includes(key)}
                      onChange={(e) =>
                        setRule({
                          ...rule,
                          watchFields: e.target.checked
                            ? [...rule.watchFields, key]
                            : rule.watchFields.filter((k) => k !== key),
                        })
                      }
                    />
                    {fields.find((f) => f.key === key)?.label ?? key}
                  </label>
                ))}
              </div>
            )}
          </fieldset>
        ) : null}
        {rule.trigger === 'updated' || rule.trigger === 'transition' ? (
          <div className="grid gap-3 md:grid-cols-2">
            <ValuesEditor
              label={t('editor.fromValues')}
              values={rule.fromValues}
              fields={fields}
              onChange={(fromValues) => setRule({ ...rule, fromValues })}
            />
            <ValuesEditor
              label={t('editor.toValues')}
              values={rule.toValues}
              fields={fields}
              onChange={(toValues) => setRule({ ...rule, toValues })}
            />
          </div>
        ) : null}
        {rule.trigger === 'event' ? (
          <div className="grid gap-1">
            <Label htmlFor={`${id}-topic`}>{t('editor.topic')}</Label>
            <Input
              id={`${id}-topic`}
              className="w-80"
              value={rule.topic}
              onChange={(e) => setRule({ ...rule, topic: e.target.value })}
            />
          </div>
        ) : null}
        <fieldset className="grid gap-2">
          <legend className="text-sm font-medium">{t('editor.condition')}</legend>
          {conditionRows === null ? (
            <Textarea
              aria-label={t('editor.conditionJson')}
              rows={4}
              value={conditionJson}
              onChange={(e) => setConditionJson(e.target.value)}
            />
          ) : (
            <>
              {conditionRows.map((row, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows are edited in place; a key that changed with the value would drop the input's focus
                <div key={`${row.field}-${i}`} className="flex flex-wrap items-end gap-2">
                  <Select
                    label={t('editor.field')}
                    value={row.field}
                    options={fields.map((f) => ({ value: f.key, label: `${f.label} (${f.key})` }))}
                    onChange={(field) =>
                      setConditionRows(conditionRows.map((r, j) => (j === i ? { ...r, field } : r)))
                    }
                    className="w-56"
                  />
                  <Select
                    label={t('editor.operator')}
                    value={row.op}
                    options={OPERATORS.map((op) => ({ value: op, label: t(`operators.${op}`) }))}
                    onChange={(op) =>
                      setConditionRows(
                        conditionRows.map((r, j) =>
                          j === i ? { ...r, op: op as ConditionRow['op'] } : r,
                        ),
                      )
                    }
                    className="w-40"
                  />
                  <Input
                    aria-label={`${t('editor.value')} ${i + 1}`}
                    value={row.value}
                    onChange={(e) =>
                      setConditionRows(
                        conditionRows.map((r, j) =>
                          j === i ? { ...r, value: e.target.value } : r,
                        ),
                      )
                    }
                    className="w-56"
                  />
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={t('editor.remove')}
                    onClick={() => setConditionRows(conditionRows.filter((_, j) => j !== i))}
                  >
                    <Trash2 aria-hidden />
                  </Button>
                </div>
              ))}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    setConditionRows([
                      ...conditionRows,
                      { field: fields[0]?.key ?? '', op: 'eq', value: '' },
                    ])
                  }
                >
                  <Plus aria-hidden /> {t('editor.addCondition')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setConditionJson(JSON.stringify(domainOf(conditionRows), null, 2));
                    setConditionRows(null);
                  }}
                >
                  {t('editor.asDomain')}
                </Button>
              </div>
            </>
          )}
        </fieldset>
      </section>

      <section
        aria-label={t('editor.thenDo')}
        className="grid gap-3 rounded-lg border bg-surface p-4"
      >
        <h2 className="text-base font-semibold">{t('editor.thenDo')}</h2>
        {rule.actions.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('editor.noActions')}</p>
        ) : null}
        <ol className="grid gap-3">
          {rule.actions.map((action, i) => (
            <ActionCard
              // biome-ignore lint/suspicious/noArrayIndexKey: rows are edited in place; a key that changed with the value would drop the input's focus
              key={`${String(action['kind'])}-${i}`}
              action={action}
              index={i}
              count={rule.actions.length}
              info={info.data}
              moduleActions={moduleActions.data?.actions ?? []}
              activityTypes={(activityTypes.data?.types ?? []).map((x) => x.name)}
              onChange={(next) => setActions(rule.actions.map((a, j) => (j === i ? next : a)))}
              onMove={(delta) => {
                const next = [...rule.actions];
                const [item] = next.splice(i, 1);
                next.splice(i + delta, 0, item as Row);
                setActions(next);
              }}
              onRemove={() => setActions(rule.actions.filter((_, j) => j !== i))}
            />
          ))}
        </ol>
        <Button
          size="sm"
          variant="secondary"
          className="justify-self-start"
          onClick={() => setActions([...rule.actions, { kind: 'set', values: {} }])}
        >
          <Plus aria-hidden /> {t('editor.addAction')}
        </Button>
        <div className="grid gap-3 md:grid-cols-2">
          <Select
            id={`${id}-runAs`}
            label={t('editor.runAs')}
            value={rule.runAs}
            options={[
              { value: 'actor', label: t('editor.runAsActor') },
              { value: 'system', label: t('editor.runAsSystem') },
            ]}
            onChange={(runAs) => setRule({ ...rule, runAs: runAs as Rule['runAs'] })}
          />
          <div className="grid gap-1">
            <span className="text-sm font-medium">{t('editor.runAsUser')}</span>
            {rule.runAsUser === null ? (
              <NamePicker
                model="res.users"
                label={t('editor.pickUser')}
                onPick={(u) => setRule({ ...rule, runAsUser: u.id })}
              />
            ) : (
              <span className="flex items-center gap-2 text-sm">
                {userName}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setRule({ ...rule, runAsUser: null })}
                >
                  {t('editor.remove')}
                </Button>
              </span>
            )}
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {rule.runAs === 'actor' ? t('editor.runAsActorHint') : t('editor.runAsSystemHint')}
        </p>
      </section>

      {recordId === 'new' ? null : (
        <section
          aria-label={t('editor.test')}
          className="grid gap-3 rounded-lg border bg-surface p-4"
        >
          <h2 className="text-base font-semibold">{t('editor.test')}</h2>
          <p className="text-sm text-muted-foreground">{t('editor.testHint')}</p>
          {testRecord === null ? (
            <NamePicker
              model={rule.targetModel}
              label={t('editor.pickRecord')}
              onPick={(r) => setTestRecord(r)}
            />
          ) : (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span>{testRecord.displayName}</span>
              <Button
                size="sm"
                variant="primary"
                busy={test.isPending}
                onClick={() => test.mutate()}
              >
                {t('editor.runTest')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setTestRecord(null);
                  setTestResult(null);
                }}
              >
                {t('editor.remove')}
              </Button>
            </div>
          )}
          {testResult === null ? null : (
            <div className="grid gap-2" aria-live="polite">
              <Badge tone={testResult.matches ? 'success' : 'warning'}>
                {testResult.matches ? t('editor.matches') : t('editor.noMatch')}
              </Badge>
              <pre className="overflow-auto rounded bg-muted p-2 text-xs">
                {JSON.stringify(testResult.actions, null, 2)}
              </pre>
            </div>
          )}
        </section>
      )}
      <div className="grid gap-1">
        <Label htmlFor={`${id}-description`}>{t('editor.description')}</Label>
        <Textarea
          id={`${id}-description`}
          rows={2}
          value={rule.description}
          onChange={(e) => setRule({ ...rule, description: e.target.value })}
        />
      </div>
    </div>
  );
}
