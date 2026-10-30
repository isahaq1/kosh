/**
 * `kosh init` on PostgreSQL: a database that does not exist yet is created, the project and `.env` are written, the
 * first migration is planned and applied, the company and administrator are installed, the authenticator is enrolled
 * through the real sign-in routes, and a second run keeps everything (files, data) and reports the enrolment.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { base, createServer, totp } from '@kosh/server';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import type { Prompter, Question } from '../src/index.js';
import { runInit } from '../src/index.js';

let pg: StartedPostgreSqlContainer;
let dir: string;
let url: string;
const PASSWORD = 'a long enough password';

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:18').start();
  dir = await mkdtemp(join(tmpdir(), 'kosh-init-'));
  const admin = new URL(pg.getConnectionUri());
  admin.pathname = '/kosh_fresh'; // does not exist yet: init creates it
  url = admin.toString();
}, 180_000);

afterAll(async () => {
  await pg?.stop();
  await rm(dir, { recursive: true, force: true });
});

/** Answers by question; the authenticator code is computed from the secret init printed. */
function scripted(
  output: string[],
  answers: Record<string, string>,
): Prompter & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async ask(q: Question) {
      asked.push(q.message);
      if (q.message.startsWith('The 6-digit code')) {
        const secret = /secret: ([A-Z2-7]+)/.exec(output.join(''))?.[1];
        if (secret === undefined) throw new Error('no secret printed');
        return totp(secret);
      }
      const answer = Object.entries(answers).find(([k]) => q.message.startsWith(k))?.[1];
      const value = answer ?? q.default;
      if (value === undefined) throw new Error(`unexpected question: ${q.message}`);
      const problem = q.validate?.(value) ?? null;
      if (problem !== null) throw new Error(`${q.message}: ${problem}`);
      return value;
    },
    async confirm(_m: string, fallback: boolean) {
      return fallback;
    },
    close() {},
  };
}

