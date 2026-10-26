/**
 * The report query (RFC 0005 §5): rows × columns × measures over a model in **one** statement (Shutro `aggregate`
 * over the leaf grouping), under the caller's rules and field security; subtotals and totals are rolled up from the
 * leaves on the server with exact arithmetic (identical to `GROUPING SETS`, but one hash table and parallel
 * aggregation in PostgreSQL instead of one table per level). The result is two
 * header trees (with labels and the drill-down domain of every header) and the cells per (row path, column path).
 * Monetary measures stay per currency at every level. Optional: a comparison period (previous period or year over
 * year) and `asOf` (models with history, as they were at an instant).
 */
import type { Env } from '@kosh/server/orm';

export type Condition = Readonly<Record<string, unknown>>;
export type Measure =
  | 'count'
  | { readonly sum: string }
  | { readonly avg: string }
  | { readonly min: string }
  | { readonly max: string };

/** The report query. */
export interface ReportQuery {
  readonly where?: Condition;
  readonly rows: readonly string[];
  readonly cols?: readonly string[];
  readonly measures: Readonly<Record<string, Measure>>;
  /** Compare with the previous period of the same length, or the same period a year earlier. */
  readonly comparison?: {
    readonly field: string;
    readonly from: string;
    /** Exclusive end (`2026-10-01` for September). */
    readonly to: string;
    readonly mode: 'previous' | 'yoy';
  };
  /** Read models with history as they were at this instant (ISO). */
  readonly asOf?: string;
}

/** A monetary amount. */
export interface Amount {
  readonly amount: string;
  readonly currency: string;
}
/** A measure value: count / number, exact decimal (string), or amounts per currency. */
export type Value = number | string | readonly Amount[] | null;

/** A row or column header. */
export interface Header {
  /** Stable key of the path (`[]` is the total). */
  readonly key: string;
  readonly group: string | null;
  readonly value: unknown;
  readonly label: string;
  readonly depth: number;
  /** The domain of this header's records (its path), to AND with the report's `where`. */
  readonly domain: Condition;
  readonly children: Header[];
}

export interface ReportResult {
  readonly rows: Header;
  readonly cols: Header;
  /** `cells[rowKey][colKey][measure]`. */
  readonly cells: Readonly<
    Record<string, Readonly<Record<string, Readonly<Record<string, Value>>>>>
  >;
  readonly comparison?: {
    readonly from: string;
    readonly to: string;
    readonly cells: Readonly<
      Record<string, Readonly<Record<string, Readonly<Record<string, Value>>>>>
    >;
  };
  /** Statements issued (1, or 2 with a comparison): the "one query per pivot" budget, observable. */
  readonly statements: number;
}

export class ReportError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'ReportError';
  }
}

type Row = Record<string, unknown>;
interface Aggregatable {
  aggregate(query: unknown): Promise<Row[]>;
}

/** Field metadata the engine needs (from the API metadata). */
export interface FieldInfo {
  readonly kind: string;
  readonly label: string;
  readonly target: string | null;
  readonly options: readonly (readonly [string, string])[] | null;
}

const GRANULARITY = /^(.+):(day|week|month|quarter|year)$/;

