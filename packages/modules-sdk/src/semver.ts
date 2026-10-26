/**
 * The version ranges manifests use (`kosh: '^1.2.0'`), without a dependency: exact (`1.2.3`), caret (`^1.2.3`),
 * tilde (`~1.2.3`), comparisons (`>=1.2.0`, `<2.0.0`, space-separated = AND) and `*`. Pre-release tags are not
 * supported (manifests declare released versions).
 */
const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

type Triple = readonly [number, number, number];

function parse(version: string): Triple | undefined {
  const m = VERSION.exec(version.trim());
  return m === null ? undefined : [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compare(a: Triple, b: Triple): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function one(version: Triple, term: string): boolean | undefined {
  if (term === '*' || term === '') return true;
  const op = /^(\^|~|>=|<=|>|<|=)?(.*)$/.exec(term);
  const bound = parse(op?.[2] ?? '');
  if (bound === undefined) return undefined;
  const c = compare(version, bound);
  switch (op?.[1]) {
    case '^':
      // ^1.2.3 → >=1.2.3 <2.0.0; ^0.2.3 → >=0.2.3 <0.3.0; ^0.0.3 → =0.0.3
      if (c < 0) return false;
      if (bound[0] > 0) return version[0] === bound[0];
      if (bound[1] > 0) return version[0] === 0 && version[1] === bound[1];
      return c === 0;
    case '~':
      return c >= 0 && version[0] === bound[0] && version[1] === bound[1];
    case '>=':
      return c >= 0;
    case '<=':
      return c <= 0;
    case '>':
      return c > 0;
    case '<':
      return c < 0;
    default:
      return c === 0;
  }
}

/**
 * True when `version` satisfies `range`.
 * @throws {RangeError} for a version or range this subset cannot read.
 */
/** Compares two `major.minor.patch` versions: negative, zero or positive. @throws on a malformed one */
export function compareVersions(a: string, b: string): number {
  const x = parse(a);
  const y = parse(b);
  if (x === undefined || y === undefined)
    throw new Error(`Not a version: '${x === undefined ? a : b}'.`);
  return compare(x, y);
}

export function satisfies(version: string, range: string): boolean {
  const v = parse(version);
  if (v === undefined)
    throw new RangeError(`${JSON.stringify(version)} is not a version (major.minor.patch).`);
  for (const term of range.trim().split(/\s+/)) {
    const ok = one(v, term);
    if (ok === undefined)
      throw new RangeError(
        `${JSON.stringify(range)} is not a version range (use ^1.2.0, ~1.2.0, >=1.2.0 <2.0.0 or 1.2.3).`,
      );
    if (!ok) return false;
  }
  return true;
}
