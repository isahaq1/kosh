/**
 * `kosh init`: sets up an installation in a folder. It asks for (or takes as flags) the database, the first company,
 * the administrator, the apps, file storage, Valkey and the port; checks the database (and creates it when it does
 * not exist yet); writes the starter project and `.env`; plans and applies the first migration; installs the company,
 * the administrator and each app's default data; and enrols the administrator's authenticator app (administrator
 * rights need a second factor). Nothing secret is printed or written except to `.env` (mode 600), and the
 * administrator's password is not stored anywhere but as its hash in the database.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { KoshModule } from '@kosh/modules-sdk';
import {
  base,
  createServer,
  DEMO_PASSWORD,
  FRAMEWORK_TABLES,
  installBase,
  installDemo,
  KOSH_VERSION,
  type KoshServer,
  migrate,
  pg,
  recordInstalledApps,
} from '@kosh/server';
import { seed } from './project.js';
import { defaultsPrompter, type Prompter, terminalPrompter } from './prompt.js';
import * as templates from './templates.js';
import { APPS, type AppName, bridgesFor, SELECTABLE_APPS } from './templates.js';
import { type CardRow, createUi, PLAIN_TERMINAL, type Terminal, type Ui } from './ui.js';

export const INIT_USAGE: string = `Usage: kosh init [folder] [options]

Sets up a Kosh installation: asks for the database, the first company, the administrator, the apps,
file storage and the port (Enter keeps the default), then writes the project, creates the database
tables and the administrator, and enrols the administrator's authenticator app.

Options (each also answers its question; with --yes the rest take their defaults):
  --database-url <url>      PostgreSQL, e.g. postgres://user:pass@localhost:5432/kosh
  --docker-db               start PostgreSQL in Docker (compose.yaml) instead
  --create-database         create the database when it does not exist
  --company <name>          the first company        --currency <code>   its currency (ISO 4217)
  --lang <en|bn>            language                 --tz <zone>         time zone (IANA)
  --admin-login <login>     --admin-name <name>      --admin-email <email>
  --admin-password <pw>     (or KOSH_ADMIN_PASSWORD; at least 12 characters)
  --apps <list>             comma-separated: ${SELECTABLE_APPS.join(', ')} (default: all; bridges come with the apps they connect)
  --storage-dir <dir>       attachments in a folder (default ./var/attachments)
  --s3-endpoint <url> --s3-bucket <name> --s3-access-key <key> --s3-secret-key <secret> [--s3-region <r>]
  --valkey-url <url>        optional: rate limits and caches shared across servers
  --port <port>             the API's port (default 3000)
  --demo                    load demo data: a sample company with contacts, products, orders, invoices and
                            projects, made by demo users (dina, rahim, karim, sumi; one shared password)
  --no-2fa                  skip the authenticator enrolment (administrator rights wait for it)
  --yes                     do not ask; use flags and defaults
`;

export interface InitIo {
  readonly write: (text: string) => void;
  /** Questions (tests script them). Default: the terminal, or defaults only with `--yes`. */
  readonly prompter?: Prompter;
  readonly cwd: string;
  /** What the output can show (colour, icons, spinners). Default: plain lines. */
  readonly terminal?: Terminal;
}

interface Answers {
  readonly dir: string;
  readonly name: string;
  readonly databaseUrl: string;
  readonly company: string;
  readonly currency: string;
  readonly lang: string;
  readonly tz: string;
  readonly admin: { login: string; name: string; email: string; password: string };
  readonly apps: AppName[];
  /** Load the apps' demo data (RFC 0008 §5.8). */
  readonly demo: boolean;
  readonly storage:
    | { readonly kind: 'dir'; readonly dir: string }
    | {
        readonly kind: 's3';
        readonly endpoint: string;
        readonly bucket: string;
        readonly accessKey: string;
        readonly secretKey: string;
        readonly region: string;
      };
  readonly valkeyUrl: string;
  readonly port: number;
  /** The Docker PostgreSQL service's settings (compose.yaml reads them from .env). */
  readonly postgres: {
    readonly user: string;
    readonly password: string;
    readonly db: string;
    readonly port: number;
  };
  /** PostgreSQL was started in Docker by init. */
  readonly dockerDb: boolean;
  /** The installation's web push keys. */
  readonly vapid: { readonly publicKey: string; readonly privateKey: string };
  /** The reply-address secret and the inbound webhook's secret (RFC 0006 part 7). */
  readonly inboundSecret: string;
  readonly inboundWebhookSecret: string;
}

const dockerAvailable = (): boolean =>
  spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' })
    .status === 0;

/** A free local port from `from` up (5432 may be taken by another PostgreSQL). */
async function freePort(from: number): Promise<number> {
  for (let port = from; port < from + 20; port++) {
    const free = await new Promise<boolean>((done) => {
      const probe = createNetServer();
      probe.once('error', () => done(false));
      probe.listen(port, '127.0.0.1', () => probe.close(() => done(true)));
    });
    if (free) return port;
  }
  throw new Error(`No free port from ${from}.`);
}