// ------------------------------------------------------------------------------------------------- dates

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const parse = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00Z`);

/** The start of the bucket after `start` (`YYYY-MM-DD`). */
export function nextBucket(start: string, granularity: string): string {
  const d = parse(start);
  switch (granularity) {
    case 'day':
      d.setUTCDate(d.getUTCDate() + 1);
      break;
    case 'week':
      d.setUTCDate(d.getUTCDate() + 7);
      break;
    case 'month':
      d.setUTCMonth(d.getUTCMonth() + 1);
      break;
    case 'quarter':
      d.setUTCMonth(d.getUTCMonth() + 3);
      break;
    default:
      d.setUTCFullYear(d.getUTCFullYear() + 1);
  }
  return iso(d);
}

/** The instant a local date starts in `tz` (for datetime buckets in the user's time zone). */
export function zonedStart(date: string, tz: string): Date {
  const utc = parse(date);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(utc);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const local = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return new Date(utc.getTime() - (local - utc.getTime()));
}

/** Shifts a date by the comparison offset. */
function shift(date: string, mode: 'previous' | 'yoy', days: number, back: boolean): string {
  const d = parse(date);
  if (mode === 'yoy') d.setUTCFullYear(d.getUTCFullYear() + (back ? -1 : 1));
  else d.setUTCDate(d.getUTCDate() + (back ? -days : days));
  return iso(d);
}

/** The bucket of `date` (the first day of its day / week / month / quarter / year). */
function bucketOf(date: string, granularity: string): string {
  const d = parse(date);
  switch (granularity) {
    case 'week': {
      const day = (d.getUTCDay() + 6) % 7; // ISO weeks start on Monday (PostgreSQL date_trunc)
      d.setUTCDate(d.getUTCDate() - day);
      return iso(d);
    }
    case 'month':
      return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-01`;
    case 'quarter':
      return `${d.getUTCFullYear()}-${pad(Math.floor(d.getUTCMonth() / 3) * 3 + 1)}-01`;
    case 'year':
      return `${d.getUTCFullYear()}-01-01`;
    default:
      return iso(d);
  }
}

// ------------------------------------------------------------------------------------------------- engine

/** The domain of one group value. */
function domainOf(
  group: string,
  value: unknown,
  fields: ReadonlyMap<string, FieldInfo>,
  tz: string,
): Condition {
  const match = GRANULARITY.exec(group);
  if (match === null) return { [group]: value ?? null };
  const [, field = '', granularity = 'day'] = match;
  if (value === null || value === undefined) return { [field]: null };
  const start = String(value);
  const end = nextBucket(start, granularity);
  if (fields.get(field)?.kind === 'datetime')
    return {
      [field]: { gte: zonedStart(start, tz).toISOString(), lt: zonedStart(end, tz).toISOString() },
    };
  return { [field]: { gte: start, lt: end } };
}

const pathKey = (values: readonly unknown[]): string => JSON.stringify(values);

function money(value: unknown): Amount | null {
  if (value === null || value === undefined) return null;
  const json =
    typeof (value as { toJSON?: unknown }).toJSON === 'function'
      ? (value as { toJSON(): unknown }).toJSON()
      : value;
  if (typeof json === 'object' && json !== null && 'amount' in json && 'currency' in json)
    return {
      amount: String((json as { amount: unknown }).amount),
      currency: String((json as { currency: unknown }).currency),
    };
  return null;
}

function plain(value: unknown): Value {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  const m = money(value);
  if (m !== null) return [m];
  return String(value); // Decimal
}

/** Exact sum of two decimal strings. */
export function addDecimal(a: string, b: string): string {
  const scale = Math.max((a.split('.')[1] ?? '').length, (b.split('.')[1] ?? '').length);
  const total = units(a, scale) + units(b, scale);
  return fromUnits(total, scale);
}

function units(x: string, scale: number): bigint {
  const [whole = '0', frac = ''] = x.replace('-', '').split('.');
  const n = BigInt(whole + frac.padEnd(scale, '0').slice(0, scale));
  return x.startsWith('-') ? -n : n;
}

function fromUnits(total: bigint, scale: number): string {
  const negative = total < 0n;
  const digits = (negative ? -total : total).toString().padStart(scale + 1, '0');
  const text = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return negative ? `-${text}` : text;
}

const COUNT = '$n'; // hidden count per leaf: weights averages when rolling up

/** Running state of one cell's measure while leaves are rolled up. */
interface Partial {
  value: Value;
  /** For averages: the exact weighted sum (as units at `scale`) and the count. */
  avgUnits?: bigint;
  avgScale?: number;
  avgCount?: number;
}

