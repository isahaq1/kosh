/**
 * The portal's end-to-end server (RFC 0015 step 3): Sales and Accounting with their portal bridges and online
 * payments (the test provider), a customer company with a contact, a sent quotation and a posted invoice. Started by Playwright's `webServer`. The tests
 * grant the portal access themselves, as staff, through the API.
 *
 * Users (password: `correct horse battery`):
 * - `maria`: sales and accounting manager, grants portal access
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountPortal } from '@kosh/account_portal';
import { payment } from '@kosh/payment';
import { installTemplates } from '@kosh/reporting';
import { salePortal } from '@kosh/sale_portal';
import {
  applyApps,
  base,
  createAppHost,
  installBase,
  installDefaults,
  prepareApps,
  recordInstalledApps,
  startAppHost,
} from '@kosh/server';
import { orm, pg } from '@kosh/server/orm';
import { PostgreSqlContainer } from '@testcontainers/postgresql';

const PASSWORD = 'correct horse battery';
const PORT = Number(process.env['KOSH_E2E_PORTAL_PORT'] ?? 3102);
process.env['KOSH_SCHEDULES'] = 'off';
process.env['KOSH_PORTAL_URL'] ??= 'http://localhost:5175';

const container = await new PostgreSqlContainer('postgres:18').start();
const databaseUrl = container.getConnectionUri();
const catalogue = [base, salePortal, accountPortal, payment];
const migrations = mkdtempSync(join(tmpdir(), 'kosh-e2e-portal-migrations-'));
const setup = pg.createDriver({ url: databaseUrl, max: 2, parseNumeric: orm.toDecimal });
await recordInstalledApps(setup, [], [], 'e2e');
await applyApps(
  await prepareApps({
    driver: setup,
    catalogue,
    change: { install: ['sale_portal', 'account_portal', 'payment'] },
    dir: migrations,
  }),
  { driver: setup, dir: migrations, actor: 'e2e' },
);
await setup.end();
const host = await createAppHost({
  databaseUrl,
  catalogue,
  migrationsDir: migrations,
  auth: { secureCookies: false, cacheMs: 0, loginLimit: 0 },
  rateLimit: { max: 0, timeWindow: '1 minute' },
  logger: { level: 'warn' },
});
const server = host.server;
const auth = server.auth;
if (auth === undefined) throw new Error('base is installed');
const { company } = await installBase(server.shutro, auth, {
  company: { name: 'Padma Traders', currency: 'BDT' },
  admin: { login: 'admin', name: 'Administrator', password: PASSWORD },
});
await installDefaults(server.shutro, server.registry.loaded.modules, { company });
await auth.createUser({
  login: 'maria',
  name: 'Maria Sultana',
  password: PASSWORD,
  company,
  companies: [company],
  groups: ['sales.manager', 'account.manager', 'portal.manager', 'messaging.user'],
});
await server.shutro.bootstrap({ reason: 'e2e seed', company }, (env) =>
  installTemplates(env, server.registry.loaded.modules),
);

const token = (
  (
    await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { login: 'maria', password: PASSWORD },
    })
  ).json() as { token: string }
).token;
const as = async (method: 'GET' | 'POST', url: string, payload?: unknown) => {
  const res = await server.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  if (res.statusCode >= 400) throw new Error(`${method} ${url}: ${res.statusCode} ${res.body}`);
  return res.json() as Record<string, unknown>;
};
await as('POST', '/api/v1/accounting/charts/install', { template: 'generic' });
const [bdt] = (await server.shutro.bootstrap(
  { reason: 'e2e seed', company },
  async (env) => env.sql<{ id: number }>`SELECT id FROM res_currency WHERE name = 'BDT'`,
)) as { id: number }[];
const acme = (await as('POST', '/api/v1/models/res.partner', {
  name: 'Acme Trading',
  isCompany: true,
  isCustomer: true,
})) as { id: number };
await as('POST', '/api/v1/models/res.partner', {
  name: 'Rina Akter',
  email: 'rina@acme.test',
  parent: acme.id,
});
const bag = (await as('POST', '/api/v1/models/product.product', {
  name: 'Jute bag',
  listPrice: '1200',
})) as { id: number };
const quotation = (await as('POST', '/api/v1/models/sale.order', {
  partner: acme.id,
  currency: bdt?.id,
  lines: { create: [{ product: bag.id, name: 'Jute bag', quantity: '50', priceUnit: '1200' }] },
})) as { id: number };
await as('POST', `/api/v1/models/sale.order/${quotation.id}/transitions/send`);
const journals = (await as('GET', '/api/v1/models/account.journal?fields=id,code,type'))[
  'items'
] as {
  id: number;
  code: string;
  type: string;
}[];
// Online payments with the test provider, into the bank journal.
await as('POST', '/api/v1/models/payment.provider', {
  name: 'Test payments',
  code: 'fake',
  journal: journals.find((j) => j.type === 'bank')?.id,
});
const invoice = (await as('POST', '/api/v1/models/account.move', {
  kind: 'out_invoice',
  journal: journals.find((j) => j.code === 'INV')?.id,
  partner: acme.id,
  currency: bdt?.id,
  lines: {
    create: [
      { lineKind: 'product', product: bag.id, name: 'Jute bag', quantity: '10', priceUnit: '1200' },
    ],
  },
})) as { id: number };
await as('POST', `/api/v1/models/account.move/${invoice.id}/transitions/post`);

await startAppHost(host, {
  port: PORT,
  host: '127.0.0.1',
  onShutdown: async () => {
    await container.stop();
  },
});
process.stdout.write(`Kosh e2e portal API on http://127.0.0.1:${PORT}\n`);
