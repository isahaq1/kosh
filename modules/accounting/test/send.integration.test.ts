/**
 * Invoices emailed by themselves (RFC 0029 §3.3) on real PostgreSQL: a customer who asked for invoices by email gets
 * each posted invoice with its PDF, once, as the user who posted it; other customers get nothing.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryMailer, mailModule } from '@kosh/mail';
import { reporting } from '@kosh/reporting';
import {
  type AppHost,
  applyApps,
  base,
  createAppHost,
  installBase,
  installDefaults,
  prepareApps,
  recordInstalledApps,
} from '@kosh/server';
import { type Driver, orm, pg } from '@kosh/server/orm';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { accounting } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const mailer = createMemoryMailer();
const catalogue = [base, mailModule({ mailer, workers: true }), reporting, accounting];

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let files: string;
let host: AppHost;
let company: number;
let bdt: number;
let wanting: number;
let other: number;
const journals: Record<string, number> = {};
const tokens = new Map<string, string>();

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function call(
  method: 'GET' | 'POST',
  url: string,
  as: string,
  payload?: unknown,
): Promise<{ status: number; json: Json }> {
  let token = tokens.get(as);
  if (token === undefined) {
    const login = await host.server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { login: as, password: PASSWORD },
    });
    token = (login.json() as { token: string }).token;
    tokens.set(as, token);
  }
  const res = await host.server.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: res.statusCode, json: res.body === '' ? null : res.json() };
}
const expectStatus = (r: { status: number; json: Json }, status: number) =>
  expect(r.status, JSON.stringify(r.json)).toBe(status);
const today = new Date().toISOString().slice(0, 10);

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-invoice-mail-'));
  files = await mkdtemp(join(tmpdir(), 'kosh-invoice-mail-files-'));
  process.env['KOSH_STORAGE_DIR'] = files;
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({
      driver,
      catalogue,
      change: { install: ['mail', 'reporting', 'accounting'] },
      dir,
    }),
    { driver, dir, actor: 'test' },
  );
  host = await createAppHost({
    databaseUrl: container.getConnectionUri(),
    catalogue,
    migrationsDir: dir,
    logger: false,
    listen: false,
    auth: { secureCookies: false, cacheMs: 0, loginLimit: 0 },
    rateLimit: { max: 0, timeWindow: '1 minute' },
  });
  const auth = host.server.auth;
  if (auth === undefined) throw new Error('base is installed');
  ({ company } = await installBase(host.server.shutro, auth, {
    company: { name: 'Padma Traders', currency: 'BDT' },
    admin: { login: 'admin', name: 'Administrator', password: PASSWORD },
  }));
  await installDefaults(host.server.shutro, host.server.registry.loaded.modules, { company });
  for (const [login, groups] of [
    ['maria', ['account.manager']],
    ['rahim', ['account.user', 'reporting.user']],
  ] as const)
    await auth.createUser({
      login,
      name: login,
      password: PASSWORD,
      company,
      companies: [company],
      groups: [...groups],
    });
  expectStatus(
    await call('POST', '/api/v1/accounting/charts/install', 'maria', { template: 'generic' }),
    200,
  );
  const ids = await host.server.shutro.bootstrap({ reason: 'test: data', company }, async (env) => {
    const partners = env.model('res.partner' as never) as unknown as {
      create(rows: unknown[]): Promise<{ ids: number[] }>;
    };
    const [row] = await env.sql<{ id: number }>`SELECT id FROM res_currency WHERE name = 'BDT'`;
    const made = await partners.create([
      {
        name: 'Bengal Steel',
        isCompany: true,
        isCustomer: true,
        email: 'ap@bengal.test',
        sendInvoicesByEmail: true,
      },
      { name: 'Acme', isCompany: true, isCustomer: true, email: 'ap@acme.test' },
    ]);
    return { bdt: row?.id as number, wanting: made.ids[0] as number, other: made.ids[1] as number };
  });
  bdt = ids.bdt;
  wanting = ids.wanting;
  other = ids.other;
  const journalRows = await call('GET', '/api/v1/models/account.journal?fields=id,code', 'maria');
  for (const j of journalRows.json.items as { id: number; code: string }[]) journals[j.code] = j.id;
}, 180_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  delete process.env['KOSH_STORAGE_DIR'];
  await rm(dir, { recursive: true, force: true });
  await rm(files, { recursive: true, force: true });
});

/** A customer invoice of 500, posted by rahim. */
async function postInvoice(partner: number): Promise<number> {
  const created = await call('POST', '/api/v1/models/account.move', 'rahim', {
    kind: 'out_invoice',
    journal: journals['INV'],
    partner,
    currency: bdt,
    date: today,
    dateDue: today,
    lines: { create: [{ lineKind: 'product', name: 'Goods', quantity: '1', priceUnit: '500' }] },
  });
  expectStatus(created, 201);
  expectStatus(
    await call('POST', `/api/v1/models/account.move/${created.json.id}/transitions/post`, 'rahim'),
    200,
  );
  return created.json.id as number;
}

test('posted invoices: emailed with their PDF to the customer who asked, once; not to others', async () => {
  const sent = await postInvoice(wanting);
  await postInvoice(other);
  const deadline = Date.now() + 25_000;
  while (mailer.sent.length === 0 && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 200));
  await new Promise((r) => setTimeout(r, 3000));
  expect(mailer.sent).toHaveLength(1);
  const [email] = mailer.sent;
  const name = (await call('GET', `/api/v1/models/account.move/${sent}?fields=name`, 'rahim')).json
    .name as string;
  expect(email?.to).toBe('ap@bengal.test');
  expect(email?.subject).toContain(name);
  expect(email?.attachments?.[0]?.filename).toBe(`${name.replaceAll('/', '-')}.pdf`);
  // On the invoice's chatter, by the user who posted it.
  const chatter = await call('GET', `/api/v1/chatter/account.move/${sent}`, 'rahim');
  const messages = (chatter.json.items as Json[]).filter((i) => i.kind === 'comment');
  expect(messages).toHaveLength(1);
  expect(messages[0]?.author?.name).toBe('rahim');
}, 60_000);