/**
 * Adds a leaf row to a cell. Counts and sums add exactly (decimals as strings, amounts per currency), min / max
 * compare, averages are weighted by the leaf's count.
 */
function accumulate(
  cell: Record<string, Partial>,
  row: Row,
  measures: Readonly<Record<string, Measure>>,
): void {
  const n = Number(row[COUNT] ?? 0);
  for (const [name, spec] of Object.entries(measures)) {
    const value = plain(row[name]);
    const op = spec === 'count' ? 'count' : (Object.keys(spec)[0] as string);
    const slot = cell[name] ?? { value: null };
    cell[name] = slot;
    if (value === null) continue;
    if (Array.isArray(value)) {
      // Amounts: one entry per currency, summed exactly.
      const current = Array.isArray(slot.value) ? [...(slot.value as Amount[])] : [];
      for (const a of value as Amount[]) {
        const i = current.findIndex((c) => c.currency === a.currency);
        if (i < 0) current.push(a);
        else {
          const before = current[i] as Amount;
          current[i] =
            op === 'sum' || op === 'count'
              ? { currency: a.currency, amount: addDecimal(before.amount, a.amount) }
              : op === 'min'
                ? Number(a.amount) < Number(before.amount)
                  ? a
                  : before
                : op === 'max'
                  ? Number(a.amount) > Number(before.amount)
                    ? a
                    : before
                  : before;
        }
      }
      slot.value = current;
      continue;
    }
    if (slot.value === null) {
      slot.value = value;
      if (op === 'avg') {
        const scale = (String(value).split('.')[1] ?? '').length;
        slot.avgScale = scale;
        slot.avgUnits = units(String(value), scale) * BigInt(n);
        slot.avgCount = n;
      }
      continue;
    }
    if (Array.isArray(slot.value)) continue;
    const before = slot.value;
    if (op === 'count' || op === 'sum')
      slot.value =
        typeof before === 'number' && typeof value === 'number'
          ? before + value
          : addDecimal(String(before), String(value));
    else if (op === 'min') slot.value = Number(value) < Number(before) ? value : before;
    else if (op === 'max') slot.value = Number(value) > Number(before) ? value : before;
    else {
      const scale = Math.max(slot.avgScale ?? 0, (String(value).split('.')[1] ?? '').length);
      const rescale = (u: bigint, from: number) => u * 10n ** BigInt(scale - from);
      slot.avgUnits =
        rescale(slot.avgUnits ?? 0n, slot.avgScale ?? 0) + units(String(value), scale) * BigInt(n);
      slot.avgScale = scale;
      slot.avgCount = (slot.avgCount ?? 0) + n;
      // The weighted mean, to `scale` + 2 places, rounded half up.
      const extra = 2;
      const scaled = slot.avgUnits * 10n ** BigInt(extra);
      const count = BigInt(Math.max(1, slot.avgCount));
      const q = (scaled + count / 2n) / count;
      slot.value = fromUnits(q, scale + extra);
    }
  }
}

function finish(
  cells: Record<string, Record<string, Record<string, Partial>>>,
): Record<string, Record<string, Record<string, Value>>> {
  const out: Record<string, Record<string, Record<string, Value>>> = {};
  for (const [rk, byCol] of Object.entries(cells)) {
    const row: Record<string, Record<string, Value>> = {};
    for (const [ck, measures] of Object.entries(byCol))
      row[ck] = Object.fromEntries(Object.entries(measures).map(([m, p]) => [m, p.value]));
    out[rk] = row;
  }
  return out;
}

/**
 * Runs the report. `labels` resolves many2one ids to display names (per target model, within the caller's rules).
 * @throws {ReportError} for invalid queries (Shutro's own errors for fields, rules and security)
 */
