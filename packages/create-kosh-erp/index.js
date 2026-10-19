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
 * Plain JavaScript without dependencies: it runs before anything is installed. On a terminal it shows a logo, step
 * icons and spinners (the package manager's output is shown only when it fails); in logs and CI, plain lines.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';

const own = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
/** What to install: kosh-erp of the same minor version (KOSH_ERP_SPEC overrides it, e.g. a local tarball). */
const [major, minor] = own.version.split('.');
const spec = process.env.KOSH_ERP_SPEC ?? `kosh-erp@^${major}.${minor}.0`;

// `npm create kosh-erp my-erp -- --yes …` reaches us without the `--` (npm consumes it); `npx create-kosh-erp`
// keeps it. Either way: an optional folder first, everything else is for kosh init.
const argv = process.argv.slice(2).filter((a, i, all) => !(a === '--' && all.indexOf('--') === i));
const positional = argv[0] !== undefined && !argv[0].startsWith('-') ? argv[0] : undefined;
const forInit = positional === undefined ? argv : argv.slice(1);

if (forInit.length === argv.length && (argv[0] === '--help' || argv[0] === '-h')) {
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

// The look: colour, icons and spinners on a terminal; plain lines in logs and CI (the same rules as kosh init).
const env = process.env;
const tty = process.stdout.isTTY === true && env.TERM !== 'dumb' && env.CI === undefined;
const color = env.NO_COLOR === undefined && ((env.FORCE_COLOR ?? '0') !== '0' || tty);
const unicode =
  env.KOSH_ASCII !== '1' &&
  (process.platform === 'win32'
    ? Boolean(
        env.WT_SESSION ||
          env.TERM_PROGRAM === 'vscode' ||
          env.TERMINAL_EMULATOR === 'JetBrains-JediTerm' ||
          env.TERM === 'xterm-256color',
      )
    : env.TERM !== 'linux');
const emoji = unicode && tty;
const ESC = '\u001b[';
const paint = (open, close) => (text) => (color ? `${ESC}${open}m${text}${ESC}${close}m` : text);
const c = {
  bold: paint('1', '22'),
  gray: paint('90', '39'),
  cyan: paint('36', '39'),
  green: paint('32', '39'),
  red: paint('31', '39'),
  yellow: paint('33', '39'),
};
const mark = unicode ? { ok: '✔', fail: '✖', warn: '▲' } : { ok: '[ok]', fail: '[x]', warn: '[!]' };
const out = (text) => process.stdout.write(text);
const icon = (pictograph) => (emoji ? pictograph : c.cyan(unicode ? '◆' : '*'));
const step = (pictograph, title, hint) => {
  out(`\n${icon(pictograph)}  ${c.bold(title)}\n`);
  if (hint) out(`  ${c.gray(hint)}\n`);
};

function banner() {
  if (!unicode) {
    out(`\n  ${c.bold('K O S H')}  npm create kosh-erp ${own.version}\n`);
    return;
  }
  const logo = [
    '██╗  ██╗ ██████╗ ███████╗██╗  ██╗',
    '██║ ██╔╝██╔═══██╗██╔════╝██║  ██║',
    '█████╔╝ ██║   ██║███████╗███████║',
    '██╔═██╗ ██║   ██║╚════██║██╔══██║',
    '██║  ██╗╚██████╔╝███████║██║  ██║',
    '╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝',
  ];
  const gradient = [51, 45, 39, 33, 63, 99]; // cyan to violet
  out('\n');
  for (const [i, row] of logo.entries())
    out(`  ${color ? `${ESC}38;5;${gradient[i]}m${row}${ESC}39m` : row}\n`);
  out(`  ${c.bold('The ERP framework on Shutro')} ${c.gray(`· create-kosh-erp ${own.version}`)}\n`);
}

/** Runs `work` (resolving to an exit code) under a spinner, then prints ✔ with the time taken, or ✖. */
async function task(label, work) {
  const frames = unicode
    ? ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
    : ['|', '/', '-', '\\'];
  const started = Date.now();
  let frame = 0;
  const draw = () => {
    const seconds = Math.floor((Date.now() - started) / 1000);
    out(`\r${ESC}2K  ${c.cyan(frames[frame++ % frames.length])} ${label} ${c.gray(`${seconds}s`)}`);
  };
  const timer = tty ? setInterval(draw, 80) : null;
  if (tty) draw();
  else out(`  … ${label}\n`);
  const status = await work();
  if (timer !== null) {
    clearInterval(timer);
    out(`\r${ESC}2K`);
  }
  const took = c.gray(`(${((Date.now() - started) / 1000).toFixed(1)}s)`);
  out(
    status === 0 ? `  ${c.green(mark.ok)} ${label} ${took}\n` : `  ${c.red(mark.fail)} ${label}\n`,
  );
  return status;
}

/** The package manager that ran us (npm create, pnpm create, yarn create). */
const agent = process.env.npm_config_user_agent ?? '';
const pm = agent.startsWith('pnpm') ? 'pnpm' : agent.startsWith('yarn') ? 'yarn' : 'npm';
/** Quotes an argument for the Windows shell (the package manager is a .cmd script there and needs one). */
const quote = (a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
/**
 * Starts a command. Node itself runs without a shell (its path may contain spaces: C:\Program Files\nodejs); the
 * package manager on Windows gets one command line, each part quoted when it needs it.
 */
const start = (command, args, options) =>
  command === process.execPath || process.platform !== 'win32'
    ? spawn(command, args, options)
    : spawn([command, ...args].map(quote).join(' '), { ...options, shell: true });

/** Runs a command in this terminal (kosh init asks its questions here). */
const run = (command, args, cwd, extra = {}) =>
  new Promise((done) => {
    const child = start(command, args, { cwd, stdio: 'inherit', env: { ...env, ...extra } });
    child.on('error', () => done(1));
    child.on('close', (status) => done(status ?? 1));
  });

/** Runs the package manager quietly (the spinner turns meanwhile); its output is printed only when it fails. */
const quiet = (args, cwd) =>
  new Promise((done) => {
    const child = start(pm, args, { cwd, env });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('error', (error) => {
      output += error.message;
    });
    child.on('close', (status) => {
      if (status !== 0) process.stderr.write(`\n${output.trim()}\n`);
      done(status ?? 1);
    });
  });
const add = (cwd, what) =>
  quiet(pm === 'npm' ? ['install', '--no-audit', '--no-fund', ...what] : ['add', ...what], cwd);
const installAll = (cwd) =>
  quiet(pm === 'npm' ? ['install', '--no-audit', '--no-fund'] : ['install'], cwd);

/** A project name: a folder name and a valid package name (lower-case letters, digits, - and _). */
const validName = (name) => /^[a-z0-9][a-z0-9._-]{0,213}$/.test(name);

/** The project name: `npm create kosh-erp my-erp`, else asked (Enter: my-erp). */
async function folder() {
  if (positional !== undefined) {
    if (!validName(basename(resolve(positional)))) {
      process.stderr.write(
        `"${positional}" is not a project name: lower-case letters, digits, - and _ (e.g. my-erp).\n`,
      );
      process.exit(2);
    }
    return positional;
  }
  if (!process.stdin.isTTY) return 'my-erp';
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  out('\n');
  for (;;) {
    const answer =
      (await rl.question(`${c.cyan('?')} Project name ${c.gray('[my-erp]')}: `)).trim() || 'my-erp';
    if (validName(answer)) {
      rl.close();
      return answer;
    }
    out(
      `  ${c.yellow(mark.warn)} Lower-case letters, digits, - and _ (e.g. my-erp, padma-traders).\n`,
    );
  }
}

banner();
const target = resolve(await folder());
const name =
  basename(target)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-') || 'kosh-app';
step('📦', 'Kosh packages', target);
mkdirSync(target, { recursive: true });
if (!existsSync(join(target, 'package.json')))
  writeFileSync(
    join(target, 'package.json'),
    `${JSON.stringify({ name, version: '0.1.0', private: true, type: 'module' }, null, 2)}\n`,
  );

if ((await task(`Installing ${spec} (Shutro comes with it)`, () => add(target, [spec]))) !== 0) {
  process.stderr.write(`\nInstalling ${spec} failed (see above).\n`);
  process.exit(1);
}

const cli = join(target, 'node_modules', 'kosh-erp', 'dist', 'cli', 'bin.js');
if (!existsSync(cli)) {
  process.stderr.write(`\n${cli} is missing: the kosh-erp installation is incomplete.\n`);
  process.exit(1);
}
// kosh init asks its questions in this terminal (stdio inherited), then sets up the database.
const init = await run(process.execPath, [cli, 'init', '.', ...forInit], target, {
  KOSH_CREATE: '1',
});
if (init !== 0) {
  process.stderr.write(
    `\nThe setup stopped. Fix the problem above, then finish it with:\n  cd ${positional ?? basename(target)}\n  npx kosh init\n`,
  );
  process.exit(init);
}

step('🎨', 'Back-office', 'React, Vite and Tailwind for the web app');
if ((await task(`Installing the back-office tools with ${pm}`, () => installAll(target))) !== 0) {
  process.stderr.write(`\n${pm} install failed (see above); run it again in ${target}.\n`);
  process.exit(1);
}

const cd = target === resolve('.') ? '' : `  ${c.cyan(`cd ${positional ?? basename(target)}`)}\n`;
const api = pm === 'npm' ? 'npm start' : `${pm} start`;
const web = pm === 'npm' ? 'npm run web' : `${pm} web`;
const arrow = unicode ? '→' : '->';
out(`
${icon('🚀')}  ${c.bold(c.green('Kosh is installed.'))} ${c.gray('Start it:')}

${cd}  ${c.cyan(api.padEnd(14))} ${c.gray('# the API (reads .env)')}
  ${c.cyan(web.padEnd(14))} ${c.gray(`# the back-office, in a second terminal ${arrow} http://localhost:5173`)}

  ${c.gray('Everything in Docker instead:')} ${c.cyan('docker compose up -d --build')} ${c.gray(`${arrow} http://localhost:8080`)}
  ${c.gray('Guide:')} https://www.npmjs.com/package/kosh-erp
`);