/** Runs a command without blocking (the spinner keeps turning); resolves with its exit code and output. */
function runAsync(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ status: number; output: string }> {
  return new Promise((done) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on('error', (error) => done({ status: 1, output: error.message }));
    child.on('close', (status) => done({ status: status ?? 1, output }));
  });
}

/** Writes compose.yaml (when missing) and starts its `db` service; waits until PostgreSQL answers. */
async function startDockerDb(
  dir: string,
  name: string,
  postgres: Answers['postgres'],
  ui: Ui,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const compose = join(dir, 'compose.yaml');
  if (!existsSync(compose))
    await writeFile(
      compose,
      templates.composeYaml({
        name,
        apps: [],
        port: 3000,
        koshVersion: KOSH_VERSION,
        dockerDb: postgres.db,
      }),
    );
  return ui.task(`Starting PostgreSQL 18 in Docker (port ${postgres.port})`, async (task) => {
    task.update('docker compose up -d db (the first run downloads the image)');
    const started = await runAsync('docker', ['compose', 'up', '-d', 'db'], {
      cwd: dir,
      env: {
        ...process.env,
        POSTGRES_USER: postgres.user,
        POSTGRES_PASSWORD: postgres.password,
        POSTGRES_DB: postgres.db,
        POSTGRES_PORT: String(postgres.port),
      },
    });
    if (started.status !== 0)
      throw new Error(`docker compose up -d db failed: ${started.output.trim().slice(-400)}`);
    const url = `postgres://${postgres.user}:${postgres.password}@localhost:${postgres.port}/${postgres.db}`;
    for (let i = 0; i < 60; i++) {
      task.update(`waiting for PostgreSQL to answer · ${i}s`);
      const checked = await checkDatabase(url, async () => false);
      if (checked.ok) {
        task.finish(
          `connected (PostgreSQL in Docker, database "${postgres.db}", data in the volume "${name}_db")`,
        );
        return url;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(
      'PostgreSQL in Docker did not become ready within a minute (docker compose logs db).',
    );
  });
}

const required = (what: string) => (v: string) => (v.trim() === '' ? `${what} is required.` : null);

/** Opens the database; offers to create it when it does not exist. Returns the PostgreSQL version. */
async function checkDatabase(
  url: string,
  create: () => Promise<boolean>,
): Promise<{ ok: true; version: string } | { ok: false; problem: string }> {
  const probe = async (target: string) => {
    const driver = pg.createDriver({ url: target, max: 1, applicationName: 'kosh init' });
    try {
      const [row] = await driver.query<{ server_version: string }>({
        text: 'SHOW server_version',
        params: [],
      });
      return String(row?.server_version ?? '');
    } finally {
      await driver.end();
    }
  };
  try {
    return { ok: true, version: await probe(url) };
  } catch (error) {
    const text =
      error instanceof Error
        ? `${error.message} ${String((error as { cause?: unknown }).cause ?? '')}`
        : String(error);
    if (/3D000|does not exist/.test(text)) {
      const parsed = new URL(url);
      const name = decodeURIComponent(parsed.pathname.slice(1));
      if (!/^[A-Za-z_][A-Za-z0-9_-]{0,62}$/.test(name))
        return { ok: false, problem: `The database name "${name}" is not a simple identifier.` };
      if (!(await create()))
        return { ok: false, problem: `The database "${name}" does not exist.` };
      parsed.pathname = '/postgres';
      const admin = pg.createDriver({
        url: parsed.toString(),
        max: 1,
        applicationName: 'kosh init',
      });
      try {
        await admin.query({ text: `CREATE DATABASE "${name}"`, params: [] });
      } catch (e) {
        return {
          ok: false,
          problem: `Could not create "${name}": ${e instanceof Error ? e.message : String(e)}`,
        };
      } finally {
        await admin.end();
      }
      return { ok: true, version: await probe(url) };
    }
    if (/ECONNREFUSED|ENOTFOUND|connect/i.test(text))
      return {
        ok: false,
        problem:
          'PostgreSQL did not answer at that address (is it running, on that host and port?).',
      };
    if (/28P01|password authentication/i.test(text))
      return { ok: false, problem: 'PostgreSQL refused the user name or password.' };
    return { ok: false, problem: text.slice(0, 300) };
  }
}

async function ask(
  prompter: Prompter,
  flags: Record<string, string | boolean | undefined>,
  cwd: string,
  positional: string | undefined,
  ui: Ui,
): Promise<Answers> {
  const flag = (name: string) => {
    const v = flags[name];
    return typeof v === 'string' ? v : undefined;
  };
  const q = async (
    name: string | null,
    message: string,
    fallback?: string,
    extra: Partial<Parameters<Prompter['ask']>[0]> = {},
  ) => {
    const given = name === null ? undefined : flag(name);
    if (given !== undefined) {
      const problem = extra.validate?.(given) ?? null;
      if (problem !== null) throw new Error(`--${name}: ${problem}`);
      return given;
    }
    return prompter.ask({
      message,
      ...(fallback === undefined ? {} : { default: fallback }),
      ...extra,
    });
  };

  const dir = resolve(cwd, positional ?? (await q(null, 'Project folder', '.')));
  const name =
    basename(dir)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-') || 'kosh-app';

  ui.step('database', 'Database', 'PostgreSQL 16 or later: a server you have, or one in Docker');
  const postgres = {
    user: 'kosh',
    password: randomBytes(18)
      .toString('base64url')
      .replace(/[^A-Za-z0-9]/g, '')
      .slice(0, 24),
    db: name.replace(/-/g, '_'),
    port: 5432,
  };
  let databaseUrl = '';
  let dockerDb = false;
  if (flag('database-url') === undefined) {
    const docker =
      flags['docker-db'] === true ||
      (dockerAvailable() && flags['yes'] !== true
        ? (await q(
            null,
            'PostgreSQL: (1) a server I already have, or (2) start one in Docker for me',
            '2',
            {
              validate: (v) => (v === '1' || v === '2' ? null : '1 or 2'),
            },
          )) === '2'
        : false);
    if (docker) {
      if (!dockerAvailable()) throw new Error('Docker is not running (docker version failed).');
      postgres.port = await freePort(5432);
      databaseUrl = await startDockerDb(dir, name, postgres, ui);
      dockerDb = true;
    }
  }
  // Asked part by part (a URL is for flags and scripts); a failed attempt keeps the answers as defaults.
  const server = {
    host: 'localhost',
    port: '5432',
    user: 'postgres',
    password: '',
    database: postgres.db,
  };
  const interactive = flag('database-url') === undefined && flags['yes'] !== true;
  for (; !dockerDb; ) {
    if (interactive) {
      ui.info('Your PostgreSQL server (Enter keeps the value in [brackets]):');
      server.user = await q(null, '  Username', server.user, { validate: required('A user name') });
      server.password = await prompter.ask({
        message: `  Password of "${server.user}"${server.password === '' ? '' : ' (Enter keeps the last one)'}`,
        secret: true,
        ...(server.password === '' ? {} : { default: server.password }),
      });
      server.port = await q(null, '  Port', server.port, {
        validate: (v) => (/^\d{1,5}$/.test(v) ? null : 'A port number, e.g. 5432'),
      });
      server.host = await q(null, '  Host', server.host, { validate: required('A host') });
      server.database = await q(null, '  Database name (created if missing)', server.database, {
        validate: (v) =>
          /^[A-Za-z_][A-Za-z0-9_-]{0,62}$/.test(v) ? null : 'Letters, digits, _ and -',
      });
      const auth = `${encodeURIComponent(server.user)}${server.password === '' ? '' : `:${encodeURIComponent(server.password)}`}`;
      const host = server.host.includes(':') ? `[${server.host}]` : server.host; // IPv6
      databaseUrl = `postgres://${auth}@${host}:${server.port}/${server.database}`;
    } else
      databaseUrl = await q(
        'database-url',
        'PostgreSQL URL',
        `postgres://postgres:postgres@localhost:5432/${name.replace(/-/g, '_')}`,
        {
          validate: (v) =>
            /^postgres(ql)?:\/\//.test(v) ? null : 'A URL starting with postgres://',
        },
      );
    const address = new URL(databaseUrl);
    const checked = await ui
      .task(`Connecting to ${address.hostname}:${address.port || '5432'}`, async (task) => {
        const result = await checkDatabase(databaseUrl, async () =>
          flags['create-database'] === true
            ? true
            : prompter.confirm('  The database does not exist yet. Create it?', true),
        );
        if (!result.ok) throw new Error(result.problem);
        task.finish(`connected (PostgreSQL ${result.version})`);
        return result;
      })
      .catch((error: unknown) => ({
        ok: false as const,
        problem: error instanceof Error ? error.message : String(error),
      }));
    if (checked.ok) break;
    ui.detail(checked.problem);
    if (!interactive) throw new Error(checked.problem);
    // Nothing listening: offer the Docker database instead of asking again.
    if (/did not answer/.test(checked.problem) && dockerAvailable()) {
      if (await prompter.confirm('  Start PostgreSQL in Docker instead?', true)) {
        postgres.port = await freePort(5432);
        databaseUrl = await startDockerDb(dir, name, postgres, ui);
        dockerDb = true;
        break;
      }
    } else if (/did not answer/.test(checked.problem))
      ui.warn(
        'Start the PostgreSQL service (or Docker Desktop, then answer 2 to the first question), or check host and port.',
      );
  }

  ui.step('company', 'Your company', 'Name, currency, language and time zone');
  const company = await q('company', 'Company name', 'My Company', {
    validate: required('A name'),
  });
  const currency = (
    await q('currency', 'Currency (ISO code)', 'BDT', {
      validate: (v) => (/^[A-Za-z]{3}$/.test(v) ? null : 'Three letters, e.g. BDT, USD, EUR'),
    })
  ).toUpperCase();
  const lang = await q('lang', 'Language (en, bn)', 'en', {
    validate: (v) => (['en', 'bn'].includes(v) ? null : 'en or bn'),
  });
  const tz = await q('tz', 'Time zone', Intl.DateTimeFormat().resolvedOptions().timeZone, {
    validate: (v) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: v });
        return null;
      } catch {
        return 'An IANA time zone, e.g. Asia/Dhaka';
      }
    },
  });

  ui.step('admin', 'Administrator', 'Full access to every app; signs in with an authenticator app');
  const login = await q('admin-login', 'Login', 'admin', {
    validate: (v) => (/^[A-Za-z0-9._@-]{3,64}$/.test(v) ? null : '3–64 letters, digits, . _ @ -'),
  });
  const adminName = await q('admin-name', 'Full name', 'Administrator', {
    validate: required('A name'),
  });
  const email = await q('admin-email', 'Email (optional)', '', {
    validate: (v) =>
      v === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? null : 'An email address, or empty',
  });
  const strong = (v: string) => (v.length >= 12 ? null : 'At least 12 characters.');
  let password = flag('admin-password') ?? process.env['KOSH_ADMIN_PASSWORD'];
  if (password !== undefined) {
    if (strong(password) !== null)
      throw new Error(`The administrator password: ${strong(password)}`);
  } else
    for (;;) {
      password = await prompter.ask({
        message: 'Password (12+ characters)',
        secret: true,
        validate: strong,
      });
      const again = await prompter.ask({ message: 'Repeat the password', secret: true });
      if (again === password) break;
      ui.warn('The passwords differ; try again.');
    }

  ui.step('apps', 'Apps', 'All are selected; remove the ones you do not need');
  for (const key of SELECTABLE_APPS) {
    const app = APPS[key];
    ui.write(
      `  ${ui.terminal.emoji ? app.icon : ui.style('cyan', '•')}  ${ui.style('bold', key.padEnd(12))} ${ui.style('gray', app.label)}\n`,
    );
  }
  const appList = await q('apps', 'Apps to install (comma-separated)', SELECTABLE_APPS.join(','), {
    validate: (v) => {
      const unknown = v
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '' && !(s in APPS));
      return unknown.length === 0 ? null : `Unknown: ${unknown.join(', ')}`;
    },
  });
  const chosen = [
    ...new Set(
      appList
        .split(',')
        .map((s) => s.trim())
        .filter((s): s is AppName => s in APPS),
    ),
  ];
  // The bridges of the chosen apps come along (RFC 0008 §5.1).
  const apps = [...chosen, ...bridgesFor(chosen).filter((b) => !chosen.includes(b))];
  const demo =
    flags['demo'] === true ||
    (await prompter.confirm(
      '  Load demo data (a sample company with orders, invoices and projects; not for production)?',
      false,
    ));

  ui.step('storage', 'File storage', 'Where attachments and generated documents are kept');
  let storage: Answers['storage'];
  const s3 =
    flag('s3-endpoint') !== undefined ||
    (flag('storage-dir') === undefined &&
      (await q(null, 'Store files in (1) a folder or (2) S3-compatible storage', '1', {
        validate: (v) => (v === '1' || v === '2' ? null : '1 or 2'),
      })) === '2');
  if (s3)
    storage = {
      kind: 's3',
      endpoint: await q('s3-endpoint', 'S3 endpoint', 'https://s3.amazonaws.com', {
        validate: required('An endpoint'),
      }),
      bucket: await q('s3-bucket', 'Bucket', `${name}-attachments`, {
        validate: required('A bucket'),
      }),
      accessKey: await q('s3-access-key', 'Access key', undefined, {
        validate: required('An access key'),
      }),
      secretKey:
        flag('s3-secret-key') ??
        (await prompter.ask({
          message: 'Secret key',
          secret: true,
          validate: required('A secret key'),
        })),
      region: await q('s3-region', 'Region', 'us-east-1'),
    };
  else storage = { kind: 'dir', dir: await q('storage-dir', 'Folder', './var/attachments') };

  ui.step('server', 'Server', 'The API port and an optional shared cache');
  const valkeyUrl = await q('valkey-url', 'Valkey/Redis URL (optional, Enter to skip)', '');
  const port = Number(
    await q('port', 'API port', '3000', {
      validate: (v) =>
        /^\d+$/.test(v) && Number(v) > 0 && Number(v) < 65536 ? null : 'A port number',
    }),
  );
  return {
    dir,
    name,
    databaseUrl,
    company,
    currency,
    lang,
    tz,
    admin: { login, name: adminName, email, password: password as string },
    apps,
    demo,
    storage,
    valkeyUrl,
    port,
    postgres,
    dockerDb,
    vapid: (await import('@kosh/notify')).generateVapidKeys(),
    inboundSecret: randomBytes(24).toString('base64url'),
    inboundWebhookSecret: randomBytes(24).toString('base64url'),
  };
}

