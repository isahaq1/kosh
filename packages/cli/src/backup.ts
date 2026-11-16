/**
 * Backups that are rehearsed, not hoped for (RFC 0034 step 2).
 *
 * - `shutro-erp backup` writes `backups/<database>-<time>.dump` (pg_dump's custom format) and beside it a manifest:
 *   the row count of every table and the totals that must survive — the ledger's debits and credits, the stock on
 *   hand —, all read **in the snapshot pg_dump exports** (`pg_dump --snapshot`), so the manifest describes exactly
 *   what the dump holds, however busy the database is.
 * - `shutro-erp backup verify [file]` restores the latest backup (or the one named) into a scratch database on the
 *   same server, measures it again, compares, drops the scratch database, and records the result in the
 *   installation (`kosh_backup_check`), where `shutro-erp doctor` reads it.
 *
 * pg_dump and pg_restore must be at least the server's version: the local ones when they are, else a `postgres`
 * image of the server's major version through Docker.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { type Driver, pg } from '@kosh/server/orm';

/** What a backup holds, measured in its own snapshot. */
export interface BackupManifest {
  readonly format: 1;
  readonly file: string;
  readonly database: string;
  readonly serverVersion: number;
  readonly createdAt: string;
  readonly rows: Readonly<Record<string, number>>;
  readonly totals: Readonly<Record<string, string>>;
}

export interface VerifyResult {
  readonly ok: boolean;
  readonly file: string;
  readonly tables: number;
  readonly problems: readonly string[];
}

/** A table name as PostgreSQL quotes it (names come from the catalog, never from input). */
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** The row count of every table of the public schema, and the totals that must survive a restore. */
async function measure(
  q: (text: string) => Promise<readonly Record<string, unknown>[]>,
): Promise<{ rows: Record<string, number>; totals: Record<string, string> }> {
  const tables = (await q(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  )) as { tablename: string }[];
  const rows: Record<string, number> = {};
  for (const t of tables) {
    const [r] = (await q(`SELECT count(*)::bigint AS n FROM ${quote(t.tablename)}`)) as {
      n: string | number;
    }[];
    rows[t.tablename] = Number(r?.n ?? 0);
  }
  const totals: Record<string, string> = {};
  const has = (name: string) => name in rows;
  // The ledger: every posted line's debits and credits (they must balance, and match the original).
  if (has('account_move_line')) {
    const [r] = (await q(
      'SELECT coalesce(sum(debit), 0)::text AS debit, coalesce(sum(credit), 0)::text AS credit FROM account_move_line',
    )) as { debit: string; credit: string }[];
    totals['ledger.debit'] = r?.debit ?? '0';
    totals['ledger.credit'] = r?.credit ?? '0';
  }
  // The stock on hand.
  if (has('stock_quant')) {
    const [r] = (await q('SELECT coalesce(sum(quantity), 0)::text AS q FROM stock_quant')) as {
      q: string;
    }[];
    totals['stock.quantity'] = r?.q ?? '0';
  }
  return { rows, totals };
}

/** The server's major version. */
async function serverMajor(db: Driver): Promise<{ num: number; major: number }> {
  const [r] = await db.query<{ v: string }>({
    text: "SELECT current_setting('server_version_num') AS v",
    params: [],
  });
  const num = Number(r?.v ?? 0);
  return { num, major: Math.floor(num / 10000) };
}

/** How to run a PostgreSQL client tool of at least `major`: the local one, else Docker's image. */
function tool(
  name: 'pg_dump' | 'pg_restore',
  major: number,
  url: string,
): { cmd: string; args: string[]; url: string } {
  const local = spawnSync(name, ['--version'], { encoding: 'utf8' });
  const version = /(\d+)(?:\.\d+)?/.exec(local.stdout ?? '')?.[1];
  if (local.status === 0 && Number(version) >= major) return { cmd: name, args: [], url };
  const docker = spawnSync('docker', ['--version'], { encoding: 'utf8' });
  if (docker.status !== 0)
    throw new Error(
      `${name} ${major} or later is needed (found ${version ?? 'none'}), and Docker is not available to run it. Install the PostgreSQL ${major} client tools.`,
    );
  // In a container, the host's localhost is host.docker.internal.
  const inside = new URL(url);
  if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(inside.hostname))
    inside.hostname = 'host.docker.internal';
  return {
    cmd: 'docker',
    args: [
      'run',
      '--rm',
      '-i',
      '--add-host=host.docker.internal:host-gateway',
      `postgres:${major}`,
      name,
    ],
    url: inside.toString(),
  };
}

