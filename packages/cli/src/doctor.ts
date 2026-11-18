/**
 * `shutro-erp doctor` (RFC 0034 step 2): checks an installation and says what to fix — the runtime, the database and
 * its connections, migrations and the installed apps, administrators and their second factor, jobs, subscribers and
 * webhooks that are stuck or failing, the clock, Valkey, mail, storage, cookies and the public address, backups and
 * telemetry. Read-only: it changes nothing. A failure is something that is broken or unsafe now; a warning is
 * something to look at. `--json` prints the results for monitoring; the exit code is 1 when a check fails.
 */
import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { lastDataHealth, migrate, readInstalledApps } from '@kosh/server';
import { type Driver, pg } from '@kosh/server/orm';
import { lastVerification } from './backup.js';
import { modulesOf } from './project.js';

export type Status = 'ok' | 'warn' | 'fail';
export interface CheckResult {
  readonly check: string;
  readonly status: Status;
  readonly detail: string;
  /** What to do about it (warnings and failures). */
  readonly fix?: string;
}

const ok = (check: string, detail: string): CheckResult => ({ check, status: 'ok', detail });
const warn = (check: string, detail: string, fix: string): CheckResult => ({
  check,
  status: 'warn',
  detail,
  fix,
});
const fail = (check: string, detail: string, fix: string): CheckResult => ({
  check,
  status: 'fail',
  detail,
  fix,
});

/** Opens a TCP connection to `host:port`, with a timeout: true when something answers. */
function reachable(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host, port });
    const finish = (value: boolean) => {
      socket.destroy();
      done(value);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/** Sends PING to a Redis / Valkey server; true on PONG. */
function pingValkey(url: URL, timeoutMs = 3000): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host: url.hostname, port: Number(url.port || 6379) });
    let answer = '';
    const finish = (value: boolean) => {
      socket.destroy();
      done(value);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('error', () => finish(false));
    socket.once('connect', () => {
      const password = decodeURIComponent(url.password);
      if (password !== '')
        socket.write(
          url.username === ''
            ? `AUTH ${password}\r\n`
            : `AUTH ${decodeURIComponent(url.username)} ${password}\r\n`,
        );
      socket.write('PING\r\n');
    });
    socket.on('data', (chunk) => {
      answer += chunk.toString();
      if (answer.includes('PONG')) finish(true);
      else if (answer.startsWith('-') && answer.includes('\r\n') && !answer.startsWith('+OK'))
        finish(false);
    });
  });
}

const table = async (db: Driver, name: string): Promise<boolean> => {
  const [row] = await db.query<{ found: string | null }>({
    text: 'SELECT to_regclass($1)::text AS found',
    params: [`public.${name}`],
  });
  return row?.found !== null && row?.found !== undefined;
};

