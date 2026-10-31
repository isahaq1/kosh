/**
 * The form renderer (RFC 0007 §5): statusbar and transition buttons from the served view (only what the user may
 * run, from the current state), groups, notebooks, editable lines, registered components (escape hatches), onchange
 * assistance, and saves with compare-and-set (a record changed by someone else since it was opened is not
 * overwritten: the user reloads). Conditions only decide display; the server re-checks every write.
 */
import {
  type ButtonNode,
  type Condition,
  evaluate,
  type FieldNode,
  type FormNode,
  holds,
  type LinesNode,
} from '@kosh/views';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useBlocker, useParams } from '@tanstack/react-router';
import {
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  MoreHorizontal,
  PanelRight,
  Plus,
  Trash2,
} from 'lucide-react';
import { type ReactElement, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ApiError,
  NetworkError,
  type Row,
  type ServedView,
  type Versioned,
  type ViewField,
} from '../api.js';
import {
  Alert,
  Button,
  Dialog,
  Label,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Spinner,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '../components/primitives.js';
import { useKosh } from '../context.js';
import { useDesign } from '../design.js';
import { cn } from '../lib/cn.js';
import { useLiveRecord } from '../live.js';
import type { FormProps } from '../registry.js';
import { useToast } from '../shell/toast.js';
import { StatsRow } from './StatsRow.js';
import { StatusChip } from './StatusChip.js';
import { PrefetchedNames, useRowNames } from './widgets.js';

type Values = Record<string, unknown>;

const pick = (row: Values, keys: readonly string[]): Values =>
  Object.fromEntries(keys.filter((k) => k in row).map((k) => [k, row[k]]));

/** Edits of a one2many, sent as Shutro commands with the parent. */
interface LineState {
  readonly rows: readonly {
    readonly key: string;
    readonly id?: number;
    readonly values: Values;
    readonly dirty: boolean;
    /** The columns edited on a saved line: only they are sent (the rest may be locked, a confirmed line's product). */
    readonly edited?: readonly string[];
  }[];
  readonly deleted: readonly number[];
}

/** A line's values as the server takes them: many2many as `{ set }` (a line's taxes). */
function lineValues(values: Values, fields: Readonly<Record<string, ViewField>>): Values {
  const out: Values = {};
  // Only what a line can be given: its id and read-only columns (a computed total, a reserved quantity) are shown,
  // never written.
  for (const [key, value] of Object.entries(values)) {
    const field = fields[key];
    if (field === undefined || field.readonly === true) continue;
    out[key] = field.kind === 'many2many' && Array.isArray(value) ? { set: value } : value;
  }
  return out;
}

/**
 * The one2many and many2many fields a form shows (its lines, its tags): a record's default fields leave them out,
 * so the form asks for them by name.
 */
const RAIL_KEY = 'kosh.rail';
/** Whether the record pages' right rail is open (RFC 0018: open by default), remembered per browser. */
function useRail(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(RAIL_KEY) !== 'closed';
    } catch {
      return true;
    }
  });
  return [
    open,
    (next: boolean) => {
      setOpen(next);
      try {
        if (next) localStorage.removeItem(RAIL_KEY);
        else localStorage.setItem(RAIL_KEY, 'closed');
      } catch {
        // storage unavailable: the choice lasts for this page
      }
    },
  ];
}

function relationFieldsOf(
  sheet: readonly FormNode[],
  fields: Readonly<Record<string, ViewField>>,
): string[] {
  const out = new Set<string>();
  const walk = (nodes: readonly FormNode[]): void => {
    for (const node of nodes) {
      if (node.kind === 'lines') out.add(node.field);
      else if (node.kind === 'field') {
        const kind = fields[node.field]?.kind;
        if (kind === 'one2many' || kind === 'many2many') out.add(node.field);
      } else if (node.kind === 'group') walk(node.children);
      else if (node.kind === 'notebook') for (const page of node.pages) walk(page.children);
    }
  };
  walk(sheet);
  return [...out];
}

function commandsOf(lines: LineState, fields: Readonly<Record<string, ViewField>>): Values {
  return {
    ...(lines.rows.some((r) => r.id === undefined)
      ? {
          create: lines.rows
            .filter((r) => r.id === undefined)
            .map((r) => lineValues(r.values, fields)),
        }
      : {}),
    ...(lines.rows.some((r) => r.id !== undefined && r.dirty)
      ? {
          update: lines.rows
            .filter((r) => r.id !== undefined && r.dirty)
            .map((r) => ({
              id: r.id,
              values: lineValues(
                Object.fromEntries((r.edited ?? []).map((k) => [k, r.values[k]])),
                fields,
              ),
            })),
        }
      : {}),
    ...(lines.deleted.length > 0 ? { delete: lines.deleted } : {}),
  };
}

