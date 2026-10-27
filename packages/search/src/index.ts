/**
 * @packageDocumentation
 * `@kosh/search` (RFC 0004 §5): the shared search layer. A search state (text facets, filters, group-by, order,
 * a custom domain) compiles to one Shutro domain + grouping that every view uses, so a filter means the same in a
 * list, a kanban and a pivot. The server validates the result (paths, operators, field security); the state
 * round-trips through the URL for deep links and saved views.
 */
import type { Condition, SearchSpec } from '@kosh/views';

/** What the user selected. */
export interface SearchState {
  /** Search-box facets: `field` is one of the spec's fields; values of the same field combine with OR. */
  readonly facets?: readonly { readonly field: string; readonly values: readonly string[] }[];
  /** Selected filter keys of the spec. */
  readonly filters?: readonly string[];
  /** Group-by options of the spec, outermost first (`partner`, `dateOrder:month`). */
  readonly groupBy?: readonly string[];
  readonly order?: readonly string[];
  /** A domain built in the custom filter editor or by the assistant (validated by the server). */
  readonly custom?: Condition;
  /** What the custom domain means, shown on its chip ("unpaid invoices from Dhaka"). */
  readonly customLabel?: string;
}

/** The compiled search. */
export interface CompiledSearch {
  /** `undefined` when nothing restricts the search. */
  readonly where: Condition | undefined;
  readonly groupBy: readonly string[];
  readonly order: readonly string[];
}

/** A search state that does not fit the spec. */
export class SearchError extends Error {
  constructor(problem: string) {
    super(problem);
    this.name = 'SearchError';
  }
}

/** A case-insensitive "contains" on a field path; LIKE wildcards typed by the user are literal. */
function textCondition(path: string, value: string): Condition {
  const escaped = value.replace(/[\\%_]/g, (c) => `\\${c}`);
  return { [path]: { ilike: `%${escaped}%` } };
}

const and = (parts: Condition[]): Condition | undefined =>
  parts.length === 0 ? undefined : parts.length === 1 ? parts[0] : { and: parts };
const or = (parts: Condition[]): Condition | undefined =>
  parts.length === 0 ? undefined : parts.length === 1 ? parts[0] : { or: parts };

/**
 * Compiles a search state. Filters of the same `group` combine with OR, groups with AND (Odoo's familiar rule);
 * `base` (the action's fixed domain) always applies. @throws {SearchError} for keys the spec does not offer
 */
export function compileSearch(
  spec: SearchSpec,
  state: SearchState,
  base?: Condition,
): CompiledSearch {
  const parts: Condition[] = base === undefined || Object.keys(base).length === 0 ? [] : [base];
  for (const facet of state.facets ?? []) {
    if (!spec.fields.includes(facet.field))
      throw new SearchError(`'${facet.field}' is not a search field.`);
    const values = facet.values.map((v) => v.trim()).filter((v) => v !== '');
    const condition = or(values.map((v) => textCondition(facet.field, v)));
    if (condition !== undefined) parts.push(condition);
  }
  const groups = new Map<string, Condition[]>();
  for (const key of state.filters ?? []) {
    const filter = spec.filters?.[key];
    if (filter === undefined) throw new SearchError(`'${key}' is not a filter.`);
    const group = filter.group ?? key;
    groups.set(group, [...(groups.get(group) ?? []), filter.domain]);
  }
  for (const domains of groups.values()) {
    const condition = or(domains);
    if (condition !== undefined) parts.push(condition);
  }
  if (state.custom !== undefined && Object.keys(state.custom).length > 0) parts.push(state.custom);
  for (const option of state.groupBy ?? [])
    if (!(spec.groupBy ?? []).includes(option))
      throw new SearchError(`'${option}' is not a group-by option.`);
  return {
    where: and(parts),
    groupBy: [...(state.groupBy ?? [])],
    order: [...(state.order ?? [])],
  };
}

/** Facets for a text typed in the search box: one suggestion per search field. */
export function suggestions(spec: SearchSpec, text: string): { field: string; value: string }[] {
  const value = text.trim();
  return value === '' ? [] : spec.fields.map((field) => ({ field, value }));
}

/** Adds a value to the facet of `field` (OR within a field). */
export function addFacet(state: SearchState, field: string, value: string): SearchState {
  const facets = [...(state.facets ?? [])];
  const index = facets.findIndex((f) => f.field === field);
  if (index < 0) facets.push({ field, values: [value] });
  else {
    const facet = facets[index] as { field: string; values: readonly string[] };
    if (!facet.values.includes(value)) facets[index] = { field, values: [...facet.values, value] };
  }
  return { ...state, facets };
}

export function removeFacet(state: SearchState, field: string): SearchState {
  return { ...state, facets: (state.facets ?? []).filter((f) => f.field !== field) };
}

/** Adds or removes `key`. */
export function toggle(list: readonly string[] | undefined, key: string): string[] {
  const current = list ?? [];
  return current.includes(key) ? current.filter((k) => k !== key) : [...current, key];
}

/** True when nothing is selected. */
export function isEmpty(state: SearchState): boolean {
  return (
    (state.facets ?? []).length === 0 &&
    (state.filters ?? []).length === 0 &&
    (state.groupBy ?? []).length === 0 &&
    (state.custom === undefined || Object.keys(state.custom).length === 0)
  );
}

/** The state as one URL parameter value (compact JSON, empty parts left out). */
export function encodeSearch(state: SearchState): string {
  const compact: Record<string, unknown> = {};
  if ((state.facets ?? []).length > 0)
    compact['f'] = (state.facets ?? []).map((f) => [f.field, ...f.values]);
  if ((state.filters ?? []).length > 0) compact['x'] = state.filters;
  if ((state.groupBy ?? []).length > 0) compact['g'] = state.groupBy;
  if ((state.order ?? []).length > 0) compact['o'] = state.order;
  if (state.custom !== undefined && Object.keys(state.custom).length > 0) {
    compact['c'] = state.custom;
    if (state.customLabel !== undefined && state.customLabel !== '')
      compact['cl'] = state.customLabel;
  }
  return Object.keys(compact).length === 0 ? '' : JSON.stringify(compact);
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];

/** Reads {@link encodeSearch}'s value; tolerant: anything malformed is dropped, never thrown. */
export function decodeSearch(text: string | null | undefined): SearchState {
  if (text === null || text === undefined || text === '') return {};
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof raw !== 'object' || raw === null) return {};
  const r = raw as Record<string, unknown>;
  const facets = (Array.isArray(r['f']) ? r['f'] : [])
    .map(strings)
    .filter((f) => f.length >= 2)
    .map(([field, ...values]) => ({ field: field as string, values }));
  const custom = r['c'];
  return {
    ...(facets.length > 0 ? { facets } : {}),
    ...(strings(r['x']).length > 0 ? { filters: strings(r['x']) } : {}),
    ...(strings(r['g']).length > 0 ? { groupBy: strings(r['g']) } : {}),
    ...(strings(r['o']).length > 0 ? { order: strings(r['o']) } : {}),
    ...(typeof custom === 'object' && custom !== null && !Array.isArray(custom)
      ? {
          custom: custom as Condition,
          ...(typeof r['cl'] === 'string' && r['cl'] !== '' ? { customLabel: r['cl'] } : {}),
        }
      : {}),
  };
}

/** Package identity. */
export const PACKAGE: { readonly name: string; readonly rfc: string } = Object.freeze({
  name: '@kosh/search',
  rfc: 'RFC 0004',
});
