/**
 * `shutro-erp apps` (RFC 0008): the App manager in the terminal. Lists the catalogue with each app's state, and installs,
 * enables or disables apps: the plan is shown first (modules, dependencies, cascades, schema statements), then
 * applied in one transaction by `@kosh/server` (`prepareApps` / `applyApps`).
 */
import { existsSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { type AppChange, catalogueOf, type KoshModule, outdatedApps } from '@kosh/modules-sdk';
import {
  applyApps,
  installedApps,
  orm,
  type PreparedApps,
  pg,
  prepareApps,
  readInstalledApps,
} from '@kosh/server';
import { PROTECTED_APPS } from '@kosh/settings';
import { modulesOf, seedWith } from './project.js';
import { defaultsPrompter, type Prompter, terminalPrompter } from './prompt.js';
import { createUi, PLAIN_TERMINAL, type Terminal, type Ui } from './ui.js';

export const APPS_USAGE: string = `Usage: shutro-erp apps [command] [app …] [options]

  shutro-erp apps                     the catalogue: installed, disabled and available apps
  shutro-erp apps install <app …>     install apps and what they need, in one transaction
  shutro-erp apps enable <app …>      serve disabled apps again (their data is still there)
  shutro-erp apps disable <app …>     switch apps off: menus, API and access go, tables and data stay
                                (apps that depend on them are disabled too)
  shutro-erp apps upgrade [app …]     move installed apps to their code's version: schema, data migrations,
                                seed data (default: every app whose code is newer)

Options:
  --plan              only show the plan
  --remove-data       an upgrade may drop the columns and tables its code no longer has
  --yes               apply without asking
  --modules <file>    the catalogue (default src/modules.ts)
  --dir <dir>         migration files (default migrations)

After a change, restart the API (npm start) so it serves the new set.
`;

/** Pictographs for the apps Shutro ERP ships; other modules get a puzzle piece. */
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

const COMMANDS = ['list', 'install', 'enable', 'disable', 'upgrade', 'uninstall'] as const;
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
    const behind =
      row !== undefined && row.version !== m.version
        ? ui.style('cyan', ` (installed ${row.version}: shutro-erp apps upgrade ${m.name})`)
        : '';
    ui.write(
      `  ${marks[s]} ${iconOf(ui, m.name)}  ${ui.style('bold', m.name.padEnd(width))}  ${ui.style('gray', m.version.padEnd(8))} ${s.padEnd(9)} ${label}${why}${behind}\n`,
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
  for (const u of plan.upgrade)
    ui.write(
      `  ${ui.style('cyan', ui.terminal.unicode ? '⇧' : '^')} ${iconOf(ui, u.name)}  ${u.name.padEnd(width)}  ${ui.style('gray', u.to.padEnd(8))} upgrade from ${u.from}\n`,
    );
  for (const name of plan.unchanged) ui.detail(`${name}: already so`);
  if (prepared.allowDestructive && migration.destructive.length > 0)
    ui.warn(`removes data: ${migration.destructive.length} column(s) or table(s) dropped`);
  if (migration.statements.length > 0)
    ui.detail(`${migration.statements.length} schema statement(s), written to a migration file`);
  if (plan.disable.length > 0) ui.detail('tables and data stay; enable brings everything back');
}

/** Runs `shutro-erp apps …`. Returns the exit code. */
export async function runApps(argv: readonly string[], io: AppsIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      modules: { type: 'string', default: 'src/modules.ts' },
      dir: { type: 'string', default: 'migrations' },
      plan: { type: 'boolean' },
      'remove-data': { type: 'boolean' },
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
      `Meanwhile: shutro-erp apps disable ${names.join(' ') || '<app>'} (reversible, keeps the data).`,
    );
    return 2;
  }
  if (command !== 'list' && command !== 'upgrade' && names.length === 0) {
    ui.fail(`Name the app(s): shutro-erp apps ${command} <app …>`);
    return 2;
  }

  const envFile = join(io.cwd, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl === '') {
    ui.fail('DATABASE_URL is not set: run shutro-erp init, or add it to .env.');
    return 1;
  }
  const driver = pg.createDriver({
    url: databaseUrl,
    max: 2,
    parseNumeric: orm.toDecimal,
    applicationName: 'shutro-erp apps',
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
    let targets = names;
    if (command === 'upgrade' && targets.length === 0) {
      targets = outdatedApps(catalogue, await installedApps(driver, catalogue)).map((u) => u.name);
      if (targets.length === 0) {
        ui.ok("Every installed app is at its code's version.");
        return 0;
      }
    }
    const change: AppChange = { [command]: targets };
    const dir = resolve(io.cwd, values.dir);
    const prepared = await ui.task('Planning against the database', async (task) => {
      const p = await prepareApps({
        driver,
        catalogue,
        change,
        dir,
        protect: PROTECTED_APPS,
        removeData: values['remove-data'] === true,
      });
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
        name: `apps_${command}_${targets.join('_').replace(/[^a-z0-9_]/g, '_')}`.slice(0, 60),
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
      ...result.upgraded.map((n) => `upgraded ${n}`),
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
