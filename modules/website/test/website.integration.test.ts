/**
 * Sites on real PostgreSQL (RFC 0021): the public API shows published pages only, with their blocks, forms and
 * translations, without a sign-in; a submission becomes a contact with every value checked, a bot's (the honeypot)
 * is kept as spam and creates nothing; forms create only what the allow-list allows and fill plain fields only; the
 * preview escapes what editors type; access by level.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contacts } from '@kosh/contacts';
import { messaging } from '@kosh/messaging';
import { permissions } from '@kosh/permissions';
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
import { HONEYPOT, websiteModule } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [base, settings, contacts, messaging, permissions, websiteModule({ cacheMs: 0 })];
const PUBLIC = '/api/v1/public/sites/padma';

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let host: AppHost;
const tokens = new Map<string, string>();
const ids: Record<string, number> = {};

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function call(
  login: string | null,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  payload?: unknown,
): Promise<{ status: number; json: Json; headers: Record<string, unknown> }> {
  let token = login === null ? undefined : tokens.get(login);
  if (login !== null && token === undefined) {
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
    ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return {
    status: res.statusCode,
    json: res.body === '' ? null : res.json(),
    headers: res.headers as Record<string, unknown>,
  };
}
const made = async (login: string, model: string, values: unknown): Promise<number> => {
  const res = await call(login, 'POST', `/api/v1/models/${model}`, values);
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return res.json.id as number;
};
const contactsNamed = async (name: string): Promise<Json[]> =>
  (
    await call(
      'maria',
      'GET',
      `/api/v1/models/res.partner?filter=${encodeURIComponent(JSON.stringify({ name }))}&fields=name,email,phone,notes`,
    )
  ).json.items;

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-website-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({
      driver,
      catalogue,
      change: { install: ['settings', 'contacts', 'website'] },
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
  const { company } = await installBase(host.server.shutro, auth, {
    company: { name: 'Padma Traders', currency: 'BDT' },
    admin: { login: 'admin', name: 'Administrator', password: PASSWORD },
  });
  await installDefaults(host.server.shutro, host.server.registry.loaded.modules, { company });
  const user = (login: string, name: string, groups: string[]) =>
    auth.createUser({ login, name, password: PASSWORD, company, companies: [company], groups });
  await user('maria', 'Maria', ['website.manager', 'contacts.manager']);
  await user('ed', 'Ed', ['website.editor']);
  await user('sam', 'Sam', ['contacts.user']);

  ids['site'] = await made('maria', 'website.site', {
    name: 'Padma Traders',
    key: 'padma',
    lang: 'en',
  });
  ids['form'] = await made('maria', 'website.form', {
    name: 'Contact us',
    key: 'contact',
    target: 'res.partner',
    successMessage: 'Thank you, we will call you.',
    fields: {
      create: [
        { name: 'name', label: 'Your name', kind: 'text', required: true, targetField: 'name' },
        { name: 'email', label: 'Email', kind: 'email', required: true, targetField: 'email' },
        { name: 'phone', label: 'Phone', kind: 'phone', targetField: 'phone' },
        { name: 'message', label: 'Message', kind: 'textarea', targetField: 'notes' },
      ],
    },
  });
  ids['home'] = await made('ed', 'website.page', {
    site: ids['site'],
    path: '/',
    title: 'Padma Traders',
    description: 'Wholesale staples.',
    blocks: {
      create: [
        {
          sequence: 1,
          kind: 'hero',
          title: 'Staples, on time',
          buttonLabel: 'Talk to us',
          buttonUrl: '/contact',
        },
        { sequence: 2, kind: 'form', title: 'Ask for prices', form: ids['form'] },
      ],
    },
  });
  ids['bn'] = await made('ed', 'website.page', {
    site: ids['site'],
    path: '/',
    lang: 'bn',
    title: 'পদ্মা ট্রেডার্স',
    translationOf: ids['home'],
  });
  ids['draft'] = await made('ed', 'website.page', {
    site: ids['site'],
    path: '/soon',
    title: 'Coming soon',
  });
  for (const page of [ids['home'], ids['bn']])
    expect(
      (await call('ed', 'POST', `/api/v1/models/website.page/${page}/transitions/publish`)).status,
    ).toBe(200);
}, 240_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('the public site: its menu and a published page with blocks, the form and translations; no sign-in', async () => {
  const site = await call(null, 'GET', PUBLIC);
  expect(site.status, JSON.stringify(site.json)).toBe(200);
  expect(site.json.site).toMatchObject({ key: 'padma', name: 'Padma Traders', lang: 'en' });
  expect(site.json.menu).toEqual([{ path: '/', title: 'Padma Traders' }]);
  expect(site.headers['cache-control']).toBe('public, max-age=0');

  const home = await call(null, 'GET', `${PUBLIC}/page?path=/`);
  expect(home.status, JSON.stringify(home.json)).toBe(200);
  expect(home.json.page).toMatchObject({
    path: '/',
    lang: 'en',
    title: 'Padma Traders',
    description: 'Wholesale staples.',
    translations: [{ lang: 'bn', path: '/' }],
  });
  expect(home.json.page.publishedAt).toBeTruthy();
  const [hero, formBlock] = home.json.page.blocks;
  expect(hero).toMatchObject({ kind: 'hero', buttonUrl: '/contact' });
  expect(formBlock.form).toMatchObject({
    key: 'contact',
    honeypot: HONEYPOT,
    successMessage: 'Thank you, we will call you.',
  });
  expect(formBlock.form.fields.map((x: Json) => x.name)).toEqual([
    'name',
    'email',
    'phone',
    'message',
  ]);

  const bn = await call(null, 'GET', `${PUBLIC}/page?path=/&lang=bn`);
  expect(bn.json.page).toMatchObject({ lang: 'bn', title: 'পদ্মা ট্রেডার্স' });
  expect(bn.json.page.translations).toEqual([{ lang: 'en', path: '/' }]);

  expect((await call(null, 'GET', `${PUBLIC}/page?path=/soon`)).status).toBe(404);
  expect((await call(null, 'GET', '/api/v1/public/sites/nowhere')).status).toBe(404);
  // The back-office API still needs a sign-in.
  expect((await call(null, 'GET', '/api/v1/models/website.page')).status).toBe(401);
});

test('a submission becomes a contact; values checked; the outbox told', async () => {
  const sent = await call(null, 'POST', `${PUBLIC}/forms/contact`, {
    name: 'Rafiq Islam',
    email: 'Rafiq@Example.test',
    phone: '+880 1711 000000',
    message: 'Price list for rice, please.',
    extra: 'ignored',
  });
  expect(sent.status, JSON.stringify(sent.json)).toBe(201);
  expect(sent.json).toEqual({ message: 'Thank you, we will call you.' });
  const [rafiq] = await contactsNamed('Rafiq Islam');
  expect(rafiq).toMatchObject({
    email: 'rafiq@example.test',
    phone: '+880 1711 000000',
    notes: 'Price list for rice, please.',
  });
  const subs = (
    await call(
      'ed',
      'GET',
      `/api/v1/models/website.submission?filter=${encodeURIComponent(JSON.stringify({ resId: rafiq.id }))}&fields=state,resModel,resName,data`,
    )
  ).json.items;
  expect(subs).toHaveLength(1);
  expect(subs[0]).toMatchObject({
    state: 'received',
    resModel: 'res.partner',
    resName: 'Rafiq Islam',
  });
  expect(subs[0].data).not.toHaveProperty('extra');

  const missing = await call(null, 'POST', `${PUBLIC}/forms/contact`, { name: 'No Email' });
  expect(missing.status).toBe(422);
  expect(missing.json.detail).toContain('Email is required');
  const bad = await call(null, 'POST', `${PUBLIC}/forms/contact`, {
    name: 'X',
    email: 'not-an-email',
  });
  expect(bad.status).toBe(422);
  const long = await call(null, 'POST', `${PUBLIC}/forms/contact`, {
    name: 'x'.repeat(201),
    email: 'a@b.test',
  });
  expect(long.status).toBe(422);
  expect(await contactsNamed('No Email')).toEqual([]);
  expect((await call(null, 'POST', `${PUBLIC}/forms/nothing`, { name: 'x' })).status).toBe(404);
});

test('a bot fills the honeypot: told it went through, kept as spam, nothing created', async () => {
  const sent = await call(null, 'POST', `${PUBLIC}/forms/contact`, {
    name: 'Cheap Pills',
    email: 'bot@spam.test',
    [HONEYPOT]: 'http://spam.test',
  });
  expect(sent.status).toBe(201);
  expect(await contactsNamed('Cheap Pills')).toEqual([]);
  const spam = (
    await call(
      'ed',
      'GET',
      `/api/v1/models/website.submission?filter=${encodeURIComponent(JSON.stringify({ state: 'spam' }))}&fields=state,resId`,
    )
  ).json.items;
  expect(spam).toHaveLength(1);
  expect(spam[0].resId).toBeNull();
});

test('forms create only what the allow-list allows, and fill plain fields only', async () => {
  const users = await call('maria', 'POST', '/api/v1/models/website.form', {
    name: 'Sign up',
    key: 'signup',
    target: 'res.users',
  });
  expect(users.status).toBe(422);
  await made('maria', 'website.form', {
    name: 'Odd',
    key: 'odd',
    target: 'res.partner',
    fields: {
      create: [
        { name: 'name', label: 'Name', kind: 'text', required: true, targetField: 'name' },
        { name: 'active', label: 'Active', kind: 'text', targetField: 'active' },
      ],
    },
  });
  const odd = await call(null, 'POST', `${PUBLIC}/forms/odd`, { name: 'Somebody', active: 'no' });
  expect(odd.status).toBe(409);
  expect(await contactsNamed('Somebody')).toEqual([]);
});

test('the preview escapes what editors type; links only to the site or http(s); access by level', async () => {
  const page = await made('ed', 'website.page', {
    site: ids['site'],
    path: '/tricky',
    title: 'Tricky',
    blocks: { create: [{ kind: 'text', title: '<script>alert(1)</script>', body: 'a & b' }] },
  });
  const preview = await call('ed', 'GET', `/api/v1/sites/pages/${page}/preview`);
  expect(preview.status, JSON.stringify(preview.json)).toBe(200);
  expect(preview.json.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  expect(preview.json.html).not.toContain('<script>');
  expect(preview.json.html).toContain('a &amp; b');

  const js = await call('ed', 'POST', '/api/v1/models/website.page', {
    site: ids['site'],
    path: '/js',
    title: 'JS',
    blocks: { create: [{ kind: 'cta', buttonLabel: 'Go', buttonUrl: 'javascript:alert(1)' }] },
  });
  expect(js.status).toBe(422);
  expect(
    (
      await call('ed', 'POST', '/api/v1/models/website.page', {
        site: ids['site'],
        path: 'no-slash',
        title: 'X',
      })
    ).status,
  ).toBe(422);
  expect(
    (
      await call('ed', 'POST', '/api/v1/models/website.page', {
        site: ids['site'],
        path: '/',
        title: 'Again',
      })
    ).status,
  ).toBe(422);

  // Editors edit pages, not sites or forms; others see nothing of Sites.
  expect(
    (await call('ed', 'POST', '/api/v1/models/website.site', { name: 'Mine', key: 'mine' })).status,
  ).toBe(403);
  expect(
    (await call('ed', 'POST', '/api/v1/models/website.form', { name: 'F', key: 'f' })).status,
  ).toBe(403);
  expect((await call('sam', 'GET', '/api/v1/models/website.page')).status).toBe(403);
  expect((await call('sam', 'GET', `/api/v1/sites/pages/${page}/preview`)).status).toBe(403);
});

test('the Sites overview (RFC 0022 step 2) is served to an editor', async () => {
  const overview = await call('ed', 'GET', '/api/v1/reports/overview?app=sites');
  expect(overview.status, JSON.stringify(overview.json)).toBe(200);
  expect(overview.json.cards.map((c: { id: string }) => c.id)).toContain('submissions_month');
});
