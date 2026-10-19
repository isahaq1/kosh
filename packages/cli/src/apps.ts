/**
 * `kosh apps` (RFC 0008): the App manager in the terminal. Lists the catalogue with each app's state, and installs,
 * enables or disables apps: the plan is shown first (modules, dependencies, cascades, schema statements), then
 * applied in one transaction by `@kosh/server` (`prepareApps` / `applyApps`).
 */
import { existsSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { type AppChange, catalogueOf, type KoshModule } from '@kosh/modules-sdk';
import {
  applyApps,
  installedApps,
  orm,
  type PreparedApps,
  pg,
  prepareApps,
  readInstalledApps,
} from '@kosh/server';
import { modulesOf, seedWith } from './project.js';
import { defaultsPrompter, type Prompter, terminalPrompter } from './prompt.js';
import { createUi, PLAIN_TERMINAL, type Terminal, type Ui } from './ui.js';

export const APPS_USAGE: string = `Usage: kosh apps [command] [app …] [options]

  kosh apps                     the catalogue: installed, disabled and available apps
  kosh apps install <app …>     install apps and what they need, in one transaction
  kosh apps enable <app …>      serve disabled apps again (their data is still there)
  kosh apps disable <app …>     switch apps off: menus, API and access go, tables and data stay
                                (apps that depend on them are disabled too)

Options:
  --plan              only show the plan
  --yes               apply without asking
  --modules <file>    the catalogue (default src/modules.ts)
  --dir <dir>         migration files (default migrations)

After a change, restart the API (npm start) so it serves the new set.
`;

/** Pictographs for the apps Kosh ships; other modules get a puzzle piece. */
const APP_ICONS: Readonly<Record<string, string>> = {
  base: '🏠',
  settings: '⚙️',
  permissions: '🛡️',
  reporting: '📊',
  messaging: '💬',
  accounting: '📒',
  sales: '🛒',
  purchase: '🧾',
  projects: '📋',
  contacts: '👥',
  product: '📦',
  uom: '📏',
  inventory: '🏬',
};

export interface AppsIo {
  readonly write: (text: string) => void;
  readonly cwd: string;
  readonly terminal?: Terminal;
  /** The confirmation question (tests script it). Default: the terminal. */
  readonly prompter?: Prompter;
}

const COMMANDS = ['list', 'install', 'enable', 'disable', 'uninstall'] as const;
type Command = (typeof COMMANDS)[number];

function iconOf(ui: Ui, name: string): string {
  return ui.terminal.emoji ? (APP_ICONS[name] ?? '🧩') : ui.style('cyan', '•');
}

async function list(
  ui: Ui,
  driver: ReturnType<typeof pg.createDriver>,
  catalogue: readonly KoshModule[],
): Promise<void> {
  // Before the first app change: the modules migrated so far (what the first change will record).
  const legacy = (await readInstalledApps(driver)) === null;
  const rows = await installedApps(driver, catalogue);
  const byName = catalogueOf(catalogue);
  const state = new Map(rows.map((r) => [r.name, r]));
  const u = ui.terminal.unicode;
  const marks = {
    installed: ui.style('green', u ? '●' : '*'),
    disabled: ui.style('yellow', u ? '◌' : 'o'),
    available: ui.style('gray', u ? '○' : '.'),
  };
  ui.step(
    'apps',
    'Apps',
    legacy ? 'no app changes yet: installed means migrated so far' : undefined,
  );
  const counts = { installed: 0, disabled: 0, available: 0 };
  const width = Math.max(...[...byName.keys()].map((n) => n.length));
  for (const m of [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const row = state.get(m.name);
    const s = row?.state ?? 'available';
    counts[s] += 1;
    const label = m.app?.label ?? '';
    const why = row?.reason === 'dependency' ? ui.style('gray', ' (needed by another app)') : '';
    ui.write(
      `  ${marks[s]} ${iconOf(ui, m.name)}  ${ui.style('bold', m.name.padEnd(width))}  ${ui.style('gray', m.version.padEnd(8))} ${s.padEnd(9)} ${label}${why}\n`,
    );
  }
  ui.write(
    `\n  ${counts.installed} installed · ${counts.disabled} disabled · ${counts.available} available\n`,
  );
}

function showPlan(ui: Ui, prepared: PreparedApps, catalogue: readonly KoshModule[]): void {
  const byName = catalogueOf(catalogue);
  const { plan, migration } = prepared;
  const u = ui.terminal.unicode;
  ui.step('install', 'Plan');
  const width = Math.max(4, ...plan.after.map((r) => r.name.length));
  for (const m of plan.install)
    ui.write(
      `  ${ui.style('green', '+')} ${iconOf(ui, m.name)}  ${m.name.padEnd(width)}  ${ui.style('gray', (byName.get(m.name)?.version ?? '').padEnd(8))} install${m.reason === 'dependency' ? ui.style('gray', ' (needed)') : ''}\n`,
    );
  for (const name of plan.enable)
    ui.write(
      `  ${ui.style('cyan', u ? '↑' : '^')} ${iconOf(ui, name)}  ${name.padEnd(width)}  ${' '.repeat(8)} enable\n`,
    );
  for (const d of plan.disable)
    ui.write(
      `  ${ui.style('yellow', u ? '↓' : 'v')} ${iconOf(ui, d.name)}  ${d.name.padEnd(width)}  ${' '.repeat(8)} disable${d.cascade ? ui.style('gray', ' (it depends on a disabled app)') : ''}\n`,
    );
  for (const name of plan.unchanged) ui.detail(`${name}: already so`);
  if (migration.statements.length > 0)
    ui.detail(`${migration.statements.length} schema statement(s), written to a migration file`);
  if (plan.disable.length > 0) ui.detail('tables and data stay; enable brings everything back');
}

/** Runs `kosh apps …`. Returns the exit code. */
export async function runApps(argv: readonly string[], io: AppsIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      modules: { type: 'string', default: 'src/modules.ts' },
      dir: { type: 'string', default: 'migrations' },
      plan: { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help === true) {
    io.write(APPS_USAGE);
    return 0;
  }
  const command = (positionals[0] ?? 'list') as Command;
  const names = positionals.slice(1);
  const ui = createUi(io.write, io.terminal ?? PLAIN_TERMINAL);
  if (!COMMANDS.includes(command)) {
    ui.fail(`Unknown command "${command}".`);
    io.write(APPS_USAGE);
    return 2;
  }
  if (command === 'uninstall') {
    ui.warn('Removing an app and its data comes with a later step of RFC 0008.');
    ui.info(
      `Meanwhile: kosh apps disable ${names.join(' ') || '<app>'} (reversible, keeps the data).`,
    );
    return 2;
  }
  if (command !== 'list' && names.length === 0) {
    ui.fail(`Name the app(s): kosh apps ${command} <app …>`);
    return 2;
  }

  const envFile = join(io.cwd, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl === '') {
    ui.fail('DATABASE_URL is not set: run kosh init, or add it to .env.');
    return 1;
  }
  const driver = pg.createDriver({
    url: databaseUrl,
    max: 2,
    parseNumeric: orm.toDecimal,
    applicationName: 'kosh apps',
  });
  const prompter =
    io.prompter ??
    (values.yes === true || values.plan === true ? defaultsPrompter() : terminalPrompter());
  try {
    process.env['KOSH_SCHEDULES'] = 'off';
    const catalogue = await modulesOf(values.modules, io.cwd);
    if (command === 'list') {
      await list(ui, driver, catalogue);
      return 0;
    }
    const change: AppChange = { [command]: names };
    const dir = resolve(io.cwd, values.dir);
    const prepared = await ui.task('Planning against the database', async (task) => {
      const p = await prepareApps({ driver, catalogue, change, dir });
      task.finish('Planned');
      return p;
    });
    showPlan(ui, prepared, catalogue);
    if (prepared.empty) {
      ui.ok('Nothing to change.');
      return 0;
    }
    if (values.plan === true) return 0;
    ui.write('\n');
    ui.pause();
    const go = values.yes === true || (await prompter.confirm('Apply this change?', true));
    ui.resume();
    if (!go) {
      ui.info('Nothing changed.');
      return 1;
    }
    const steps = {
      schema: 'schema',
      data: 'data and defaults',
      hooks: 'install hooks',
      state: 'installed set',
    };
    const result = await ui.task('Applying in one transaction', async (task) => {
      const r = await applyApps(prepared, {
        driver,
        dir,
        actor: `cli:${userInfo().username}`,
        name: `apps_${command}_${names.join('_').replace(/[^a-z0-9_]/g, '_')}`.slice(0, 60),
        onStep: (step, detail) => task.update(`${steps[step]}: ${detail}`),
        load: (context, modules) =>
          seedWith(
            {
              shutro: context.shutro,
              driver: context.driver,
              modules: context.registry.loaded.modules,
            },
            (t) => ui.detail(t.trim()),
            modules,
          ),
      });
      task.finish('Applied in one transaction');
      return r;
    });
    const done = [
      ...result.installed.map((n) => `installed ${n}`),
      ...result.enabled.map((n) => `enabled ${n}`),
      ...result.disabled.map((n) => `disabled ${n}`),
    ];
    ui.card(`${ui.terminal.emoji ? '🧩 ' : ''}Apps changed`, [
      ['Changes', done.join(', ')],
      [
        'Migration',
        result.migration === null
          ? 'none'
          : `migrations/${result.migration.version}_${result.migration.name}.sql`,
      ],
      ['Next', 'restart the API (npm start) to serve the new set'],
    ]);
    return 0;
  } catch (error) {
    ui.fail(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    prompter.close();
    await driver.end();
  }
}