/** Runs every check against the installation in `cwd`. */
export async function diagnose(
  cwd: string,
  options: { readonly modules?: string; readonly migrations?: string } = {},
): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const envFile = resolve(cwd, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const env = process.env;
  const production = env['NODE_ENV'] === 'production';

  // ---- runtime
  const major = Number(process.versions.node.split('.')[0]);
  out.push(
    major >= 24
      ? ok('runtime', `Node.js ${process.versions.node}`)
      : fail('runtime', `Node.js ${process.versions.node}`, 'Install Node.js 24 or later.'),
  );

  // ---- database
  const databaseUrl = env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl === '') {
    out.push(
      fail(
        'database',
        'DATABASE_URL is not set',
        'Run shutro-erp init, or set DATABASE_URL in .env.',
      ),
    );
    return out;
  }
  let backupCheck: CheckResult = warn(
    'backups',
    'no verified backup recorded',
    'Back up and verify on a schedule: shutro-erp backup && shutro-erp backup verify.',
  );
  const db = pg.createDriver({
    url: databaseUrl,
    max: 1,
    applicationName: 'shutro-erp-doctor',
    connectTimeoutSeconds: 5,
  });
  try {
    let version: number;
    try {
      const [row] = await db.query<{ v: string; size: string; now: Date }>({
        text: "SELECT current_setting('server_version_num') AS v, pg_size_pretty(pg_database_size(current_database())) AS size, now() AS now",
        params: [],
      });
      version = Number(row?.v ?? 0);
      const shown = `${Math.floor(version / 10000)}.${version % 10000}`;
      out.push(
        version >= 160000
          ? ok('database', `PostgreSQL ${shown}, ${row?.size ?? '?'}`)
          : fail('database', `PostgreSQL ${shown}`, 'Upgrade PostgreSQL to 16 or later.'),
      );
      // The clock: the database's and this machine's agree (sessions, schedules and audit times depend on it).
      const skew = Math.abs((row?.now ?? new Date()).getTime() - Date.now()) / 1000;
      out.push(
        skew <= 5
          ? ok('clock', `within ${skew.toFixed(1)} s of the database`)
          : warn(
              'clock',
              `${skew.toFixed(0)} s apart from the database`,
              'Synchronise the clocks (NTP) of this machine and the database server.',
            ),
      );
    } catch (error) {
      out.push(
        fail(
          'database',
          `cannot connect: ${error instanceof Error ? error.message : String(error)}`,
          'Check DATABASE_URL, and that PostgreSQL is running and reachable.',
        ),
      );
      return out;
    }
    const [conn] = await db.query<{ used: number; max: number }>({
      text: "SELECT count(*)::int AS used, current_setting('max_connections')::int AS max FROM pg_stat_activity",
      params: [],
    });
    const used = conn?.used ?? 0;
    const max = conn?.max ?? 100;
    out.push(
      used / max <= 0.8
        ? ok('connections', `${used} of ${max} in use`)
        : warn(
            'connections',
            `${used} of ${max} in use`,
            'Raise max_connections, or put PgBouncer in front of PostgreSQL.',
          ),
    );

    // ---- migrations and apps
    const dir = resolve(cwd, options.migrations ?? 'migrations');
    if (existsSync(dir)) {
      const status = await migrate.migrationStatus({ driver: db, dir });
      out.push(
        status.pending.length === 0
          ? ok('migrations', `${status.applied.length} applied, none pending`)
          : warn(
              'migrations',
              `${status.pending.length} pending: ${status.pending.map((f) => `${f.version}_${f.name}`).join(', ')}`,
              'Run shutro-erp migrate.',
            ),
      );
    } else out.push(warn('migrations', 'no migrations/ folder', 'Run shutro-erp migrate.'));
    const installed = (await readInstalledApps(db)) ?? [];
    const modulesFile = options.modules ?? 'src/modules.ts';
    if (installed.length === 0)
      out.push(
        warn('apps', 'no app installed yet', 'Run shutro-erp init, or shutro-erp apps install.'),
      );
    else if (existsSync(resolve(cwd, modulesFile))) {
      const known = new Set((await modulesOf(modulesFile, cwd)).map((m) => m.name));
      const lost = installed.filter((a) => !known.has(a.name));
      const live = installed.filter((a) => a.state === 'installed').length;
      out.push(
        lost.length === 0
          ? ok('apps', `${live} installed, all in ${modulesFile}`)
          : fail(
              'apps',
              `installed but missing from ${modulesFile}: ${lost.map((a) => a.name).join(', ')}`,
              `Add them back to ${modulesFile} (the server cannot serve their data without them), or uninstall them.`,
            ),
      );
    }

    // ---- administrators (CLAUDE.md: at least one, each with a second factor)
    if ((await table(db, 'auth_user_group')) && (await table(db, 'res_users'))) {
      const admins = await db.query<{ login: string; totp: boolean | null }>({
        text: `SELECT u.login, c.totp_enabled AS totp
                 FROM res_users u
                 JOIN auth_user_group g ON g.user_id = u.id AND g."group" = 'base.admin'
                 LEFT JOIN auth_credential c ON c.user_id = u.id
                WHERE u.active AND NOT coalesce(u.is_service, false)
                GROUP BY u.login, c.totp_enabled ORDER BY u.login`,
        params: [],
      });
      const without = admins.filter((a) => a.totp !== true);
      if (admins.length === 0)
        out.push(
          fail(
            'administrators',
            'no active administrator',
            'Create one: shutro-erp user create <login> --roles base.admin.',
          ),
        );
      else if (without.length === admins.length)
        out.push(
          fail(
            'administrators',
            `${admins.length} administrator(s), none with two-factor sign-in`,
            'Each administrator sets up an authenticator app at their next sign-in (Settings › Your profile).',
          ),
        );
      else if (without.length > 0)
        out.push(
          warn(
            'administrators',
            `without two-factor sign-in: ${without.map((a) => a.login).join(', ')}`,
            'They set it up at their next sign-in (the server asks for it); or remove their administrator role.',
          ),
        );
      else out.push(ok('administrators', `${admins.length}, all with two-factor sign-in`));
    }

    // ---- background work: jobs, subscribers, webhooks
    if (await table(db, 'shutro_job')) {
      const [jobs] = await db.query<{ late: number; dead: number; names: string | null }>({
        text: `SELECT count(*) FILTER (WHERE state = 'pending' AND run_at < now() - interval '15 minutes')::int AS late,
                      count(*) FILTER (WHERE state = 'dead' AND coalesce(done_at, run_at) > now() - interval '1 day')::int AS dead,
                      string_agg(DISTINCT name, ', ') FILTER (WHERE state = 'dead' AND coalesce(done_at, run_at) > now() - interval '1 day') AS names
                 FROM shutro_job`,
        params: [],
      });
      if ((jobs?.late ?? 0) > 0)
        out.push(
          fail(
            'jobs',
            `${jobs?.late} job(s) waiting for more than 15 minutes`,
            'The job workers are not running: start the server (npm start), and check its log.',
          ),
        );
      else if ((jobs?.dead ?? 0) > 0)
        out.push(
          warn(
            'jobs',
            `${jobs?.dead} job(s) gave up in the last day: ${jobs?.names ?? ''}`,
            'Read their last_error in shutro_job, fix the cause, and run them again.',
          ),
        );
      else out.push(ok('jobs', 'none late, none failed in the last day'));
    }
    if (await table(db, 'shutro_subscription')) {
      const [subs] = await db.query<{ stuck: number; names: string | null; dead: number }>({
        text: `SELECT count(*) FILTER (WHERE last_error IS NOT NULL)::int AS stuck,
                      string_agg(name, ', ') FILTER (WHERE last_error IS NOT NULL) AS names,
                      (SELECT count(*)::int FROM shutro_dead_event WHERE at > now() - interval '1 day') AS dead
                 FROM shutro_subscription`,
        params: [],
      });
      out.push(
        (subs?.stuck ?? 0) === 0 && (subs?.dead ?? 0) === 0
          ? ok('events', 'every subscriber up to date')
          : warn(
              'events',
              `${subs?.stuck ?? 0} subscriber(s) retrying${subs?.names ? ` (${subs.names})` : ''}, ${subs?.dead ?? 0} event(s) given up in the last day`,
              'Read last_error in shutro_subscription and shutro_dead_event; fix the cause.',
            ),
      );
    }
    if (await table(db, 'webhook_delivery')) {
      const [hooks] = await db.query<{ failed: number }>({
        text: `SELECT count(*)::int AS failed FROM webhook_delivery
                WHERE state = 'failed' AND coalesce(updated_at, created_at) > now() - interval '1 day'`,
        params: [],
      });
      out.push(
        (hooks?.failed ?? 0) === 0
          ? ok('webhooks', 'no failed delivery in the last day')
          : warn(
              'webhooks',
              `${hooks?.failed} delivery(ies) failed in the last day`,
              'Integrations › Webhooks › Deliveries: read the response, fix the receiver, replay.',
            ),
      );
    }
    // The companies' data, as last checked (`shutro-erp check data`, or the weekly run of a server).
    const health = await lastDataHealth(db);
    const failing = health.filter((h) => !h.ok);
    const oldest = health.reduce(
      (at, h) => Math.min(at, new Date(h.checkedAt).getTime()),
      Number.POSITIVE_INFINITY,
    );
    out.push(
      health.length === 0
        ? warn(
            'data',
            'the data was never checked',
            'Run shutro-erp check data (a running server does it once a week).',
          )
        : failing.length > 0
          ? warn(
              'data',
              `${failing.reduce((n, h) => n + h.failing.length, 0)} check(s) found something in ${failing.length} company(ies): ${failing
                .flatMap((h) => h.failing.map((f) => f.label))
                .slice(0, 2)
                .join('; ')}`,
              'Run shutro-erp check data to see each finding with its records, or open Settings › Data health.',
            )
          : Date.now() - oldest > 14 * 86_400_000
            ? warn(
                'data',
                `last checked ${Math.floor((Date.now() - oldest) / 86_400_000)} days ago`,
                'Run shutro-erp check data, or keep a server running: it checks once a week.',
              )
            : ok('data', `every check holds in ${health.length} company(ies)`),
    );
    const last = await lastVerification(db);
    const days = last === null ? null : (Date.now() - new Date(last.at).getTime()) / 86_400_000;
    backupCheck =
      last === null
        ? warn(
            'backups',
            'no verified backup recorded',
            'Back up and verify on a schedule: shutro-erp backup && shutro-erp backup verify (docs: operations).',
          )
        : !last.ok
          ? fail(
              'backups',
              `the last backup verified (${last.file}) did not match: ${last.problems.slice(0, 2).join('; ')}`,
              'Find why the restore differs; back up again and verify.',
            )
          : (days ?? 0) > 7
            ? warn(
                'backups',
                `last verified ${Math.floor(days ?? 0)} days ago (${last.file})`,
                'Back up and verify at least weekly.',
              )
            : ok(
                'backups',
                `verified ${days !== null && days < 1 ? 'today' : `${Math.floor(days ?? 0)} day(s) ago`} (${last.file})`,
              );
  } finally {
    await db.end();
  }

  // ---- services
  const valkeyUrl = env['VALKEY_URL'];
  if (valkeyUrl === undefined || valkeyUrl === '')
    out.push(
      production
        ? warn(
            'valkey',
            'VALKEY_URL is not set',
            'Set it for rate limiting, caching and live updates across several servers.',
          )
        : ok('valkey', 'not used (one server)'),
    );
  else
    out.push(
      (await pingValkey(new URL(valkeyUrl)))
        ? ok('valkey', 'answers')
        : fail(
            'valkey',
            `no answer at ${new URL(valkeyUrl).host}`,
            'Start Valkey, or fix VALKEY_URL.',
          ),
    );
  const smtp = env['SMTP_URL'];
  if (smtp === undefined || smtp === '')
    out.push(
      warn(
        'mail',
        'SMTP_URL is not set: no email is sent',
        'Set SMTP_URL (smtp://user:pass@host:587) to send invitations, documents and notifications.',
      ),
    );
  else {
    const url = new URL(smtp);
    out.push(
      (await reachable(url.hostname, Number(url.port || (url.protocol === 'smtps:' ? 465 : 587))))
        ? ok('mail', `SMTP server reachable at ${url.host}`)
        : fail(
            'mail',
            `SMTP server unreachable at ${url.host}`,
            'Check SMTP_URL and the mail server.',
          ),
    );
  }
  const s3 = env['S3_ENDPOINT'];
  if (s3 !== undefined && s3 !== '') {
    const url = new URL(s3);
    out.push(
      (await reachable(url.hostname, Number(url.port || (url.protocol === 'https:' ? 443 : 80))))
        ? ok('storage', `S3 endpoint reachable at ${url.host}`)
        : fail(
            'storage',
            `S3 endpoint unreachable at ${url.host}`,
            'Check S3_ENDPOINT and the storage service.',
          ),
    );
  }

  // ---- exposure
  const secure = (env['SHUTRO_ERP_SECURE_COOKIES'] ?? env['KOSH_SECURE_COOKIES']) !== 'false';
  const base = env['KOSH_BASE_URL'];
  if (production && (!secure || base?.startsWith('http://')))
    out.push(
      fail(
        'exposure',
        `production ${!secure ? 'with insecure cookies' : `served at ${base}`}`,
        'Serve over HTTPS and keep secure cookies on (unset SHUTRO_ERP_SECURE_COOKIES).',
      ),
    );
  else out.push(ok('exposure', production ? 'HTTPS and secure cookies' : 'development settings'));

  // ---- backups (the last verification recorded by `shutro-erp backup verify`) and telemetry
  out.push(backupCheck);
  out.push(
    env['OTEL_EXPORTER_OTLP_ENDPOINT'] === undefined || env['OTEL_EXPORTER_OTLP_ENDPOINT'] === ''
      ? warn(
          'telemetry',
          'traces are not exported',
          'Set OTEL_EXPORTER_OTLP_ENDPOINT to send traces to your observability service.',
        )
      : ok('telemetry', `traces to ${env['OTEL_EXPORTER_OTLP_ENDPOINT']}`),
  );
  return out;
}

