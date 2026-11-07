/**
 * The App manager's engine (RFC 0008 §5.2–5.4): the installed set of a database (`kosh_module`), and app changes
 * planned against the live database and applied in ONE transaction.
 *
 * - {@link prepareApps} plans: the module changes (`planApps`), the runtime registry (installed modules) and the
 *   schema registry (installed and disabled: a disabled module keeps its tables), and the schema statements. It
 *   refuses changes that would drop data, a database that does not match its modules yet, and a disable that would
 *   leave required columns no served module fills.
 * - {@link applyApps} applies: the migration file, the new modules' data, their `postInstall` hooks and the
 *   installed set, all in one PostgreSQL transaction (DDL is transactional): a failure leaves nothing behind, not
 *   even the migration file. Shutro runs on a driver pinned to that transaction (nested transactions become
 *   savepoints), so the ORM does the work and Kosh only decides where it happens.
 * - {@link installedModules} is what a server serves: the catalogue modules installed in its database.
 *
 * Before the first app change there is no `kosh_module`: servers and `kosh migrate` treat the module list as the
 * installed set (as before RFC 0008), and the first app change adopts the modules Shutro has migrated.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type AppChange,
  type AppPlan,
  AppPlanError,
  type InstalledApp,
  type KoshModule,
  planApps,
  servedModules,
} from '@kosh/modules-sdk';
import { IDEMPOTENCY_TABLE } from './api/idempotency.js';
import { audit } from './audit.js';
import {
  type Driver,
  type DriverConnection,
  type DriverQuery,
  type MigrationFile,
  type MigrationPlan,
  migrate,
  orm,
  pg,
  type Shutro,
} from './orm.js';
import { buildKoshRegistry, type KoshRegistry } from './registry.js';

/** The installed set: one row per module. */
export const APPS_TABLE = 'kosh_module';
/** Every applied app change: who, what, and the SQL that ran. */
export const APPS_LOG_TABLE = 'kosh_app_log';
/**
 * Notified (with the new set's digest) when an app change commits: every server of the database rebuilds for the new
 * installed set (`createAppHost`).
 */
export const APPS_CHANNEL = 'kosh_apps';
/** What an uninstall dropped, kept for {@link SNAPSHOT_DAYS} days (RFC 0008 §5.4). */
export const APPS_SNAPSHOT_TABLE = 'kosh_app_snapshot';
/** How long an uninstall's snapshot is kept. */
export const SNAPSHOT_DAYS = 30;
/** Tables the framework owns (not a model's): migrations never alter or drop them. */
export const FRAMEWORK_TABLES: readonly string[] = [
  IDEMPOTENCY_TABLE,
  APPS_TABLE,
  APPS_LOG_TABLE,
  APPS_SNAPSHOT_TABLE,
];

/** Creates the App manager's tables (idempotent). */
export function appTableStatements(): DriverQuery[] {
  return [
    {
      text: `CREATE TABLE IF NOT EXISTS ${APPS_TABLE} (
  name text PRIMARY KEY,
  version text NOT NULL,
  state text NOT NULL CHECK (state IN ('installed', 'disabled')),
  reason text NOT NULL CHECK (reason IN ('selected', 'dependency', 'bridge')),
  added_at timestamptz NOT NULL DEFAULT now(),
  added_by text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
)`,
      params: [],
    },
    // When the module's demo data was loaded (RFC 0008 §5.8); added to tables from before it.
    { text: `ALTER TABLE ${APPS_TABLE} ADD COLUMN IF NOT EXISTS demo_at timestamptz`, params: [] },
    {
      text: `CREATE TABLE IF NOT EXISTS ${APPS_LOG_TABLE} (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL,
  change jsonb NOT NULL,
  statements text NOT NULL,
  digest text NOT NULL,
  migration_file text,
  migration_content text
)`,
      params: [],
    },
    {
      text: `CREATE TABLE IF NOT EXISTS ${APPS_SNAPSHOT_TABLE} (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL,
  modules text[] NOT NULL,
  tables jsonb NOT NULL
)`,
      params: [],
    },
    {
      // Rows written before 2026-10-27 hold the change as a JSON string inside the jsonb (it was encoded twice):
      // turn them back into the object. Idempotent; nothing to do once repaired.
      text: `UPDATE ${APPS_LOG_TABLE} SET change = (change #>> '{}')::jsonb WHERE jsonb_typeof(change) = 'string'`,
      params: [],
    },
  ];
}

