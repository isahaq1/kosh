/**
 * A unified diff of two texts (RFC 0012 §5.6, "Review changes"): what Studio shows before applying and what a
 * proposal carries as a patch (`git apply` reads it). Line based, with three lines of context.
 */

const CONTEXT = 3;
/** Above this many line pairs the diff replaces the whole file rather than search for the common lines. */
const MAX_CELLS = 4_000_000;

type Op = { readonly kind: ' ' | '-' | '+'; readonly line: string };

function linesOf(text: string | null): string[] {
  if (text === null || text === '') return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/** The edit script from `a` to `b` (longest common subsequence). */
function ops(a: readonly string[], b: readonly string[]): Op[] {
  if (a.length * b.length > MAX_CELLS)
    return [
      ...a.map((line): Op => ({ kind: '-', line })),
      ...b.map((line): Op => ({ kind: '+', line })),
    ];
  const width = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i * width + j] =
        a[i] === b[j]
          ? (lcs[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(lcs[(i + 1) * width + j] ?? 0, lcs[i * width + j + 1] ?? 0);
  const out: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ kind: ' ', line: a[i] as string });
      i++;
      j++;
    } else if (
      i < a.length &&
      (j === b.length || (lcs[(i + 1) * width + j] ?? 0) >= (lcs[i * width + j + 1] ?? 0))
    ) {
      out.push({ kind: '-', line: a[i] as string });
      i++;
    } else {
      out.push({ kind: '+', line: b[j] as string });
      j++;
    }
  }
  return out;
}

/**
 * The unified diff of one file, `''` when nothing changed. `before` null: a new file; `after` null: a deleted one.
 * `path` is relative to the project (`src/modules/acme/models.ts`).
 */
export function unifiedDiff(path: string, before: string | null, after: string | null): string {
  if (before === after) return '';
  const a = linesOf(before);
  const b = linesOf(after);
  const script = ops(a, b);
  const header = [
    `diff --git a/${path} b/${path}`,
    ...(before === null ? ['new file mode 100644'] : []),
    ...(after === null ? ['deleted file mode 100644'] : []),
    `--- ${before === null ? '/dev/null' : `a/${path}`}`,
    `+++ ${after === null ? '/dev/null' : `b/${path}`}`,
  ];
  const hunks: string[] = [];
  let k = 0;
  while (k < script.length) {
    if (script[k]?.kind === ' ') {
      k++;
      continue;
    }
    // A hunk: from CONTEXT lines before this change to CONTEXT lines after the last change close to it.
    let start = k;
    let back = 0;
    while (start > 0 && back < CONTEXT && script[start - 1]?.kind === ' ') {
      start--;
      back++;
    }
    let end = k;
    let quiet = 0;
    while (end < script.length && quiet <= 2 * CONTEXT) {
      quiet = script[end]?.kind === ' ' ? quiet + 1 : 0;
      end++;
    }
    end -= Math.max(0, quiet - CONTEXT);
    // Line numbers where the hunk starts, in a and in b.
    let aLine = 1;
    let bLine = 1;
    for (let x = 0; x < start; x++) {
      if (script[x]?.kind !== '+') aLine++;
      if (script[x]?.kind !== '-') bLine++;
    }
    const body = script.slice(start, end);
    const aCount = body.filter((o) => o.kind !== '+').length;
    const bCount = body.filter((o) => o.kind !== '-').length;
    hunks.push(
      `@@ -${aCount === 0 ? aLine - 1 : aLine},${aCount} +${bCount === 0 ? bLine - 1 : bLine},${bCount} @@`,
      ...body.map((o) => `${o.kind}${o.line}`),
    );
    k = end;
  }
  return `${[...header, ...hunks].join('\n')}\n`;
}
