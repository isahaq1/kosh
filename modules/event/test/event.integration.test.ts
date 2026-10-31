/**
 * Event Hub on real PostgreSQL through the HTTP API (RFC 0021): registrations are confirmed only while the event is
 * open, the ticket on sale and a seat left (the event's and the ticket's); a full event offers its waiting list, and a
 * freed seat goes to the first waiting; check-in by code, once, for confirmed registrations; sessions within their
 * event; access; the demo.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contacts } from '@kosh/contacts';
import { messaging } from '@kosh/messaging';
import {
  type AppHost,
  applyApps,
  base,
  createAppHost,
  installBase,
  installDemo,
  prepareApps,
  recordInstalledApps,
} from '@kosh/server';
import { type Driver, orm, pg } from '@kosh/server/orm';
import { settings } from '@kosh/settings';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { event } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [base, settings, contacts, messaging, event];
const E = '/api/v1/models/event.event';
const R = '/api/v1/models/event.registration';

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let host: AppHost;
let company: number;
const ids: Record<string, number> = {};
const tokens = new Map<string, string>();

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function call(
  method: 'GET' | 'POST' | 'PATCH',
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
const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const register = async (name: string, ticket: string) => {
  const made = await call('POST', R, 'rahim', { event: ids['event'], ticket: ids[ticket], name });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  return made.json.id as number;
};
const run = (id: number, transition: string) =>
  call('POST', `${R}/${id}/transitions/${transition}`, 'rahim');
const state = async (id: number) => (await call('GET', `${R}/${id}`, 'rahim')).json.state;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-event-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({ driver, catalogue, change: { install: ['settings', 'event'] }, dir }),
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
  for (const [login, groups] of [
    ['maria', ['event.manager']],
    ['rahim', ['event.user']],
    ['bob', ['base.user']],
  ] as const)
    await auth.createUser({
      login,
      name: login,
      password: PASSWORD,
      company,
      companies: [company],
      groups: [...groups],
    });
  const made = await call('POST', E, 'maria', {
    name: 'Supplier day',
    dateBegin: `${day(30)}T03:00:00Z`,
    dateEnd: `${day(30)}T11:00:00Z`,
    seatsMax: 3,
    tickets: {
      create: [
        { name: 'Standard', price: '1500' },
        { name: 'VIP', price: '5000', seatsMax: 1 },
        { name: 'Early bird', price: '900', saleEnd: day(-1) },
      ],
    },
  });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  ids['event'] = made.json.id;
  const tickets = (
    await call(
      'GET',
      `/api/v1/models/event.ticket?filter=${encodeURIComponent(JSON.stringify({ event: ids['event'] }))}&fields=name`,
      'maria',
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

test('seats: the event open, the ticket on sale, the event’s and the ticket’s seats; the waiting list moves up', async () => {
  const early = await register('Too early', 'Standard');
  expect((await run(early, 'confirm')).status).toBe(409); // not open yet
  expect((await call('POST', `${E}/${ids['event']}/transitions/publish`, 'maria')).status).toBe(
    200,
  );

  const nusrat = await register('Nusrat', 'Standard');
  expect((await run(nusrat, 'confirm')).status).toBe(200);
  expect((await call('GET', `${R}/${nusrat}`, 'rahim')).json.price).toBe('1500');
  const vip = await register('Arif', 'VIP');
  expect((await run(vip, 'confirm')).status).toBe(200);
  const vip2 = await register('Second VIP', 'VIP');
  expect((await run(vip2, 'confirm')).status).toBe(409); // the VIP seat is taken
  const bird = await register('Late bird', 'Early bird');
  expect((await run(bird, 'confirm')).status).toBe(409); // no longer sold
  const tania = await register('Tania', 'Standard');
  expect((await run(tania, 'confirm')).status).toBe(200); // 3 of 3
  const kamal = await register('Kamal', 'Standard');
  expect((await run(kamal, 'confirm')).status).toBe(409); // full
  expect((await run(kamal, 'wait')).status).toBe(200);
  const sumi = await register('Sumi', 'Standard');
  await run(sumi, 'wait');
  const full = (await call('GET', `${E}/${ids['event']}`, 'rahim')).json;
  expect(full).toMatchObject({ seatsTaken: 3, seatsAvailable: 0 });

  expect((await run(nusrat, 'cancel')).status).toBe(200);
  expect(await state(kamal)).toBe('confirmed'); // the first waiting
  expect(await state(sumi)).toBe('waiting');
  ids['arif'] = vip;
  ids['sumi'] = sumi;
});

test('check-in by code, once, for confirmed registrations', async () => {
  const { code, name } = (await call('GET', `${R}/${ids['arif']}`, 'rahim')).json;
  const checkin = (c: string) => call('POST', '/api/v1/eventhub/checkin', 'rahim', { code: c });
  const first = await checkin(String(code).toLowerCase());
  expect(first.status, JSON.stringify(first.json)).toBe(200);
  expect(first.json).toMatchObject({ name, event: 'Supplier day', ticket: 'VIP' });
  const again = await checkin(code);
  expect(again.status).toBe(409);
  expect(JSON.stringify(again.json)).toContain('was checked in at');
  const waiting = (await call('GET', `${R}/${ids['sumi']}`, 'rahim')).json.code;
  expect((await checkin(waiting)).status).toBe(409);
  expect((await checkin('NOPE')).status).toBe(404);
  expect((await call('GET', `${E}/${ids['event']}`, 'rahim')).json.attended).toBe(1);
});

test('sessions happen during their event; access', async () => {
  const outside = await call('POST', '/api/v1/models/event.session', 'maria', {
    event: ids['event'],
    name: 'After party',
    dateBegin: `${day(31)}T10:00:00Z`,
    dateEnd: `${day(31)}T12:00:00Z`,
  });
  expect(outside.status).toBe(422);
  const inside = await call('POST', '/api/v1/models/event.session', 'maria', {
    event: ids['event'],
    name: 'Keynote',
    dateBegin: `${day(30)}T03:30:00Z`,
    dateEnd: `${day(30)}T04:30:00Z`,
  });
  expect(inside.status).toBe(201);
  expect(
    (await call('POST', '/api/v1/models/event.ticket', 'rahim', { event: ids['event'], name: 'X' }))
      .status,
  ).toBe(403);
  expect((await call('GET', R, 'bob')).status).toBe(403);
});

test('the demo data loads', async () => {
  const auth = host.server.auth;
  if (auth === undefined) throw new Error('base is installed');
  const summary = await installDemo({
    shutro: host.server.shutro,
    auth,
    driver,
    modules: host.server.registry.loaded.modules,
    company,
  });
  expect(JSON.stringify(summary)).toContain('Event Hub');
});
