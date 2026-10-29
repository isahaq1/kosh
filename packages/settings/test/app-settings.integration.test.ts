/**
 * App settings on real PostgreSQL (RFC 0020): a test app declares a company section (a `res.company` field it adds:
 * type, label and default from Shutro) and an installation section (key / values). Those with the app's access see
 * them; its editors change them — checked against the declaration, only what changed, audited with old and new
 * values — and reset them to the defaults; others are refused. A wrong declaration stops the server.
 */
import {
  defineModule as defineKoshModule,
  type KoshModule,
  type SettingsSpec,
} from '@kosh/modules-sdk';
import { base, baseShutro, createServer, installBase, type KoshServer, totp } from '@kosh/server';
import { extendModel, f, orm } from '@kosh/server/orm';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { settings } from '../src/index.js';

const PASSWORD = 'correct horse battery';
let container: StartedPostgreSqlContainer;
let server: KoshServer;
const tokens = new Map<string, string>();

const DemoCompany = extendModel('res.company', {
  fields: { demoDays: f.integer({ default: 7, label: 'Days ahead' }) },
});
const SETTINGS: SettingsSpec = {
  sections: [
    {
      key: 'planning',
      label: 'Planning',
      scope: 'company',
      editors: ['demo.manager'],
      fields: [{ key: 'demoDays', min: 1, max: 30, help: 'How far ahead.' }],
    },
    {
      key: 'display',
      label: 'Display',
      scope: 'installation',
      fields: [
        {
          key: 'mode',
          type: 'selection',
          label: 'Mode',
          options: { a: 'A', b: 'B' },
          default: 'a',
        },
        { key: 'banner', type: 'char', label: 'Banner', visibleWhen: { key: 'mode', equals: 'b' } },
      ],
    },
  ],
};
const demo = (spec: SettingsSpec): KoshModule =>
  defineKoshModule({
    shutro: orm.defineModule({
      name: 'demo',
      version: '0.1.0',
      depends: [baseShutro],
      groups: [
        orm.defineGroup({ code: 'demo.user', label: 'Demo user', implies: ['base.user'] }),
        orm.defineGroup({ code: 'demo.manager', label: 'Demo manager', implies: ['demo.user'] }),
      ],
      models: [],
      extensions: [DemoCompany],
    }),
    kosh: '^0.1.0',
    depends: [base],
    app: { code: 'demo', label: 'Demo', icon: 'box', sequence: 5, category: 'Test' },
    accessLevels: {
      user: { label: 'User', groups: ['demo.user'] },
      manager: { label: 'Manager', groups: ['demo.manager'], implies: ['user'] },
    },
    settings: spec,
  });

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function call(method: 'GET' | 'PATCH' | 'POST', url: string, as: string, payload?: unknown) {
  let token = tokens.get(as);
  if (token === undefined) {
    const login = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { login: as, password: PASSWORD },
    });
    token = (login.json() as { token: string }).token;
    if (as === 'admin') {
      const headers = { authorization: `Bearer ${token}` };
      const setup = await server.app.inject({
        method: 'POST',
        url: '/api/v1/auth/2fa/setup',
        headers,
      });
      await server.app.inject({
        method: 'POST',
        url: '/api/v1/auth/2fa/enable',
        headers,
        payload: { code: totp((setup.json() as { secret: string }).secret) },
      });
    }
    tokens.set(as, token);
  }
  const res = await server.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: res.statusCode, json: (res.body === '' ? null : res.json()) as Json };
}
const options = (databaseUrl: string, modules: readonly KoshModule[]) => ({
  databaseUrl,
  modules,
  auth: { secureCookies: false, cacheMs: 0, loginLimit: 0 },
  rateLimit: { max: 0, timeWindow: '1 minute' },
  logger: false as const,
});

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18').start();
  server = await createServer(
    options(container.getConnectionUri(), [base, settings, demo(SETTINGS)]),
  );
  for (const statement of orm.createTableStatements(server.registry.registry))
    await server.driver.query(statement);
  const auth = server.auth;
  if (auth === undefined) throw new Error('base is installed');
  const { company } = await installBase(server.shutro, auth, {
    company: { name: 'Padma Traders', currency: 'BDT' },
    admin: { login: 'admin', name: 'Administrator', password: PASSWORD },
  });
  for (const [login, groups] of [
    ['dana', ['demo.manager']],
    ['bob', ['demo.user']],
    ['eve', ['base.user']],
  ] as const)
    await auth.createUser({
      login,
      name: login,
      password: PASSWORD,
      company,
      companies: [company],
      groups: [...groups],
    });
}, 180_000);

