#!/usr/bin/env node
/**
 * `npm create kosh-erp@latest [folder] [-- kosh init options]`: a complete Kosh installation in one command.
 *
 * 1. creates the folder and a package.json (or uses the existing one),
 * 2. installs kosh-erp (Shutro comes with it) with the package manager that ran this,
 * 3. runs `kosh init`, which asks for the database, the company, the administrator, the apps, file storage and
 *    the port, then creates the database tables, the administrator and the seed data,
 * 4. installs what the project needs next (the back-office's build tools),
 * 5. prints how to start it.
 *
 * Plain JavaScript without dependencies: it runs before anything is installed.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';

const own = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
/** What to install: kosh-erp of the same minor version (KOSH_ERP_SPEC overrides it, e.g. a local tarball). */
const spec = process.env.KOSH_ERP_SPEC ?? `kosh-erp@^${own.version}`;

const argv = process.argv.slice(2);
const dashes = argv.indexOf('--');
const ours = dashes === -1 ? argv : argv.slice(0, dashes);
const forInit = dashes === -1 ? argv.filter((a) => a.startsWith('-')) : argv.slice(dashes + 1);
const positional = ours.find((a) => !a.startsWith('-'));

if (ours.includes('--help') || ours.includes('-h')) {
  process.stdout.write(`Usage: npm create kosh-erp@latest [folder] [-- kosh init options]

Creates a Kosh installation in [folder]: installs kosh-erp, then asks for the database, the company, the
administrator, the apps, file storage and the port, and sets everything up.

Examples:
  npm create kosh-erp@latest my-erp
  npm create kosh-erp@latest my-erp -- --docker-db
  npm create kosh-erp@latest my-erp -- --yes --database-url postgres://… --admin-password "…"
`);
  process.exit(0);
}

/** The package manager that ran us (npm create, pnpm create, yarn create). */
const agent = process.env.npm_config_user_agent ?? '';
const pm = agent.startsWith('pnpm') ? 'pnpm' : agent.startsWith('yarn') ? 'yarn' : 'npm';
/**
 * Runs a command in this terminal. The package manager is a .cmd script on Windows and needs a shell there, so its
 * arguments are quoted; Node itself runs without one (its path may contain spaces: C:\Program Files\nodejs).
 */
const run = (command, args, cwd, env = {}) => {
  const options = { cwd, stdio: 'inherit', env: { ...process.env, ...env } };
  if (command === process.execPath || process.platform !== 'win32')
    return spawnSync(command, args, options).status ?? 1;
  // One command line, each part quoted when it needs it (the shell gets no separate argument list).
  const quote = (a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
  return (
    spawnSync([command, ...args].map(quote).join(' '), { ...options, shell: true }).status ?? 1
  );
};
const add = (cwd, what) =>
  run(pm, pm === 'npm' ? ['install', '--no-audit', '--no-fund', ...what] : ['add', ...what], cwd);
const installAll = (cwd) =>
  run(pm, pm === 'npm' ? ['install', '--no-audit', '--no-fund'] : ['install'], cwd);

async function folder() {
  if (positional !== undefined) return positional;
  if (!process.stdin.isTTY) return 'my-erp';
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question('Project folder [my-erp]: ')).trim();
  rl.close();
  return answer === '' ? 'my-erp' : answer;
}

const target = resolve(await folder());
const name =
  basename(target)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-') || 'kosh-app';
process.stdout.write(`\nCreating a Kosh installation in ${target}\n\n`);
mkdirSync(target, { recursive: true });
if (!existsSync(join(target, 'package.json')))
  writeFileSync(
    join(target, 'package.json'),
    `${JSON.stringify({ name, version: '0.1.0', private: true, type: 'module' }, null, 2)}\n`,
  );

process.stdout.write(`Installing ${spec} …\n`);
if (add(target, [spec]) !== 0) {
  process.stderr.write(`\nInstalling ${spec} failed (see above).\n`);
  process.exit(1);
}

const cli = join(target, 'node_modules', 'kosh-erp', 'dist', 'cli', 'bin.js');
if (!existsSync(cli)) {
  process.stderr.write(`\n${cli} is missing: the kosh-erp installation is incomplete.\n`);
  process.exit(1);
}
process.stdout.write('\n');
// kosh init asks its questions in this terminal (stdio inherited), then sets up the database.
const init = run(process.execPath, [cli, 'init', '.', ...forInit], target, { KOSH_CREATE: '1' });
if (init !== 0) {
  process.stderr.write(
    `\nThe setup stopped. Fix the problem above, then finish it with:\n  cd ${positional ?? basename(target)}\n  npx kosh init\n`,
  );
  process.exit(init);
}

process.stdout.write('\nInstalling the back-office tools …\n');
if (installAll(target) !== 0) {
  process.stderr.write(`\n${pm} install failed (see above); run it again in ${target}.\n`);
  process.exit(1);
}

const cd = target === resolve('.') ? '' : `  cd ${positional ?? basename(target)}\n`;
const start = pm === 'npm' ? 'npm start' : `${pm} start`;
const web = pm === 'npm' ? 'npm run web' : `${pm} web`;
process.stdout.write(`
Kosh is installed.

${cd}  ${start}            # the API (reads .env)
  ${web}          # the back-office, in a second terminal → http://localhost:5173

Everything in Docker instead:  docker compose up -d --build   → http://localhost:8080
Guide: https://www.npmjs.com/package/kosh-erp
`);
