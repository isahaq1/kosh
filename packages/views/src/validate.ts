/**
 * Load-time checks of views, actions and searches against the installed models (RFC 0004 §5): unknown fields,
 * transitions, relation targets and group-by fields fail when the server starts, never when a user opens a screen.
 */
import { nodesOf } from './extend.js';
import type { FieldNode, MeasureNode, SearchSpec, ViewDefinition, WindowAction } from './types.js';

/** What validation needs to know about a model. */
export interface ModelInfo {
  readonly fields: ReadonlyMap<
    string,
    { readonly kind: string; readonly target: string | null; readonly stored: boolean }
  >;
  readonly transitions: readonly string[];
}
export type ModelLookup = (model: string) => ModelInfo | undefined;

const GROUPABLE = new Set([
  'selection',
  'state',
  'many2one',
  'boolean',
  'char',
  'date',
  'datetime',
]);

/** Follows `a.b.c` through relations; returns the problem, or `null`. */
function pathProblem(models: ModelLookup, model: string, path: string): string | null {
  let current = model;
  const parts = path.split('.');
  for (const [i, key] of parts.entries()) {
    const info = models(current);
    const field = info?.fields.get(key);
    if (field === undefined) return `'${path}' (no field '${key}' on ${current})`;
    if (i < parts.length - 1) {
      if (field.target === null) return `'${path}' ('${key}' of ${current} is not a relation)`;
      current = field.target;
    }
  }
  return null;
}

/** The problems of a view (empty when valid). */
export function validateView(view: ViewDefinition, models: ModelLookup): string[] {
  const info = models(view.model);
  if (info === undefined) return [`the model '${view.model}' is not installed`];
  const problems: string[] = [];
  const checkField = (node: FieldNode, model: string): void => {
    const problem = pathProblem(models, model, node.field);
    if (problem !== null) problems.push(`unknown field ${problem}`);
  };
  for (const node of nodesOf(view)) {
    if (node.kind === 'field') {
      // Columns of `lines` are checked against the related model below.
      if (view.type === 'form' && isLineColumn(view, node)) continue;
      checkField(node, view.model);
    }
    if (node.kind === 'lines') {
      const field = info.fields.get(node.field);
      if (field === undefined || field.kind !== 'one2many' || field.target === null)
        problems.push(`'${node.field}' is not a one2many of ${view.model}`);
      else for (const column of node.columns) checkField(column, field.target);
    }
    if (node.kind === 'button' && !info.transitions.includes(node.transition))
      problems.push(
        `unknown transition '${node.transition}' (has ${info.transitions.join(', ') || 'none'})`,
      );
  }
  if (view.type === 'form' && view.header.statusbar !== undefined) {
    const kind = info.fields.get(view.header.statusbar)?.kind;
    if (kind !== 'state' && kind !== 'selection')
      problems.push(`statusbar '${view.header.statusbar}' is not a state or selection field`);
  }
  if (view.type === 'kanban') {
    const group = info.fields.get(view.groupBy);
    if (group === undefined || !GROUPABLE.has(group.kind) || !group.stored)
      problems.push(
        `kanban groupBy '${view.groupBy}' is not a stored selection, state, many2one or char field`,
      );
    for (const key of [view.card.title, view.card.subtitle].filter(
      (k): k is string => k !== undefined,
    ))
      if (pathProblem(models, view.model, key) !== null)
        problems.push(`unknown card field '${key}'`);
  }
  problems.push(...reportProblems(view, info, models));
  if (view.type === 'list')
    for (const term of view.defaultOrder ?? []) {
      const key = term.split(/\s+/)[0] ?? '';
      if (info.fields.get(key)?.stored !== true)
        problems.push(`defaultOrder '${term}' is not a stored field`);
    }
  return problems;
}

function isLineColumn(view: ViewDefinition, node: FieldNode): boolean {
  return nodesOf(view).some((n) => n.kind === 'lines' && n.columns.includes(node));
}

/** The problems of an action. */
export function validateAction(
  action: WindowAction,
  models: ModelLookup,
  views: ReadonlyMap<string, ViewDefinition>,
): string[] {
  if (models(action.model) === undefined) return [`the model '${action.model}' is not installed`];
  const problems: string[] = [];
  if (action.views.length === 0) problems.push('no view types');
  for (const [type, id] of Object.entries(action.viewIds ?? {})) {
    const view = views.get(id as string);
    if (view === undefined) problems.push(`unknown view '${id}'`);
    else if (view.type !== type || view.model !== action.model)
      problems.push(
        `view '${id}' is a ${view.type} of ${view.model}, not a ${type} of ${action.model}`,
      );
  }
  return problems;
}