type Queryable = Pick<Driver, 'query'>;

/** The installed set, dependencies first; `null` before the first app change (no `kosh_module` yet). */
export async function readInstalledApps(db: Queryable): Promise<InstalledApp[] | null> {
  const [exists] = await db.query<{ found: string | null }>({
    text: `SELECT to_regclass('public.${APPS_TABLE}')::text AS found`,
    params: [],
  });
  if (exists?.found === null || exists?.found === undefined) return null;
  const rows = await db.query<{ name: string; version: string; state: string; reason: string }>({
    text: `SELECT name, version, state, reason FROM ${APPS_TABLE} ORDER BY added_at, name`,
    params: [],
  });
  return rows.map((r) => ({
    name: r.name,
    version: r.version,
    state: r.state as InstalledApp['state'],
    reason: r.reason as InstalledApp['reason'],
  }));
}

/**
 * The installed set. Before the first app change there is no `kosh_module`: the modules Shutro has migrated
 * (`shutro_module`) are adopted, so modules added to the catalogue since then count as available, not installed.
 */
export async function installedApps(
  db: Queryable,
  catalogue: readonly KoshModule[],
): Promise<InstalledApp[]> {
  const rows = await readInstalledApps(db);
  if (rows !== null) return rows;
  const [ledger] = await db.query<{ found: string | null }>({
    text: "SELECT to_regclass('public.shutro_module')::text AS found",
    params: [],
  });
  if (ledger?.found === null || ledger?.found === undefined) return [];
  const migrated = new Set(
    (await db.query<{ name: string }>({ text: 'SELECT name FROM shutro_module', params: [] })).map(
      (r) => r.name,
    ),
  );
  const all = new Map<string, KoshModule>();
  const visit = (m: KoshModule) => {
    if (all.has(m.name)) return;
    for (const d of m.depends) visit(d);
    all.set(m.name, m);
  };
  for (const m of catalogue) visit(m);
  return [...all.values()]
    .filter((m) => migrated.has(m.name))
    .map((m) => ({ name: m.name, version: m.version, state: 'installed', reason: 'selected' }));
}

/** A digest of an installed set: equal sets, equal digests (what `NOTIFY` carries and hosts compare). */
export const appsDigest = (rows: readonly InstalledApp[]): string => digestOf(rows);

const digestOf = (rows: readonly InstalledApp[]) =>
  createHash('sha256')
    .update(JSON.stringify([...rows].sort((a, b) => a.name.localeCompare(b.name))))
    .digest('hex');

/**
 * The catalogue modules a database serves (state `installed`): what `createServer({ modules })` takes.
 * @param source a driver, or a database URL (a short-lived connection is opened).
 */
export async function installedModules(
  source: Driver | string,
  catalogue: readonly KoshModule[],
  states: readonly InstalledApp['state'][] = ['installed'],
): Promise<KoshModule[]> {
  const driver =
    typeof source === 'string'
      ? pg.createDriver({ url: source, max: 1, applicationName: 'shutro-erp apps' })
      : source;
  try {
    const rows = await readInstalledApps(driver);
    return rows === null ? [...catalogue] : servedModules(catalogue, rows, states);
  } finally {
    if (typeof source === 'string') await driver.end();
  }
}

/** Records `modules` as installed (`kosh init`, after its first migration). Existing rows are left as they are. */
export async function recordInstalledApps(
  db: Queryable,
  modules: readonly KoshModule[],
  selected: readonly string[],
  actor: string,
): Promise<void> {
  for (const q of appTableStatements()) await db.query(q);
  for (const m of modules)
    await db.query({
      text: `INSERT INTO ${APPS_TABLE} (name, version, state, reason, added_by)
VALUES ($1, $2, 'installed', $3, $4) ON CONFLICT (name) DO NOTHING`,
      params: [m.name, m.version, selected.includes(m.name) ? 'selected' : 'dependency', actor],
    });
}