test('a fresh installation: database created, project written, migrated, administrator enrolled', async () => {
  const output: string[] = [];
  const prompter = scripted(output, {
    'Company name': 'Padma Traders',
    Currency: 'bdt',
    Language: 'bn',
    'Time zone': 'Asia/Dhaka',
    Login: 'owner',
    'Full name': 'Nusrat Owner',
    Email: 'owner@padma.test',
    'Password (12+ characters)': PASSWORD,
    'Repeat the password': PASSWORD,
    'Apps to install': 'reporting,messaging',
  });
  const code = await runInit(['shop', '--database-url', url], {
    write: (t) => output.push(t),
    prompter,
    cwd: dir,
  });
  const text = output.join('');
  expect(code, text).toBe(0);
  expect(text).toContain('connected (PostgreSQL 18');
  expect(text).toContain('created company "Padma Traders" (BDT) and administrator "owner"');
  expect(text).toMatch(/Recovery codes[^\n]*\n(\s+\S+\n){10}/);
  expect(text).not.toContain(PASSWORD); // never echoed
  expect(text).toContain('messaging        5 activity type(s) installed');

  const project = join(dir, 'shop');
  for (const file of [
    'package.json',
    'src/modules.ts',
    'src/server.ts',
    'src/web/main.tsx',
    'src/web/index.css',
    'index.html',
    'vite.config.ts',
    '.gitignore',
    '.env',
    'README.md',
    'Dockerfile',
    'compose.yaml',
    'nginx.conf',
    '.dockerignore',
  ])
    expect(existsSync(join(project, file)), file).toBe(true);
  const env = await readFile(join(project, '.env'), 'utf8');
  expect(env).toContain(`DATABASE_URL=${url}`);
  expect(env).toContain('SHUTRO_ERP_STORAGE_DIR=./var/attachments');
  expect(env).not.toContain(PASSWORD);
  expect(env).toMatch(/^POSTGRES_PASSWORD=[A-Za-z0-9]{20,}$/m); // for compose.yaml
  const modules = await readFile(join(project, 'src/modules.ts'), 'utf8');
  // The catalogue lists every app; the database says which are installed (RFC 0008).
  expect(modules).toContain("import { reporting } from 'shutro-erp/reporting';");
  expect(modules).toContain(
    'export const modules = [base, settings, realtime, notify, mail, automation, integrations, studio, dataImport, assistant, permissions, reporting, messaging, contacts, product, sales, purchase, accounting, project, saleAccount, purchaseAccount, todo, calendarApp, crm, hr, recruitment, stock, saleProject, saleStock, purchaseStock, l10nBd, l10nIn];',
  );
  const main = await readFile(join(project, 'src/web/main.tsx'), 'utf8');
  expect(main).toContain(
    "import { messagingMessages, registerMessagingWeb } from 'shutro-erp/messaging/web';",
  );
  expect(main).toContain(
    "import { settingsMessages, registerSettingsWeb } from 'shutro-erp/settings/web';",
  );
  expect(await readFile(join(project, 'src/server.ts'), 'utf8')).toContain('createAppHost');
  const pkg = JSON.parse(await readFile(join(project, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
    dependencies: Record<string, string>;
  };
  expect(pkg.scripts['start']).toBe('node --env-file=.env src/server.ts');
  expect(pkg.scripts).toMatchObject({ migrate: 'shutro-erp migrate', seed: 'shutro-erp seed' });
  expect(pkg.dependencies).toMatchObject({ 'shutro-erp': '^0.1.0' });
  expect(pkg.dependencies).not.toHaveProperty('shutro'); // it comes with shutro-erp
  expect(await readdir(join(project, 'migrations'))).toEqual(['0001_init.sql']);
  expect(existsSync(join(project, 'var', 'attachments'))).toBe(true);

  // The installation works: the administrator signs in with the password and a second factor.
  process.env['KOSH_SCHEDULES'] = 'off';
  const server = await createServer({ databaseUrl: url, modules: [base], logger: false });
  try {
    const login = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { login: 'owner', password: PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({ twoFactorRequired: true });
    const [user] = await server.driver.query<{
      name: string;
      lang: string;
      tz: string;
      email: string;
    }>({
      text: "SELECT name, lang, tz, email FROM res_users WHERE login = 'owner'",
      params: [],
    });
    expect(user).toEqual({
      name: 'Nusrat Owner',
      lang: 'bn_BD',
      tz: 'Asia/Dhaka',
      email: 'owner@padma.test',
    });
    const types = await server.driver.query({
      text: 'SELECT id FROM mail_activity_type',
      params: [],
    });
    expect(types.length).toBe(5);
    // Installed: base, Settings and the chosen apps (not permissions).
    const installed = await server.driver.query<{ name: string; reason: string }>({
      text: 'SELECT name, reason FROM kosh_module ORDER BY name',
      params: [],
    });
    expect(installed.map((r) => r.name)).toEqual([
      'automation',
      'base',
      'import',
      'integrations',
      'mail',
      'messaging',
      'notify',
      'realtime',
      'reporting',
      'settings',
      'storage',
      'studio',
    ]);
  } finally {
    await server.close();
  }

  // A second run keeps the files and the data, and sees the enrolment.
  const again: string[] = [];
  const second = await runInit(['shop', '--database-url', url], {
    write: (t) => again.push(t),
    prompter: scripted(again, {
      Login: 'owner',
      'Password (12+ characters)': PASSWORD,
      'Repeat the password': PASSWORD,
      'Apps to install': 'reporting,messaging',
    }),
    cwd: dir,
  });
  const text2 = again.join('');
  expect(second, text2).toBe(0);
  expect(text2).toContain('kept    src/modules.ts (exists)');
  expect(text2).toContain('kept    .env');
  expect(text2).toContain('applied 0 migration(s)');
  expect(text2).toContain('already has users');
  expect(text2).toContain('"owner" already signs in with an authenticator app.');
}, 240_000);

test('the same project with more apps gets their tables first; another project’s database is refused', async () => {
  // The first test's project (base and two apps) runs again with Products, Sales and Accounting: their tables are
  // planned before their data migrations run (product_sale_tax_rel…).
  const output: string[] = [];
  const code = await runInit(
    [
      join(dir, 'shop'),
      '--yes',
      '--no-2fa',
      '--no-start',
      '--database-url',
      url,
      '--admin-password',
      PASSWORD,
      '--apps',
      'reporting,messaging,contacts,product,sales,accounting',
    ],
    { write: (t) => output.push(t), cwd: dir },
  );
  const text = output.join('');
  expect(code, text).toBe(0);
  expect(text).toContain('(the database had an earlier version)');
  const server = await createServer({ databaseUrl: url, modules: [base], logger: false });
  try {
    const [rel] = await server.driver.query<{ found: string | null }>({
      text: "SELECT to_regclass('public.product_sale_tax_rel')::text AS found",
      params: [],
    });
    expect(rel?.found).toBe('product_sale_tax_rel');
  } finally {
    await server.close();
  }

  // A new folder on that database: its history is the other project's; said plainly, nothing changed.
  const other: string[] = [];
  const refused = await runInit(
    [
      join(dir, 'elsewhere'),
      '--yes',
      '--no-2fa',
      '--no-start',
      '--database-url',
      url,
      '--admin-password',
      PASSWORD,
    ],
    { write: (t) => other.push(t), cwd: dir },
  );
  expect(refused).toBe(1);
  expect(other.join('')).toContain('belongs to another installation');
}, 240_000);

test('--yes needs the administrator password; a weak one is refused', async () => {
  const output: string[] = [];
  const code = await runInit(
    [join(dir, 'other'), '--yes', '--database-url', url, '--admin-password', 'short'],
    { write: (t) => output.push(t), cwd: dir },
  );
  expect(code).toBe(1);
  expect(output.join('')).toContain('At least 12 characters.');
}, 120_000);

test('the database asked part by part: host, port, user, hidden password, database (created)', async () => {
  const uri = new URL(pg.getConnectionUri());
  const output: string[] = [];
  const prompter = scripted(output, {
    'PostgreSQL: (1)': '1',
    '  Host': uri.hostname,
    '  Port': uri.port,
    '  Username': decodeURIComponent(uri.username),
    '  Password of': decodeURIComponent(uri.password),
    '  Database name': 'kosh_parts',
    'Password (12+ characters)': PASSWORD,
    'Repeat the password': PASSWORD,
  });
  const code = await runInit(['parts', '--no-2fa', '--demo'], {
    write: (t) => output.push(t),
    prompter,
    cwd: dir,
  });
  const text = output.join('');
  expect(code, text).toBe(0);
  expect(text).toContain('connected (PostgreSQL 18');
  expect(prompter.asked).toContain('  Database name (created if missing)');
  // The demo data of every app (all are installed by default), made by the demo users.
  expect(text).toContain('contacts: 8 companies and 3 people');
  expect(text).toContain('sale_project: 2 service products create tasks or projects when sold');
  // BDT: the company is in Bangladesh by default, and its localization came with Accounting.
  expect(text).toMatch(/l10n_bd\s+the Bangladesh chart \(\d+ accounts\), 14 taxes, 4 withholdings/);
  expect(text).toContain('Demo users');
  expect(text).toContain('dina, rahim, karim, sumi');
  const env = await readFile(join(dir, 'parts', '.env'), 'utf8');
  expect(env).toContain(
    `DATABASE_URL=postgres://${uri.username}:${uri.password}@${uri.hostname}:${uri.port}/kosh_parts`,
  );
  expect(text).not.toContain(decodeURIComponent(uri.password)); // the database password is not echoed either
}, 240_000);
