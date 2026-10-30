/**
 * The business apps' end-to-end server (RFC 0008 step 7): a real installation of Contacts, Products, Sales,
 * Purchase and Accounting with their bridges (the planner proposes `sale_account` and `purchase_account`), the
 * Bangladesh chart of accounts, a few partners and products, a confirmed sales order and a posted customer
 * invoice. Started by Playwright's `webServer` (project `apps`), on another port than the fixture server.
 *
 * Users (password: `correct horse battery`):
 * - `admin`: administrator with 2FA (the fixture's secret)
 * - `dina`: accounting, sales, purchase and contacts manager; uses the AI assistant (a fake client: no key, no
 *   network) and imports data
 * - `rahim`: salesperson who invoices (sale_account.user) and accountant
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountPortal } from '@kosh/account_portal';
import { accounting } from '@kosh/accounting';
import { createAssistant, fakeClient } from '@kosh/assistant';
import { automation } from '@kosh/automation';
import { calendarApp } from '@kosh/calendar';
import { contacts } from '@kosh/contacts';
import { crm } from '@kosh/crm';
import { hr } from '@kosh/hr';
import { dataImport } from '@kosh/import';
import { l10nBd } from '@kosh/l10n_bd';
import { l10nIn } from '@kosh/l10n_in';
import { mail } from '@kosh/mail';
import { installActivityTypes, messaging } from '@kosh/messaging';
import { notify } from '@kosh/notify';
import { installApprovalPolicies, permissions } from '@kosh/permissions';
import { portal } from '@kosh/portal';
import { product } from '@kosh/product';
import { project } from '@kosh/project';
import { purchase } from '@kosh/purchase';
import { purchaseAccount } from '@kosh/purchase_account';
import { purchaseStock } from '@kosh/purchase_stock';
import { realtime } from '@kosh/realtime';
import { recruitment } from '@kosh/recruitment';
import { installTemplates, reporting } from '@kosh/reporting';
import { saleAccount } from '@kosh/sale_account';
import { salePortal } from '@kosh/sale_portal';
import { saleProject } from '@kosh/sale_project';
import { saleStock } from '@kosh/sale_stock';
import { sales } from '@kosh/sales';
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
import { settings } from '@kosh/settings';
import { stock } from '@kosh/stock';
import { stockAccount } from '@kosh/stock_account';
import { todo } from '@kosh/todo';
import { PostgreSqlContainer } from '@testcontainers/postgresql';

export const ADMIN_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const PASSWORD = 'correct horse battery';
const PORT = Number(process.env['KOSH_E2E_APPS_PORT'] ?? 3101);

process.env['KOSH_STORAGE_DIR'] ??= mkdtempSync(join(tmpdir(), 'kosh-e2e-apps-files-'));
process.env['KOSH_SCHEDULES'] ??= 'off';
const container = await new PostgreSqlContainer('postgres:18').start();
const databaseUrl = container.getConnectionUri();
// The AI assistant with a fake client: "Customer: …" and "Line: <product>; <quantity>; <unit price>" lines of a
// pasted text fill a new sales order and its lines.
const NL = String.fromCharCode(10);
const assistant = createAssistant({
  client: fakeClient((request) => {
    if (!('schema' in request) || !request.system.includes('propose the values'))
      return { clauses: [], combine: 'and', unsupported: '' };
    const text = request.user.split(NL);
    const customer =
      text
        .find((l) => l.startsWith('Customer:'))
        ?.slice('Customer:'.length)
        .trim() ?? '';
    const lines = text
      .filter((l) => l.startsWith('Line:'))
      .map((l) =>
        l
          .slice('Line:'.length)
          .split(';')
          .map((part) => part.trim()),
      )
      .map(([product = '', quantity = '', priceUnit = '']) => ({
        product,
        name: product,
        quantity,
        priceUnit,
      }));
    return { fields: { partner: customer }, lines: { lines }, notes: '' };
  }, 'fake-claude'),
});
const CATALOGUE = [
  base,
  settings,
  realtime,
  notify,
  mail,
  automation,
  permissions,
  reporting,
  messaging,
  contacts,
  product,
  sales,
  purchase,
  accounting,
  project,
  todo,
  calendarApp,
  crm,
  hr,
  recruitment,
  stock,
  saleAccount,
  purchaseAccount,
  saleProject,
  saleStock,
  purchaseStock,
  stockAccount,
  assistant,
  dataImport,
  l10nBd,
  l10nIn,
  portal,
  salePortal,
  accountPortal,
];
const migrations = mkdtempSync(join(tmpdir(), 'kosh-e2e-apps-migrations-'));
const setup = pg.createDriver({ url: databaseUrl, max: 2, parseNumeric: orm.toDecimal });
await recordInstalledApps(setup, [], [], 'e2e');
await applyApps(
  await prepareApps({
    driver: setup,
    catalogue: CATALOGUE,
    change: {
      install: [
        'settings',
        'realtime',
        'notify',
        'mail',
        'automation',
        'sales',
        'purchase',
        'accounting',
        'project',
        'todo',
        'calendar',
        'crm',
        'hr',
        'recruitment',
        'stock',
        'assistant',
        'import',
        'l10n_bd',
        'l10n_in',
        'sale_portal',
        'account_portal',
      ],
    },
    dir: migrations,
  }),
  { driver: setup, dir: migrations, actor: 'e2e' },
);
await setup.end();
const host = await createAppHost({
  databaseUrl,
  catalogue: CATALOGUE,
  migrationsDir: migrations,
  auth: { secureCookies: false, cacheMs: 0, loginLimit: 0 },
  rateLimit: { max: 0, timeWindow: '1 minute' },
  logger: { level: 'warn' },
});
const server = host.server;
const auth = server.auth;
if (auth === undefined) throw new Error('base is installed');
const { company, admin } = await installBase(server.shutro, auth, {
  company: { name: 'Padma Traders', currency: 'BDT' },
  admin: { login: 'admin', name: 'Administrator', password: PASSWORD },
});
await installDefaults(server.shutro, server.registry.loaded.modules, { company });
type Model = {
  create(rows: unknown[]): Promise<{ ids: number[] }>;
  search(q: unknown): Promise<{ write(v: unknown): Promise<void> }>;
};
await server.shutro.bootstrap({ reason: 'e2e seed', company }, async (env) => {
  const model = (name: string) => env.model(name as never) as unknown as Model;
  await installApprovalPolicies(env, server.registry.loaded.modules);
  await installTemplates(env, server.registry.loaded.modules);
  await installActivityTypes(env);
  await model('assistant.config').create([{ company, enabled: true }]);
  await (await model('auth.credential').search({ where: { user: admin } })).write({
    totpSecret: ADMIN_TOTP_SECRET,
    totpEnabled: true,
  });
});
for (const [login, name, groups] of [
  [
    'dina',
    'Dina Rahman',
    [
      'account.manager',
      'sales.manager',
      'purchase.manager',
      'project.manager',
      'todo.user',
      'calendar.manager',
      'crm.manager',
      'hr.manager',
      'hiring.manager',
      'stock.manager',
      'messaging.user',
      'reporting.user',
      'assistant.user',
      'import.user',
      'contacts.manager',
      'portal.manager',
    ],
  ],
  [
    'rahim',
    'Rahim Uddin',
    [
      'sale_account.user',
      'sale_project.user',
      'account.user',
      'messaging.user',
      'reporting.user',
      'todo.user',
      'calendar.user',
      'crm.user',
      'hr.user',
      'hiring.user',
      'stock.user',
    ],
  ],
] as const)
  await auth.createUser({
    login,
    name,
    password: PASSWORD,
    company,
    companies: [company],
    groups: [...groups],
  });

// The chart, partners, products, an order and an invoice, as the users would make them (through the API).
const token = async (login: string) => {
  const res = await server.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { login, password: PASSWORD },
  });
  return (res.json() as { token: string }).token;
};
const as = async (login: string, method: 'GET' | 'POST', url: string, payload?: unknown) => {
  const res = await server.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${await token(login)}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  if (res.statusCode >= 400) throw new Error(`${method} ${url}: ${res.statusCode} ${res.body}`);
  return res.json() as Record<string, unknown>;
};
// The Bangladesh chart, taxes and withholdings came with l10n_bd (its defaults, on install).
const [bdt] = (await server.shutro.bootstrap(
  { reason: 'e2e seed', company },
  async (env) => env.sql<{ id: number }>`SELECT id FROM res_currency WHERE name = 'BDT'`,
)) as { id: number }[];
const vat = (
  await as(
    'dina',
    'GET',
    `/api/v1/models/account.tax?fields=id&filter=${encodeURIComponent(JSON.stringify({ use: 'sale', name: 'VAT 15%' }))}&limit=1`,
  )
)['items'] as { id: number }[];
const partners = (await as('dina', 'POST', '/api/v1/models/res.partner', {
  name: 'Bengal Steel',
  isCompany: true,
  isCustomer: true,
  isVendor: true,
  city: 'Chattogram',
})) as { id: number };
await as('dina', 'POST', '/api/v1/models/res.partner', {
  name: 'Acme Trading',
  isCompany: true,
  isCustomer: true,
  city: 'Dhaka',
});
const beam = (await as('dina', 'POST', '/api/v1/models/product.product', {
  name: 'Steel beam',
  listPrice: '1000',
  standardPrice: '700',
  taxes: { set: vat[0] === undefined ? [] : [vat[0].id] },
})) as { id: number };
const order = (await as('rahim', 'POST', '/api/v1/models/sale.order', {
  partner: partners.id,
  currency: bdt?.id,
  lines: {
    create: [
      {
        product: beam.id,
        name: 'Steel beam',
        quantity: '2',
        priceUnit: '1000',
        taxes: { set: vat[0] === undefined ? [] : [vat[0].id] },
      },
    ],
  },
})) as { id: number };
await as('rahim', 'POST', `/api/v1/models/sale.order/${order.id}/transitions/confirm`);
// A posted invoice, unpaid, due in 30 days: Register payment, aging and reconciliation have something to show.
const journals = (await as('dina', 'GET', '/api/v1/models/account.journal?fields=id,code'))[
  'items'
] as {
  id: number;
  code: string;
}[];
const inv = journals.find((j) => j.code === 'INV') as { id: number };
const invoice = (await as('rahim', 'POST', '/api/v1/models/account.move', {
  kind: 'out_invoice',
  journal: inv.id,
  partner: partners.id,
  currency: bdt?.id,
  ref: 'Beams for the bridge',
  lines: {
    create: [
      {
        lineKind: 'product',
        product: beam.id,
        name: 'Steel beam',
        quantity: '5',
        priceUnit: '1000',
        taxes: { set: vat[0] === undefined ? [] : [vat[0].id] },
      },
    ],
  },
})) as { id: number };
await as('rahim', 'POST', `/api/v1/models/account.move/${invoice.id}/transitions/post`);

await startAppHost(host, {
  port: PORT,
  host: '127.0.0.1',
  onShutdown: async () => {
    await container.stop();
  },
});
process.stdout.write(`Kosh e2e apps API on http://127.0.0.1:${PORT}\n`);
