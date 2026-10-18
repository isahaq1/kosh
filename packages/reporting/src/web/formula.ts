/**
 * Spreadsheet formulas: numbers, text, cell references (`A1`), ranges (`A1:B3`), `+ - * / ^`, comparisons,
 * parentheses, and functions `SUM AVERAGE MIN MAX COUNT IF ROUND ABS` plus `REPORT(model, measure, domain?)`, the
 * grand total of a report query (resolved by the caller, so sheets stay live and within the user's rules).
 * Errors are values (`#REF!`, `#DIV/0!`, `#CYCLE!`, `#NAME?`, `#VALUE!`), as in other spreadsheets.
 */

export type CellValue = number | string | boolean | null;
export type Cells = Readonly<Record<string, string>>;

/** A `REPORT()` call to resolve before evaluating: `key` identifies it, `value` comes back from the server. */
export interface ReportCall {
  readonly key: string;
  readonly model: string;
  readonly measure: string;
  readonly domain: Readonly<Record<string, unknown>> | undefined;
}

class FormulaError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

type Token =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'ref'; v: string }
  | { t: 'id'; v: string }
  | { t: 'op'; v: string };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      const m = /^\d*\.?\d+(e[+-]?\d+)?/i.exec(src.slice(i));
      if (m === null) throw new FormulaError('#VALUE!');
      out.push({ t: 'num', v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (c === '"') {
      // Strings: a backslash escapes the next character (\" is a quote), so REPORT can carry a domain as JSON.
      let text = '';
      let j = i + 1;
      for (; j < src.length && src[j] !== '"'; j++) {
        if (src[j] === '\\' && j + 1 < src.length) j++;
        text += src[j];
      }
      if (j >= src.length) throw new FormulaError('#VALUE!');
      out.push({ t: 'str', v: text });
      i = j + 1;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(src.slice(i));
    if (word !== null) {
      const w = word[0];
      out.push(
        /^[A-Za-z]{1,2}\d+$/.test(w)
          ? { t: 'ref', v: w.toUpperCase() }
          : { t: 'id', v: w.toUpperCase() },
      );
      i += w.length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['<=', '>=', '<>'].includes(two)) {
      out.push({ t: 'op', v: two });
      i += 2;
      continue;
    }
    if ('+-*/^(),:<>=&'.includes(c)) {
      out.push({ t: 'op', v: c });
      i++;
      continue;
    }
    throw new FormulaError('#VALUE!');
  }
  return out;
}

/** Column letters ↔ index (`A` → 0, `AA` → 26). */
export function columnIndex(letters: string): number {
  return [...letters].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
}
export function columnName(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function expand(from: string, to: string): string[] {
  const a = /^([A-Z]+)(\d+)$/.exec(from);
  const b = /^([A-Z]+)(\d+)$/.exec(to);
  if (a === null || b === null) throw new FormulaError('#REF!');
  const [c1, c2] = [columnIndex(a[1] as string), columnIndex(b[1] as string)].sort(
    (x, y) => x - y,
  ) as [number, number];
  const [r1, r2] = [Number(a[2]), Number(b[2])].sort((x, y) => x - y) as [number, number];
  const out: string[] = [];
  for (let c = c1; c <= c2; c++) for (let r = r1; r <= r2; r++) out.push(`${columnName(c)}${r}`);
  return out;
}

const ERRORS = new Set(['#REF!', '#DIV/0!', '#CYCLE!', '#NAME?', '#VALUE!', '#N/A']);

const num = (v: CellValue): number => {
  if (typeof v === 'string' && ERRORS.has(v)) throw new FormulaError(v); // errors propagate through references
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === null || v === '') return 0;
  const n = Number(v);
  if (Number.isNaN(n)) throw new FormulaError('#VALUE!');
  return n;
};

/** The key of a REPORT call (stable for caching). */
export const reportKey = (model: string, measure: string, domain: unknown): string =>
  JSON.stringify([model, measure, domain ?? null]);

/** The REPORT calls of a sheet's formulas (resolve them, then evaluate). */
export function reportCalls(cells: Cells): ReportCall[] {
  const calls = new Map<string, ReportCall>();
  for (const src of Object.values(cells)) {
    if (!src.startsWith('=')) continue;
    for (const m of src.matchAll(
      /REPORT\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*(?:,\s*"((?:[^"\\]|\\.)*)")?\s*\)/gi,
    )) {
      const [, model = '', measure = '', domainText] = m;
      let domain: Record<string, unknown> | undefined;
      try {
        domain =
          domainText === undefined
            ? undefined
            : (JSON.parse(domainText.replace(/\\"/g, '"')) as Record<string, unknown>);
      } catch {
        continue;
      }
      const key = reportKey(model, measure, domain);
      calls.set(key, { key, model, measure, domain });
    }
  }
  return [...calls.values()];
}

/** Evaluates every cell of a sheet. `reports` holds the resolved REPORT totals by key. */
export function evaluateSheet(
  cells: Cells,
  reports: ReadonlyMap<string, number | string>,
): Record<string, CellValue> {
  const results = new Map<string, CellValue>();
  const active = new Set<string>();
  const value = (ref: string): CellValue => {
    if (results.has(ref)) return results.get(ref) as CellValue;
    if (active.has(ref)) throw new FormulaError('#CYCLE!');
    const src = cells[ref];
    let out: CellValue;
    if (src === undefined || src === '') out = null;
    else if (!src.startsWith('='))
      out = src.trim() !== '' && !Number.isNaN(Number(src)) ? Number(src) : src;
    else {
      active.add(ref);
      try {
        out = evaluate(src.slice(1));
      } catch (e) {
        out = e instanceof FormulaError ? e.code : '#VALUE!';
      }
      active.delete(ref);
    }
    results.set(ref, out);
    return out;
  };

  function evaluate(src: string): CellValue {
    const tokens = tokenize(src);
    let pos = 0;
    const peek = () => tokens[pos];
    const eat = (v?: string) => {
      const tok = tokens[pos++];
      if (tok === undefined || (v !== undefined && !(tok.t === 'op' && tok.v === v)))
        throw new FormulaError('#VALUE!');
      return tok;
    };
    const args = (): (CellValue | CellValue[])[] => {
      const list: (CellValue | CellValue[])[] = [];
      eat('(');
      if (peek()?.t === 'op' && peek()?.v === ')') {
        eat(')');
        return list;
      }
      for (;;) {
        const a = tokens[pos];
        const b = tokens[pos + 1];
        const c = tokens[pos + 2];
        if (a?.t === 'ref' && b?.t === 'op' && b.v === ':' && c?.t === 'ref') {
          pos += 3;
          list.push(expand(a.v, c.v).map(value));
        } else list.push(comparison());
        const next = eat();
        if (next.t === 'op' && next.v === ')') return list;
        if (!(next.t === 'op' && next.v === ',')) throw new FormulaError('#VALUE!');
      }
    };
    const flat = (xs: (CellValue | CellValue[])[]) =>
      xs.flatMap((x) => (Array.isArray(x) ? x : [x]));
    const call = (name: string): CellValue => {
      if (name === 'REPORT') {
        // Re-scan the raw arguments: REPORT("model", "measure", "domain json")
        const list = args().map((a) => (Array.isArray(a) ? null : a));
        const [model, measure, domainText] = list;
        let domain: unknown;
        try {
          domain = typeof domainText === 'string' ? JSON.parse(domainText) : undefined;
        } catch {
          throw new FormulaError('#VALUE!');
        }
        const result = reports.get(reportKey(String(model), String(measure), domain));
        if (result === undefined) throw new FormulaError('#N/A');
        return typeof result === 'number' ? result : Number(result);
      }
      const list = args();
      const numbers = (): number[] =>
        flat(list)
          .filter((v) => v !== null && v !== '')
          .map(num);
      switch (name) {
        case 'SUM':
          return numbers().reduce((a, b) => a + b, 0);
        case 'AVERAGE': {
          const ns = numbers();
          if (ns.length === 0) throw new FormulaError('#DIV/0!');
          return ns.reduce((a, b) => a + b, 0) / ns.length;
        }
        case 'MIN': {
          const ns = numbers();
          return ns.length === 0 ? 0 : Math.min(...ns);
        }
        case 'MAX': {
          const ns = numbers();
          return ns.length === 0 ? 0 : Math.max(...ns);
        }
        case 'COUNT':
          return flat(list).filter((v) => typeof v === 'number').length;
        case 'ABS':
          return Math.abs(num(list[0] as CellValue));
        case 'ROUND': {
          const digits = num((list[1] as CellValue) ?? 0);
          const f = 10 ** digits;
          return Math.round(num(list[0] as CellValue) * f) / f;
        }
        case 'IF':
          return num(list[0] as CellValue) !== 0
            ? ((list[1] as CellValue) ?? true)
            : ((list[2] as CellValue) ?? false);
        default:
          throw new FormulaError('#NAME?');
      }
    };
    const primary = (): CellValue => {
      const tok = eat();
      if (tok.t === 'num') return tok.v;
      if (tok.t === 'str') return tok.v;
      if (tok.t === 'ref') return value(tok.v);
      if (tok.t === 'id') {
        if (tok.v === 'TRUE') return true;
        if (tok.v === 'FALSE') return false;
        pos--;
        const name = (eat() as { v: string }).v;
        return call(name);
      }
      if (tok.v === '(') {
        const v = comparison();
        eat(')');
        return v;
      }
      if (tok.v === '-') return -num(power());
      if (tok.v === '+') return num(power());
      throw new FormulaError('#VALUE!');
    };
    const power = (): CellValue => {
      let left = primary();
      while (peek()?.t === 'op' && peek()?.v === '^') {
        eat();
        left = num(left) ** num(primary());
      }
      return left;
    };
    const term = (): CellValue => {
      let left = power();
      while (peek()?.t === 'op' && (peek()?.v === '*' || peek()?.v === '/')) {
        const op = (eat() as { v: string }).v;
        const right = num(power());
        if (op === '/' && right === 0) throw new FormulaError('#DIV/0!');
        left = op === '*' ? num(left) * right : num(left) / right;
      }
      return left;
    };
    const sum = (): CellValue => {
      let left = term();
      while (peek()?.t === 'op' && ['+', '-', '&'].includes(peek()?.v as string)) {
        const op = (eat() as { v: string }).v;
        const right = term();
        left =
          op === '&'
            ? `${left ?? ''}${right ?? ''}`
            : op === '+'
              ? num(left) + num(right)
              : num(left) - num(right);
      }
      return left;
    };
    const comparison = (): CellValue => {
      const left = sum();
      const tok = peek();
      if (tok?.t === 'op' && ['=', '<>', '<', '>', '<=', '>='].includes(tok.v)) {
        eat();
        const right = sum();
        const [a, b] =
          typeof left === 'number' || typeof right === 'number'
            ? [num(left), num(right)]
            : [String(left ?? ''), String(right ?? '')];
        switch (tok.v) {
          case '=':
            return a === b;
          case '<>':
            return a !== b;
          case '<':
            return a < b;
          case '>':
            return a > b;
          case '<=':
            return a <= b;
          default:
            return a >= b;
        }
      }
      return left;
    };
    const result = comparison();
    if (pos !== tokens.length) throw new FormulaError('#VALUE!');
    return result;
  }

  const out: Record<string, CellValue> = {};
  for (const ref of Object.keys(cells)) {
    try {
      out[ref] = value(ref);
    } catch (e) {
      out[ref] = e instanceof FormulaError ? e.code : '#VALUE!';
    }
  }
  return out;
}