/** The modules of the chosen apps (imported here, so a server-only install never loads the others). */
async function modulesFor(apps: readonly AppName[]): Promise<KoshModule[]> {
  // Settings (the App manager) and the realtime gateway come with every installation.
  const modules: KoshModule[] = [
    base,
    (await import('@kosh/settings')).settings,
    (await import('@kosh/realtime')).realtime,
    (await import('@kosh/notify')).notify,
    (await import('@kosh/mail')).mail,
    (await import('@kosh/automation')).automation,
    (await import('@kosh/studio')).studio,
  ];
  for (const app of apps) {
    if (app === 'permissions') modules.push((await import('@kosh/permissions')).permissions);
    if (app === 'reporting') modules.push((await import('@kosh/reporting')).reporting);
    if (app === 'messaging') modules.push((await import('@kosh/messaging')).messaging);
    // The business apps (modules/): dependencies come along with them.
    if (app === 'contacts') modules.push((await import('@kosh/contacts')).contacts);
    if (app === 'product') modules.push((await import('@kosh/product')).product);
    if (app === 'sales') modules.push((await import('@kosh/sales')).sales);
    if (app === 'purchase') modules.push((await import('@kosh/purchase')).purchase);
    if (app === 'accounting') modules.push((await import('@kosh/accounting')).accounting);
    if (app === 'sale_account') modules.push((await import('@kosh/sale_account')).saleAccount);
    if (app === 'purchase_account')
      modules.push((await import('@kosh/purchase_account')).purchaseAccount);
    if (app === 'project') modules.push((await import('@kosh/project')).project);
    if (app === 'sale_project') modules.push((await import('@kosh/sale_project')).saleProject);
  }
  return modules;
}