/** The payload of a save: changed values, many2many as `{ set }`. */
function payloadOf(
  changes: Values,
  fields: Readonly<Record<string, ViewField>>,
  lines: ReadonlyMap<string, LineState>,
  /** The fields of a one2many's lines. */
  lineFields: (key: string) => Readonly<Record<string, ViewField>>,
): Values {
  const out: Values = {};
  for (const [key, value] of Object.entries(changes)) {
    if (fields[key]?.kind === 'many2many') out[key] = { set: Array.isArray(value) ? value : [] };
    else out[key] = value;
  }
  for (const [key, state] of lines) {
    const commands = commandsOf(state, lineFields(key));
    if (Object.keys(commands).length > 0) out[key] = commands;
  }
  return out;
}

function Lines({
  node,
  served,
  ids,
  readonly,
  state,
  onState,
}: {
  readonly node: LinesNode;
  readonly served: ServedView;
  readonly ids: readonly number[];
  readonly readonly: boolean;
  readonly state: LineState | undefined;
  readonly onState: (state: LineState) => void;
}): ReactElement | null {
  const { api, registry } = useKosh();
  const { t } = useTranslation();
  const field = served.fields[served.view.model]?.[node.field];
  const target = field?.target ?? '';
  const columnFields = served.fields[target] ?? {};
  const columns = node.columns.filter((c) => columnFields[c.field] !== undefined);
  const loaded = useQuery({
    queryKey: ['lines', target, ids],
    queryFn: () =>
      api.list(target, {
        filter: { id: { in: [...ids] } },
        fields: ['id', ...columns.map((c) => c.field)],
        limit: 1000,
      }),
    enabled: ids.length > 0 && target !== '',
  });
  const rows: LineState['rows'] =
    state?.rows ??
    (loaded.data?.items ?? []).map((r) => ({
      key: `id-${r.id}`,
      id: r.id,
      values: r as Values,
      dirty: false,
    }));
  const names = useRowNames(
    rows.map((r) => r.values),
    Object.values(columnFields),
  );
  if (field === undefined) return null;
  const set = (next: LineState['rows'], deleted = state?.deleted ?? []) =>
    onState({ rows: next, deleted });
  return (
    <PrefetchedNames.Provider value={names}>
      <div className="col-span-full overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">{node.id}</caption>
          <thead>
            <tr className="border-b">
              {columns.map((c) => (
                <th
                  key={c.id}
                  scope="col"
                  className="px-2 py-1.5 text-start font-medium text-muted-foreground"
                >
                  {c.label ?? columnFields[c.field]?.label ?? c.field}
                </th>
              ))}
              <th className="w-10">
                <span className="sr-only">{t('views.removeLine')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={row.key} className="border-b">
                {columns.map((c) => {
                  const meta = columnFields[c.field] as ViewField;
                  const Widget = registry.widget(c, meta);
                  return (
                    <td key={c.id} className="px-2 py-1">
                      <Widget
                        id={`${row.key}-${c.id}`}
                        node={c}
                        field={meta}
                        value={row.values[c.field]}
                        record={row.values}
                        readonly={readonly || meta.readonly}
                        onChange={(value) =>
                          set(
                            rows.map((r, i) =>
                              i === index
                                ? {
                                    ...r,
                                    values: { ...r.values, [c.field]: value },
                                    dirty: true,
                                    edited: [...new Set([...(r.edited ?? []), c.field])],
                                  }
                                : r,
                            ),
                          )
                        }
                      />
                    </td>
                  );
                })}
                <td>
                  {readonly ? null : (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t('views.removeLine')}
                      onClick={() =>
                        set(
                          rows.filter((_, i) => i !== index),
                          row.id === undefined
                            ? (state?.deleted ?? [])
                            : [...(state?.deleted ?? []), row.id],
                        )
                      }
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {readonly ? null : (
          <Button
            variant="link"
            size="sm"
            className="mt-1"
            onClick={() =>
              set([...rows, { key: `new-${rows.length}-${Date.now()}`, values: {}, dirty: true }])
            }
          >
            <Plus aria-hidden />
            {t('views.addLine')}
          </Button>
        )}
      </div>
    </PrefetchedNames.Provider>
  );
}

/** The default form renderer. */
export function FormView({
  served,
  recordId,
  defaults,
  onSaved,
  onBack,
  crumbs,
  pager,
  proposed,
}: FormProps): ReactElement {
  const { api, registry, uid, companyId, offline } = useKosh();
  const { t } = useTranslation();
  const design = useDesign();
  const toast = useToast();
  const queryClient = useQueryClient();
  const formId = useId();
  const [railOpen, setRailOpen] = useRail();
  const route = useParams({ strict: false }) as { app?: string; action?: string };
  const view = served.view;
  if (view.type !== 'form') throw new Error(`FormView renders form views, not ${view.type}.`);
  const model = view.model;
  const fields = served.fields[model] ?? {};
  const isNew = recordId === 'new';
  // The new record starts from its defaults; proposed values are not part of it, they are unsaved changes
  // (so Discard takes them away).
  const base: Values = Object.fromEntries(
    Object.entries(defaults ?? {}).filter(([key]) => proposed?.includes(key) !== true),
  );

  const loaded = useQuery({
    // A new record's defaults are part of the key: a cached form must not hide them.
    queryKey: ['record', model, recordId, ...(isNew ? [JSON.stringify(base)] : [])],
    queryFn: async () =>
      isNew
        ? {
            record: {
              id: 0,
              ...(await api.onchange(model, { values: base, changed: [] })).values,
              ...base, // what was asked for wins over the server's defaults
            } as Row,
            etag: null,
          }
        : (async () => {
            // The defaults (what conditions and the header read), then the lines and tags the form shows.
            const relations = relationFieldsOf(view.sheet, fields);
            const [record, related] = await Promise.all([
              api.get(model, recordId),
              relations.length === 0 ? null : api.get(model, recordId, relations),
            ]);
            return related === null
              ? record
              : {
                  ...record,
                  record: {
                    ...related.record,
                    ...record.record,
                    ...pick(related.record, relations),
                  },
                };
          })(),
  });
  // Proposed values (from a document) are unsaved changes: Save, Discard and the leave guard apply to them.
  // Proposed lines of a one2many are new rows of its line editor.
  const linesOf = (key: string): Values[] | null => {
    const given = defaults?.[key];
    return fields[key]?.kind === 'one2many' && Array.isArray(given) ? (given as Values[]) : null;
  };
  const isLines = (key: string) => linesOf(key) !== null;
  const proposedChanges = (): Values =>
    isNew && proposed !== undefined
      ? Object.fromEntries(
          proposed.filter((key) => !isLines(key)).map((key) => [key, defaults?.[key]]),
        )
      : {};
  const proposedLines = (): ReadonlyMap<string, LineState> =>
    new Map(
      isNew && proposed !== undefined
        ? proposed.filter(isLines).map((key) => [
            key,
            {
              rows: (linesOf(key) ?? []).map((values, i) => ({
                key: `proposed-${i}`,
                values,
                dirty: true,
              })),
              deleted: [],
            },
          ])
        : [],
    );
  const [changes, setChanges] = useState<Values>(proposedChanges);
  /** The latest onchange request: older answers are ignored. */
  const onchangeSequence = useRef(0);
  const [lines, setLines] = useState<ReadonlyMap<string, LineState>>(proposedLines);
  const [problem, setProblem] = useState<ApiError | null>(null);
  const [warnings, setWarnings] = useState<readonly string[]>([]);
  const [confirming, setConfirming] = useState<ButtonNode | null>(null);
  const [deleting, setDeleting] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new record id starts a clean form
  useEffect(() => {
    setChanges(proposedChanges());
    setLines(proposedLines());
    setProblem(null);
  }, [recordId]);

  const record = loaded.data?.record;
  const values = useMemo<Values>(() => ({ ...(record ?? {}), ...changes }), [record, changes]);
  const env = { uid, companyId };
  const dirty = Object.keys(changes).length > 0 || lines.size > 0;
  // Leaving with unsaved changes asks first (in-app navigation and closing the tab). A ref, not the render's
  // value: a save clears it before navigating to the saved record, ahead of the next render.
  const unsaved = useRef(dirty);
  unsaved.current = dirty;
  useBlocker({
    shouldBlockFn: () => unsaved.current && !window.confirm(t('views.leaveConfirm')),
    enableBeforeUnload: () => unsaved.current,
  });
  const live = useLiveRecord(model, recordId, dirty);
  const canEdit = isNew ? served.operations.create : served.operations.write;
  const locked = !canEdit || (!isNew && holds(view.readonlyWhen, values, env));

  // A failure: the server's refusal in the form; no server at all as a toast (the save was kept, or must wait).
  const fail = (e: unknown) => {
    setProblem(e instanceof ApiError ? e : null);
    if (e instanceof NetworkError) toast({ title: t('offline.needsConnection'), tone: 'danger' });
  };
  const save = useMutation({
    mutationFn: async (): Promise<Versioned & { readonly queued?: true }> => {
      // A new record is created with the action's defaults too (a bill from Bills, a delivery from Deliveries):
      // they are part of it without being changes.
      const payload = payloadOf(
        isNew
          ? { ...Object.fromEntries(Object.entries(base).filter(([k]) => !isLines(k))), ...changes }
          : changes,
        fields,
        lines,
        (key) => served.fields[fields[key]?.target ?? ''] ?? {},
      );
      const etag = loaded.data?.etag ?? null;
      try {
        return isNew
          ? await api.create(model, payload)
          : await api.update(model, recordId, payload, etag);
      } catch (error) {
        if (!(error instanceof NetworkError) || offline === undefined) throw error;
        // Offline: the change is kept on the device and sent when the network is back (offline/queue.ts).
        await offline.add({
          kind: isNew ? 'create' : 'update',
          model,
          modelLabel: crumbs?.[crumbs.length - 1]?.label ?? model,
          recordId: isNew ? null : recordId,
          title: String(values['displayName'] ?? values['name'] ?? `#${recordId}`),
          values: payload,
          etag,
          app: route.app,
          action: route.action,
        });
        const scalars = Object.fromEntries(
          Object.entries(payload).filter(
            ([k]) => fields[k]?.kind !== 'one2many' && fields[k]?.kind !== 'many2many',
          ),
        );
        return { record: { ...(record ?? { id: 0 }), ...scalars } as Row, etag, queued: true };
      }
    },
    onSuccess: async (result) => {
      setChanges({});
      setLines(new Map());
      setProblem(null);
      if (result.queued === true) {
        unsaved.current = false;
        toast({
          title: t('offline.savedOnDevice'),
          description: t('offline.willSync'),
          tone: 'info',
        });
        if (isNew) onBack();
        else
          queryClient.setQueryData(['record', model, recordId], {
            record: result.record,
            etag: result.etag,
          });
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ['list', model] });
      unsaved.current = false;
      if (isNew) onSaved(result.record.id);
      else queryClient.setQueryData(['record', model, recordId], result);
    },
    onError: fail,
  });
  const transition = useMutation({
    mutationFn: async (name: string) => {
      if (dirty) await save.mutateAsync();
      return api.transition(model, recordId as number, name);
    },
    onSuccess: async (result, name) => {
      setProblem(null);
      queryClient.setQueryData(['record', model, recordId], result);
      // The answer has the record's own fields: its lines (and what the transition changed in them, a line's
      // reserved quantity) are fetched again.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['record', model, recordId] }),
        queryClient.invalidateQueries({ queryKey: ['lines'] }),
        queryClient.invalidateQueries({ queryKey: ['list', model] }),
      ]);
      const button =
        view.type === 'form' ? view.header.buttons.find((b) => b.transition === name) : undefined;
      toast({ title: t('views.transitionDone', { action: button?.label ?? name }) });
    },
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: () => api.remove(model, recordId as number),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['list', model] });
      toast({ title: t('views.deleted') });
      onBack();
    },
    onError: fail,
  });

  const runOnchange = (draft: Values, changed: readonly string[]) => {
    // Only the latest change's answer applies: an earlier one arriving late would undo what was typed since.
    const sequence = ++onchangeSequence.current;
    // The record's id travels on its own: it is not a field of the draft.
    const { id: _id, ...plain } = draft;
    void api
      .onchange(model, {
        ...(isNew ? {} : { id: recordId }),
        values: plain,
        changed: [...changed],
      })
      .then((result) => {
        if (sequence !== onchangeSequence.current) return;
        const assisted: Values = {};
        // Computed values (display name, totals) come back too: shown, never written.
        for (const [k, v] of Object.entries(result.values))
          if (
            !changed.includes(k) &&
            k !== 'id' &&
            fields[k]?.readonly !== true &&
            JSON.stringify(draft[k] ?? null) !== JSON.stringify(v ?? null)
          )
            assisted[k] = v;
        if (Object.keys(assisted).length > 0) setChanges((c) => ({ ...c, ...assisted }));
        setWarnings(result.warnings ?? []);
      })
      .catch(() => undefined);
  };
  const change = (key: string, value: unknown) => {
    setChanges({ ...changes, [key]: value });
    if (served.onchange.includes(key)) runOnchange({ ...values, [key]: value }, [key]);
  };
  // Proposed values and the action's defaults trigger their onchanges once the new record is there (the customer's
  // currency; a new receipt's locations): what follows from them is part of the new record, unsaved like it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per loaded new record
  useEffect(() => {
    if (!isNew || record === undefined) return;
    const given = [...new Set([...(proposed ?? []), ...Object.keys(defaults ?? {})])];
    const keys = given.filter((key) => served.onchange.includes(key) && !isLines(key));
    if (keys.length > 0) runOnchange(values, keys);
  }, [record]);

  const names = useRowNames(record === undefined ? [] : [values], Object.values(fields));
  if (loaded.isPending) return <Spinner label={t('app.loading')} />;
  if (loaded.isError)
    return (
      <Alert
        action={
          <Button size="sm" onClick={onBack}>
            {t('views.back')}
          </Button>
        }
      >
        {loaded.error instanceof ApiError ? loaded.error.message : t('app.error')}
      </Alert>
    );

  const visible = (condition: Condition | undefined) => evaluate(condition, values, env) !== false;
  const renderField = (node: FieldNode): ReactElement | null => {
    const field = fields[node.field];
    if (field === undefined || !visible(node.visibleWhen)) return null;
    const Widget = registry.widget(node, field);
    const readonly = locked || field.readonly || holds(node.readonlyWhen, values, env);
    const id = `${formId}-${node.id}`;
    const invalid = problem?.problem.detail.includes(node.field) === true;
    return (
      <div
        key={node.id}
        className={cn(
          'grid gap-1',
          (field.kind === 'text' || field.kind === 'html') && 'col-span-full',
        )}
      >
        <Label htmlFor={id}>
          {node.label ?? field.label}
          {field.required && !readonly ? (
            <span aria-hidden className="text-danger">
              {' '}
              *
            </span>
          ) : null}
          {recordId === 'new' && proposed?.includes(node.field) === true ? (
            <span className="ms-2 rounded bg-accent px-1.5 py-0.5 text-[10px] font-medium text-accent-foreground">
              {t('views.proposed')}
            </span>
          ) : null}
        </Label>
        <div className="min-h-9 py-1.5 text-sm">
          <Widget
            id={id}
            node={node}
            field={field}
            value={values[node.field]}
            record={values}
            readonly={readonly}
            onChange={(v) => change(node.field, v)}
            invalid={invalid}
          />
        </div>
        {node.help === undefined ? null : (
          <p className="text-xs text-muted-foreground">{node.help}</p>
        )}
      </div>
    );
  };
  const renderNodes = (nodes: readonly FormNode[]): (ReactElement | null)[] =>
    nodes.map((node) => {
      switch (node.kind) {
        case 'field':
          return renderField(node);
        case 'group':
          if (!visible(node.visibleWhen)) return null;
          return (
            <fieldset key={node.id} className="col-span-full">
              {node.label === undefined ? null : (
                <legend className="mb-2 text-sm font-semibold">{node.label}</legend>
              )}
              <div
                className={cn(
                  'grid gap-x-6 gap-y-3',
                  node.columns === 1
                    ? 'grid-cols-1'
                    : node.columns === 3
                      ? 'sm:grid-cols-3'
                      : 'sm:grid-cols-2',
                )}
              >
                {renderNodes(node.children)}
              </div>
              {design.active ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="mt-2 border border-dashed border-primary/50 text-primary"
                  onClick={() =>
                    design.choose({
                      kind: 'form',
                      view: view.id,
                      model,
                      group: node.id,
                      ...(node.label === undefined ? {} : { groupLabel: node.label }),
                    })
                  }
                >
                  <Plus aria-hidden />
                  {t('views.design.addField')}
                </Button>
              ) : null}
            </fieldset>
          );
        case 'notebook': {
          const pages = node.pages.filter((p) => visible(p.visibleWhen));
          if (pages.length === 0) return null;
          return (
            <Tabs key={node.id} defaultValue={pages[0]?.id} className="col-span-full">
              <TabsList>
                {pages.map((p) => (
                  <TabsTrigger key={p.id} value={p.id}>
                    {p.label}
                  </TabsTrigger>
                ))}
              </TabsList>
              {pages.map((p) => (
                <TabsContent key={p.id} value={p.id}>
                  <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
                    {renderNodes(p.children)}
                  </div>
                </TabsContent>
              ))}
            </Tabs>
          );
        }
        case 'stats':
          if (isNew || !visible(node.visibleWhen)) return null;
          return (
            <StatsRow
              key={node.id}
              node={node}
              values={values}
              env={env}
              version={loaded.data?.etag ?? null}
            />
          );
        case 'lines': {
          const ids = Array.isArray(values[node.field])
            ? (values[node.field] as unknown[]).filter((v): v is number => typeof v === 'number')
            : [];
          return (
            <Lines
              key={node.id}
              node={node}
              served={served}
              ids={ids}
              readonly={locked || holds(node.readonlyWhen, values, env)}
              state={lines.get(node.field)}
              onState={(state) => setLines((m) => new Map(m).set(node.field, state))}
            />
          );
        }
        default: {
          // component nodes (the escape hatch)
          if (!visible(node.visibleWhen)) return null;
          const Component = registry.component(node.component);
          if (Component === undefined)
            return (
              <Alert key={node.id} tone="warning">
                {`Component '${node.component}' is not registered.`}
              </Alert>
            );
          return (
            <div key={node.id} className="col-span-full">
              <Component
                node={node}
                record={isNew ? null : (record ?? null)}
                model={model}
                served={served}
                api={api}
                version={loaded.data?.etag ?? null}
                reload={() =>
                  void queryClient.invalidateQueries({ queryKey: ['record', model, recordId] })
                }
              />
            </div>
          );
        }
      }
    });

  const statusbar = view.header.statusbar;
  const state = statusbar === undefined ? undefined : values[statusbar];
  const buttons = view.header.buttons.filter((b) => {
    const spec = served.transitions.find((tr) => tr.name === b.transition);
    return (
      !isNew &&
      spec !== undefined &&
      (state === undefined || spec.from.includes(String(state))) &&
      visible(b.visibleWhen)
    );
  });
  // The rail (RFC 0018 §4.2): the summary (the view's `summary` fields, else its `totals` group), the record's
  // details, and the timeline.
  const totalsGroup =
    view.summary === undefined
      ? view.sheet.find((n) => n.kind === 'group' && n.id === 'totals')
      : undefined;
  const summaryNodes: FieldNode[] =
    view.summary !== undefined
      ? view.summary.map((key) => ({ kind: 'field', id: `summary-${key}`, field: key }))
      : totalsGroup?.kind === 'group'
        ? totalsGroup.children.filter((n): n is FieldNode => n.kind === 'field')
        : [];
  const row = (node: FieldNode) => {
    const field = fields[node.field];
    if (field === undefined || !visible(node.visibleWhen)) return null;
    const Widget = registry.widget(node, field);
    return (
      <div key={node.id} className="flex items-baseline justify-between gap-3 py-1 text-sm">
        <dt className="text-muted-foreground">{node.label ?? field.label}</dt>
        <dd className="text-end font-medium tabular-nums">
          <Widget
            id={`${formId}-rail-${node.id}`}
            node={node}
            field={field}
            value={values[node.field]}
            record={values}
            readonly
          />
        </dd>
      </div>
    );
  };
  const detailNodes: FieldNode[] = ['createdBy', 'createdAt', 'updatedBy', 'updatedAt', 'company']
    .filter((key) => fields[key] !== undefined && values[key] !== undefined && values[key] !== null)
    .map((key) => ({ kind: 'field', id: `detail-${key}`, field: key }));
  const chatter =
    view.chatter === true && registry.component('chatter') !== undefined && !isNew
      ? (registry.component('chatter') as NonNullable<ReturnType<typeof registry.component>>)
      : undefined;
  const rail = (
    <>
      {summaryNodes.length === 0 ? null : (
        <section className="rounded-lg border bg-surface p-4" aria-labelledby={`${formId}-summary`}>
          <h2 id={`${formId}-summary`} className="mb-1 text-sm font-semibold">
            {t('views.summary')}
          </h2>
          <dl className="divide-y">{summaryNodes.map(row)}</dl>
        </section>
      )}
      {isNew || detailNodes.length === 0 ? null : (
        <section className="rounded-lg border bg-surface p-4" aria-labelledby={`${formId}-details`}>
          <h2 id={`${formId}-details`} className="mb-1 text-sm font-semibold">
            {t('views.details')}
          </h2>
          <dl>{detailNodes.map(row)}</dl>
        </section>
      )}
      {chatter === undefined
        ? null
        : (() => {
            const Chatter = chatter;
            return (
              <Chatter
                node={{ kind: 'component', id: 'chatter', component: 'chatter' }}
                record={record ?? null}
                model={model}
                served={served}
                api={api}
                version={loaded.data?.etag ?? null}
                reload={() => void loaded.refetch()}
              />
            );
          })()}
    </>
  );
  const showRail = railOpen;
  // The main column: each group, notebook and table of lines a card; loose fields together.
  const sections: { key: string; nodes: FormNode[] }[] = [];
  for (const node of view.sheet) {
    if (node === totalsGroup) continue;
    const loose = node.kind === 'field' || node.kind === 'component';
    const last = sections[sections.length - 1];
    if (loose && last?.key.startsWith('loose-') === true) last.nodes.push(node);
    else sections.push({ key: loose ? `loose-${node.id}` : node.id, nodes: [node] });
  }
  // The key facts under the title: the view's `subtitle`, else the first many2one, date and monetary fields.
  const flatFields = (nodes: readonly FormNode[]): FieldNode[] =>
    nodes.flatMap((n) =>
      n.kind === 'field'
        ? [n]
        : n.kind === 'group'
          ? flatFields(n.children)
          : n.kind === 'notebook'
            ? n.pages.flatMap((p) => flatFields(p.children))
            : [],
    );
  const facts: FieldNode[] = isNew
    ? []
    : view.subtitle !== undefined
      ? view.subtitle
          .filter((key) => fields[key] !== undefined)
          .map((key) => ({ kind: 'field', id: `fact-${key}`, field: key }))
      : (() => {
          const candidates = flatFields(view.sheet).filter(
            (n) =>
              n.field !== statusbar &&
              values[n.field] !== null &&
              values[n.field] !== undefined &&
              values[n.field] !== '',
          );
          const first = (kinds: readonly string[]) =>
            candidates.find((n) => kinds.includes(fields[n.field]?.kind ?? ''));
          // The total, when the summary has one; else its first amount.
          const totals =
            summaryNodes.find((n) => n.field === 'amountTotal') ??
            summaryNodes.find((n) => fields[n.field]?.kind === 'monetary');
          return [first(['many2one']), first(['date']), totals ?? first(['monetary'])].filter(
            (n): n is FieldNode => n !== undefined,
          );
        })();
  const named = [values['displayName'], values['name']].find(
    (v) => typeof v === 'string' && v.trim() !== '',
  );
  const title = named === undefined ? (isNew ? t('views.new') : `#${recordId}`) : String(named);

  return (
    <PrefetchedNames.Provider value={names}>
      <form
        aria-label={title}
        data-kosh-form
        className={cn('grid gap-4', !isNew && 'kosh-quiet')}
        onSubmit={(e) => {
          e.preventDefault();
          if (dirty && !locked) save.mutate();
        }}
      >
        <div className="sticky top-12 z-20 -mx-4 flex flex-wrap items-center justify-between gap-2 border-b bg-background/95 px-4 py-2 backdrop-blur">
          <div className="flex min-w-0 items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t('views.back')}
              data-kosh-back
              onClick={onBack}
            >
              <ArrowLeft className="rtl:-scale-x-100" aria-hidden />
            </Button>
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-2.5">
                <h1 className="truncate text-xl font-semibold">{title}</h1>
                {statusbar === undefined || fields[statusbar] === undefined || isNew ? null : (
                  <StatusChip
                    field={fields[statusbar]}
                    value={state}
                    transitions={served.transitions.filter((tr) => tr.field === statusbar)}
                  />
                )}
                {locked && !isNew ? (
                  <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                    {t('views.readonly')}
                  </span>
                ) : null}
              </div>
              {facts.length === 0 ? null : (
                <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
                  {facts.map((node, i) => {
                    const field = fields[node.field] as NonNullable<(typeof fields)[string]>;
                    const Widget = registry.widget(node, field);
                    return (
                      <span key={node.id} className="flex items-center gap-2" title={field.label}>
                        {i === 0 ? null : <span aria-hidden>·</span>}
                        <span className="sr-only">{field.label}: </span>
                        <Widget
                          id={`${formId}-fact-${node.id}`}
                          node={node}
                          field={field}
                          value={values[node.field]}
                          record={values}
                          readonly
                        />
                      </span>
                    );
                  })}
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {live.others.length === 0 ? null : (
              <ul
                className="flex items-center -space-x-1"
                aria-label={t('views.viewing', {
                  names: live.others.map((u) => u.name).join(', '),
                })}
                title={t('views.viewing', { names: live.others.map((u) => u.name).join(', ') })}
              >
                {live.others.slice(0, 4).map((u) => (
                  <li
                    key={u.uid}
                    className="flex size-6 items-center justify-center rounded-full border-2 border-surface bg-accent text-[10px] font-semibold text-accent-foreground"
                  >
                    {u.name
                      .split(/\s+/)
                      .slice(0, 2)
                      .map((w) => w.charAt(0).toUpperCase())
                      .join('')}
                  </li>
                ))}
              </ul>
            )}
            <span
              aria-live="polite"
              className="flex items-center gap-1 text-xs text-muted-foreground"
            >
              {locked ? null : save.isPending ? (
                t('views.saving')
              ) : dirty ? (
                <>
                  <CircleDot className="size-3 text-warning-text" aria-hidden />
                  {t('views.unsaved')}
                </>
              ) : save.isSuccess ? (
                <>
                  <Check className="size-3 text-success" aria-hidden />
                  {t('views.allSaved')}
                </>
              ) : null}
            </span>
            {pager === undefined ? null : (
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <span className="tabular-nums">
                  {t('views.position', { position: pager.position, total: pager.total })}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t('views.previousRecord')}
                  disabled={pager.onPrev === undefined}
                  data-kosh-prev
                  onClick={pager.onPrev}
                >
                  <ChevronLeft className="rtl:-scale-x-100" aria-hidden />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t('views.nextRecord')}
                  disabled={pager.onNext === undefined}
                  data-kosh-next
                  onClick={pager.onNext}
                >
                  <ChevronRight className="rtl:-scale-x-100" aria-hidden />
                </Button>
              </div>
            )}
            {dirty && !locked ? (
              <>
                <Button
                  type="button"
                  onClick={() => {
                    setChanges({});
                    setLines(new Map());
                    setProblem(null);
                  }}
                >
                  {t('views.discard')}
                </Button>
                <Button type="submit" variant="primary" busy={save.isPending} data-kosh-save>
                  {t('views.save')}
                </Button>
              </>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="hidden xl:inline-flex"
              aria-pressed={railOpen}
              aria-label={railOpen ? t('views.hidePanel') : t('views.showPanel')}
              title={railOpen ? t('views.hidePanel') : t('views.showPanel')}
              onClick={() => setRailOpen(!railOpen)}
            >
              <PanelRight className="rtl:-scale-x-100" aria-hidden />
            </Button>
            {!isNew && served.operations.unlink ? (
              <Menu>
                <MenuTrigger asChild>
                  <Button type="button" variant="ghost" size="icon" aria-label="Actions">
                    <MoreHorizontal aria-hidden />
                  </Button>
                </MenuTrigger>
                <MenuContent>
                  <MenuItem onSelect={() => setDeleting(true)}>
                    <Trash2 className="size-4" aria-hidden />
                    {t('views.delete')}
                  </MenuItem>
                </MenuContent>
              </Menu>
            ) : null}
          </div>
        </div>

        <div
          className={cn(
            'grid gap-4',
            showRail && 'xl:grid-cols-[minmax(0,1fr)_20rem] xl:items-start',
          )}
        >
          <div className="grid min-w-0 content-start gap-4">
            {live.changedByOther ? (
              <Alert
                tone="warning"
                action={
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => {
                      setChanges({});
                      setLines(new Map());
                      live.dismiss();
                      void loaded.refetch();
                    }}
                  >
                    {t('views.reload')}
                  </Button>
                }
              >
                {t('views.changedByOther')}
              </Alert>
            ) : null}
            {problem === null ? null : (
              <Alert
                tone={problem.kind === 'stale-record' ? 'warning' : 'danger'}
                action={
                  problem.kind === 'stale-record' ? (
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => {
                        setChanges({});
                        setProblem(null);
                        void loaded.refetch();
                      }}
                    >
                      {t('views.reload')}
                    </Button>
                  ) : undefined
                }
              >
                {problem.kind === 'stale-record' ? t('views.stale') : problem.message}
              </Alert>
            )}
            {warnings.map((w) => (
              <Alert key={w} tone="info">
                {w}
              </Alert>
            ))}

            {buttons.length === 0 ? null : (
              <div
                role="toolbar"
                aria-label={t('views.recordActions')}
                className="flex flex-wrap gap-2"
              >
                <div className="contents">
                  {buttons.map((b, i) => (
                    <Button
                      key={b.id}
                      type="button"
                      size="sm"
                      variant={
                        b.primary === true || (i === 0 && !buttons.some((x) => x.primary === true))
                          ? 'primary'
                          : 'secondary'
                      }
                      busy={transition.isPending && transition.variables === b.transition}
                      onClick={() =>
                        b.confirm === undefined ? transition.mutate(b.transition) : setConfirming(b)
                      }
                    >
                      {b.label ?? b.transition}
                    </Button>
                  ))}
                </div>
              </div>
            )}

            {sections.map((section) =>
              section.nodes[0]?.kind === 'stats' ? (
                // The tiles of related records stand on their own, not in a card.
                <div key={section.key} className="grid">
                  {renderNodes(section.nodes)}
                </div>
              ) : (
                <section key={section.key} className="rounded-lg border bg-surface p-5">
                  <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
                    {renderNodes(section.nodes)}
                  </div>
                </section>
              ),
            )}

            {showRail ? null : rail}
          </div>
          {showRail ? (
            <aside
              aria-label={t('views.recordPanel')}
              // Beside the record when wide; under it otherwise (one grid column).
              className="grid content-start gap-4 xl:sticky xl:top-28"
            >
              {rail}
            </aside>
          ) : null}
        </div>
      </form>

      <Dialog
        open={confirming !== null}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={confirming?.label ?? confirming?.transition ?? ''}
        description={confirming?.confirm ?? ''}
        footer={
          <>
            <Button onClick={() => setConfirming(null)}>{t('views.no')}</Button>
            <Button
              variant="primary"
              onClick={() => {
                if (confirming !== null) transition.mutate(confirming.transition);
                setConfirming(null);
              }}
            >
              {t('views.yes')}
            </Button>
          </>
        }
      />
      <Dialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t('views.confirmDelete')}
        footer={
          <>
            <Button onClick={() => setDeleting(false)}>{t('views.no')}</Button>
            <Button variant="danger" busy={remove.isPending} onClick={() => remove.mutate()}>
              {t('views.delete')}
            </Button>
          </>
        }
      />
    </PrefetchedNames.Provider>
  );
}