/** The problems of a search definition. */
export function validateSearch(model: string, spec: SearchSpec, models: ModelLookup): string[] {
  if (models(model) === undefined) return [`the model '${model}' is not installed`];
  const problems: string[] = [];
  for (const path of spec.fields) {
    const p = pathProblem(models, model, path);
    if (p !== null) problems.push(`unknown search field ${p}`);
  }
  for (const option of spec.groupBy ?? []) {
    const [key = '', granularity] = option.split(':');
    const field = models(model)?.fields.get(key);
    if (field === undefined || !field.stored)
      problems.push(`group-by '${option}' is not a stored field`);
    else if (granularity !== undefined && field.kind !== 'date' && field.kind !== 'datetime')
      problems.push(`group-by '${option}': a granularity needs a date field`);
  }
  return problems;
}

const NUMERIC = new Set(['integer', 'float', 'decimal', 'monetary']);
const DATES = new Set(['date', 'datetime']);
const GROUPS = new Set([
  'char',
  'selection',
  'state',
  'boolean',
  'integer',
  'date',
  'datetime',
  'many2one',
]);

/** Checks of the report views (pivot, graph, calendar, gantt, map, hierarchy, cohort). */
function reportProblems(view: ViewDefinition, info: ModelInfo, models: ModelLookup): string[] {
  const problems: string[] = [];
  const field = (key: string) => info.fields.get(key);
  const group = (option: string) => {
    const [key = '', granularity, extra] = option.split(':');
    const f = field(key);
    if (f === undefined || !f.stored || !GROUPS.has(f.kind) || extra !== undefined)
      problems.push(
        `'${option}' cannot group ${view.model} (a stored char, selection, state, boolean, integer, date or many2one field)`,
      );
    else if (granularity !== undefined && !DATES.has(f.kind))
      problems.push(`'${option}': a granularity needs a date field`);
    else if (granularity === undefined && f.kind === 'datetime')
      problems.push(`'${option}' is a datetime: give a granularity (e.g. ${key}:month)`);
  };
  const measure = (m: MeasureNode) => {
    if (m.measure === 'count') return;
    const key = Object.values(m.measure)[0] as string;
    const f = field(key);
    if (f === undefined || !f.stored || !NUMERIC.has(f.kind))
      problems.push(`measure '${m.id}': '${key}' is not a stored numeric field`);
  };
  const date = (key: string, what: string) => {
    const f = field(key);
    if (f === undefined || !DATES.has(f.kind) || !f.stored)
      problems.push(`${what} '${key}' is not a stored date or datetime field`);
  };
  const exists = (key: string | undefined, what: string) => {
    if (key !== undefined && pathProblem(models, view.model, key) !== null)
      problems.push(`unknown ${what} field '${key}'`);
  };
  switch (view.type) {
    case 'pivot':
      for (const g of [...view.rows, ...view.cols]) group(g);
      if (view.rows.length + view.cols.length > 6) problems.push('at most 6 row and column groups');
      if (view.measures.length === 0) problems.push('no measures');
      for (const m of view.measures) measure(m);
      if (view.comparison !== undefined) date(view.comparison.field, 'comparison field');
      break;
    case 'graph':
      for (const g of view.groupBy) group(g);
      measure(view.measure);
      if (view.comparison !== undefined) date(view.comparison.field, 'comparison field');
      break;
    case 'calendar':
      date(view.dateStart, 'dateStart');
      if (view.dateStop !== undefined) date(view.dateStop, 'dateStop');
      exists(view.title, 'title');
      exists(view.color, 'color');
      break;
    case 'gantt':
      date(view.dateStart, 'dateStart');
      date(view.dateStop, 'dateStop');
      exists(view.title, 'title');
      if (view.groupBy !== undefined) group(view.groupBy);
      if (view.progress !== undefined && !NUMERIC.has(field(view.progress)?.kind ?? ''))
        problems.push(`progress '${view.progress}' is not numeric`);
      break;
    case 'map':
      for (const key of [view.latitude, view.longitude])
        if (!NUMERIC.has(field(key)?.kind ?? ''))
          problems.push(`'${key}' is not a numeric (coordinate) field`);
      exists(view.title, 'title');
      exists(view.subtitle, 'subtitle');
      break;
    case 'hierarchy': {
      const parent = field(view.parent);
      if (parent?.kind !== 'many2one' || parent.target !== view.model)
        problems.push(`parent '${view.parent}' is not a many2one to ${view.model}`);
      exists(view.title, 'title');
      exists(view.subtitle, 'subtitle');
      break;
    }
    case 'cohort':
      date(view.dateStart, 'dateStart');
      date(view.dateStop, 'dateStop');
      break;
    default:
      break;
  }
  return problems;
}