function envFile(a: Answers): string {
  const lines = [
    '# Kosh settings (kosh init). Keep this file out of version control: it holds credentials.',
    `DATABASE_URL=${a.databaseUrl}`,
    `PORT=${a.port}`,
  ];
  if (a.storage.kind === 'dir') lines.push(`KOSH_STORAGE_DIR=${a.storage.dir}`);
  else
    lines.push(
      `S3_ENDPOINT=${a.storage.endpoint}`,
      `S3_BUCKET=${a.storage.bucket}`,
      `S3_ACCESS_KEY=${a.storage.accessKey}`,
      `S3_SECRET_KEY=${a.storage.secretKey}`,
      `S3_REGION=${a.storage.region}`,
    );
  if (a.valkeyUrl !== '') lines.push(`VALKEY_URL=${a.valkeyUrl}`);
  lines.push(
    '',
    '# Where users open the back-office (links in emails and notifications).',
    'KOSH_BASE_URL=http://localhost:5173',
    '# Email notifications: an SMTP server (Mailpit in development: smtp://localhost:1025, inbox on :8025).',
    '# SMTP_URL=smtp://user:password@smtp.example.com:587',
    '# MAIL_FROM=Kosh <no-reply@example.com>',
    '# Replies by email (RFC 0006 part 7): the inbound mailbox domain, and the webhook secret your provider sends.',
    `MAIL_INBOUND_SECRET=${a.inboundSecret}`,
    '# MAIL_INBOUND_DOMAIN=mail.example.com',
    '# MAIL_INBOUND_ALIAS=reply',
    `MAIL_INBOUND_WEBHOOK_SECRET=${a.inboundWebhookSecret}`,
    '# Without a webhook provider, a mailbox read every 30 s: IMAP_URL=imaps://user:password@host:993/INBOX',
    '',
    '# Kosh Studio (RFC 0012): propose (default: changes become patches) or write (development, one server: Studio',
    '# writes src/modules/<name>/ and applies at once). KOSH_STUDIO_DIR: the project folder (default: the working one).',
    '# KOSH_STUDIO=write',
    '',
    '# SMS and WhatsApp through Twilio (opt-in per user; a phone number on the user).',
    '# TWILIO_ACCOUNT_SID=',
    '# TWILIO_AUTH_TOKEN=',
    '# TWILIO_SMS_FROM=+1...',
    '# TWILIO_WHATSAPP_FROM=+1...',
    '',
    '# Web push (generated by kosh init; keep them, browsers subscribed with the public key stay subscribed).',
    `VAPID_PUBLIC_KEY=${a.vapid.publicKey}`,
    `VAPID_PRIVATE_KEY=${a.vapid.privateKey}`,
    `VAPID_SUBJECT=${a.admin.email === '' ? 'mailto:admin@localhost' : `mailto:${a.admin.email}`}`,
  );
  lines.push(
    '',
    '# PostgreSQL in Docker (compose.yaml): docker compose up -d db, or everything with docker compose up -d --build',
    `POSTGRES_USER=${a.postgres.user}`,
    `POSTGRES_PASSWORD=${a.postgres.password}`,
    `POSTGRES_DB=${a.postgres.db}`,
    `POSTGRES_PORT=${a.postgres.port}`,
  );
  return `${lines.join('\n')}\n`;
}