/**
 * Writes back the migration files of app changes that are applied but missing from `dir` (a server whose files were
 * not kept, e.g. a recreated container), exactly as they were, so the next file gets the next number and every
 * applied file keeps its checksum. Returns the restored file names.
 */
export async function restoreAppMigrations(db: Queryable, dir: string): Promise<string[]> {
  const [log] = await db.query<{ found: string | null }>({
    text: `SELECT to_regclass('public.${APPS_LOG_TABLE}')::text AS found`,
    params: [],
  });
  if (log?.found === null || log?.found === undefined) return [];
  const rows = await db.query<{ migration_file: string; migration_content: string }>({
    text: `SELECT migration_file, migration_content FROM ${APPS_LOG_TABLE}
WHERE migration_file IS NOT NULL ORDER BY id`,
    params: [],
  });
  const restored: string[] = [];
  for (const row of rows) {
    const path = join(dir, row.migration_file);
    if (existsSync(path)) continue;
    await mkdir(dir, { recursive: true });
    await writeFile(path, row.migration_content);
    restored.push(row.migration_file);
  }
  return restored;
}

/** A planned app change, ready for {@link applyApps}. */
export interface PreparedApps {
  readonly plan: AppPlan;
  /** The installed set the plan was made from (checked again when applying). */
  readonly current: readonly InstalledApp[];
  /** The installed modules afterwards: what the server serves. */
  readonly runtime: KoshRegistry;
  /** Installed and disabled modules afterwards: what the schema keeps. */
  readonly schema: KoshRegistry;
  /** The schema statements (none for disable / enable). */
  readonly migration: MigrationPlan;
  /** True when the plan changes nothing. */
  readonly empty: boolean;
  /** An upgrade may drop columns or tables its new code no longer has (`removeData`); an uninstall drops its own. */
  readonly allowDestructive: boolean;
  /** The installed and disabled modules before the change (an uninstall's hooks run on it). */
  readonly before: KoshRegistry;
  /** What an uninstall drops: each table, or column, with the rows that hold data. */
  readonly drops: readonly {
    readonly table: string;
    readonly column: string | null;
    readonly rows: number;
  }[];
}

/** Options of {@link prepareApps}. */
export interface PrepareAppsOptions {
  readonly driver: Driver;
  /** The modules this installation can install. */
  readonly catalogue: readonly KoshModule[];
  readonly change: AppChange;
  /** The migration files' folder (pending files must be applied first). */
  readonly dir: string;
  /** Modules that can never be disabled. Default: `base`. */
  readonly protect?: readonly string[];
  /**
   * An upgrade may drop the columns and tables its new code no longer has (RFC 0012 §5.4: "remove data"). Default:
   * false, and such an upgrade is refused with what it would drop.
   */
  readonly removeData?: boolean;
}

