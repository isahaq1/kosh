/**
 * The payroll formula language (RFC 0024 §2.3): small, safe and exact — never `eval`. Numbers are Shutro Decimals;
 * names in capitals are variables (`WAGE`, `ABSENT_DAYS`, `INPUT_BONUS`, `P_HOUSE_RENT_PCT`, an earlier rule's code);
 * functions are `min`, `max`, `abs`, `round(x, places)`, `floor`, `ceil`, `if(condition, then, else)` and
 * `slab('TABLE', amount)` (a progressive table, such as income tax). Comparisons (`< <= > >= == !=`) and `and`, `or`,
 * `not` give 1 or 0. A formula is at most 500 characters.
 *
 * `evaluate` returns the value and the formula with the values written in, for the payslip's explanation.
 */
import { type Decimal, orm } from '@kosh/server/orm';

export class FormulaError extends Error {
  override readonly name = 'FormulaError';
}

type Token =
  | { readonly t: 'num'; readonly v: string }
  | { readonly t: 'str'; readonly v: string }
  | { readonly t: 'name'; readonly v: string }
  | { readonly t: 'op'; readonly v: string };

const OPS = ['<=', '>=', '==', '!=', '<', '>', '+', '-', '*', '/', '(', ')', ','];

function tokenize(text: string): Token[] {
  if (text.length > 500) throw new FormulaError('A formula is at most 500 characters.');
  const out: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    const num = /^\d+(\.\d+)?/.exec(text.slice(i));
    if (num !== null) {
      out.push({ t: 'num', v: num[0] });
      i += num[0].length;
      continue;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i));
    if (name !== null) {
      out.push({ t: 'name', v: name[0] });
      i += name[0].length;
      continue;
    }
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) throw new FormulaError('A quoted name is not closed.');
      out.push({ t: 'str', v: text.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    const op = OPS.find((o) => text.startsWith(o, i));
    if (op === undefined) throw new FormulaError(`Unexpected “${c}”.`);
    out.push({ t: 'op', v: op });
    i += op.length;
  }
  return out;
}

/** A parsed formula. */
export type Node =
  | { readonly k: 'num'; readonly v: string }
  | { readonly k: 'str'; readonly v: string }
  | { readonly k: 'var'; readonly v: string }
  | { readonly k: 'neg'; readonly a: Node }
  | { readonly k: 'not'; readonly a: Node }
  | { readonly k: 'bin'; readonly op: string; readonly a: Node; readonly b: Node }
  | { readonly k: 'call'; readonly f: string; readonly args: readonly Node[] };

const FUNCTIONS: Readonly<Record<string, [number, number]>> = {
  min: [1, 20],
  max: [1, 20],
  abs: [1, 1],
  round: [1, 2],
  floor: [1, 1],
  ceil: [1, 1],
  if: [3, 3],
  slab: [2, 2],
};

