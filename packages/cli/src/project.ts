/**
 * Commands that work on an installation (a folder made by `kosh init`): `kosh migrate`, `kosh seed`,
 * `kosh module create`. They read `.env` (DATABASE_URL, storage, ...) and the module list in `src/modules.ts`.
 *
 * - Schema migrations are versioned SQL files in `migrations/`, planned from the modules against the live database
 *   (Shutro migrate) and applied in order; each module's data migrations (`migrations` in its Shutro module) run
 *   once when its version goes up.
 * - Seed data is each module's `data` (Shutro records with external ids: created, updated when changed, `noupdate`
 *   ones left to the users), plus the apps' defaults (approval policies, document templates, activity types).
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { KoshModule } from '@kosh/modules-sdk';
import {
  createServer,
  FRAMEWORK_TABLES,
  installDefaults,
  installedModules,
  type KoshServer,
  migrate,
  orm,
  readInstalledApps,
  restoreAppMigrations,
} from '@kosh/server';

function isModule(value: unknown): value is KoshModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'shutro' in value &&
    'accessLevels' in value &&
    'name' in value
  );
}

/** The Kosh modules a file or package exports: `modules`, the default export, or every module export. */
export async function modulesOf(specifier: string, cwd: string): Promise<KoshModule[]> {
  const target =
    specifier.startsWith('.') ||
    specifier.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(specifier) ||
    /\.(m?[jt]s|cjs)$/.test(specifier) // src/modules.ts is a file, not a package
      ? pathToFileURL(resolve(cwd, specifier)).href
      : specifier;
  const exported = (await import(target)) as Record<string, unknown>;
  for (const key of ['catalogue', 'modules', 'default']) {
    const value = exported[key];
    if (Array.isArray(value) && value.every(isModule)) return value;
    if (isModule(value)) return [value];
  }
  const all = Object.values(exported).filter(isModule);
  if (all.length === 0)
    throw new Error(
      `${specifier} exports no Kosh modules (defineModule from kosh-erp/modules-sdk).`,
    );
  return all;
}

/** Opens the installation in `cwd`: `.env`, the modules, a server (not listening). */
export async function openProject(
  cwd: string,
  modulesFile: string,
  options: {
    /** `schema`: installed and disabled modules (what migrations keep); default: the installed ones (what is served). */
    readonly set?: 'served' | 'schema';
  } = {},
): Promise<KoshServer> {
  const envFile = join(cwd, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl === '')
    throw new Error('DATABASE_URL is not set: run kosh init, or add it to .env.');
  if (!existsSync(resolve(cwd, modulesFile)))
    throw new Error(`${modulesFile} does not exist: run kosh init, or pass --modules <file>.`);
  process.env['KOSH_SCHEDULES'] = 'off';
  // The module list is the catalogue; the database says which of them are installed (RFC 0008).
  const modules = await installedModules(
    databaseUrl,
    await modulesOf(modulesFile, cwd),
    options.set === 'schema' ? ['installed', 'disabled'] : ['installed'],
  );
  return createServer({ databaseUrl, modules, logger: false });
}

/** What seed data is loaded with: a server's, or an app change's transaction (`kosh apps`). */
export interface SeedContext {
  readonly shutro: KoshServer['shutro'];
  readonly driver: Pick<KoshServer['driver'], 'query'>;
  readonly modules: readonly KoshModule[];
}

/** Loads the modules' seed data and the apps' defaults (idempotent). */
export async function seed(
  server: KoshServer,
  write: (text: string) => void,
  only?: readonly string[],
): Promise<void> {
  await seedWith(
    { shutro: server.shutro, driver: server.driver, modules: server.registry.loaded.modules },
    write,
    only,
  );
}