afterAll(async () => {
  await server?.close();
  await container?.stop();
});

const D = '/api/v1/settings/app-settings';

test('seen by those who open the app, with the declared and the field’s metadata', async () => {
  expect((await call('GET', D, 'dana')).json.apps).toEqual([
    expect.objectContaining({ app: 'demo', label: 'Demo', sections: expect.any(Array) }),
  ]);
  expect((await call('GET', D, 'eve')).json.apps).toEqual([]);
  expect((await call('GET', `${D}/demo`, 'eve')).status).toBe(404);

  const page = (await call('GET', `${D}/demo`, 'bob')).json;
  const planning = page.sections.find((s: Json) => s.key === 'planning');
  expect(planning).toMatchObject({ scope: 'company', editable: false });
  expect(planning.settings[0]).toMatchObject({
    key: 'demoDays',
    type: 'integer',
    label: 'Days ahead',
    default: 7,
    value: 7,
    changed: false,
    help: 'How far ahead.',
  });
  const display = page.sections.find((s: Json) => s.key === 'display');
  expect(display.settings[0]).toMatchObject({
    key: 'mode',
    value: 'a',
    options: [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' },
    ],
  });
  expect(display.settings[1].visibleWhen).toEqual({ key: 'mode', equals: 'b' });
});

test('editors change them, checked and audited; others refused; reset to the defaults', async () => {
  const changed = await call('PATCH', `${D}/demo/planning`, 'dana', { values: { demoDays: 14 } });
  expect(changed.status, JSON.stringify(changed.json)).toBe(200);
  expect(changed.json.settings[0]).toMatchObject({ value: 14, changed: true });
  const [row] = await server.driver.query<{ days: number }>({
    text: 'SELECT demo_days AS days FROM res_company LIMIT 1',
    params: [],
  });
  expect(row?.days).toBe(14);

  for (const values of [{ demoDays: 0 }, { demoDays: 31 }, { demoDays: 'x' }, { other: 1 }])
    expect((await call('PATCH', `${D}/demo/planning`, 'dana', { values })).status).toBe(422);
  expect(
    (await call('PATCH', `${D}/demo/planning`, 'bob', { values: { demoDays: 3 } })).status,
  ).toBe(403);
  // Installation settings: administrators only (no editors declared).
  expect((await call('PATCH', `${D}/demo/display`, 'dana', { values: { mode: 'b' } })).status).toBe(
    403,
  );
  const display = await call('PATCH', `${D}/demo/display`, 'admin', {
    values: { mode: 'b', banner: 'Hello' },
  });
  expect(display.status, JSON.stringify(display.json)).toBe(200);
  expect(display.json.settings.map((s: Json) => [s.key, s.value, s.changed])).toEqual([
    ['mode', 'b', true],
    ['banner', 'Hello', true],
  ]);
  expect(
    (await call('PATCH', `${D}/demo/display`, 'admin', { values: { mode: 'c' } })).status,
  ).toBe(422);

  const [event] = await server.driver.query<{ details: Json }>({
    text: "SELECT details FROM audit_event WHERE kind = 'settings.changed' ORDER BY id ASC LIMIT 1",
    params: [],
  });
  expect(event?.details).toMatchObject({
    app: 'demo',
    section: 'planning',
    changes: { demoDays: { from: 7, to: 14 } },
  });

  const reset = await call('POST', `${D}/demo/planning/reset`, 'dana', { keys: ['demoDays'] });
  expect(reset.json.settings[0]).toMatchObject({ value: 7, changed: false });
  const resetAll = await call('POST', `${D}/demo/display/reset`, 'admin', {});
  expect(resetAll.json.settings.map((s: Json) => s.value)).toEqual(['a', null]);
});

test('a wrong declaration stops the server', async () => {
  const wrong = demo({
    sections: [{ key: 'bad', label: 'Bad', scope: 'company', fields: [{ key: 'noSuchField' }] }],
  });
  await expect(
    createServer(options(container.getConnectionUri(), [base, settings, wrong])),
  ).rejects.toThrow(/noSuchField/);
});
