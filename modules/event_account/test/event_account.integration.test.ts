/**
 * The Event Hub ↔ Accounting bridge on real PostgreSQL (RFC 0021, Event Hub step 3): the two apps propose it; a
 * paid place gets a draft customer invoice for the event and ticket, its attendee becoming the customer (a new
 * contact, then the same one for the same email); a free place gets none.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accounting } from '@kosh/accounting';
import { contacts } from '@kosh/contacts';
import { event } from '@kosh/event';
import { messaging } from '@kosh/messaging';
import { planApps } from '@kosh/modules-sdk';
import { permissions } from '@kosh/permissions';
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
import { settings } from '@kosh/settings';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { eventAccount } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [
  base,
  settings,
  contacts,
  messaging,
  permissions,
  reporting,
  accounting,
  event,
  eventAccount,
];
const R = '/api/v1/models/event.registration';

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let host: AppHost;
let company: number;
const ids: Record<string, number> = {};
let token: string | undefined;

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function call(
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
): Promise<{ status: number; json: Json }> {
  if (token === undefined) {
    const login = await host.server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { login: 'maria', password: PASSWORD },
    });
    token = (login.json() as { token: string }).token;
  }
  const res = await host.server.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: res.statusCode, json: res.body === '' ? null : res.json() };
}
const place = async (name: string, ticket: string, email?: string): Promise<Json> => {
  const made = await call('POST', R, {
    event: ids['event'],
    ticket: ids[ticket],
    name,
    ...(email === undefined ? {} : { email }),
  });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  const confirmed = await call('POST', `${R}/${made.json.id}/transitions/confirm`);
  expect(confirmed.status, JSON.stringify(confirmed.json)).toBe(200);
  return (await call('GET', `${R}/${made.json.id}`)).json;
};

test('the plan proposes the bridge when Event Hub and Accounting come', () => {
  const plan = planApps(catalogue, [], { install: ['event', 'accounting'] });
  expect(plan.install.find((i) => i.name === 'event_account')).toEqual({
    name: 'event_account',
    reason: 'bridge',
  });
});

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-event-account-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({
      driver,
      catalogue,
      change: { install: ['settings', 'accounting', 'event'] },
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
  await auth.createUser({
    login: 'maria',
    name: 'Maria',
    password: PASSWORD,
    company,
    companies: [company],
    groups: ['account.manager', 'event.manager', 'contacts.manager'],
  });
  expect(
    (await call('POST', '/api/v1/accounting/charts/install', { template: 'generic' })).status,
  ).toBe(200);
  const made = await call('POST', '/api/v1/models/event.event', {
    name: 'Supplier day',
    dateBegin: '2099-03-01T03:00:00Z',
    dateEnd: '2099-03-01T11:00:00Z',
    tickets: {
      create: [
        { name: 'Standard', price: '1500' },
        { name: 'Guest', price: '0' },
      ],
    },
  });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  ids['event'] = made.json.id;
  await call('POST', `/api/v1/models/event.event/${ids['event']}/transitions/publish`);
  const tickets = (
    await call(
      'GET',
      `/api/v1/models/event.ticket?filter=${encodeURIComponent(JSON.stringify({ event: ids['event'] }))}&fields=name`,
    )
  ).json.items as Json[];
  for (const t of tickets) ids[t.name] = t.id;
}, 240_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('a paid place invoiced to its attendee; the same email, the same customer; a free place, no invoice', async () => {
  const first = await place('Nusrat Jahan', 'Standard', 'nusrat@example.test');
  expect(first.invoice).toBeTruthy();
  const invoiceId = first.invoice?.id ?? first.invoice;
  const invoice = (await call('GET', `/api/v1/models/account.move/${invoiceId}`)).json;
  expect(invoice).toMatchObject({
    kind: 'out_invoice',
    state: 'draft',
    invoiceOrigin: 'Supplier day',
  });
  expect(Number(invoice.amountTotal?.amount ?? invoice.amountTotal)).toBe(1500);
  const partner = first.partner?.id ?? first.partner;
  const contact = (await call('GET', `/api/v1/models/res.partner/${partner}`)).json;
  expect(contact).toMatchObject({ name: 'Nusrat Jahan', email: 'nusrat@example.test' });

  const second = await place('Nusrat (second ticket)', 'Standard', 'nusrat@example.test');
  expect(second.partner?.id ?? second.partner).toBe(partner);
  expect(second.invoice).toBeTruthy();

  const guest = await place('A guest', 'Guest');
  expect(guest.invoice).toBeNull();
});