/** {@link seed} on any Shutro instance (inside an app change's transaction, too). */
export async function seedWith(
  context: SeedContext,
  write: (text: string) => void,
  only?: readonly string[],
): Promise<void> {
  const installed = context.modules.map((m) => m.name);
  const unknown = (only ?? []).filter((m) => !installed.includes(m));
  if (unknown.length > 0)
    throw new Error(`Not installed: ${unknown.join(', ')} (installed: ${installed.join(', ')}).`);
  // Looked up first: a failing query would abort an app change's transaction.
  const [table] = await context.driver.query<{ found: string | null }>({
    text: "SELECT to_regclass('public.res_company')::text AS found",
    params: [],
  });
  const [company] =
    table?.found === null || table?.found === undefined
      ? []
      : await context.driver.query<{ id: string }>({
          text: 'SELECT id::text AS id FROM res_company ORDER BY id LIMIT 1',
          params: [],
        });
  const companyId = company === undefined ? undefined : Number(company.id);
  const results = await orm.loadData(context.shutro, {
    ...(companyId === undefined ? {} : { company: companyId }),
    ...(only === undefined || only.length === 0 ? {} : { modules: only }),
  });
  for (const r of results)
    write(
      `  ${r.module.padEnd(16)} ${r.created.length} created, ${r.updated.length} updated, ${r.unchanged} unchanged, ${r.kept.length} kept, ${r.deleted.length} deleted
`,
    );
  // The modules' defaults (data the users may edit afterwards): every served module's hooks.defaults, which may
  // derive from the modules being seeded.
  const wanted =
    only === undefined || only.length === 0
      ? context.modules
      : context.modules.filter((m) => only.includes(m.name));
  for (const d of await installDefaults(context.shutro, context.modules, {
    company: companyId,
    reason: 'kosh seed',
  }))
    if (wanted.some((m) => m.name === d.module))
      write(`  ${d.module.padEnd(16)} ${d.summary}
`);
}

/** Applies the pending files; a destructive one without `allowDestructive` is reported (exit code 1). */
async function apply(
  server: KoshServer,
  dir: string,
  write: (text: string) => void,
  allowDestructive: boolean,
): Promise<number> {
  try {
    const result = await migrate.applyMigrations({
      driver: server.driver,
      dir,
      registry: server.registry.registry,
      ...(allowDestructive ? { allowDestructive: true } : {}),
    });
    write(
      `Applied ${result.applied.length} migration file(s)${result.applied.map((f) => `\n  ${f.version}_${f.name}.sql`).join('')}\n`,
    );
    for (const m of result.modules) write(`  module ${m.module}: ${m.from ?? 'new'} → ${m.to}\n`);
    for (const h of result.hooks) write(`  data migration ${h.module}@${h.version}\n`);
    return 0;
  } catch (error) {
    if (error instanceof Error && error.name === 'DestructiveMigrationError') {
      write(`${error.message}\nReview it, then run kosh migrate --allow-destructive.\n`);
      return 1;
    }
    throw error;
  }
}

/** Applies pending files, plans what is still missing (a new file) and applies it, then seeds. */
export async function migrateProject(
  server: KoshServer,
  dir: string,
  write: (text: string) => void,
  options: { name?: string; planOnly?: boolean; allowDestructive?: boolean; seed?: boolean } = {},
): Promise<number> {
  const registry = server.registry.registry;
  // Files written earlier but not applied yet (e.g. a destructive one waiting for review) go first: planning
  // before them would plan the same changes twice.
  const pending = (await migrate.migrationStatus({ driver: server.driver, dir })).pending;
  if (pending.length > 0 && options.planOnly !== true) {
    write(`${pending.length} migration file(s) not applied yet: applying them first.\n`);
    const done = await apply(server, dir, write, options.allowDestructive === true);
    if (done !== 0) return done;
  }
  // The framework's own tables (idempotency keys, the installed apps) are not a model's: never altered or dropped.
  const plan = await migrate.planMigration({
    driver: server.driver,
    registry,
    ignore: FRAMEWORK_TABLES,
  });
  if (plan.statements.length > 0) {
    const file = await migrate.writeMigrationFile({ dir, name: options.name ?? 'update', plan });
    write(`Planned ${plan.statements.length} change(s) in ${file.path}\n`);
    for (const op of plan.destructive) write(`  destructive: ${migrate.renderOperation(op)}\n`);
  } else write('The database matches the modules: no new migration.\n');
  if (options.planOnly === true) return 0;
  if (plan.destructive.length > 0 && options.allowDestructive !== true) {
    write(
      'It drops or changes existing data: review the file, then run kosh migrate --allow-destructive.\n',
    );
    return 1;
  }
  if (plan.statements.length > 0 || pending.length === 0) {
    const done = await apply(server, dir, write, options.allowDestructive === true);
    if (done !== 0) return done;
  }
  if (options.seed !== false) {
    const [users] = await server.driver.query<{ n: string }>({
      text: 'SELECT count(*)::text AS n FROM res_company',
      params: [],
    });
    if (Number(users?.n ?? 0) > 0) {
      write('Seed data:\n');
      // The server holds the schema set: disabled modules keep their tables but get no seed data.
      const rows = await readInstalledApps(server.driver);
      const served = rows?.filter((r) => r.state === 'installed').map((r) => r.name);
      await seed(server, write, served !== undefined && served.length > 0 ? served : undefined);
    } else write('No company yet: seed data waits for kosh init.\n');
  }
  return 0;
}

