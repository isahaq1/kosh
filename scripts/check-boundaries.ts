/**
 * Repository rules Biome cannot express. Run by `pnpm lint` and CI: node scripts/check-boundaries.ts
 *
 * - Shutro is imported in ONE place, packages/server/src/orm.ts (CLAUDE.md, Shutro integration). Everything else
 *   imports what it needs from there, so the dependency can be renamed or swapped in one file.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const ORM = 'packages/server/src/orm.ts';
const SHUTRO = /(?:from\s+|import\s*\(\s*|require\(\s*)['"]shutro(?:\/[^'"]*)?['"]/;
const SKIP = new Set([
  'node_modules',
  'dist',
  '.turbo',
  'coverage',
  '.git',
  'playwright-report',
  'test-results',
]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (SKIP.has(name)) return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx|js|mjs)$/.test(name) ? [path] : [];
  });
}

const offenders = ['packages', 'apps']
  .flatMap((d) => files(join(root, d)))
  .map((f) => relative(root, f).split(sep).join('/'))
  .filter((f) => f !== ORM && SHUTRO.test(readFileSync(join(root, f), 'utf8')));

if (offenders.length > 0) {
  process.stderr.write(
    `Shutro may only be imported in ${ORM} (CLAUDE.md). Import from '@kosh/server/orm' instead:\n${offenders.map((f) => `  ${f}`).join('\n')}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write('check-boundaries: ok\n');
}
