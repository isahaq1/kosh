/**
 * `pnpm i18n:extract` (RFC 0023 §3.1, step 5): every English string a module serves — its models' and fields' labels,
 * help, selection and state labels, constraint and guard messages; its manifest's app, roles, actions, menus, views,
 * searches, settings, overview, print and import templates, events and approval policies — keyed by the English
 * text. Writes `src/i18n/bn.ts` for each module that serves any: the translations it has are kept, missing ones are
 * added as `''` (for a translator to fill), strings no longer served are dropped. `--check` writes nothing and lists
 * what is missing (the checker's T1 counts the same).
 *
 *   node --experimental-transform-types --import ./scripts/source-loader.mjs --conditions=@kosh/source \
 *     scripts/i18n-extract.ts [--check] [module…]
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifestStrings, modelStrings, readDictionary } from './i18n-strings.ts';

type M = Record<string, unknown>;
const root = join(fileURLToPath(import.meta.url), '..', '..');
const check = process.argv.includes('--check');
const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));

const quote = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

function writeDictionary(file: string, entries: readonly (readonly [string, string])[]): void {
  mkdirSync(join(file, '..'), { recursive: true });
  // Keys as Biome formats them: bare when they are identifiers.
  const key = (k: string) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : quote(k));
  const body = entries.map(([k, v]) => `  ${key(k)}: ${quote(v)},`).join('\n');
  writeFileSync(
    file,
    `/** Bangla for the module's labels, keyed by their English text (RFC 0023 §3.1; \`pnpm i18n:extract\`). */\nexport const bn: Readonly<Record<string, string>> = {\n${body}\n};\n`,
  );
}

// ---- every module on disk.
const isManifest = (v: unknown): v is M =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as M)['name'] === 'string' &&
  typeof (v as M)['shutro'] === 'object';
const dirs = readdirSync(join(root, 'modules')).sort();
let missingTotal = 0;
const report: string[] = [];
for (const dir of dirs) {
  if (only.length > 0 && !only.includes(dir)) continue;
  const entry = join(root, 'modules', dir, 'src', 'index.ts');
  if (!existsSync(entry)) continue;
  const exported = (await import(`../modules/${dir}/src/index.ts`)) as M;
  const manifest = Object.values(exported).find((v) => isManifest(v) && (v as M)['name'] === dir) as
    | M
    | undefined;
  if (manifest === undefined) continue;
  const strings = new Set([...modelStrings(manifest['shutro'] as M), ...manifestStrings(manifest)]);
  const file = join(root, 'modules', dir, 'src', 'i18n', 'bn.ts');
  const known = readDictionary(file);
  // Context keys a translator added (`res.partner.state`: a field's label where the English word means something
  // else here) are kept: the server looks them up first.
  const context = [...known].filter(
    ([k, v]) => /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+\.[a-zA-Z]\w*$/.test(k) && v !== '',
  );
  const entries = [
    ...[...strings].sort((a, b) => a.localeCompare(b)).map((s) => [s, known.get(s) ?? ''] as const),
    ...context.sort(([a], [b]) => a.localeCompare(b)),
  ];
  const missing = entries.filter(([, v]) => v === '').length;
  missingTotal += missing;
  report.push(`${dir}: ${entries.length} strings, ${missing} missing`);
  if (!check && entries.length > 0) writeDictionary(file, entries);
}
process.stdout.write(`${report.join('\n')}\ni18n: ${missingTotal} missing\n`);
if (check && missingTotal > 0) process.exit(1);
