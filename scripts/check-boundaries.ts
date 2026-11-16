/**
 * Repository rules Biome cannot express. Run by `pnpm lint` and CI: node scripts/check-boundaries.ts
 *
 * - Shutro is imported in ONE place, packages/server/src/orm.ts (CLAUDE.md, Shutro integration). Everything else
 *   imports what it needs from there, so the dependency can be renamed or swapped in one file.
 * - The framework (packages/) never imports a business app (modules/): apps depend on the framework, not the
 *   other way round (RFC 0008). The CLI is exempt: it assembles installations (`kosh init` installs the apps).
 * - End-to-end specs wait on state, never on time (RFC 0034 step 1): `waitForTimeout` makes a spec pass on a fast
 *   machine and fail on a busy one. Wait for the element, the URL or the response instead.
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

const isDir = (d: string) =>
  statSync(join(root, d), { throwIfNoEntry: false })?.isDirectory() === true;
const all = ['packages', 'modules', 'apps']
  .filter(isDir)
  .flatMap((d) => files(join(root, d)))
  .map((f) => relative(root, f).split(sep).join('/'));
const offenders = all.filter((f) => f !== ORM && SHUTRO.test(readFileSync(join(root, f), 'utf8')));
const apps = new Set(isDir('modules') ? readdirSync(join(root, 'modules')) : []);
const APP_IMPORT = /(?:from\s+|import\s*\(\s*)['"]@kosh\/([a-z0-9-]+)/g;
const SLEEP = /\.waitForTimeout\(/;
const sleeping = all
  .filter((f) => /\/e2e(-apps)?\/.*\.spec\.ts$/.test(f))
  .filter((f) => SLEEP.test(readFileSync(join(root, f), 'utf8')))
  .map((f) => `  ${f}`);
const upward = all
  .filter((f) => f.startsWith('packages/') && !f.startsWith('packages/cli/'))
  .flatMap((f) =>
    [...readFileSync(join(root, f), 'utf8').matchAll(APP_IMPORT)]
      .filter((m) => apps.has(m[1] ?? ''))
      .map((m) => `  ${f} imports @kosh/${m[1]}`),
  );

if (offenders.length > 0) {
  process.stderr.write(
    `Shutro may only be imported in ${ORM} (CLAUDE.md). Import from '@kosh/server/orm' instead:\n${offenders.map((f) => `  ${f}`).join('\n')}\n`,
  );
  process.exitCode = 1;
} else if (upward.length > 0) {
  process.stderr.write(
    `The framework (packages/) must not import business apps (modules/):\n${upward.join('\n')}\n`,
  );
  process.exitCode = 1;
} else if (sleeping.length > 0) {
  process.stderr.write(
    `End-to-end specs wait on state, not on time — replace waitForTimeout with an expect on the element, the URL or the response:\n${sleeping.join('\n')}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write('check-boundaries: ok\n');
}