export async function runReport(
  env: Env,
  model: string,
  query: ReportQuery,
  fields: ReadonlyMap<string, FieldInfo>,
  labels: (target: string, ids: readonly number[]) => Promise<ReadonlyMap<number, string>>,
): Promise<ReportResult> {
  const rows = [...query.rows];
  const cols = [...(query.cols ?? [])];
  if (rows.length + cols.length > 6)
    throw new ReportError('At most 6 row and column groups together.');
  const all = [...rows, ...cols];
  if (new Set(all).size !== all.length) throw new ReportError('A group is used twice.');
  const measures = Object.keys(query.measures);
  if (measures.length === 0) throw new ReportError('Give at least one measure.');
  if (measures.some((m) => m.startsWith('$') || all.includes(m)))
    throw new ReportError('Measure names must differ from groups.');
  // Every row level × every column level: (R + 1) × (C + 1) grouping sets, one statement.
  const sets: string[][] = [];
  for (let r = rows.length; r >= 0; r--)
    for (let c = cols.length; c >= 0; c--) sets.push([...rows.slice(0, r), ...cols.slice(0, c)]);

  const and = (a: Condition | undefined, b: Condition | undefined): Condition | undefined =>
    a === undefined || Object.keys(a).length === 0 ? b : b === undefined ? a : { and: [a, b] };
  const run = async (where: Condition | undefined): Promise<Row[]> => {
    const exec = (e: Env) =>
      (e.model(model as never) as unknown as Aggregatable).aggregate({
        ...(where === undefined ? {} : { where }),
        groupBy: all,
        measures: { ...query.measures, [COUNT]: 'count' },
      });
    if (query.asOf === undefined) return exec(env);
    const instant = new Date(query.asOf);
    if (Number.isNaN(instant.getTime())) throw new ReportError('asOf is an ISO date-time.');
    return env.asOf(instant, exec);
  };

  const comparison = query.comparison;
  let base = query.where;
  let previousWhere: Condition | undefined;
  let days = 0;
  if (comparison !== undefined) {
    if (fields.get(comparison.field) === undefined)
      throw new ReportError(`Unknown comparison field '${comparison.field}'.`);
    days = Math.round(
      (parse(comparison.to).getTime() - parse(comparison.from).getTime()) / 86_400_000,
    );
    if (days <= 0) throw new ReportError('The comparison range ends before it starts.');
    base = and(query.where, { [comparison.field]: { gte: comparison.from, lt: comparison.to } });
    previousWhere = and(query.where, {
      [comparison.field]: {
        gte: shift(comparison.from, comparison.mode, days, true),
        lt: shift(comparison.to, comparison.mode, days, true),
      },
    });
  }
  // A many2one group value may come as `{ id, … }` (targets with a record name): keys and labels use the id.
  const idOf = (value: unknown): unknown =>
    typeof value === 'object' && value !== null && 'id' in value
      ? Number((value as { id: unknown }).id)
      : value;
  const normalize = (rows: readonly Row[]): Row[] =>
    rows.map((row) => {
      const out: Record<string, unknown> = { ...row };
      for (const group of all) {
        const info = fields.get(group.split(':')[0] as string);
        if (info?.kind === 'many2one') out[group] = idOf(row[group]);
      }
      return out as Row;
    });
  const current = normalize(await run(base));
  const previous = previousWhere === undefined ? undefined : normalize(await run(previousWhere));

  // Labels: selection options, many2one display names, dates as they are (the client formats them).
  const idsByTarget = new Map<string, Set<number>>();
  for (const group of all) {
    const info = fields.get(group.split(':')[0] as string);
    if (info?.kind !== 'many2one' || info.target === null) continue;
    const set = idsByTarget.get(info.target) ?? new Set<number>();
    for (const row of [...current, ...(previous ?? [])])
      if (typeof row[group] === 'number') set.add(row[group] as number);
    idsByTarget.set(info.target, set);
  }
  const names = new Map<string, ReadonlyMap<number, string>>();
  for (const [target, ids] of idsByTarget)
    names.set(target, ids.size === 0 ? new Map() : await labels(target, [...ids]));
  const label = (group: string, value: unknown): string => {
    if (value === null || value === undefined) return '';
    const info = fields.get(group.split(':')[0] as string);
    const option = info?.options?.find(([v]) => v === value);
    if (option !== undefined) return option[1];
    if (info?.kind === 'many2one' && info.target !== null)
      return names.get(info.target)?.get(value as number) ?? `#${String(value)}`;
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    return String(value);
  };

  const tz = env.tz;
  const tree = (groups: readonly string[], source: readonly Row[]): Header => {
    const root: Header = {
      key: pathKey([]),
      group: null,
      value: null,
      label: '',
      depth: 0,
      domain: {},
      children: [],
    };
    const index = new Map<string, Header>([[root.key, root]]);
    for (const row of source) {
      const depth = groups.length;
      const path: unknown[] = [];
      let parent = root;
      for (let i = 0; i < depth; i++) {
        const group = groups[i] as string;
        path.push(row[group] ?? null);
        const key = pathKey(path);
        let node = index.get(key);
        if (node === undefined) {
          const own = domainOf(group, row[group], fields, tz);
          node = {
            key,
            group,
            value: row[group] ?? null,
            label: label(group, row[group]),
            depth: i + 1,
            domain:
              parent.depth === 0 && parent.group === null ? own : { and: [parent.domain, own] },
            children: [],
          };
          index.set(key, node);
          parent.children.push(node);
        }
        parent = node;
      }
    }
    sortTree(root);
    return root;
  };
  // Headers in a stable order: selections as declared, many2one by name, others by value; empty last.
  const sortTree = (node: Header): void => {
    const group = node.children[0]?.group;
    if (group !== undefined && group !== null) {
      const info = fields.get(group.split(':')[0] as string);
      const options = info?.options?.map(([v]) => v);
      const rank = (h: Header): number | string =>
        options !== undefined
          ? options.indexOf(String(h.value))
          : info?.kind === 'many2one'
            ? h.label.toLowerCase()
            : (h.value as number | string);
      node.children.sort((a, b) => {
        if (a.value === null || b.value === null)
          return a.value === null ? (b.value === null ? 0 : 1) : -1;
        const x = rank(a);
        const y = rank(b);
        return x < y ? -1 : x > y ? 1 : 0;
      });
    }
    for (const child of node.children) sortTree(child);
  };

  const cellsOf = (source: readonly Row[], remap?: (group: string, value: unknown) => unknown) => {
    const cells: Record<string, Record<string, Record<string, Partial>>> = {};
    for (const row of source) {
      const values = (groups: readonly string[]) =>
        groups.map((g) => (remap === undefined ? (row[g] ?? null) : remap(g, row[g] ?? null)));
      const rowValues = values(rows);
      const colValues = values(cols);
      for (let r = rowValues.length; r >= 0; r--) {
        const rk = pathKey(rowValues.slice(0, r));
        const byRow = cells[rk] ?? {};
        cells[rk] = byRow;
        for (let c = colValues.length; c >= 0; c--) {
          const ck = pathKey(colValues.slice(0, c));
          const cell = byRow[ck] ?? {};
          byRow[ck] = cell;
          accumulate(cell, row, query.measures);
        }
      }
    }
    return finish(cells);
  };

  const result: ReportResult = {
    rows: tree(rows, current),
    cols: tree(cols, current),
    cells: cellsOf(current),
    statements: previous === undefined ? 1 : 2,
  };
  if (previous === undefined || comparison === undefined) return result;
  // Previous-period buckets of the comparison field are moved onto the current period's, so cells line up.
  const forward = (group: string, value: unknown): unknown => {
    const match = GRANULARITY.exec(group);
    if (match === null || match[1] !== comparison.field || value === null) return value;
    return bucketOf(shift(String(value), comparison.mode, days, false), match[2] as string);
  };
  return {
    ...result,
    comparison: {
      from: shift(comparison.from, comparison.mode, days, true),
      to: shift(comparison.to, comparison.mode, days, true),
      cells: cellsOf(previous, forward),
    },
  };
}
