/**
 * Documents on real PostgreSQL (RFC 0024 §2.8): a folder kept to its members is hidden from others, its documents too;
 * uploads and versions; one search over documents and the attachments of records the user may read; share links
 * that expire, need their password and serve only what they share; requests emailed with a link that takes the file
 * into the folder once, and reminded once when late; the demo data.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryMailer } from '@kosh/mail';
import {
  type AppHost,
  applyApps,
  base,
  createAppHost,
  installBase,
  installDefaults,
  installDemo,
  prepareApps,
  recordInstalledApps,
} from '@kosh/server';
import { type Driver, orm, pg } from '@kosh/server/orm';
import { settings } from '@kosh/settings';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { documentsModule, remindRequests } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const API = 'https://erp.test';
const mailer = createMemoryMailer();
const catalogue = [base, settings, documentsModule({ mailer, apiUrl: API })];
const D = '/api/v1/models/documents.document';

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let files: string;
let host: AppHost;
let company: number;
const ids: Record<string, number> = {};
const tokens = new Map<string, string>();

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
const tokenOf = async (as: string) => {
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
  return token;
};
async function call(method: 'GET' | 'POST' | 'PATCH', url: string, as: string, payload?: unknown) {
  const res = await host.server.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${await tokenOf(as)}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: res.statusCode, json: (res.body === '' ? null : res.json()) as Json };
}
async function upload(url: string, as: string | null, name: string, text: string) {
  const res = await host.server.app.inject({
    method: 'POST',
    url,
    headers: {
      ...(as === null ? {} : { authorization: `Bearer ${await tokenOf(as)}` }),
      'content-type': 'text/plain',
      'x-filename': encodeURIComponent(name),
    },
    payload: Buffer.from(text),
  });
  return { status: res.statusCode, json: (res.body === '' ? null : res.json()) as Json };
}

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  files = await mkdtemp(join(tmpdir(), 'kosh-documents-files-'));
  process.env['KOSH_STORAGE_DIR'] = files;
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-documents-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({ driver, catalogue, change: { install: ['settings', 'documents'] }, dir }),
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
    ['dina', ['documents.manager', 'contacts.manager']],
    ['rina', ['documents.user']],
    ['omar', ['documents.user']],
  ] as const)
    ids[login] = Number(
      await auth.createUser({
        login,
        name: login,
        password: PASSWORD,
        company,
        companies: [company],
        groups: [...groups],
      }),
    );
  ids['open'] = (
    await call('POST', '/api/v1/models/documents.folder', 'dina', { name: 'Contracts' })
  ).json.id;
  const hr = await call('POST', '/api/v1/models/documents.folder', 'dina', {
    name: 'HR',
    restricted: true,
    members: { set: [ids['rina']] },
  });
  expect(hr.status, JSON.stringify(hr.json)).toBe(201);
  ids['hr'] = hr.json.id;
}, 240_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
  await rm(files, { recursive: true, force: true });
  delete process.env['KOSH_STORAGE_DIR'];
});

test('a folder kept to its members: hidden from others, with its documents; uploads and versions', async () => {
  const names = async (as: string) =>
    (
      (await call('GET', '/api/v1/models/documents.folder?fields=name', as)).json.items as Json[]
    ).map((f) => f.name);
  expect((await names('rina')).sort()).toEqual(['Contracts', 'HR']);
  expect(await names('omar')).toEqual(['Contracts']);

  const made = await upload(
    `/api/v1/documents/upload?folder=${ids['hr']}`,
    'rina',
    'offer-letter.txt',
    'v1',
  );
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  ids['letter'] = made.json.id;
  expect((await call('GET', `${D}/${ids['letter']}`, 'omar')).status).toBe(403);
  expect(
    (await upload(`/api/v1/documents/${ids['letter']}/versions`, 'omar', 'x.txt', 'no')).status,
  ).toBe(404);
  const second = await upload(
    `/api/v1/documents/${ids['letter']}/versions`,
    'rina',
    'offer-letter-v2.txt',
    'v2',
  );
  expect(second.json.versions).toBe(2);
  const doc = (await call('GET', `${D}/${ids['letter']}`, 'rina')).json;
  expect(doc).toMatchObject({ name: 'offer-letter.txt', versions: 2, mime: 'text/plain', size: 2 });
  const vres = await call('GET', `/api/v1/documents/${ids['letter']}/versions`, 'rina');
  const versions = vres.json.versions;
  expect(versions.map((v: Json) => v.name)).toEqual(['offer-letter-v2.txt', 'offer-letter.txt']);
  // Not into a folder they cannot see.
  expect(
    (await upload(`/api/v1/documents/upload?folder=${ids['hr']}`, 'omar', 'sneak.txt', 'x')).status,
  ).toBeGreaterThanOrEqual(400);
});

test('one search: documents and the attachments of records the user may read', async () => {
  // A contact's attachment named like the document.
  const partner = (await call('POST', '/api/v1/models/res.partner', 'dina', { name: 'Acme' })).json
    .id;
  const att = await upload(
    `/api/v1/attachments/res.partner/${partner}`,
    'dina',
    'offer-acme.txt',
    'acme',
  );
  expect(att.status, JSON.stringify(att.json)).toBe(201);
  const found = (await call('GET', '/api/v1/documents/search?q=offer', 'dina')).json;
  expect(found.documents.map((d: Json) => d.name)).toEqual(['offer-letter.txt']);
  expect(found.attachments.map((a: Json) => [a.name, a.model])).toEqual([
    ['offer-acme.txt', 'res.partner'],
  ]);
  // Omar does not see the HR document; the contact's file, yes (Documents users read contacts).
  const his = (await call('GET', '/api/v1/documents/search?q=offer', 'omar')).json;
  expect(his.documents).toEqual([]);
  expect(his.attachments.map((a: Json) => a.name)).toEqual(['offer-acme.txt']);
});

test('share links: what they share, with their password, until they expire', async () => {
  const shared = await call('POST', '/api/v1/documents/shares', 'rina', {
    document: ids['letter'],
    days: 2,
    password: 'open sesame',
  });
  expect(shared.status, JSON.stringify(shared.json)).toBe(201);
  const path = new URL(shared.json.url).pathname;
  expect((await host.server.app.inject({ method: 'GET', url: path })).statusCode).toBe(401);
  const listed = await host.server.app.inject({
    method: 'GET',
    url: path,
    headers: { 'x-share-password': 'open sesame' },
  });
  expect(listed.json().documents.map((d: Json) => d.name)).toEqual(['offer-letter.txt']);
  const file = await host.server.app.inject({
    method: 'GET',
    url: `${path}/documents/${ids['letter']}`,
    headers: { 'x-share-password': 'open sesame' },
  });
  expect(file.statusCode).toBe(200);
  expect(file.body).toBe('v2');
  // Omar cannot share what he cannot see; an unknown link is nothing.
  expect(
    (await call('POST', '/api/v1/documents/shares', 'omar', { document: ids['letter'] })).status,
  ).toBe(404);
  expect((await host.server.app.inject({ method: 'GET', url: `${path}x` })).statusCode).toBe(404);
  // Expired: nothing.
  const [share] = (await call('GET', '/api/v1/models/documents.share?fields=id', 'dina')).json
    .items;
  await call('PATCH', `/api/v1/models/documents.share/${share.id}`, 'dina', {
    expiresAt: '2020-01-01T00:00:00Z',
  });
  expect(
    (
      await host.server.app.inject({
        method: 'GET',
        url: path,
        headers: { 'x-share-password': 'open sesame' },
      })
    ).statusCode,
  ).toBe(404);
});

test('a request: emailed with a link that takes the file into the folder once; reminded once when late', async () => {
  const made = await call('POST', '/api/v1/models/documents.request', 'dina', {
    name: 'Your NID card',
    folder: ids['hr'],
    email: 'karim@example.com',
    dueDate: '2026-01-15',
  });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  const R = `/api/v1/models/documents.request/${made.json.id}`;
  expect((await call('POST', `${R}/transitions/send`, 'dina')).status).toBe(200);
  const mail = mailer.sent.find((m) => m.to === 'karim@example.com');
  expect(mail?.subject).toBe('Padma Traders asks you for a document');
  const link = /https:\/\/erp\.test(\/api\/v1\/public\/documents\/requests\/[A-Za-z0-9_-]+)/.exec(
    mail?.text ?? '',
  )?.[1];
  expect(link).toBeDefined();
  const page = await host.server.app.inject({ method: 'GET', url: link ?? '' });
  expect(page.statusCode).toBe(200);
  expect(page.body).toContain('Your NID card');
  expect(page.headers['content-security-policy']).toContain("script-src 'nonce-");

  // Late: one reminder, with a new link (the first stops working).
  const remind = () =>
    host.server.shutro.bootstrap({ reason: 'test: reminders', company }, (env) =>
      (
        env as never as {
          asSuperuser: (o: unknown, f: (su: never) => Promise<number>) => Promise<number>;
        }
      ).asSuperuser({ reason: 'test' }, (su) => remindRequests(su)),
    );
  expect(await remind()).toBe(1);
  expect(await remind()).toBe(0);
  expect((await host.server.app.inject({ method: 'GET', url: link ?? '' })).statusCode).toBe(404);
  const again = mailer.sent.filter((m) => m.to === 'karim@example.com').at(-1);
  const fresh = /https:\/\/erp\.test(\/api\/v1\/public\/documents\/requests\/[A-Za-z0-9_-]+)/.exec(
    again?.text ?? '',
  )?.[1];
  const sent = await upload(fresh ?? '', null, 'nid.txt', 'NID');
  expect(sent.status, JSON.stringify(sent.json)).toBe(201);
  const request = (await call('GET', R, 'dina')).json;
  expect(request.state).toBe('received');
  const received = (await call('GET', `${D}/${sent.json.document}`, 'rina')).json;
  expect(received).toMatchObject({ name: 'Your NID card — karim@example.com', versions: 1 });
  expect(received.folder?.id ?? received.folder).toBe(ids['hr']);
  // Once.
  expect((await upload(fresh ?? '', null, 'nid.txt', 'again')).status).toBe(404);
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
  expect(JSON.stringify(summary)).toContain('Documents');
});