const MARK: Record<Status, string> = { ok: '✔', warn: '▲', fail: '✖' };

export async function runDoctor(
  argv: readonly string[],
  write: (text: string) => void,
  cwd: string,
): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      json: { type: 'boolean' },
      modules: { type: 'string', default: 'src/modules.ts' },
      dir: { type: 'string', default: 'migrations' },
    },
    strict: true,
  });
  const results = await diagnose(cwd, {
    ...(values.modules === undefined ? {} : { modules: values.modules }),
    ...(values.dir === undefined ? {} : { migrations: values.dir }),
  });
  const failed = results.filter((r) => r.status === 'fail').length;
  const warned = results.filter((r) => r.status === 'warn').length;
  if (values.json === true) {
    write(`${JSON.stringify({ ok: failed === 0, failed, warned, results }, null, 2)}\n`);
    return failed > 0 ? 1 : 0;
  }
  const width = Math.max(...results.map((r) => r.check.length));
  for (const r of results) {
    write(`${MARK[r.status]} ${r.check.padEnd(width)}  ${r.detail}\n`);
    if (r.fix !== undefined) write(`  ${' '.repeat(width)}  → ${r.fix}\n`);
  }
  write(
    `\n${failed === 0 ? 'No failure' : `${failed} failure(s)`}, ${warned} warning(s). ${failed > 0 ? 'Fix the failures first.' : ''}\n`,
  );
  return failed > 0 ? 1 : 0;
}
