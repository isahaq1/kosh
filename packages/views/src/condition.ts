/**
 * Client-side evaluation of view conditions (`readonlyWhen`, `visibleWhen`): the subset of Shutro domains that only
 * needs the record's own values. Paths through relations (`partner.country`) cannot be decided here and yield
 * `undefined` (RFC 0004 §7: the server ships such results with the record). The display only: the server
 * re-checks every write.
 */
import type { Condition } from './types.js';

/** Values `$env` placeholders resolve to. */
export interface ConditionEnv {
  readonly uid: number;
  readonly companyId: number;
  readonly companyIds?: readonly number[];
}

const OPERATORS = new Set([
  'eq',
  'ne',
  'lt',
  'lte',
  'gt',
  'gte',
  'in',
  'notIn',
  'isNull',
  'like',
  'ilike',
]);

function resolve(value: unknown, env: ConditionEnv): unknown {
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && '$env' in value) {
    const key = (value as { $env: unknown }).$env;
    if (key === 'uid') return env.uid;
    if (key === 'companyId') return env.companyId;
    if (key === 'companyIds') return env.companyIds ?? [env.companyId];
    return undefined;
  }
  return Array.isArray(value) ? value.map((v) => resolve(v, env)) : value;
}

/** Compares numbers and numeric strings (decimals are strings) numerically, everything else as text. */
function compare(a: unknown, b: unknown): number {
  const x = Number(a);
  const y = Number(b);
  if (a !== null && b !== null && a !== '' && b !== '' && !Number.isNaN(x) && !Number.isNaN(y))
    return x - y;
  return String(a).localeCompare(String(b));
}

const idOf = (v: unknown): unknown =>
  typeof v === 'object' && v !== null && 'id' in v ? (v as { id: unknown }).id : v;

function likeToRegExp(pattern: string, flags: string): RegExp {
  const escaped = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replaceAll('%', '.*')
    .replaceAll('_', '.');
  return new RegExp(`^${escaped}$`, flags);
}

function test(op: string, actual: unknown, expected: unknown): boolean {
  const a = idOf(actual);
  switch (op) {
    case 'eq':
      return expected === null
        ? a === null || a === undefined
        : compare(a, expected) === 0 && a !== null;
    case 'ne':
      return !test('eq', actual, expected);
    case 'lt':
      return a !== null && compare(a, expected) < 0;
    case 'lte':
      return a !== null && compare(a, expected) <= 0;
    case 'gt':
      return a !== null && compare(a, expected) > 0;
    case 'gte':
      return a !== null && compare(a, expected) >= 0;
    case 'in':
      return Array.isArray(expected) && expected.some((e) => test('eq', a, e));
    case 'notIn':
      return Array.isArray(expected) && !expected.some((e) => test('eq', a, e));
    case 'isNull':
      return (a === null || a === undefined) === (expected === true);
    case 'like':
      return typeof a === 'string' && likeToRegExp(String(expected), '').test(a);
    case 'ilike':
      return typeof a === 'string' && likeToRegExp(String(expected), 'i').test(a);
    default:
      return false;
  }
}

/**
 * True only when a condition is given and holds: for `readonlyWhen` (absent: never read-only). Undecided conditions
 * (relation paths) count as not holding; the server re-checks anyway.
 */
export function holds(
  condition: Condition | undefined,
  values: Readonly<Record<string, unknown>>,
  env: ConditionEnv,
): boolean {
  return condition !== undefined && evaluate(condition, values, env) === true;
}

/**
 * Evaluates `condition` on `values`: `true`, `false`, or `undefined` when it needs data the client does not have
 * (relation paths, unknown operators).
 */
export function evaluate(
  condition: Condition | undefined,
  values: Readonly<Record<string, unknown>>,
  env: ConditionEnv,
): boolean | undefined {
  if (condition === undefined) return true;
  let unknown = false;
  for (const [key, raw] of Object.entries(condition)) {
    let result: boolean | undefined;
    if (key === 'and' || key === 'or') {
      const parts = (raw as Condition[]).map((c) => evaluate(c, values, env));
      if (key === 'and')
        result = parts.includes(false) ? false : parts.includes(undefined) ? undefined : true;
      else result = parts.includes(true) ? true : parts.includes(undefined) ? undefined : false;
    } else if (key === 'not') {
      const inner = evaluate(raw as Condition, values, env);
      result = inner === undefined ? undefined : !inner;
    } else if (key.includes('.') || !(key in values)) {
      result = undefined; // a relation path or a value not loaded: the server decides
    } else {
      const value = resolve(raw, env);
      const isOps =
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        Object.keys(value).every((k) => OPERATORS.has(k));
      result = isOps
        ? Object.entries(value as Record<string, unknown>).every(([op, v]) =>
            test(op, values[key], resolve(v, env)),
          )
        : test('eq', values[key], value);
    }
    if (result === false) return false;
    if (result === undefined) unknown = true;
  }
  return unknown ? undefined : true;
}

const idOfValue = (v: unknown): unknown =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && 'id' in v
    ? (v as { id: unknown }).id
    : v;

/**
 * A condition with its `$record` placeholders replaced by the record's values (`{ partner: { $record: 'id' } }` on
 * record 42 becomes `{ partner: 42 }`); related values give their id. For stat tiles (RFC 0022 §3.1) and any
 * filter a record page opens.
 */
export function resolveRecord(
  condition: Condition,
  values: Readonly<Record<string, unknown>>,
): Condition {
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (typeof value !== 'object' || value === null) return value;
    if ('$record' in value)
      return idOfValue(values[String((value as { $record: unknown }).$record)]) ?? null;
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
  };
  return walk(condition) as Condition;
}