/** Plans an app change against the live database. Changes nothing. @throws {AppPlanError} */
export async function prepareApps(options: PrepareAppsOptions): Promise<PreparedApps> {
  const { driver, catalogue } = options;
  await restoreAppMigrations(driver, options.dir);
  const pending = (await migrate.migrationStatus({ driver, dir: options.dir })).pending;
  if (pending.length > 0)
    throw new AppPlanError(
      `${pending.length} migration file(s) are not applied yet (${pending.map((f) => `${f.version}_${f.name}`).join(', ')}).`,
      'Run shutro-erp migrate first.',
    );
  const current = await installedApps(driver, catalogue);
  const plan = planApps(catalogue, current, options.change, options.protect ?? ['base']);
  const registryOf = (rows: readonly InstalledApp[], states: readonly InstalledApp['state'][]) =>
    buildKoshRegistry(servedModules(catalogue, rows, states));

  // The database must match its modules before apps change: otherwise the plan would carry unrelated changes.
  const before = registryOf(current, ['installed', 'disabled']);
  const drift = await migrate.planMigration({
    driver,
    registry: before.registry,
    ignore: FRAMEWORK_TABLES,
  });
  // An upgrade is exactly that difference: the upgraded modules' code ahead of the database.
  if (drift.statements.length > 0 && plan.upgrade.length === 0)
    throw new AppPlanError(
      `The database does not match the installed modules (${drift.statements.length} change(s) not migrated).`,
      'Run shutro-erp migrate first.',
    );

  const runtime = registryOf(plan.after, ['installed']);
  const schema = registryOf(plan.after, ['installed', 'disabled']);
  const migration = await migrate.planMigration({
    driver,
    registry: schema.registry,
    ignore: FRAMEWORK_TABLES,
  });
  const removeData =
    (options.removeData === true && plan.upgrade.length > 0) || plan.uninstall.length > 0;
  if (migration.destructive.length > 0 && !removeData)
    throw new AppPlanError(
      `The change would drop or alter data: ${migration.destructive.map((op) => migrate.renderOperation(op)).join('; ')}.`,
      plan.upgrade.length > 0
        ? 'Upgrade with "remove data" (shutro-erp apps upgrade --remove-data) to drop them, or keep the fields in the code.'
        : 'App changes never destroy data; review the modules, or use shutro-erp migrate --plan.',
    );
  // A disabled module's columns stay in other modules' tables: a NOT NULL one without a database default (a function
  // default or a compute lives in the ORM) would make every insert there fail.
  const orphaned: string[] = [];
  for (const model of runtime.registry.models.keys()) {
    const kept = schema.registry.describe(model);
    const served = runtime.registry.describe(model).fields;
    for (const [field, d] of Object.entries(kept.fields)) {
      if (!d.store || d.column === null || served[field] !== undefined) continue;
      const [column] = await driver.query<{ is_nullable: string; column_default: string | null }>({
        text: `SELECT is_nullable, column_default FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
        params: [kept.table, d.column],
      });
      if (column?.is_nullable === 'NO' && column.column_default === null)
        orphaned.push(`${model}.${field}`);
    }
  }
  if (orphaned.length > 0)
    throw new AppPlanError(
      `Disabling would leave required fields that no enabled module fills: ${orphaned.join(', ')}.`,
      'Disable the modules that extend these models too, or make the fields optional.',
    );
  // What an uninstall drops, with the rows that hold data: the plan shows it before anyone confirms.
  const drops: { table: string; column: string | null; rows: number }[] = [];
  if (plan.uninstall.length > 0)
    for (const op of migration.destructive) {
      if (op.kind !== 'dropTable' && op.kind !== 'dropColumn') continue;
      const column = op.kind === 'dropColumn' ? op.column : null;
      const [row] = await driver.query<{ n: string }>({
        text:
          column === null
            ? `SELECT count(*)::text AS n FROM "${op.table}"`
            : `SELECT count(*)::text AS n FROM "${op.table}" WHERE "${column}" IS NOT NULL`,
        params: [],
      });
      drops.push({ table: op.table, column, rows: Number(row?.n ?? 0) });
    }
  return {
    plan,
    current,
    runtime,
    schema,
    migration,
    empty:
      plan.install.length === 0 &&
      plan.enable.length === 0 &&
      plan.disable.length === 0 &&
      plan.upgrade.length === 0 &&
      plan.uninstall.length === 0 &&
      migration.statements.length === 0,
    allowDestructive: removeData,
    before,
    drops,
  };
}

/** What the new modules' data loading receives (inside the transaction). */
export interface AppLoadContext {
  readonly shutro: Shutro;
  readonly driver: Driver;
  readonly registry: KoshRegistry;
  /** The first company, once one exists. */
  readonly company: number | undefined;
}

/** Options of {@link applyApps}. */
export interface ApplyAppsOptions {
  readonly driver: Driver;
  /** The migration files' folder: the change's statements are written there as the next file. */
  readonly dir: string;
  /** Who applies it (a login, or `cli`): recorded in the installed set and the log. */
  readonly actor: string;
  /** The migration file's name. Default: `apps`. */
  readonly name?: string;
  /** Progress: `schema`, `data`, `hooks`, `state`. */
  readonly onStep?: (step: 'schema' | 'data' | 'hooks' | 'state', detail: string) => void;
  /**
   * The audit event's actor (a user id; `null` for the CLI) and request address. The event (`apps.change`) is
   * written in the change's transaction whenever the audit log is installed.
   */
  readonly audit?: { readonly actor: number | null; readonly ip?: string };
  /**
   * Loads the new modules' data. Default: Shutro `loadData` for those modules, then every served module's
   * `hooks.defaults`.
   */
  readonly load?: (context: AppLoadContext, modules: readonly string[]) => Promise<void>;
}

/** What {@link applyApps} did. */
export interface AppsResult {
  readonly migration: MigrationFile | null;
  readonly installed: readonly string[];
  readonly enabled: readonly string[];
  readonly disabled: readonly string[];
  readonly upgraded: readonly string[];
  readonly uninstalled: readonly string[];
  /** The snapshot of what the uninstall dropped (`kosh_app_snapshot.id`), or null. */
  readonly snapshot: number | null;
}

/**
 * A driver on one connection of an open transaction: Shutro's transactions become savepoints of it, and session
 * settings stay transaction-local. Nothing commits until the outer transaction does.
 *
 * No pool size is reported (`max`): what Shutro would run on a second connection (standard sequences' counters)
 * runs in this transaction too, which is what an install wants: a rolled-back install takes its numbers back.
 */
function pinnedDriver(conn: DriverConnection): Driver {
  return {
    query: (q) => conn.query(q),
    transaction: (options, fn) =>
      conn.savepoint(async (inner) => {
        for (const [name, value] of Object.entries(options.settings ?? {}))
          await inner.query({ text: 'SELECT set_config($1, $2, true)', params: [name, value] });
        if (options.statementTimeoutMs !== undefined)
          await inner.query({
            text: "SELECT set_config('statement_timeout', $1, true)",
            params: [String(options.statementTimeoutMs)],
          });
        return fn(inner);
      }),
    listen: async () => async () => {},
    end: async () => {},
  };
}

/**
 * Runs every served module's `hooks.defaults` (idempotent: approval policies, document templates, activity types,
 * ... derived from the served modules) in one system scope. Returns each module's summary line.
 */
export async function installDefaults(
  shutro: Shutro,
  modules: readonly KoshModule[],
  options: { readonly company?: number | undefined; readonly reason?: string } = {},
): Promise<{ readonly module: string; readonly summary: string }[]> {
  const out: { module: string; summary: string }[] = [];
  const hooked = modules.filter((m) => m.hooks?.defaults !== undefined);
  if (hooked.length === 0) return out;
  await shutro.bootstrap(
    {
      reason: options.reason ?? 'module defaults',
      ...(options.company === undefined ? {} : { company: options.company }),
    },
    async (env) => {
      for (const m of hooked) {
        const summary = await m.hooks?.defaults?.(env, modules);
        if (summary !== undefined) out.push({ module: m.name, summary });
      }
    },
  );
  return out;
}

/** The new modules' data, then every served module's defaults (they may derive from the new modules). */
const defaultLoad = async (context: AppLoadContext, modules: readonly string[]) => {
  await orm.loadData(context.shutro, {
    modules,
    ...(context.company === undefined ? {} : { company: context.company }),
  });
  await installDefaults(context.shutro, context.registry.loaded.modules, {
    company: context.company,
    reason: `install ${modules.join(', ')}`,
  });
};

/**
 * Applies a prepared change in one transaction (one app change per database at a time). @throws {AppPlanError}
 * when the installed set changed since it was prepared.
 */
export async function applyApps(
  prepared: PreparedApps,
  options: ApplyAppsOptions,
): Promise<AppsResult> {
  const { plan } = prepared;
  const step = options.onStep ?? (() => {});
  let snapshotId: number | null = null;
  const file =
    prepared.migration.statements.length > 0
      ? await migrate.writeMigrationFile({
          dir: options.dir,
          name: options.name ?? 'apps',
          plan: prepared.migration,
        })
      : null;
  try {
    await options.driver.transaction({}, async (conn) => {
      for (const q of appTableStatements()) await conn.query(q);
      await conn.query({ text: "SELECT pg_advisory_xact_lock(hashtext('kosh_apps'))", params: [] });
      const tx = pinnedDriver(conn);
      const now = await readInstalledApps(tx);
      // Before the first change the table was just created empty: compare with what was planned from.
      if (now !== null && now.length > 0 && digestOf(now) !== digestOf(prepared.current))
        throw new AppPlanError(
          'The installed apps changed since this change was planned.',
          'Plan it again.',
        );

      const removed = plan.uninstall.map((u) => u.name);
      let snapshot: number | null = null;
      if (removed.length > 0) {
        // Each module may refuse (Accounting while posted entries exist), on the modules as they are now.
        const before = orm.createShutro({ driver: tx, registry: prepared.before.registry });
        for (const name of removed) {
          const hook = prepared.before.loaded.byName.get(name)?.hooks?.preUninstall;
          if (hook === undefined) continue;
          step('hooks', name);
          try {
            await before.bootstrap({ reason: `uninstall ${name}` }, (env) => hook(env));
          } catch (error) {
            throw new AppPlanError(
              `${name} cannot be uninstalled: ${error instanceof Error ? error.message : String(error)}`,
              'Disable it instead: the app goes away and its data stays.',
            );
          }
        }
        // The snapshot: every dropped table's rows and every dropped column's values, kept for 30 days.
        step('state', 'snapshot');
        const tables: { table: string; column: string | null; rows: unknown }[] = [];
        for (const d of prepared.drops) {
          const [row] = await tx.query<{ rows: unknown }>({
            text:
              d.column === null
                ? `SELECT coalesce(json_agg(t), '[]'::json) AS rows FROM "${d.table}" t`
                : `SELECT coalesce(json_agg(json_build_object('id', id, 'value', "${d.column}")), '[]'::json) AS rows FROM "${d.table}" WHERE "${d.column}" IS NOT NULL`,
            params: [],
          });
          tables.push({ table: d.table, column: d.column, rows: row?.rows ?? [] });
        }
        await tx.query({
          text: `DELETE FROM ${APPS_SNAPSHOT_TABLE} WHERE at < now() - make_interval(days => $1)`,
          params: [SNAPSHOT_DAYS],
        });
        const [made] = await tx.query<{ id: string }>({
          text: `INSERT INTO ${APPS_SNAPSHOT_TABLE} (actor, modules, tables) VALUES ($1, $2, $3::jsonb) RETURNING id::text AS id`,
          params: [options.actor, removed, tables],
        });
        snapshot = made === undefined ? null : Number(made.id);
      }

      // Upgrades run the modules' data migrations even without schema statements (Shutro tracks the versions).
      if (file !== null || plan.upgrade.length > 0) {
        step('schema', `${prepared.migration.statements.length} statement(s)`);
        await migrate.applyMigrations({
          driver: tx,
          dir: options.dir,
          registry: prepared.schema.registry,
          allowDestructive: prepared.allowDestructive,
        });
      }
      const shutro = orm.createShutro({ driver: tx, registry: prepared.runtime.registry });
      // A failed query would abort the transaction: look the table up before reading it.
      const [companies] = await tx.query<{ found: string | null }>({
        text: "SELECT to_regclass('public.res_company')::text AS found",
        params: [],
      });
      let companyId: number | undefined;
      if (companies?.found !== null && companies?.found !== undefined) {
        const [first] = await tx.query<{ id: string }>({
          text: 'SELECT id::text AS id FROM res_company ORDER BY id LIMIT 1',
          params: [],
        });
        companyId = first === undefined ? undefined : Number(first.id);
      }
      const added = plan.install.map((m) => m.name);
      if (added.length > 0) {
        step('data', added.join(', '));
        await (options.load ?? defaultLoad)(
          { shutro, driver: tx, registry: prepared.runtime, company: companyId },
          added,
        );
        for (const name of added) {
          const hook = prepared.runtime.loaded.byName.get(name)?.hooks?.postInstall;
          if (hook === undefined) continue;
          step('hooks', name);
          await shutro.bootstrap(
            {
              reason: `install ${name}`,
              ...(companyId === undefined ? {} : { company: companyId }),
            },
            (env) => hook(env),
          );
        }
      }

      const upgraded = plan.upgrade.map((u) => u.name);
      if (upgraded.length > 0) {
        // Their seed data again (records they changed), then every module's defaults.
        step('data', upgraded.join(', '));
        await (options.load ?? defaultLoad)(
          { shutro, driver: tx, registry: prepared.runtime, company: companyId },
          upgraded,
        );
      }

      if (removed.length > 0) {
        step('data', `remove ${removed.join(', ')}`);
        await removeModuleData(tx, shutro, prepared, removed);
        await tx.query({
          text: `DELETE FROM ${APPS_TABLE} WHERE name = ANY($1)`,
          params: [removed],
        });
      }

      step('state', `${plan.after.length} module(s)`);
      for (const row of plan.after)
        await tx.query({
          text: `INSERT INTO ${APPS_TABLE} (name, version, state, reason, added_by)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (name) DO UPDATE SET version = EXCLUDED.version, state = EXCLUDED.state,
  changed_at = CASE WHEN ${APPS_TABLE}.state IS DISTINCT FROM EXCLUDED.state THEN now() ELSE ${APPS_TABLE}.changed_at END`,
          params: [row.name, row.version, row.state, row.reason, options.actor],
        });
      const sql = prepared.migration.statements.map((s) => `${s.sql};`).join('\n');
      // The file itself, byte for byte: restoreAppMigrations writes it back where it went missing.
      const content = file === null ? null : await readFile(file.path, 'utf8');
      await tx.query({
        text: `INSERT INTO ${APPS_LOG_TABLE} (actor, change, statements, digest, migration_file, migration_content)
VALUES ($1, $2::jsonb, $3, $4, $5, $6)`,
        params: [
          options.actor,
          // The driver encodes a jsonb parameter itself: pass the value, not its JSON text.
          {
            install: plan.install,
            enable: plan.enable,
            disable: plan.disable,
            upgrade: plan.upgrade,
            uninstall: plan.uninstall,
            snapshot,
            migration: file === null ? null : `${file.version}_${file.name}.sql`,
          },
          sql,
          createHash('sha256').update(sql).digest('hex'),
          file === null ? null : `${file.version}_${file.name}.sql`,
          content,
        ],
      });
      if (prepared.runtime.registry.models.has('audit.event' as never)) {
        const parts = [
          ...plan.install.map((m) => `installed ${m.name}`),
          ...plan.enable.map((n) => `enabled ${n}`),
          ...plan.disable.map((m) => `disabled ${m.name}`),
          ...plan.upgrade.map((u) => `upgraded ${u.name} ${u.from} → ${u.to}`),
          ...plan.uninstall.map((u) => `uninstalled ${u.name} (data removed)`),
        ];
        await shutro.bootstrap({ reason: 'apps change audit' }, (env) =>
          audit(env, {
            kind: 'apps.change',
            summary: parts.length === 0 ? 'migrated the installed apps' : parts.join(', '),
            actor: options.audit?.actor ?? null,
            company: null,
            details: {
              by: options.actor,
              migration: file === null ? null : `${file.version}_${file.name}.sql`,
              ...(removed.length === 0 ? {} : { snapshot, drops: prepared.drops }),
            },
            ...(options.audit?.ip === undefined ? {} : { ip: options.audit.ip }),
          }),
        );
      }
      // Delivered when the transaction commits, to every server listening on this database.
      await tx.query({
        text: 'SELECT pg_notify($1, $2)',
        params: [APPS_CHANNEL, digestOf(plan.after)],
      });
      snapshotId = snapshot;
    });
  } catch (error) {
    if (file !== null) await rm(file.path, { force: true });
    throw error;
  }
  return {
    migration: file,
    installed: plan.install.map((m) => m.name),
    enabled: plan.enable,
    disabled: plan.disable.map((m) => m.name),
    upgraded: plan.upgrade.map((u) => u.name),
    uninstalled: plan.uninstall.map((u) => u.name),
    snapshot: snapshotId,
  };
}

/** Whether a table exists (a failed query would abort the transaction). */
async function hasTable(tx: Driver, table: string): Promise<boolean> {
  const [row] = await tx.query<{ found: string | null }>({
    text: 'SELECT to_regclass($1)::text AS found',
    params: [`public.${table}`],
  });
  return row?.found !== null && row?.found !== undefined;
}

/**
 * After an uninstall's schema change (RFC 0008 §5.4): the modules' records in the models that stay (by external
 * id; one that others still use is kept and logged), their external ids, their groups and role grants, the runtime
 * roles' rights on models that went, and Shutro's record of the modules.
 */
async function removeModuleData(
  tx: Driver,
  shutro: Shutro,
  prepared: PreparedApps,
  removed: readonly string[],
): Promise<void> {
  const models = new Set<string>([...prepared.runtime.registry.models.keys()].map(String));
  const ids = await tx.query<{ model: string; res_id: string; name: string }>({
    text: 'SELECT model, res_id::text AS res_id, name FROM shutro_external_id WHERE module = ANY($1)',
    params: [removed],
  });
  for (const row of ids) {
    if (!models.has(row.model)) continue;
    try {
      await shutro.bootstrap({ reason: `uninstall: ${row.name}` }, async (env) => {
        const records = env.model(row.model as never) as unknown as {
          browse(ids: number[]): { unlink(): Promise<void> };
        };
        await records.browse([Number(row.res_id)]).unlink();
      });
    } catch {
      // Still used by records that stay (a sequence, a category): kept, without its module.
    }
  }
  await tx.query({
    text: 'DELETE FROM shutro_external_id WHERE module = ANY($1)',
    params: [removed],
  });
  const byName = prepared.before.loaded.byName;
  const groups = removed.flatMap((n) => (byName.get(n)?.shutro.groups ?? []).map((g) => g.code));
  const permissions = removed.flatMap((n) =>
    (byName.get(n)?.shutro.permissions ?? []).map((p) => p.code),
  );
  if (groups.length > 0 && (await hasTable(tx, 'auth_user_group')))
    await tx.query({
      text: 'DELETE FROM auth_user_group WHERE "group" = ANY($1)',
      params: [groups],
    });
  const kept = [...models];
  if (await hasTable(tx, 'shutro_role')) {
    await tx.query({
      text: 'UPDATE shutro_role SET implies = array(SELECT g FROM unnest(implies) AS g WHERE NOT (g = ANY($1))) WHERE implies && $1',
      params: [groups],
    });
    await tx.query({
      text: 'DELETE FROM shutro_role_access WHERE role = ANY($1) OR NOT (model = ANY($2))',
      params: [groups, kept],
    });
    await tx.query({
      text: 'DELETE FROM shutro_role_rule WHERE role = ANY($1) OR NOT (model = ANY($2))',
      params: [groups, kept],
    });
    await tx.query({
      text: 'DELETE FROM shutro_role_permission WHERE role = ANY($1) OR permission = ANY($2)',
      params: [groups, permissions],
    });
    await tx.query({
      text: 'DELETE FROM shutro_role_field WHERE NOT (model = ANY($1))',
      params: [kept],
    });
  }
  if (await hasTable(tx, 'shutro_module'))
    await tx.query({ text: 'DELETE FROM shutro_module WHERE name = ANY($1)', params: [removed] });
}
