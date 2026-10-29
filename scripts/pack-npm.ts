/**
 * Assembles the single npm package `shutro-erp` from the built workspace packages (run `pnpm build` first):
 *
 *   dist-npm/shutro-erp/dist/<package>/…   one folder per published workspace package
 *
 * Imports between workspace packages (`@kosh/server`, `@kosh/reporting/web`, …) are rewritten to relative paths,
 * remaining mentions in comments and messages name the package's entry points (`shutro-erp/views`), and source maps
 * are dropped (they point at sources not shipped). Entry points:
 *
 *   shutro-erp            the server (`@kosh/server`)        shutro-erp/orm         Shutro, through the server
 *   shutro-erp/<package>  modules-sdk, views, search, permissions, reporting, storage, messaging, ui, cli, server
 *   shutro-erp/<package>/web   permissions, reporting, messaging (their React contributions)
 *   shutro-erp/ui/styles.css   the design tokens
 *
 * Usage: node scripts/pack-npm.ts [version] (default: the version being released, 0.2.1)
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const NAME = 'shutro-erp';
const OUT = join(ROOT, 'dist-npm', NAME);
/** Published packages (the RFC 0006 placeholders jobs, mail, notify and realtime are not). */
const PACKAGES = [
  'modules-sdk',
  'views',
  'search',
  'server',
  'permissions',
  'storage',
  'messaging',
  'settings',
  'realtime',
  'notify',
  'mail',
  'automation',
  'integrations',
  'studio',
  'assistant',
  'import',
  'mail',
  'contacts',
  'product',
  'sales',
  'purchase',
  'accounting',
  'sale_account',
  'purchase_account',
  'project',
  'todo',
  'calendar',
  'sale_project',
  'portal',
  'sale_portal',
  'account_portal',
  'purchase_portal',
  'project_portal',
  'payment',
  'l10n_bd',
  'l10n_in',
  'ui',
  'reporting',
  'cli',
];
const SPECIFIER =
  /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])@kosh\/([a-z0-9_-]+)(\/[a-z0-9./_-]+)?\2/g;
/** `@kosh/<package>[/<sub>]` in comments and messages (not the `@kosh/source` build condition). */
const MENTION = /@kosh\/(?!source\b)([a-z0-9_-]+)((?:\/[a-z0-9._-]+)*)/g;

interface Manifest {
  readonly version?: string;
  readonly exports: Readonly<Record<string, string | { readonly default: string }>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly bin?: Readonly<Record<string, string>>;
}

/** Where a bundled package lives: the framework in packages/, the business apps in modules/ (RFC 0008). */
const dirOf = (name: string): string =>
  existsSync(join(ROOT, 'packages', name))
    ? join(ROOT, 'packages', name)
    : join(ROOT, 'modules', name);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const manifests = new Map<string, Manifest>(
  PACKAGES.map((name) => [
    name,
    JSON.parse(readFileSync(join(dirOf(name), 'package.json'), 'utf8')) as Manifest,
  ]),
);

/** `dist/…` inside the bundle for an export of a workspace package (`./web` → `reporting/web/index.js`). */
function target(pkg: string, sub: string): string {
  const manifest = manifests.get(pkg);
  if (manifest === undefined) throw new Error(`@kosh/${pkg} is not bundled.`);
  const entry = manifest.exports[sub === '' ? '.' : `.${sub}`];
  if (entry === undefined) throw new Error(`@kosh/${pkg}${sub} is not an export of @kosh/${pkg}.`);
  const path = typeof entry === 'string' ? entry : entry.default;
  if (path.startsWith('./src/')) return `${pkg}/${path.slice('./src/'.length)}`; // styles.css
  return `${pkg}/${path.replace(/^\.\/dist\//, '')}`;
}

/** The public entry point of a workspace export (`shutro-erp/reporting/web`). */
function publicName(pkg: string, sub: string): string {
  if (pkg === 'server' && sub === '') return NAME;
  if (pkg === 'server' && sub === '/orm') return `${NAME}/orm`;
  return `${NAME}/${pkg}${sub}`;
}

const version = process.argv[2] ?? '0.3.4';
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const dependencies: Record<string, string> = {};
const peerDependencies: Record<string, string> = {};
for (const [name, manifest] of manifests) {
  const built = join(dirOf(name), 'dist');
  if (!existsSync(join(built, 'index.js')))
    throw new Error(`${relative(ROOT, built)} is missing: run pnpm build first.`);
  cpSync(built, join(OUT, 'dist', name), { recursive: true });
  for (const [dep, range] of Object.entries(manifest.dependencies ?? {}))
    if (!dep.startsWith('@kosh/')) dependencies[dep] = range;
  for (const [dep, range] of Object.entries(manifest.peerDependencies ?? {}))
    peerDependencies[dep] = range;
}
cpSync(join(ROOT, 'packages', 'ui', 'src', 'styles.css'), join(OUT, 'dist', 'ui', 'styles.css'));
// Peers stay peers (one React, one QueryClient context in the application).
for (const dep of Object.keys(peerDependencies)) delete dependencies[dep];