async function writeProject(a: Answers, ui: Ui): Promise<void> {
  const write = (text: string) => ui.detail(text.trim());
  const options = {
    name: a.name,
    apps: a.apps,
    port: a.port,
    koshVersion: KOSH_VERSION,
    dockerDb: a.postgres.db,
    fileStorage: a.storage.kind === 'dir',
  };
  await mkdir(join(a.dir, 'src', 'web'), { recursive: true });
  await mkdir(join(a.dir, 'public'), { recursive: true });
  const pkgPath = join(a.dir, 'package.json');
  const existing = existsSync(pkgPath)
    ? (JSON.parse(await readFile(pkgPath, 'utf8')) as Record<string, unknown>)
    : null;
  const files: [string, string, boolean][] = [
    ['package.json', templates.packageJson(options, existing), true],
    ['src/modules.ts', templates.modulesTs(options), false],
    ['src/server.ts', templates.serverTs(), false],
    ['src/web/main.tsx', templates.mainTsx(options), false],
    ['src/web/index.css', templates.indexCss(), false],
    ['index.html', templates.indexHtml(options), false],
    ['public/manifest.webmanifest', templates.manifest(options), false],
    ['public/icon.svg', templates.icon(), false],
    ['vite.config.ts', templates.viteConfig(options), false],
    ['tsconfig.json', templates.tsconfig(), false],
    ['README.md', templates.readme(options), false],
    ['.gitignore', templates.gitignore(), false],
    ['Dockerfile', templates.dockerfile(), false],
    // Rewritten when init started the database itself (that early copy predates the storage answer).
    ['compose.yaml', templates.composeYaml(options), a.dockerDb],
    ['nginx.conf', templates.nginxConf(), false],
    ['.dockerignore', templates.dockerignore(), false],
  ];
  for (const [file, content, merge] of files) {
    const path = join(a.dir, file);
    const present = existsSync(path);
    if (present && !merge) {
      write(`  kept    ${file} (exists)\n`);
      continue;
    }
    await writeFile(path, content);
    write(`  ${present ? 'updated' : 'wrote  '} ${file}\n`);
  }
  const envPath = join(a.dir, '.env');
  if (existsSync(envPath)) write('  kept    .env (exists: check it matches the answers)\n');
  else {
    await writeFile(envPath, envFile(a));
    await chmod(envPath, 0o600).catch(() => undefined); // owner only, where the file system supports it
    write('  wrote   .env (credentials; not committed)\n');
  }
}

