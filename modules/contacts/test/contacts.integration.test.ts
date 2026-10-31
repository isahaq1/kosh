/**
 * Contacts on real PostgreSQL (RFC 0022 step 2): tags kept by managers and read by users, set on contacts and
 * searched; coordinates for the map; the Overview served to a Contacts user; the action's views.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { messaging } from '@kosh/messaging';
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
import { storage } from '@kosh/storage';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { contacts } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [base, settings, storage, messaging, permissions, reporting, contacts];

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let host: AppHost;
let company: number;
const tokens = new Map<string, string>();

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function call(
  login: string,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  payload?: unknown,
): Promise<{ status: number; json: Json }> {
  let token = tokens.get(login);
  if (token === undefined) {
    const res = await host.server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { login, password: PASSWORD },
    });
    token = (res.json() as { token: string }).token;
    tokens.set(login, token);
  }
  const res = await host.server.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: res.statusCode, json: res.body === '' ? null : res.json() };
}

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-contacts-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({ driver, catalogue, change: { install: ['settings', 'contacts'] }, dir }),
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
    ['maria', ['contacts.manager']],
    ['sam', ['contacts.user']],
  ] as const)
    await auth.createUser({
      login,
      name: login,
      password: PASSWORD,
      company,
      companies: [company],
      groups: [...groups],
    });
}, 240_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('tags: managers make them, users read them; set on a contact and searched; one name once', async () => {
  const made = await call('maria', 'POST', '/api/v1/models/res.partner.tag', {
    name: 'Key account',
  });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  expect(
    (await call('sam', 'POST', '/api/v1/models/res.partner.tag', { name: 'Mine' })).status,
  ).toBe(403);
  expect(
    (await call('maria', 'POST', '/api/v1/models/res.partner.tag', { name: 'Key account' })).status,
  ).toBe(422);
  const contact = await call('sam', 'POST', '/api/v1/models/res.partner', {
    name: 'Bengal Steel',
    isCompany: true,
    tags: { set: [made.json.id] },
    latitude: '22.3569',
    longitude: '91.7832',
  });
  expect(contact.status, JSON.stringify(contact.json)).toBe(201);
  const tagged = await call(
    'sam',
    'GET',
    `/api/v1/models/res.partner?filter=${encodeURIComponent(JSON.stringify({ tags: { any: { name: 'Key account' } } }))}&fields=name,tags,latitude`,
  );
  expect(tagged.status, JSON.stringify(tagged.json)).toBe(200);
  expect(tagged.json.items.map((r: { name: string }) => r.name)).toEqual(['Bengal Steel']);
  expect(String(tagged.json.items[0].latitude?.amount ?? tagged.json.items[0].latitude)).toMatch(
    /^22\.3569/,
  );
});

test('the Overview and the views (RFC 0022 step 2): a user gets the cards; the action offers kanban and map', async () => {
  const overview = await call('sam', 'GET', '/api/v1/reports/overview?app=contacts');
  expect(overview.status, JSON.stringify(overview.json)).toBe(200);
  expect(overview.json.cards.map((c: { id: string }) => c.id)).toEqual([
    'contacts_all',
    'customers',
    'vendors',
    'new_month',
    'by_country',
    'by_city',
  ]);
  const action = await call('sam', 'GET', '/api/v1/actions/contacts.action_partners');
  expect(action.status).toBe(200);
  expect(action.json.spec.views).toEqual(['list', 'kanban', 'map', 'hierarchy', 'form']);
  const mapView = await call('sam', 'GET', '/api/v1/views?model=res.partner&type=map');
  expect(mapView.status, JSON.stringify(mapView.json)).toBe(200);
  expect(mapView.json.view).toMatchObject({ latitude: 'latitude', longitude: 'longitude' });
  // Tags are a manager's menu.
  const menus = await call('sam', 'GET', '/api/v1/menus?app=contacts');
  const ids = JSON.stringify(menus.json);
  expect(ids).not.toContain('contacts.tags');
  expect(JSON.stringify((await call('maria', 'GET', '/api/v1/menus?app=contacts')).json)).toContain(
    'contacts.tags',
  );
});