for (const file of walk(join(OUT, 'dist'))) {
  if (file.endsWith('.map') || file.endsWith('.tsbuildinfo')) {
    rmSync(file);
    continue;
  }
  if (!file.endsWith('.js') && !file.endsWith('.d.ts') && !file.endsWith('.css')) continue;
  const text = readFileSync(file, 'utf8')
    .replace(SPECIFIER, (_all, lead: string, quote: string, pkg: string, sub = '') => {
      let path = relative(dirname(file), join(OUT, 'dist', target(pkg, sub)))
        .split(sep)
        .join('/');
      if (!path.startsWith('.')) path = `./${path}`;
      return `${lead}${quote}${path}${quote}`;
    })
    .replace(MENTION, (all, pkg: string, sub: string) =>
      manifests.has(pkg) ? publicName(pkg, sub) : all,
    )
    .replace(/^\/\/# sourceMappingURL=.*$/m, '');
  writeFileSync(file, text);
}

const leftovers = walk(join(OUT, 'dist')).filter((f) =>
  /(from|import)\s*\(?\s*['"]@kosh\//.test(readFileSync(f, 'utf8')),
);
if (leftovers.length > 0) throw new Error(`Unrewritten @kosh imports in ${leftovers.join(', ')}`);

const exports: Record<string, string | { types: string; default: string }> = {};
const entry = (path: string) => ({
  types: `./dist/${path.replace(/\.js$/, '.d.ts')}`,
  default: `./dist/${path}`,
});
exports['.'] = entry(target('server', ''));
exports['./orm'] = entry(target('server', '/orm'));
for (const [name, manifest] of manifests)
  for (const sub of Object.keys(manifest.exports)) {
    const path = target(name, sub === '.' ? '' : sub.slice(1));
    const key = `./${name}${sub === '.' ? '' : sub.slice(1)}`;
    exports[key] = path.endsWith('.css') ? `./dist/${path}` : entry(path);
  }
exports['./package.json'] = './package.json';

const cliBins = Object.entries(manifests.get('cli')?.bin ?? {}).map(([cmd, path]) => [
  cmd,
  `dist/cli/${path.replace(/^\.\/dist\//, '')}`, // npm's form (no leading ./)
]);
// The package's own name runs the CLI too: `npx shutro-erp init my-erp` in an empty folder.
const bin = Object.fromEntries([
  ...cliBins,
  ...cliBins.slice(0, 1).map(([, path]) => [NAME, path]),
]);

const sorted = (deps: Record<string, string>) =>
  Object.fromEntries(Object.entries(deps).sort(([a], [b]) => a.localeCompare(b)));
const pkg = {
  name: NAME,
  version,
  description:
    'Shutro ERP (Kosh): a modern ERP framework on TypeScript, PostgreSQL and the Shutro ORM — typed end to end, permissions enforced on the server, metadata-driven views, reporting, documents and a chatter on every record.',
  keywords: ['erp', 'framework', 'typescript', 'postgresql', 'shutro', 'fastify', 'react', 'odoo'],
  author: { name: 'Isahaq', email: 'hmisahaq01@gmail.com' },
  license: 'MIT',
  homepage: 'https://github.com/isahaq1/kosh#readme',
  repository: { type: 'git', url: 'git+https://github.com/isahaq1/kosh.git' },
  bugs: { url: 'https://github.com/isahaq1/kosh/issues' },
  type: 'module',
  sideEffects: ['*.css'],
  engines: { node: '>=24' },
  bin,
  exports,
  files: ['dist', 'README.md', 'LICENSE'],
  dependencies: sorted(dependencies),
  peerDependencies: sorted(peerDependencies),
  // The React layer is optional for server-only installs.
  peerDependenciesMeta: Object.fromEntries(
    Object.keys(peerDependencies).map((dep) => [dep, { optional: true }]),
  ),
};
writeFileSync(join(OUT, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
cpSync(join(ROOT, 'scripts', 'npm-readme.md'), join(OUT, 'README.md'));
cpSync(join(ROOT, 'LICENSE'), join(OUT, 'LICENSE'));
process.stdout.write(
  `dist-npm/${NAME} ${version}: ${PACKAGES.length} packages, ${Object.keys(exports).length} entry points, deps ${Object.keys(dependencies).length}, peers ${Object.keys(peerDependencies).join(', ')}\n`,
);