/** Applies the first migration and installs the company, the administrator and the apps' defaults. */
async function setUp(server: KoshServer, a: Answers, ui: Ui): Promise<number | null> {
  const dir = join(a.dir, 'migrations');
  await ui.task('Creating the database tables', async (task) => {
    const [installed] = await server.driver.query<{ found: string | null }>({
      text: "SELECT to_regclass('public.res_users')::text AS found",
      params: [],
    });
    if (installed?.found === null || installed?.found === undefined) {
      task.update('planning');
      const plan = await migrate.planMigration({
        driver: server.driver,
        registry: server.registry.registry,
        ignore: FRAMEWORK_TABLES, // the framework's own tables, not a model's: never dropped
      });
      const file = await migrate.writeMigrationFile({ dir, name: 'init', plan });
      ui.detail(
        `planned ${plan.statements.length} statements in migrations/${basename(file.path)}`,
      );
    }
    task.update('applying');
    const result = await migrate.applyMigrations({
      driver: server.driver,
      dir,
      registry: server.registry.registry,
    });
    // The installed set (RFC 0008): what `kosh apps` changes later.
    await recordInstalledApps(
      server.driver,
      server.registry.loaded.modules,
      ['base', 'settings', 'realtime', 'notify', ...a.apps],
      `kosh init (${a.admin.login})`,
    );
    task.finish(
      `Database tables ready ${ui.style('gray', `(applied ${result.applied.length} migration(s))`)}`,
    );
  });

  const [users] = await server.driver.query<{ n: string }>({
    text: 'SELECT count(*)::text AS n FROM res_users',
    params: [],
  });
  if (Number(users?.n ?? 0) > 0) {
    ui.info('the database already has users: company and administrator left as they are');
    return null;
  }
  const auth = server.auth;
  if (auth === undefined) throw new Error('base is installed, so sign-in is available');
  const admin = await ui.task('Creating the company and the administrator', async (task) => {
    const { company, admin } = await installBase(server.shutro, auth, {
      company: { name: a.company, currency: a.currency },
      admin: { login: a.admin.login, name: a.admin.name, password: a.admin.password },
    });
    type Model = {
      browse(ids: number[]): { write(values: unknown): Promise<void> };
    };
    await server.shutro.bootstrap({ reason: 'kosh init', company }, async (env) => {
      const model = (name: string) => env.model(name as never) as unknown as Model;
      const lang = a.lang === 'bn' ? 'bn_BD' : 'en_US';
      await model('res.users')
        .browse([admin])
        .write({ lang, tz: a.tz, ...(a.admin.email === '' ? {} : { email: a.admin.email }) });
    });
    task.finish(
      `created company "${a.company}" (${a.currency}) and administrator "${a.admin.login}"`,
    );
    return admin;
  });
  const modules = server.registry.loaded.modules.length;
  let loaded = 0;
  await ui.task("Installing the apps' default data", async (task) => {
    await seed(server, (t) => {
      loaded += 1;
      task.update(ui.progress(Math.min(loaded, modules), modules, 'modules'));
      ui.detail(t.trim());
    });
  });
  if (a.demo)
    await ui.task('Loading the demo data', async (task) => {
      const [first] = await server.driver.query<{ id: number }>({
        text: 'SELECT min(id)::int AS id FROM res_company',
        params: [],
      });
      const seeded = await installDemo({
        shutro: server.shutro,
        auth,
        driver: server.driver,
        modules: server.registry.loaded.modules,
        company: first?.id as number,
        write: (t) => ui.detail(t),
      });
      task.finish(
        seeded.length === 0
          ? 'no installed app has demo data'
          : `${seeded.length} app(s) seeded; demo users dina, rahim, karim and sumi`,
      );
    });
  return admin;
}