/** Parses a formula. @throws {FormulaError} on a mistake, saying where */
export function parse(text: string): Node {
  const tokens = tokenize(text);
  let p = 0;
  const peek = () => tokens[p];
  const isOp = (v: string) => peek()?.t === 'op' && peek()?.v === v;
  const isWord = (v: string) => peek()?.t === 'name' && peek()?.v === v;
  const expect = (v: string) => {
    if (!isOp(v))
      throw new FormulaError(
        `“${v}” expected${peek() === undefined ? ' at the end' : ` before “${peek()?.v}”`}.`,
      );
    p += 1;
  };
  const or = (): Node => {
    let a = and();
    while (isWord('or')) {
      p += 1;
      a = { k: 'bin', op: 'or', a, b: and() };
    }
    return a;
  };
  const and = (): Node => {
    let a = not();
    while (isWord('and')) {
      p += 1;
      a = { k: 'bin', op: 'and', a, b: not() };
    }
    return a;
  };
  const not = (): Node => {
    if (isWord('not')) {
      p += 1;
      return { k: 'not', a: not() };
    }
    return compare();
  };
  const compare = (): Node => {
    const a = add();
    const t = peek();
    if (t?.t === 'op' && ['<', '<=', '>', '>=', '==', '!='].includes(t.v)) {
      p += 1;
      return { k: 'bin', op: t.v, a, b: add() };
    }
    return a;
  };
  const add = (): Node => {
    let a = mul();
    while (isOp('+') || isOp('-')) {
      const op = (tokens[p] as Token).v;
      p += 1;
      a = { k: 'bin', op, a, b: mul() };
    }
    return a;
  };
  const mul = (): Node => {
    let a = unary();
    while (isOp('*') || isOp('/')) {
      const op = (tokens[p] as Token).v;
      p += 1;
      a = { k: 'bin', op, a, b: unary() };
    }
    return a;
  };
  const unary = (): Node => {
    if (isOp('-')) {
      p += 1;
      return { k: 'neg', a: unary() };
    }
    return primary();
  };
  const primary = (): Node => {
    const t = peek();
    if (t === undefined) throw new FormulaError('The formula ends too early.');
    p += 1;
    if (t.t === 'num') return { k: 'num', v: t.v };
    if (t.t === 'str') return { k: 'str', v: t.v };
    if (t.t === 'op' && t.v === '(') {
      const inner = or();
      expect(')');
      return inner;
    }
    if (t.t === 'name') {
      if (isOp('(')) {
        const arity = FUNCTIONS[t.v];
        if (arity === undefined) throw new FormulaError(`There is no function “${t.v}”.`);
        p += 1;
        const args: Node[] = [];
        if (!isOp(')')) {
          args.push(or());
          while (isOp(',')) {
            p += 1;
            args.push(or());
          }
        }
        expect(')');
        if (args.length < arity[0] || args.length > arity[1])
          throw new FormulaError(
            `${t.v} takes ${arity[0] === arity[1] ? arity[0] : `${arity[0]} to ${arity[1]}`} values.`,
          );
        return { k: 'call', f: t.v, args };
      }
      if (!/^[A-Z][A-Z0-9_]*$/.test(t.v))
        throw new FormulaError(`“${t.v}”: variables are written in capitals (WAGE, ABSENT_DAYS…).`);
      return { k: 'var', v: t.v };
    }
    throw new FormulaError(`Unexpected “${t.v}”.`);
  };
  const node = or();
  if (p < tokens.length) throw new FormulaError(`Unexpected “${(tokens[p] as Token).v}”.`);
  return node;
}

/** The variables a formula reads. */
export function variablesOf(node: Node): string[] {
  switch (node.k) {
    case 'var':
      return [node.v];
    case 'neg':
    case 'not':
      return variablesOf(node.a);
    case 'bin':
      return [...variablesOf(node.a), ...variablesOf(node.b)];
    case 'call':
      return node.args.flatMap(variablesOf);
    default:
      return [];
  }
}

/** A progressive table: bands of `upTo` (null: the rest) at a rate in percent. */
export interface Slab {
  readonly bands: readonly { readonly upTo: Decimal | null; readonly rate: Decimal }[];
}

export interface Scope {
  readonly variables: ReadonlyMap<string, Decimal>;
  readonly slabs: ReadonlyMap<string, Slab>;
  /** Names read as zero when unset (inputs not given this month, nothing paid yet this year). */
  readonly zero?: (name: string) => boolean;
}

const ZERO = orm.toDecimal(0);
const ONE = orm.toDecimal(1);
const truth = (b: boolean) => (b ? ONE : ZERO);

