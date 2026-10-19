/**
 * The API server of the end-to-end tests: PostgreSQL in a container, the e2e module set, seed data and users
 * (Playwright `webServer`; `node e2e/server.ts` after `pnpm build`). Stops the container on SIGTERM / SIGINT.
 *
 * Users (password `correct horse battery`):
 * - `rahim`: contacts user, purchase requester
 * - `dina`: contacts manager, purchase approver
 * - `maria`: purchase manager (finance director level)
 * - `rahim`, `dina`, `maria` also have Messaging (the chatter)
 * - `bob`: an internal user without any app role
 * - `admin`: administrator with 2FA (secret {@link ADMIN_TOTP_SECRET})
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installActivityTypes } from '@kosh/messaging';
import { installApprovalPolicies } from '@kosh/permissions';
import { installTemplates } from '@kosh/reporting';
import { createServer, installBase, startServer } from '@kosh/server';
import { orm } from '@kosh/server/orm';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { MODULES } from './fixture/modules.ts';

export const ADMIN_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const PASSWORD = 'correct horse battery';
const PORT = Number(process.env['KOSH_E2E_PORT'] ?? 3100);

// Attachments in a temporary directory (production: S3-compatible storage).
process.env['KOSH_STORAGE_DIR'] ??= mkdtempSync(join(tmpdir(), 'kosh-e2e-files-'));
const container = await new PostgreSqlContainer('postgres:18').start();
const server = await createServer({
  databaseUrl: container.getConnectionUri(),
  modules: MODULES,
  auth: { secureCookies: false, cacheMs: 0, loginLimit: 0 },
  rateLimit: { max: 0, timeWindow: '1 minute' },
  logger: { level: 'warn' },
});
for (const statement of orm.createTableStatements(server.registry.registry))
  await server.driver.query(statement);
const auth = server.auth;
if (auth === undefined) throw new Error('base is installed');
const { company, admin } = await installBase(server.shutro, auth, {
  company: { name: 'Dhaka Ltd', currency: 'BDT' },
  admin: { login: 'admin', name: 'Administrator', password: PASSWORD },
});
type Model = {
  create(rows: unknown[]): Promise<{ ids: number[] }>;
  search(q: unknown): Promise<{ write(v: unknown): Promise<void> }>;
};
await server.shutro.bootstrap({ reason: 'e2e seed', company }, async (env) => {
  const model = (name: string) => env.model(name as never) as unknown as Model;
  await installApprovalPolicies(env, server.registry.loaded.modules);
  await installTemplates(env, server.registry.loaded.modules);
  await installActivityTypes(env);
  await (await model('auth.credential').search({ where: { user: admin } })).write({
    totpSecret: ADMIN_TOTP_SECRET,
    totpEnabled: true,
  });
  await model('res.partner').create([
    {
      name: 'Acme Trading',
      email: 'sales@acme.test',
      city: 'Dhaka',
      isCompany: true,
      creditLimit: '500000',
      latitude: '23.8103',
      longitude: '90.4125',
      company,
    },
    {
      name: 'Bengal Steel',
      email: 'info@bengalsteel.test',
      city: 'Chattogram',
      isCompany: true,
      creditLimit: '250000',
      latitude: '22.3569',
      longitude: '91.7832',
      company,
    },
    { name: 'Rafiq Ahmed', email: 'rafiq@example.test', city: 'Dhaka', company },
    { name: 'Sumaiya Khan', email: 'sumaiya@example.test', city: 'Sylhet', company },
  ]);
  // Contacts of the companies (hierarchy), and purchase orders this month and last year (reports).
  await model('res.partner').create([
    { name: 'Karim (Acme buyer)', parent: 1, city: 'Dhaka', company },
    { name: 'Nadia (Acme accounts)', parent: 1, city: 'Dhaka', company },
  ]);
  const today = new Date();
  const day = (offset: number) =>
    new Date(
      Date.UTC(today.getFullYear(), today.getMonth(), Math.min(today.getDate(), 20) + offset),
    )
      .toISOString()
      .slice(0, 10);
  const lastYear = (d: string) => `${Number(d.slice(0, 4)) - 1}${d.slice(4)}`;
  await model('purchase.order').create([
    {
      name: 'PO-R-001',
      vendor: 1,
      amountTotal: '12000',
      dateOrder: day(-3),
      dateDue: day(4),
      received: 50,
      company,
    },
    {
      name: 'PO-R-002',
      vendor: 1,
      amountTotal: '8000',
      dateOrder: day(-1),
      dateDue: day(2),
      received: 100,
      company,
    },
    {
      name: 'PO-R-003',
      vendor: 2,
      amountTotal: '30000',
      dateOrder: day(0),
      dateDue: day(9),
      received: 0,
      company,
    },
    {
      name: 'PO-R-OLD',
      vendor: 1,
      amountTotal: '10000',
      dateOrder: lastYear(day(-2)),
      dateDue: lastYear(day(5)),
      company,
    },
  ]);
});
for (const [login, name, groups] of [
  ['rahim', 'Rahim Uddin', ['contacts.user', 'purchase.user', 'reporting.user', 'messaging.user']],
  [
    'dina',
    'Dina Rahman',
    ['contacts.manager', 'purchase.approver', 'reporting.designer', 'messaging.user'],
  ],
  ['maria', 'Maria Das', ['contacts.user', 'purchase.manager', 'reporting.user', 'messaging.user']],
  ['bob', 'Bob Smith', ['base.user']],
] as const)
  await auth.createUser({
    login,
    name,
    password: PASSWORD,
    company,
    companies: [company],
    groups: [...groups],
  });

await startServer(server, {
  port: PORT,
  host: '127.0.0.1',
  onShutdown: async () => {
    await container.stop();
  },
});
process.stdout.write(`Kosh e2e API on http://127.0.0.1:${PORT}\n`);
