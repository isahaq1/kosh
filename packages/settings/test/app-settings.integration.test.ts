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

test('step 2: history per setting; copy to another company previewed then made; export and import', async () => {
  // History of the company section: the change (7 → 14) and the reset (14 → 7), newest first, by Dana.
  const history = await call('GET', `${D}/demo/planning/history?key=demoDays`, 'bob');
  expect(history.status, JSON.stringify(history.json)).toBe(200);
  expect(history.json.events.length).toBeGreaterThanOrEqual(2);
  expect(history.json.events[0]).toMatchObject({
    how: 'changed',
    actor: { name: 'dana' },
    changes: [{ key: 'demoDays', label: 'Days ahead', from: 14, to: 7 }],
  });
  expect((await call('GET', `${D}/demo/planning/history`, 'eve')).status).toBe(404);

  // A second company: Dana sets 21 days here; the administrator copies the section to the new one.
  const [bdt] = await server.driver.query<{ id: number }>({
    text: 'SELECT id FROM res_currency ORDER BY id ASC LIMIT 1',
    params: [],
  });
  const second = await call('POST', '/api/v1/settings/companies', 'admin', {
    name: 'Meghna Mills',
    currency: bdt?.id,
  });
  expect(second.status, JSON.stringify(second.json)).toBe(201);
  const other = second.json.id ?? second.json.company?.id;
  expect(other).toBeTruthy();
  expect(
    (await call('PATCH', `${D}/demo/planning`, 'dana', { values: { demoDays: 21 } })).status,
  ).toBe(200);
  const companyOf = async (): Promise<number> =>
    (
      await server.driver.query<{ id: number }>({
        text: 'SELECT id FROM res_company ORDER BY id ASC LIMIT 1',
        params: [],
      })
    )[0]?.id as number;
  const first = await companyOf();
  expect(
    (await call('POST', `${D}/copy`, 'dana', { from: first, to: other, preview: true })).status,
  ).toBe(403);
  const previewed = await call('POST', `${D}/copy`, 'admin', {
    from: first,
    to: other,
    preview: true,
  });
  expect(previewed.status, JSON.stringify(previewed.json)).toBe(200);
  expect(previewed.json).toMatchObject({
    preview: true,
    from: { id: first, name: 'Padma Traders' },
    to: { id: other, name: 'Meghna Mills' },
    sections: [
      {
        app: 'demo',
        section: 'planning',
        changes: [{ key: 'demoDays', from: 7, to: 21 }],
      },
    ],
  });
  const [untouched] = await server.driver.query<{ days: number }>({
    text: 'SELECT demo_days AS days FROM res_company WHERE id = $1',
    params: [other],
  });
  expect(untouched?.days).toBe(7);
  const copied = await call('POST', `${D}/copy`, 'admin', { from: first, to: other });
  expect(copied.status, JSON.stringify(copied.json)).toBe(200);
  const [now] = await server.driver.query<{ days: number }>({
    text: 'SELECT demo_days AS days FROM res_company WHERE id = $1',
    params: [other],
  });
  expect(now?.days).toBe(21);
  const [copyEvent] = await server.driver.query<{ details: Json; company: number }>({
    text: "SELECT details, company_id AS company FROM audit_event WHERE kind = 'settings.changed' ORDER BY id DESC LIMIT 1",
    params: [],
  });
  expect(copyEvent?.company).toBe(other);
  expect(copyEvent?.details).toMatchObject({
    copiedFrom: first,
    changes: { demoDays: { from: 7, to: 21 } },
  });
  // Nothing left to copy.
  expect(
    (await call('POST', `${D}/copy`, 'admin', { from: first, to: other })).json.sections,
  ).toEqual([]);

  // Export: the installation's and the company's settings; import: checked, previewed, applied, the unknown skipped.
  expect((await call('GET', `${D}/export`, 'dana')).status).toBe(403);
  const exported = await call('GET', `${D}/export`, 'admin');
  expect(exported.status, JSON.stringify(exported.json)).toBe(200);
  expect(exported.json).toMatchObject({
    kosh: 'app-settings',
    version: 1,
    company: { id: first },
    installation: { 'demo.display': { mode: 'a', banner: null } },
    companySettings: { 'demo.planning': { demoDays: 21 } },
  });
  const file = {
    ...exported.json,
    installation: {
      'demo.display': { mode: 'b', banner: 'Imported', nope: 1 },
      'gone.section': {},
    },
    companySettings: { 'demo.planning': { demoDays: 9 } },
  };
  expect((await call('POST', `${D}/import`, 'admin', { file: { hello: 1 } })).status).toBe(422);
  expect(
    (
      await call('POST', `${D}/import`, 'admin', {
        file: { ...file, companySettings: { 'demo.planning': { demoDays: 99 } } },
        preview: true,
      })
    ).status,
  ).toBe(422);
  const dry = await call('POST', `${D}/import`, 'admin', { file, preview: true });
  expect(dry.status, JSON.stringify(dry.json)).toBe(200);
  expect(dry.json.skipped).toEqual(['demo.display.nope', 'gone.section']);
  expect(
    dry.json.sections.map((x: Json) => [x.section, x.changes.map((c: Json) => c.key)]),
  ).toEqual([
    ['display', ['mode', 'banner']],
    ['planning', ['demoDays']],
  ]);
  expect((await call('GET', `${D}/demo`, 'admin')).json.sections[0].settings[0].value).toBe(21);
  const done = await call('POST', `${D}/import`, 'admin', { file });
  expect(done.status, JSON.stringify(done.json)).toBe(200);
  const after = (await call('GET', `${D}/demo`, 'admin')).json;
  expect(after.sections.find((x: Json) => x.key === 'planning').settings[0].value).toBe(9);
  expect(
    after.sections.find((x: Json) => x.key === 'display').settings.map((x: Json) => x.value),
  ).toEqual(['b', 'Imported']);
  const imported = await call('GET', `${D}/demo/planning/history`, 'admin');
  expect(imported.json.events[0]).toMatchObject({
    how: 'imported',
    changes: [{ from: 21, to: 9 }],
  });
});

test('a wrong declaration stops the server', async () => {
  const wrong = demo({
    sections: [{ key: 'bad', label: 'Bad', scope: 'company', fields: [{ key: 'noSuchField' }] }],
  });
  await expect(
    createServer(options(container.getConnectionUri(), [base, settings, wrong])),
  ).rejects.toThrow(/noSuchField/);
});
