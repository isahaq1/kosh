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
import { PrefetchedNames, useRowNames } from './widgets.js';

type Values = Record<string, unknown>;

/** Edits of a one2many, sent as Shutro commands with the parent. */
interface LineState {
  readonly rows: readonly {
    readonly key: string;
    readonly id?: number;
    readonly values: Values;
    readonly dirty: boolean;
  }[];
  readonly deleted: readonly number[];
}

function commandsOf(lines: LineState): Values {
  return {
    ...(lines.rows.some((r) => r.id === undefined)
      ? { create: lines.rows.filter((r) => r.id === undefined).map((r) => r.values) }
      : {}),
    ...(lines.rows.some((r) => r.id !== undefined && r.dirty)
      ? {
          update: lines.rows
            .filter((r) => r.id !== undefined && r.dirty)
            .map((r) => ({ id: r.id, values: r.values })),
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
): Values {
  const out: Values = {};
  for (const [key, value] of Object.entries(changes)) {
    if (fields[key]?.kind === 'many2many') out[key] = { set: Array.isArray(value) ? value : [] };
    else out[key] = value;
  }
  for (const [key, state] of lines) {
    const commands = commandsOf(state);
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
  const rows =
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
                                ? { ...r, values: { ...r.values, [c.field]: value }, dirty: true }
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
        : api.get(model, recordId),
  });
  // Proposed values (from a document) are unsaved changes: Save, Discard and the leave guard apply to them.
  const proposedChanges = (): Values =>
    isNew && proposed !== undefined
      ? Object.fromEntries(proposed.map((key) => [key, defaults?.[key]]))
      : {};
  const [changes, setChanges] = useState<Values>(proposedChanges);
  const [lines, setLines] = useState<ReadonlyMap<string, LineState>>(new Map());
  const [problem, setProblem] = useState<ApiError | null>(null);
  const [warnings, setWarnings] = useState<readonly string[]>([]);
  const [confirming, setConfirming] = useState<ButtonNode | null>(null);
  const [deleting, setDeleting] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new record id starts a clean form
  useEffect(() => {
    setChanges(proposedChanges());
    setLines(new Map());
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
      const payload = payloadOf(changes, fields, lines);
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
      await queryClient.invalidateQueries({ queryKey: ['list', model] });
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

  const change = (key: string, value: unknown) => {
    const next = { ...changes, [key]: value };
    setChanges(next);
    if (!served.onchange.includes(key)) return;
    // The record's id travels on its own: it is not a field of the draft.
    const { id: _id, ...plain } = values;
    void api
      .onchange(model, {
        ...(isNew ? {} : { id: recordId }),
        values: { ...plain, [key]: value },
        changed: [key],
      })
      .then((result) => {
        const assisted: Values = {};
        // Computed values (display name, totals) come back too: shown, never written.
        for (const [k, v] of Object.entries(result.values))
          if (k !== key && k !== 'id' && fields[k]?.readonly !== true && values[k] !== v)
            assisted[k] = v;
        if (Object.keys(assisted).length > 0) setChanges((c) => ({ ...c, ...assisted }));
        setWarnings(result.warnings ?? []);
      })
      .catch(() => undefined);
  };

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
  const named = [values['displayName'], values['name']].find(
    (v) => typeof v === 'string' && v.trim() !== '',
  );
  const title = named === undefined ? (isNew ? t('views.new') : `#${recordId}`) : String(named);

  return (
    <PrefetchedNames.Provider value={names}>
      <form
        aria-label={title}
        data-kosh-form
        className="grid gap-4"
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
              {crumbs === undefined || crumbs.length === 0 ? null : (
                <nav aria-label={t('views.breadcrumbs')}>
                  <ol className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                    {crumbs.map((c, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: a crumb's position in the path is its identity (app, then list); the path is never reordered
                      <li key={i} className="flex items-center gap-1">
                        {c.onClick === undefined ? (
                          <span>{c.label}</span>
                        ) : (
                          <button
                            type="button"
                            className="hover:text-foreground hover:underline"
                            onClick={c.onClick}
                          >
                            {c.label}
                          </button>
                        )}
                        <ChevronRight className="size-3 rtl:-scale-x-100" aria-hidden />
                      </li>
                    ))}
                  </ol>
                </nav>
              )}
              <h1 className="truncate text-lg font-semibold">{title}</h1>
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

        {statusbar === undefined && buttons.length === 0 ? null : (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-surface px-3 py-2">
            <div className="flex flex-wrap gap-2">
              {buttons.map((b) => (
                <Button
                  key={b.id}
                  type="button"
                  size="sm"
                  variant={b.primary === true ? 'primary' : 'secondary'}
                  busy={transition.isPending && transition.variables === b.transition}
                  onClick={() =>
                    b.confirm === undefined ? transition.mutate(b.transition) : setConfirming(b)
                  }
                >
                  {b.label ?? b.transition}
                </Button>
              ))}
            </div>
            {statusbar === undefined ? null : (
              <ol
                aria-label={fields[statusbar]?.label ?? statusbar}
                className="flex flex-wrap items-center gap-1 text-xs"
              >
                {(fields[statusbar]?.options ?? []).map((o) => (
                  <li
                    key={o.value}
                    aria-current={o.value === state ? 'step' : undefined}
                    className={cn(
                      'rounded-full px-2.5 py-1',
                      o.value === state
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted text-muted-foreground',
                    )}
                  >
                    {o.label}
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}

        <div className="grid gap-6 rounded-lg border bg-surface p-5">
          {locked && !isNew ? (
            <p className="text-xs text-muted-foreground">{t('views.readonly')}</p>
          ) : null}
          <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">{renderNodes(view.sheet)}</div>
        </div>

        {view.chatter === true && registry.component('chatter') !== undefined && !isNew
          ? (() => {
              const Chatter = registry.component('chatter') as NonNullable<
                ReturnType<typeof registry.component>
              >;
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
            })()
          : null}
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