/** `kosh migrate [status] …` */
export async function runMigrate(
  argv: readonly string[],
  write: (t: string) => void,
  cwd: string,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      modules: { type: 'string', default: 'src/modules.ts' },
      dir: { type: 'string', default: 'migrations' },
      name: { type: 'string' },
      plan: { type: 'boolean' },
      'allow-destructive': { type: 'boolean' },
      'no-seed': { type: 'boolean' },
    },
  });
  const server = await openProject(cwd, values.modules, { set: 'schema' });
  try {
    const dir = resolve(cwd, values.dir);
    // App changes made on another server (the Apps page) wrote their files there: they come back from the log.
    for (const file of await restoreAppMigrations(server.driver, dir))
      write(`Restored migrations/${file} (an applied app change)
`);
    if (positionals[0] === 'status') {
      const status = await migrate.migrationStatus({ driver: server.driver, dir });
      write(
        `Applied (${status.applied.length}):${status.applied.map((f) => `\n  ${f.version}_${f.name}`).join('')}\n` +
          `Pending (${status.pending.length}):${status.pending.map((f) => `\n  ${f.version}_${f.name}`).join('')}\n`,
      );
      return 0;
    }
    if (values.name !== undefined && !/^[a-z0-9_]+$/.test(values.name))
      throw new Error(
        '--name takes lower-case letters, digits and underscores (add_customer_phone).',
      );
    return await migrateProject(server, dir, write, {
      ...(values.name === undefined ? {} : { name: values.name }),
      planOnly: values.plan === true,
      allowDestructive: values['allow-destructive'] === true,
      seed: values['no-seed'] !== true,
    });
  } finally {
    await server.close();
  }
}

/** `kosh seed [module …]` */
export async function runSeed(
  argv: readonly string[],
  write: (t: string) => void,
  cwd: string,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: { modules: { type: 'string', default: 'src/modules.ts' } },
  });
  const server = await openProject(cwd, values.modules);
  try {
    write('Seed data:\n');
    await seed(server, write, positionals);
    return 0;
  } finally {
    await server.close();
  }
}