/** Enrols the administrator's authenticator through the real sign-in routes; prints the recovery codes once. */
async function enrol(server: KoshServer, a: Answers, prompter: Prompter, ui: Ui): Promise<boolean> {
  const write = ui.write;
  const call = async (url: string, payload: unknown, token?: string) => {
    const res = await server.app.inject({
      method: 'POST',
      url,
      payload: payload as object,
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    });
    const body = res.body === '' ? {} : (res.json() as Record<string, unknown>);
    if (res.statusCode >= 400)
      throw new Error(String(body['detail'] ?? body['title'] ?? res.statusCode));
    return body;
  };
  let token: string;
  let setup: Record<string, unknown>;
  try {
    const session = await call('/api/v1/auth/login', {
      login: a.admin.login,
      password: a.admin.password,
    });
    if (session['twoFactorRequired'] === true) {
      ui.ok(`"${a.admin.login}" already signs in with an authenticator app.`);
      return true;
    }
    token = String(session['token']);
    setup = await call('/api/v1/auth/2fa/setup', {}, token);
  } catch (error) {
    ui.fail(
      `Could not enrol "${a.admin.login}": ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
  ui.info(
    'Add this account to your authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, …):',
  );
  write(
    `    ${ui.style('gray', 'secret:')} ${ui.style('bold', String(setup['secret']))}\n` +
      `    ${ui.style('gray', 'or open:')} ${String(setup['otpauthUri'])}\n`,
  );
  for (let attempt = 1; attempt <= 3; attempt++) {
    const code = await prompter.ask({
      message: 'The 6-digit code the app shows',
      validate: (v) => (/^\d{6}$/.test(v) ? null : 'Six digits'),
    });
    try {
      const enabled = await call('/api/v1/auth/2fa/enable', { code }, token);
      const codes = (enabled['recoveryCodes'] as string[] | undefined) ?? [];
      ui.ok('Two-factor sign-in is on.');
      write(
        `  ${ui.style('yellow', 'Recovery codes')} (each works once if the phone is lost; keep them safe, they are not shown again):\n` +
          `${codes.map((c) => `    ${ui.style('bold', c)}`).join('\n')}\n`,
      );
      await call('/api/v1/auth/logout', {}, token).catch(() => undefined);
      return true;
    } catch (error) {
      ui.fail(error instanceof Error ? error.message : String(error));
    }
  }
  ui.warn(
    'Not enrolled: run kosh init again later, or enrol from the API (POST /api/v1/auth/2fa/setup).',
  );
  return false;
}

/** Runs `kosh init`. Returns the exit code. */
export async function runInit(argv: readonly string[], io: InitIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      'database-url': { type: 'string' },
      'create-database': { type: 'boolean' },
      company: { type: 'string' },
      currency: { type: 'string' },
      lang: { type: 'string' },
      tz: { type: 'string' },
      'admin-login': { type: 'string' },
      'admin-name': { type: 'string' },
      'admin-email': { type: 'string' },
      'admin-password': { type: 'string' },
      apps: { type: 'string' },
      'storage-dir': { type: 'string' },
      's3-endpoint': { type: 'string' },
      's3-bucket': { type: 'string' },
      's3-access-key': { type: 'string' },
      's3-secret-key': { type: 'string' },
      's3-region': { type: 'string' },
      'valkey-url': { type: 'string' },
      port: { type: 'string' },
      'no-2fa': { type: 'boolean' },
      demo: { type: 'boolean' },
      'docker-db': { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help === true) {
    io.write(INIT_USAGE);
    return 0;
  }
  const terminal = io.terminal ?? PLAIN_TERMINAL;
  const interactive2fa = values['no-2fa'] !== true && values.yes !== true;
  // Six question steps, then the project files and the database, then (interactively) the second factor.
  const ui = createUi(io.write, terminal, { steps: interactive2fa ? 9 : 8 });
  const asked =
    io.prompter ??
    (values.yes === true
      ? defaultsPrompter()
      : terminalPrompter(process.stdin, process.stdout, {
          marker: ui.style('cyan', '? '),
          fallback: (t) => ui.style('gray', t),
          problem: (t) => ui.style('yellow', `${terminal.unicode ? '▲' : '!'} ${t}`),
        }));
  // A question stops the spinner while it is asked (the prompter writes to the terminal itself).
  const prompter: Prompter = {
    async ask(q) {
      ui.pause();
      try {
        return await asked.ask(q);
      } finally {
        ui.resume();
      }
    },
    async confirm(message, fallback) {
      ui.pause();
      try {
        return await asked.confirm(message, fallback);
      } finally {
        ui.resume();
      }
    },
    close: () => asked.close(),
  };
  let server: KoshServer | undefined;
  const started = Date.now();
  try {
    await ui.banner(`The ERP framework on Shutro · v${KOSH_VERSION}`);
    ui.write(`  ${ui.style('gray', 'Kosh setup: press Enter to keep the value in [brackets].')}\n`);
    const answers = await ask(prompter, values, io.cwd, positionals[0], ui);

    ui.step('files', 'Project files', answers.dir);
    await ui.task('Writing the project', async () => {
      await writeProject(answers, ui);
      if (answers.storage.kind === 'dir')
        await mkdir(resolve(answers.dir, answers.storage.dir), { recursive: true });
    });

    ui.step('install', 'Installing', `base + ${answers.apps.join(', ') || 'no apps'}`);
    process.env['KOSH_SCHEDULES'] = 'off';
    server = await ui.task('Loading the modules', async (task) => {
      const modules = await modulesFor(answers.apps);
      const created = await createServer({
        databaseUrl: answers.databaseUrl,
        modules,
        logger: false,
        auth: { secureCookies: false },
      });
      task.finish(`Loaded ${modules.length} module(s): ${modules.map((m) => m.name).join(', ')}`);
      return created;
    });
    const live = server;
    const admin = await setUp(live, answers, ui);
    if (admin !== null && answers.storage.kind === 's3') {
      const storage = answers.storage;
      await ui.task(`Preparing the bucket "${storage.bucket}"`, async () => {
        const { S3Storage } = await import('@kosh/storage');
        await new S3Storage({
          endpoint: storage.endpoint,
          bucket: storage.bucket,
          accessKeyId: storage.accessKey,
          secretAccessKey: storage.secretKey,
          region: storage.region,
        }).ensureBucket();
      });
    }
    // Also on a second run: the administrator may not have enrolled the first time.
    let enrolled = false;
    if (interactive2fa) {
      ui.step('security', 'Two-factor sign-in', 'Administrator rights need a second factor');
      enrolled = await enrol(live, answers, prompter, ui);
    } else if (values.yes === true && values['no-2fa'] !== true)
      ui.info(
        'The authenticator app is enrolled interactively: run npx kosh init again (without --yes).',
      );

    const rows: CardRow[] = [
      ['Company', `${answers.company} (${answers.currency})`],
      [
        'Administrator',
        `${answers.admin.login} ${ui.style(enrolled ? 'green' : 'yellow', enrolled ? '· 2FA on' : '· 2FA pending')}`,
      ],
      [
        'Apps',
        [
          'base',
          'settings',
          'realtime',
          'notify',
          'mail',
          'automation',
          'studio',
          ...answers.apps,
        ].join(', '),
      ],
      ...(answers.demo
        ? [['Demo users', `dina, rahim, karim, sumi · password "${DEMO_PASSWORD}"`] as CardRow]
        : []),
      ['Database', answers.dockerDb ? `Docker (port ${answers.postgres.port})` : 'your server'],
      ['API', `http://localhost:${answers.port}`],
      ['Took', `${((Date.now() - started) / 1000).toFixed(1)}s`],
    ];
    ui.card(
      `${terminal.emoji ? '🚀 ' : ''}Kosh is set up`,
      rows,
      enrolled || values['no-2fa'] === true ? 'green' : 'yellow',
    );

    const relative =
      answers.dir === resolve(io.cwd) ? '' : `cd ${positionals[0] ?? answers.dir}\n  `;
    // npm create kosh-erp installs the dependencies and prints the next steps itself.
    if (process.env['KOSH_CREATE'] === '1') {
      if (!enrolled)
        ui.warn(
          'Administrator rights need a second factor: run `npx kosh init` again to enrol the authenticator app.',
        );
      return 0;
    }
    const cmd = (c: string) => ui.style('cyan', c);
    ui.write(
      `\n  ${ui.style('bold', 'Next')}\n  ${relative}${cmd('npm install')}\n  ${cmd('npm start')}          ${ui.style('gray', `# the API on http://localhost:${answers.port}`)}\n` +
        `  ${cmd('npm run web')}        ${ui.style('gray', '# the back-office on http://localhost:5173')}\n\n` +
        `  Sign in as "${answers.admin.login}"${enrolled ? ' with your password and a code from the authenticator app' : ''}.\n`,
    );
    if (!enrolled)
      ui.warn(
        'Administrator rights need a second factor: run `kosh init` again to enrol the authenticator app.',
      );
    return 0;
  } catch (error) {
    ui.write('\n');
    ui.fail(`kosh init stopped: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    await server?.close();
    prompter.close();
  }
}