/** Runs a process; resolves when it exits 0, rejects with its error output otherwise. */
function run(
  cmd: string,
  args: readonly string[],
  options: { readonly stdout?: NodeJS.WritableStream; readonly stdin?: NodeJS.ReadableStream } = {},
): Promise<void> {
  return new Promise((done, failed) => {
    const child = spawn(cmd, [...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (c: Buffer) => {
      err += c.toString();
    });
    if (options.stdout !== undefined) child.stdout.pipe(options.stdout);
    else child.stdout.resume();
    if (options.stdin !== undefined) options.stdin.pipe(child.stdin);
    else child.stdin.end();
    child.on('error', failed);
    child.on('close', (code) =>
      code === 0 ? done() : failed(new Error(`${cmd} exited with ${code}: ${err.trim()}`)),
    );
  });
}

/** Writes a backup of `databaseUrl` into `dir`; returns its manifest. */
export async function backup(databaseUrl: string, dir: string): Promise<BackupManifest> {
  await mkdir(dir, { recursive: true });
  const db = pg.createDriver({ url: databaseUrl, max: 1, applicationName: 'shutro-erp-backup' });
  try {
    const { num, major } = await serverMajor(db);
    const database = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = join(dir, `${database}-${stamp}.dump`);
    const dump = tool('pg_dump', major, databaseUrl);
    let measured: { rows: Record<string, number>; totals: Record<string, string> } = {
      rows: {},
      totals: {},
    };
    // One snapshot for both: the counts and pg_dump see exactly the same data.
    await db.transaction({ isolation: 'repeatable read', readOnly: true }, async (conn) => {
      const [snap] = await conn.query<{ id: string }>({
        text: 'SELECT pg_export_snapshot() AS id',
        params: [],
      });
      measured = await measure((text) => conn.query({ text, params: [] }));
      const out = createWriteStream(file);
      await run(
        dump.cmd,
        [...dump.args, '--format=custom', `--snapshot=${snap?.id ?? ''}`, '--no-owner', dump.url],
        { stdout: out },
      );
      await new Promise<void>((done) => out.end(done));
    });
    const manifest: BackupManifest = {
      format: 1,
      file: basename(file),
      database,
      serverVersion: num,
      createdAt: new Date().toISOString(),
      rows: measured.rows,
      totals: measured.totals,
    };
    await writeFile(`${file}.json`, `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  } finally {
    await db.end();
  }
}

/** The newest backup in `dir` (a `.dump` with its manifest). */
export function latestBackup(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const dumps = readdirSync(dir)
    .filter((f) => f.endsWith('.dump') && existsSync(join(dir, `${f}.json`)))
    .map((f) => ({ f, at: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  return dumps[0] === undefined ? null : join(dir, dumps[0].f);
}

const CHECKS_TABLE = 'kosh_backup_check';

/** Records a verification in the installation (`shutro-erp doctor` reads the latest). */
async function record(db: Driver, result: VerifyResult): Promise<void> {
  await db.query({
    text: `CREATE TABLE IF NOT EXISTS ${CHECKS_TABLE} (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(), file text NOT NULL, ok boolean NOT NULL, tables integer NOT NULL, problems jsonb NOT NULL)`,
    params: [],
  });
  await db.query({
    text: `INSERT INTO ${CHECKS_TABLE} (file, ok, tables, problems) VALUES ($1, $2, $3, $4::jsonb)`,
    params: [result.file, result.ok, result.tables, JSON.stringify(result.problems)],
  });
}

/** Restores `file` into a scratch database next to `databaseUrl`'s, measures it against its manifest, drops it. */
export async function verify(databaseUrl: string, file: string): Promise<VerifyResult> {
  const manifest = JSON.parse(await readFile(`${file}.json`, 'utf8')) as BackupManifest;
  const admin = new URL(databaseUrl);
  const scratchName = `${manifest.database}_verify_${randomBytes(4).toString('hex')}`.toLowerCase();
  const scratch = new URL(databaseUrl);
  scratch.pathname = `/${scratchName}`;
  const main = pg.createDriver({
    url: admin.toString(),
    max: 1,
    applicationName: 'shutro-erp-verify',
  });
  const problems: string[] = [];
  let tables = 0;
  try {
    const { major } = await serverMajor(main);
    if (!/^[a-z0-9_]+$/.test(scratchName))
      throw new Error(`The database name ${manifest.database} cannot name a scratch database.`);
    await main.query({ text: `CREATE DATABASE ${scratchName}`, params: [] });
    try {
      const restore = tool('pg_restore', major, scratch.toString());
      const { createReadStream } = await import('node:fs');
      await run(
        restore.cmd,
        [...restore.args, '--no-owner', '--no-acl', '--exit-on-error', `--dbname=${restore.url}`],
        { stdin: createReadStream(file) },
      );
      const restored = pg.createDriver({
        url: scratch.toString(),
        max: 1,
        applicationName: 'shutro-erp-verify',
      });
      try {
        const now = await measure((text) => restored.query({ text, params: [] }));
        tables = Object.keys(now.rows).length;
        for (const [t, n] of Object.entries(manifest.rows)) {
          const got = now.rows[t];
          if (got === undefined) problems.push(`table ${t} is missing`);
          else if (got !== n) problems.push(`table ${t}: ${got} rows, ${n} expected`);
        }
        for (const t of Object.keys(now.rows))
          if (!(t in manifest.rows)) problems.push(`table ${t} was not in the backup's manifest`);
        for (const [k, v] of Object.entries(manifest.totals))
          if (now.totals[k] !== v) problems.push(`${k}: ${now.totals[k] ?? 'none'}, ${v} expected`);
        if (
          now.totals['ledger.debit'] !== undefined &&
          now.totals['ledger.debit'] !== now.totals['ledger.credit']
        )
          problems.push(
            `the ledger does not balance: debit ${now.totals['ledger.debit']}, credit ${now.totals['ledger.credit']}`,
          );
      } finally {
        await restored.end();
      }
    } finally {
      await main.query({ text: `DROP DATABASE IF EXISTS ${scratchName} WITH (FORCE)`, params: [] });
    }
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  const result: VerifyResult = {
    ok: problems.length === 0,
    file: basename(file),
    tables,
    problems,
  };
  try {
    await record(main, result);
  } finally {
    await main.end();
  }
  return result;
}

/** The latest recorded verification, for `shutro-erp doctor`. */
export async function lastVerification(
  db: Driver,
): Promise<{ at: Date; file: string; ok: boolean; problems: string[] } | null> {
  const [exists] = await db.query<{ found: string | null }>({
    text: `SELECT to_regclass('public.${CHECKS_TABLE}')::text AS found`,
    params: [],
  });
  if (exists?.found === null || exists?.found === undefined) return null;
  const [row] = await db.query<{ at: Date; file: string; ok: boolean; problems: unknown }>({
    text: `SELECT at, file, ok, problems::text AS problems FROM ${CHECKS_TABLE} ORDER BY at DESC LIMIT 1`,
    params: [],
  });
  if (row === undefined) return null;
  const parsed: unknown =
    typeof row.problems === 'string' ? JSON.parse(row.problems) : row.problems;
  const problems = Array.isArray(parsed) ? parsed.map(String) : [];
  return { at: row.at, file: row.file, ok: row.ok, problems };
}

export async function runBackup(
  argv: readonly string[],
  write: (text: string) => void,
  cwd: string,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: { dir: { type: 'string', default: 'backups' } },
    allowPositionals: true,
    strict: true,
  });
  const envFile = resolve(cwd, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl === '')
    throw new Error('DATABASE_URL is not set: run shutro-erp init, or add it to .env.');
  const dir = resolve(cwd, values.dir ?? 'backups');
  if (positionals[0] === 'verify') {
    const file = positionals[1] === undefined ? latestBackup(dir) : resolve(cwd, positionals[1]);
    if (file === null) {
      write(`No backup in ${dir}: run shutro-erp backup first.\n`);
      return 1;
    }
    write(`Restoring ${basename(file)} into a scratch database…\n`);
    const result = await verify(databaseUrl, file);
    if (result.ok) {
      write(
        `✔ ${result.file}: restored and checked — ${result.tables} tables with their rows, the ledger and the stock as backed up.\n`,
      );
      return 0;
    }
    write(
      `✖ ${result.file}: the restore does not match the backup:\n${result.problems.map((p) => `  ${p}`).join('\n')}\n`,
    );
    return 1;
  }
  if (positionals.length > 0) {
    write('Usage: shutro-erp backup [--dir backups] · shutro-erp backup verify [file]\n');
    return 2;
  }
  const manifest = await backup(databaseUrl, dir);
  const tables = Object.keys(manifest.rows).length;
  const rows = Object.values(manifest.rows).reduce((s, n) => s + n, 0);
  write(
    `✔ ${join(values.dir ?? 'backups', manifest.file)}: ${tables} tables, ${rows} rows. Verify it: shutro-erp backup verify\n`,
  );
  return 0;
}