const camel = (name: string) =>
  name.replace(/[-_]+([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
const title = (name: string) =>
  name
    .split(/[-_]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

/** The files of a new module (`kosh module create <name>`). */
export function moduleFiles(name: string): Record<string, string> {
  const id = camel(name);
  const label = title(name);
  const model = `${name}.item`;
  return {
    'models.ts': `/** The models of the ${label} module (Shutro): fields, access per group, rules. */
import { orm } from 'kosh-erp/orm';

const { defineModel, f } = orm;

export const Item = defineModel('${model}', {
  archivable: true,
  access: {
    '${name}.user': ['read', 'write', 'create'],
    '${name}.manager': ['read', 'write', 'create', 'unlink', 'export', 'import'],
  },
  order: ['name asc'],
  fields: {
    name: f.char({ required: true }),
    code: f.char({ index: 'unique' }),
    notes: f.text(),
  },
});
`,
    'data.ts': `/**
 * Seed data of the ${label} module: \`kosh seed\` (and \`kosh migrate\`) create these records, update them when they
 * change here, and delete records removed from this list. \`noupdate\` records are created once, then left to the users.
 * Refer to other records by external id: orm.ref('res.currency', 'base.currency_bdt').
 */
import { orm } from 'kosh-erp/orm';

export const data = [
  orm.record('${model}', 'item_sample', { name: 'Sample item', code: 'SAMPLE' }, { noupdate: true }),
];
`,
    'migrations.ts': `/**
 * Data migrations of the ${label} module: each runs once, when an installed module is upgraded past its version
 * (raise \`version\` in index.ts, then \`kosh migrate\`). Schema changes need none: \`kosh migrate\` plans them.
 */
import type { DataMigration } from 'kosh-erp/orm';

export const migrations: DataMigration[] = [
  // {
  //   version: '0.2.0',
  //   description: 'Upper-case the item codes',
  //   up: async ({ sql }) => {
  //     await sql\`UPDATE ${name.replace(/-/g, '_')}_item SET code = upper(code)\`;
  //   },
  // },
];
`,
    'index.ts': `/**
 * The ${label} module: its Shutro models, groups, seed data and data migrations, plus access levels, an app,
 * menus, actions and views. Installed by listing it in src/modules.ts, then \`kosh migrate\`.
 */
import { base, baseShutro } from 'kosh-erp';
import { defineModule } from 'kosh-erp/modules-sdk';
import { orm } from 'kosh-erp/orm';
import { form, list } from 'kosh-erp/views';
import { data } from './data.ts';
import { migrations } from './migrations.ts';
import { Item } from './models.ts';

export const ${id}Shutro = orm.defineModule({
  name: '${name}',
  version: '0.1.0',
  depends: [baseShutro],
  groups: [
    orm.defineGroup({ code: '${name}.user', label: '${label} user', implies: ['base.user'] }),
    orm.defineGroup({ code: '${name}.manager', label: '${label} manager', implies: ['${name}.user'] }),
  ],
  models: [Item],
  data,
  migrations,
});

export const ${id} = defineModule({
  shutro: ${id}Shutro,
  kosh: '^0.1.0',
  depends: [base],
  accessLevels: {
    user: { label: 'User', groups: ['${name}.user'] },
    manager: { label: 'Manager', groups: ['${name}.manager'], implies: ['user'] },
  },
  app: { code: '${name}', label: '${label}', icon: 'box', sequence: 50 },
  actions: {
    '${name}.action_items': { model: '${model}', label: 'Items', views: ['list', 'form'] },
  },
  menus: [
    { id: '${name}.root', label: '${label}', app: '${name}' },
    { id: '${name}.items', parent: '${name}.root', label: 'Items', action: '${name}.action_items' },
  ],
  views: {
    '${model}.list': list(Item, { columns: ['name', 'code'] }),
    '${model}.form': form(Item, (f) => ({ sheet: [f.group('main', ['name', 'code', 'notes'])] })),
  },
});
`,
  };
}

/** `kosh module create <name>`: scaffolds src/modules/<name>/ and lists it in src/modules.ts. */
export async function runModule(
  argv: readonly string[],
  write: (t: string) => void,
  cwd: string,
): Promise<number> {
  const [action, name] = argv;
  if (action !== 'create' || name === undefined) {
    write('Usage: kosh module create <name>   (lower-case letters, digits and -, e.g. library)\n');
    return 2;
  }
  if (
    !/^[a-z][a-z0-9-]{1,40}$/.test(name) ||
    ['base', 'kosh', 'auth', 'res', 'mail', 'storage', 'report', 'approval'].includes(name)
  ) {
    write(
      `"${name}" cannot be a module name: lower-case letters, digits and -, not a reserved prefix.\n`,
    );
    return 2;
  }
  const dir = join(cwd, 'src', 'modules', name);
  if (existsSync(dir)) {
    write(`src/modules/${name} exists already.\n`);
    return 1;
  }
  await mkdir(dir, { recursive: true });
  for (const [file, content] of Object.entries(moduleFiles(name))) {
    await writeFile(join(dir, file), content);
    write(`  wrote   src/modules/${name}/${file}\n`);
  }
  const list = join(cwd, 'src', 'modules.ts');
  const id = camel(name);
  if (existsSync(list)) {
    const text = await readFile(list, 'utf8');
    const listed = /export const modules = \[([^\]]*)\];/.exec(text);
    if (listed !== null) {
      const imports = [...text.matchAll(/^import .*;$/gm)];
      const last = imports.at(-1);
      const at = last === undefined ? 0 : (last.index ?? 0) + last[0].length;
      const withImport = `${text.slice(0, at)}\nimport { ${id} } from './modules/${name}/index.ts';${text.slice(at)}`;
      const next = withImport.replace(
        /export const modules = \[([^\]]*)\];/,
        (_m, items: string) => `export const modules = [${items.trim()}, ${id}];`,
      );
      await writeFile(list, next);
      write(`  updated src/modules.ts (${id} added)\n`);
    } else write(`  add ${id} to the modules list in src/modules.ts\n`);
  }
  write(
    `\nNext: kosh apps install ${name}   (creates its tables and loads its seed data, in one transaction)\n`,
  );
  return 0;
}

/** The access levels a role list names: `reporting.user`, `messaging.user`, … (groups of installed modules). */
function groupsOf(server: KoshServer, roles: string): string[] {
  const list = roles
    .split(',')
    .map((r) => r.trim())
    .filter((r) => r !== '');
  const known = new Set(
    server.registry.loaded.modules.flatMap((m) =>
      Object.values(m.accessLevels).flatMap((level) => [...level.groups]),
    ),
  );
  known.add('base.user');
  known.add('base.admin');
  const unknown = list.filter((r) => !known.has(r));
  if (unknown.length > 0)
    throw new Error(
      `Unknown role(s): ${unknown.join(', ')}. Known: ${[...known].sort().join(', ')}.`,
    );
  return list;
}

/** `kosh user create <login> …` and `kosh user password <login>`. */
export async function runUser(
  argv: readonly string[],
  write: (t: string) => void,
  cwd: string,
  prompter?: import('./prompt.js').Prompter,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      modules: { type: 'string', default: 'src/modules.ts' },
      name: { type: 'string' },
      email: { type: 'string' },
      roles: { type: 'string', default: 'base.user' },
      password: { type: 'string' },
    },
  });
  const [action, login] = positionals;
  if ((action !== 'create' && action !== 'password') || login === undefined) {
    write(
      'Usage: kosh user create <login> [--name <name>] [--email <email>] [--roles a.user,b.manager] [--password <pw>]\n' +
        '       kosh user password <login> [--password <pw>]\n',
    );
    return 2;
  }
  const { terminalPrompter } = await import('./prompt.js');
  const ask = prompter ?? terminalPrompter();
  const password =
    values.password ??
    process.env['KOSH_USER_PASSWORD'] ??
    (await ask.ask({
      message: 'Password (12+ characters)',
      secret: true,
      validate: (v) => (v.length >= 12 ? null : 'At least 12 characters.'),
    }));
  if (prompter === undefined) ask.close();
  const server = await openProject(cwd, values.modules);
  try {
    const auth = server.auth;
    if (auth === undefined) throw new Error('base is not installed.');
    const [company] = await server.driver.query<{ id: string }>({
      text: 'SELECT id::text AS id FROM res_company ORDER BY id LIMIT 1',
      params: [],
    });
    if (company === undefined) throw new Error('No company yet: run kosh init first.');
    const [user] = await server.driver.query<{ id: string }>({
      text: 'SELECT id::text AS id FROM res_users WHERE login = $1',
      params: [login],
    });
    if (action === 'password') {
      if (user === undefined) throw new Error(`No user "${login}".`);
      await server.shutro.bootstrap({ reason: `kosh user password ${login}` }, (env) =>
        auth.setPassword(env, Number(user.id), password),
      );
      write(`Password of "${login}" changed.\n`);
      return 0;
    }
    if (user !== undefined) throw new Error(`A user "${login}" exists already.`);
    const id = await auth.createUser({
      login,
      name: values.name ?? login,
      password,
      company: Number(company.id),
      companies: [Number(company.id)],
      groups: groupsOf(server, values.roles),
    });
    if (values.email !== undefined)
      await server.shutro.bootstrap({ reason: `kosh user create ${login}` }, async (env) => {
        await (
          env.model('res.users' as never) as unknown as {
            browse(ids: number[]): { write(v: unknown): Promise<void> };
          }
        )
          .browse([id])
          .write({ email: values.email });
      });
    write(`Created "${login}" with ${values.roles}.\n`);
    return 0;
  } finally {
    await server.close();
  }
}
