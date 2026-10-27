/**
 * @packageDocumentation
 * `@kosh/cli`, the `kosh` command: `init` (a new installation), `migrate` and `seed` (schema and data),
 * `module create` (a new module), and `generate client` (RFC 0002 §6.4).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { generateClient, openApiOf } from '@kosh/server';
import { runStudio } from '@kosh/studio';
import { runApps } from './apps.js';
import { runInit } from './init.js';
import { modulesOf, runMigrate, runModule, runSeed, runUser } from './project.js';
import type { Terminal } from './ui.js';

export { APPS_USAGE, type AppsIo, runApps } from './apps.js';
export { INIT_USAGE, type InitIo, releaseVersion, runInit } from './init.js';
export {
  migrateProject,
  moduleFiles,
  modulesOf,
  openProject,
  runMigrate,
  runModule,
  runSeed,
  runUser,
  type SeedContext,
  seed,
  seedWith,
} from './project.js';
export {
  defaultsPrompter,
  InputEndedError,
  type Prompter,
  type PromptLook,
  type Question,
  terminalPrompter,
} from './prompt.js';
export {
  type CardRow,
  createUi,
  detectTerminal,
  PLAIN_TERMINAL,
  type TaskHandle,
  type Terminal,
  type Ui,
} from './ui.js';

/** Package identity. */
export const PACKAGE: { readonly name: string; readonly rfc: string } = Object.freeze({
  name: '@kosh/cli',
  rfc: 'RFC 0001',
});

const USAGE = `Usage: kosh <command>

Commands (run in the installation's folder; they read .env and src/modules.ts):
  init [folder]          Set up an installation: database, company, administrator, apps (kosh init --help)
  apps                   The apps: installed, disabled, available (kosh apps --help)
  apps install <app …>   Install apps and what they need, in one transaction
  apps disable <app …>   Switch apps off (their data stays); apps enable <app …> brings them back
  migrate                Plan schema changes into migrations/NNNN_*.sql, apply pending files, run the modules'
                         data migrations, load seed data
      --plan                 only write the plan (review it before applying)
      --name <name>          name of the new file (default: update)
      --allow-destructive    apply changes that drop columns or tables
      --no-seed              skip the seed data
  migrate status         Applied and pending migration files
  seed [module ...]      Load the modules' seed data and the apps' defaults (all modules, or those named)
  module create <name>   Scaffold src/modules/<name>/ (models, views, menus, access, seed data, data migrations)
  studio build [dir …]   Regenerate the Studio modules from their studio.json (default: every src/modules/*/studio.json)
  user create <login>    Create a user: --name, --email, --roles reporting.user,messaging.user, --password
  user password <login>  Set a new password
  generate client   Typed API client from the module set or an OpenAPI document
      --modules <file|package>   a module (or file) exporting Kosh modules (\`modules\`, default, or each export)
      --from <file|url>          an OpenAPI document instead (a URL needs --token)
      --token <token>            Bearer token for --from <url>
      --out <file>               where to write (default: src/api/kosh.gen.ts)
      --check                    fail if the file is out of date (CI)

Every command takes --modules <file> (default src/modules.ts).
`;

/** Options of {@link runCli}. */
export interface CliOptions {
  /** Base for relative paths. Default: `process.cwd()`. */
  readonly cwd?: string;
  readonly fetch?: typeof fetch;
  /** What the output can show (colour, icons, spinners). Default: plain lines. */
  readonly terminal?: Terminal;
}

async function documentFrom(
  from: string,
  token: string | undefined,
  cwd: string,
  doFetch: typeof fetch,
): Promise<Record<string, unknown>> {
  if (/^https?:\/\//.test(from)) {
    const response = await doFetch(from, {
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`GET ${from}: ${response.status} ${response.statusText}.`);
    return (await response.json()) as Record<string, unknown>;
  }
  return JSON.parse(await readFile(resolve(cwd, from), 'utf8')) as Record<string, unknown>;
}

async function generate(
  argv: readonly string[],
  write: (text: string) => void,
  options: CliOptions,
): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      modules: { type: 'string' },
      from: { type: 'string' },
      token: { type: 'string' },
      out: { type: 'string' },
      check: { type: 'boolean' },
    },
    strict: true,
  });
  const cwd = options.cwd ?? process.cwd();
  if ((values.modules === undefined) === (values.from === undefined)) {
    write('kosh generate client: pass exactly one of --modules or --from.\n');
    return 2;
  }
  const document =
    values.modules === undefined
      ? await documentFrom(
          values.from as string,
          values.token,
          cwd,
          options.fetch ?? globalThis.fetch,
        )
      : openApiOf(await modulesOf(values.modules, cwd));
  const code = generateClient(document);
  const out = resolve(cwd, values.out ?? 'src/api/kosh.gen.ts');
  if (values.check === true) {
    const current = await readFile(out, 'utf8').catch(() => '');
    if (current.replaceAll('\r\n', '\n') === code) {
      write(`${out} is up to date.\n`);
      return 0;
    }
    write(`${out} is out of date: run kosh generate client.\n`);
    return 1;
  }
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, code);
  write(`Wrote ${out}.\n`);
  return 0;
}

/** Runs the CLI; returns the exit code. */
export async function runCli(
  argv: readonly string[],
  write: (text: string) => void,
  options: CliOptions = {},
): Promise<number> {
  if (argv.length === 0 || argv[0] === '--help') {
    write(USAGE);
    return argv.length === 0 ? 2 : 0;
  }
  const cwd = options.cwd ?? process.cwd();
  if (argv[0] === 'init')
    return runInit(argv.slice(1), {
      write,
      cwd,
      ...(options.terminal === undefined ? {} : { terminal: options.terminal }),
    });
  if (argv[0] === 'apps')
    return runApps(argv.slice(1), {
      write,
      cwd,
      ...(options.terminal === undefined ? {} : { terminal: options.terminal }),
    });
  const commands: Record<string, typeof runMigrate> = {
    migrate: runMigrate,
    seed: runSeed,
    module: runModule,
    studio: runStudio,
    user: (args, out, dir) => runUser(args, out, dir),
  };
  const command = commands[argv[0] ?? ''];
  if (command !== undefined)
    try {
      return await command(argv.slice(1), write, cwd);
    } catch (error) {
      write(`kosh ${argv[0]}: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  if (argv[0] === 'generate' && argv[1] === 'client') {
    try {
      return await generate(argv.slice(2), write, options);
    } catch (error) {
      write(`kosh generate client: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }
  write(`Unknown command '${argv.join(' ')}'. Run kosh --help.\n`);
  return 2;
}