/** The tax of `amount` by a progressive table: each band at its rate. */
export function slabTax(slab: Slab, amount: Decimal): Decimal {
  let left = amount;
  let floor = ZERO;
  let tax = ZERO;
  for (const band of slab.bands) {
    if (left.lte(0)) break;
    const width = band.upTo === null ? left : band.upTo.minus(floor);
    const part = left.lt(width) ? left : width;
    if (part.gt(0)) tax = tax.plus(part.times(band.rate).div(100));
    left = left.minus(part);
    if (band.upTo !== null) floor = band.upTo;
  }
  return tax;
}

/** Evaluates a parsed formula. @throws {FormulaError} for an unknown variable or table, or a division by zero */
export function evaluate(node: Node, scope: Scope): Decimal {
  const value = (n: Node): Decimal => {
    switch (n.k) {
      case 'num':
        return orm.toDecimal(n.v);
      case 'str':
        throw new FormulaError(`“${n.v}” is a name, not a number.`);
      case 'var': {
        const v = scope.variables.get(n.v);
        if (v !== undefined) return v;
        if (scope.zero?.(n.v) === true) return ZERO;
        throw new FormulaError(`Unknown variable ${n.v}.`);
      }
      case 'neg':
        return value(n.a).neg();
      case 'not':
        return truth(value(n.a).isZero());
      case 'bin': {
        if (n.op === 'and') return truth(!value(n.a).isZero() && !value(n.b).isZero());
        if (n.op === 'or') return truth(!value(n.a).isZero() || !value(n.b).isZero());
        const a = value(n.a);
        const b = value(n.b);
        switch (n.op) {
          case '+':
            return a.plus(b);
          case '-':
            return a.minus(b);
          case '*':
            return a.times(b);
          case '/':
            if (b.isZero()) throw new FormulaError('A division by zero.');
            return a.div(b);
          case '<':
            return truth(a.lt(b));
          case '<=':
            return truth(a.lte(b));
          case '>':
            return truth(a.gt(b));
          case '>=':
            return truth(a.gte(b));
          case '==':
            return truth(a.eq(b));
          default:
            return truth(!a.eq(b));
        }
      }
      case 'call': {
        const args = n.args;
        switch (n.f) {
          case 'if':
            return value(args[0] as Node).isZero()
              ? value(args[2] as Node)
              : value(args[1] as Node);
          case 'slab': {
            const table = args[0] as Node;
            if (table.k !== 'str')
              throw new FormulaError("slab takes the table's code in quotes: slab('TAX', amount).");
            const slab = scope.slabs.get(table.v);
            if (slab === undefined)
              throw new FormulaError(`No slab table ${table.v} for this period.`);
            return slabTax(slab, value(args[1] as Node));
          }
          case 'round': {
            const places = args.length > 1 ? Number(value(args[1] as Node).toString()) : 0;
            return value(args[0] as Node).toDecimalPlaces(places);
          }
          case 'floor':
            return value(args[0] as Node).floor();
          case 'ceil':
            return value(args[0] as Node).ceil();
          case 'abs':
            return value(args[0] as Node).abs();
          default: {
            const vs = args.map(value);
            return vs.reduce((m, v) => ((n.f === 'min' ? v.lt(m) : v.gt(m)) ? v : m));
          }
        }
      }
    }
  };
  return value(node);
}

/** The formula with its variables' values written in: `WAGE * 0.6` → `50000 × 0.6`. */
export function explain(text: string, scope: Scope): string {
  return tokenize(text)
    .map((t) => {
      if (t.t === 'name' && /^[A-Z][A-Z0-9_]*$/.test(t.v)) {
        const v = scope.variables.get(t.v) ?? (scope.zero?.(t.v) === true ? ZERO : undefined);
        return v === undefined ? t.v : v.toDecimalPlaces(2).toString();
      }
      if (t.t === 'str') return `'${t.v}'`;
      if (t.t === 'op') return t.v === '*' ? '×' : t.v === '/' ? '÷' : t.v;
      return t.v;
    })
    .join(' ')
    .replace(/\( /g, '(')
    .replace(/ \)/g, ')')
    .replace(/ ,/g, ',');
}
