/**
 * After `shutro-erp init`: the project's dependencies installed with the package manager that ran the installer, the API
 * and the back-office started, each waited for until it answers, and the back-office opened in the default browser.
 * Both keep running in this terminal until Ctrl+C, which stops them together. Their output is kept, and shown when
 * one of them fails to start.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import type { Ui } from './ui.js';

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

/** The package manager that ran the CLI (`npx`, `pnpm dlx`, `yarn dlx`, `bunx`), from its user agent; npm otherwise. */
export function packageManager(env: NodeJS.ProcessEnv = process.env): PackageManager {
  const agent = env['npm_config_user_agent'] ?? '';
  for (const pm of ['pnpm', 'yarn', 'bun'] as const) if (agent.startsWith(`${pm}/`)) return pm;
  return 'npm';
}

/** The command that opens `url` in the default browser on `platform`. */
export function browserCommand(
  url: string,
  platform: string = process.platform,
): readonly [string, readonly string[]] {
  if (platform === 'win32') return ['cmd', ['/c', 'start', '""', url]];
  if (platform === 'darwin') return ['open', [url]];
  return ['xdg-open', [url]];
}

const windows = process.platform === 'win32';

/** A child process running `pm args` in `cwd`, its output kept (the last 200 lines). */
function start(pm: PackageManager, args: readonly string[], cwd: string) {
  const child = spawn(pm, args, {
    cwd,
    env: { ...process.env, FORCE_COLOR: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
    // npm, pnpm… are .cmd scripts on Windows; elsewhere a process group, stopped as a whole.
    shell: windows,
    detached: !windows,
  });
  const lines: string[] = [];
  const keep = (chunk: Buffer) => {
    lines.push(
      ...chunk
        .toString()
        .split(/\r?\n/)
        .filter((l) => l.trim() !== ''),
    );
    lines.splice(0, Math.max(0, lines.length - 200));
  };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  const exited = new Promise<number>((done) => child.on('close', (code) => done(code ?? 1)));
  return { child, lines, exited };
}

/** Stops a started process and what it started. */
function stop(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    if (windows)
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGTERM');
  } catch {
    // already gone
  }
}

/** Resolves when `url` answers (any HTTP status below 500); rejects when `exited` settles first or on timeout. */
async function answers(url: string, exited: Promise<number>, seconds: number): Promise<void> {
  let gone: number | null = null;
  void exited.then((code) => {
    gone = code;
  });
  for (let i = 0; i < seconds * 2; i++) {
    if (gone !== null) throw new Error(`it stopped (exit code ${gone})`);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.status < 500) return;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no answer at ${url} within ${seconds}s`);
}

export interface LaunchOptions {
  readonly dir: string;
  readonly port: number;
  readonly webPort: number;
  readonly login: string;
}

/**
 * Installs, starts and opens the installation; returns when the user stops it (Ctrl+C) or a server stops by itself.
 */
export async function launch(o: LaunchOptions, ui: Ui): Promise<void> {
  const pm = packageManager();
  await ui.task(`Installing the dependencies (${pm} install)`, async (task) => {
    task.update('the first run downloads them');
    const run = start(pm, ['install'], o.dir);
    const code = await run.exited;
    if (code !== 0) throw new Error(`${pm} install failed:\n${run.lines.slice(-15).join('\n')}`);
  });
  const api = start(pm, ['run', 'start'], o.dir);
  const web = start(pm, ['run', 'web'], o.dir);
  const stopAll = () => {
    stop(api.child);
    stop(web.child);
  };
  process.once('exit', stopAll);
  const failed = (name: string, run: typeof api) => (error: unknown) => {
    stopAll();
    const tail = run.lines.slice(-15).join('\n');
    throw new Error(
      `The ${name} did not start: ${error instanceof Error ? error.message : String(error)}${tail === '' ? '' : `\n${tail}`}`,
    );
  };
  const apiUrl = `http://localhost:${o.port}`;
  const webUrl = `http://localhost:${o.webPort}`;
  await ui
    .task(`Starting the API on ${apiUrl}`, () => answers(`${apiUrl}/health/ready`, api.exited, 90))
    .catch(failed('API', api));
  await ui
    .task(`Starting the back-office on ${webUrl}`, () => answers(webUrl, web.exited, 90))
    .catch(failed('back-office', web));
  const [command, args] = browserCommand(webUrl);
  const opened = spawn(command, args, { stdio: 'ignore', detached: true, shell: false });
  opened.on('error', () => ui.info(`Open ${webUrl} in your browser.`));
  opened.unref();
  ui.ok(`Opened ${ui.style('cyan', webUrl)} in your browser · sign in as "${o.login}"`);
  ui.outro(
    `${ui.style('green', 'Shutro ERP is running')}  ${ui.style('gray', `back-office ${webUrl} · API ${apiUrl} · Ctrl+C stops both`)}`,
  );
  // Until Ctrl+C, or until one of them stops by itself (its last lines are shown).
  const which = await Promise.race([
    new Promise<'stopped'>((done) => {
      process.once('SIGINT', () => done('stopped'));
      process.once('SIGTERM', () => done('stopped'));
    }),
    api.exited.then(() => 'api' as const),
    web.exited.then(() => 'web' as const),
  ]);
  stopAll();
  if (which === 'stopped') {
    ui.write(
      `\n  ${ui.style('gray', `Stopped. Start again with: ${pm} start  and  ${pm} run web`)}\n`,
    );
    return;
  }
  const run = which === 'api' ? api : web;
  ui.fail(`The ${which === 'api' ? 'API' : 'back-office'} stopped:`);
  ui.write(`${run.lines.slice(-15).join('\n')}\n`);
}
