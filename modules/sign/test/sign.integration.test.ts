/**
 * Sign on real PostgreSQL (RFC 0024 §2.8): a template from a two-page PDF with fields per role; a request from a
 * contact's record refused without a signer for every role; signers in order — the second asked only once the
 * first signed — each with a one-time code (wrong codes counted, five at most); the PDF sealed with a certificate
 * page, its hashes kept, stored in Documents and on the contact; in parallel, both asked at once and a refusal
 * ending the request.
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
  prepareApps,
  recordInstalledApps,
} from '@kosh/server';
import { type Driver, orm, pg } from '@kosh/server/orm';
import { settings } from '@kosh/settings';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { signModule } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const API = 'https://erp.test';
const mailer = createMemoryMailer();
const catalogue = [base, settings, signModule({ mailer, apiUrl: API })];
/** A 1×1 PNG: a drawn signature as the page sends it. */
const DRAWN =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

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
const bearer = async (as: string) => {
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
  return `Bearer ${token}`;
};
async function call(method: 'GET' | 'POST' | 'PATCH', url: string, as: string, payload?: unknown) {
  const res = await host.server.app.inject({
    method,
    url,
    headers: { authorization: await bearer(as) },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: res.statusCode, json: (res.body === '' ? null : res.json()) as Json };
}
const visit = async (method: 'GET' | 'POST', url: string, payload?: unknown) => {
  const res = await host.server.app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: res.statusCode, body: res.body, headers: res.headers };
};
/** The path of the last signing link sent to `email`. */
const linkTo = (email: string): string => {
  const mail = mailer.sent
    .filter((m) => m.to === email && m.subject.includes('asks you to sign'))
    .at(-1);
  return (
    /https:\/\/erp\.test(\/api\/v1\/public\/sign\/[A-Za-z0-9_-]+)/.exec(mail?.text ?? '')?.[1] ?? ''
  );
};
const codeFor = (email: string): string => {
  const mail = mailer.sent
    .filter((m) => m.to === email && m.subject.startsWith('Your code'))
    .at(-1);
  return /(\d{6})/.exec(mail?.subject ?? '')?.[1] ?? '';
};

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  files = await mkdtemp(join(tmpdir(), 'kosh-sign-files-'));
  process.env['KOSH_STORAGE_DIR'] = files;
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-sign-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({ driver, catalogue, change: { install: ['settings', 'sign'] }, dir }),
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
    login: 'dina',
    name: 'Dina',
    password: PASSWORD,
    company,
    companies: [company],
    groups: ['sign.manager', 'documents.manager', 'contacts.manager'],
  });
  ids['acme'] = (
    await call('POST', '/api/v1/models/res.partner', 'dina', { name: 'Acme' })
  ).json.id;
  const made = await call('POST', '/api/v1/models/sign.template', 'dina', {
    name: 'Service agreement',
    fields: {
      create: [
        {
          role: 'Customer',
          kind: 'signature',
          page: 1,
          x: '0.1',
          y: '0.8',
          width: '0.3',
          height: '0.08',
        },
        {
          role: 'Customer',
          kind: 'date',
          page: 1,
          x: '0.5',
          y: '0.85',
          width: '0.2',
          height: '0.04',
        },
        {
          role: 'Customer',
          kind: 'checkbox',
          label: 'I agree',
          page: 1,
          x: '0.1',
          y: '0.7',
          width: '0.05',
          height: '0.03',
        },
        {
          role: 'Company',
          kind: 'signature',
          page: 2,
          x: '0.1',
          y: '0.8',
          width: '0.3',
          height: '0.08',
        },
        {
          role: 'Company',
          kind: 'text',
          label: 'Title',
          page: 2,
          x: '0.5',
          y: '0.8',
          width: '0.3',
          height: '0.04',
        },
      ],
    },
  });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  ids['template'] = made.json.id;
  const pdf = await PDFDocument.create();
  pdf.addPage().drawText('Service agreement — page 1');
  pdf.addPage().drawText('Page 2');
  const uploaded = await host.server.app.inject({
    method: 'POST',
    url: `/api/v1/sign/templates/${ids['template']}/pdf`,
    headers: { authorization: await bearer('dina'), 'content-type': 'application/pdf' },
    payload: Buffer.from(await pdf.save()),
  });
  expect(uploaded.statusCode, uploaded.body).toBe(200);
  expect(uploaded.json()).toEqual({ pages: 2 });
}, 240_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
  await rm(files, { recursive: true, force: true });
  delete process.env['KOSH_STORAGE_DIR'];
});

test('in order with one-time codes: the second asked once the first signed; sealed, stored and attached', async () => {
  // Every role needs a signer.
  const short = await call('POST', '/api/v1/sign/requests', 'dina', {
    template: ids['template'],
    signers: [{ role: 'Customer', name: 'Karim', email: 'karim@example.com' }],
  });
  expect(
    (await call('POST', `/api/v1/models/sign.request/${short.json.id}/transitions/send`, 'dina'))
      .status,
  ).toBe(422);

  const made = await call('POST', '/api/v1/sign/requests', 'dina', {
    template: ids['template'],
    name: 'Acme service agreement',
    model: 'res.partner',
    id: ids['acme'],
    signers: [
      { role: 'Customer', name: 'Karim', email: 'karim@example.com' },
      { role: 'Company', name: 'Dina', email: 'dina@padma.example' },
    ],
  });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  const R = `/api/v1/models/sign.request/${made.json.id}`;
  expect((await call('POST', `${R}/transitions/send`, 'dina')).status).toBe(200);
  const karim = linkTo('karim@example.com');
  expect(karim).not.toBe('');
  expect(linkTo('dina@padma.example')).toBe(''); // in order: not yet

  const page = await visit('GET', karim);
  expect(page.status).toBe(200);
  expect(page.body).toContain('Acme service agreement');
  expect(page.body).toContain('I agree');
  expect(page.headers['content-security-policy']).toContain("script-src 'nonce-");
  const pdf = await visit('GET', `${karim}/pdf`);
  expect(pdf.headers['content-type']).toBe('application/pdf');

  expect((await visit('POST', `${karim}/code`)).status).toBe(200);
  const code = codeFor('karim@example.com');
  expect(code).toMatch(/^\d{6}$/);
  const values = { values: { '1': DRAWN, '3': true } };
  expect((await visit('POST', `${karim}/sign`, { code: '000000', ...values })).status).toBe(401);
  // Without the signature: refused with why.
  const missing = await visit('POST', `${karim}/sign`, { code, values: { '3': true } });
  expect(missing.status).toBe(422);
  const signed = await visit('POST', `${karim}/sign`, { code, ...values });
  expect(signed.status, signed.body).toBe(200);
  expect(JSON.parse(signed.body)).toEqual({ completed: false });
  expect((await visit('GET', karim)).status).toBe(404); // used

  const dina = linkTo('dina@padma.example');
  await visit('POST', `${dina}/code`);
  const done = await visit('POST', `${dina}/sign`, {
    code: codeFor('dina@padma.example'),
    values: { '4': DRAWN, '5': 'Director' },
  });
  expect(JSON.parse(done.body)).toEqual({ completed: true });

  const request = (await call('GET', R, 'dina')).json;
  expect(request.state).toBe('signed');
  expect(request.hashBefore).toMatch(/^[0-9a-f]{64}$/);
  expect(request.hashAfter).toMatch(/^[0-9a-f]{64}$/);
  expect(request.hashAfter).not.toBe(request.hashBefore);
  // The sealed PDF: the two pages and the certificate.
  const sealed = await host.server.app.inject({
    method: 'GET',
    url: `/api/v1/attachments/${request.sealed?.id ?? request.sealed}/download`,
    headers: { authorization: await bearer('dina') },
  });
  expect(sealed.statusCode).toBe(200);
  expect((await PDFDocument.load(sealed.rawPayload)).getPageCount()).toBe(3);
  // In Documents, and on the contact.
  const doc = (
    await call(
      'GET',
      `/api/v1/models/documents.document/${request.document?.id ?? request.document}`,
      'dina',
    )
  ).json;
  expect(doc).toMatchObject({
    name: 'Acme service agreement (signed).pdf',
    versions: 1,
    resModel: 'res.partner',
  });
  const onContact = (await call('GET', `/api/v1/attachments/res.partner/${ids['acme']}`, 'dina'))
    .json;
  expect(JSON.stringify(onContact)).toContain('Acme service agreement (signed).pdf');
  expect(mailer.sent.filter((m) => m.subject === 'Acme service agreement is signed')).toHaveLength(
    2,
  );
});

test('codes: five wrong tries at most, a new code starts again', async () => {
  const made = await call('POST', '/api/v1/sign/requests', 'dina', {
    template: ids['template'],
    name: 'Second agreement',
    signers: [
      { role: 'Customer', name: 'Lina', email: 'lina@example.com' },
      { role: 'Company', name: 'Dina', email: 'dina@padma.example' },
    ],
  });
  await call('POST', `/api/v1/models/sign.request/${made.json.id}/transitions/send`, 'dina');
  const lina = linkTo('lina@example.com');
  await visit('POST', `${lina}/code`);
  for (let i = 0; i < 5; i++)
    expect((await visit('POST', `${lina}/sign`, { code: '999999', values: {} })).status).toBe(401);
  expect(
    (await visit('POST', `${lina}/sign`, { code: codeFor('lina@example.com'), values: {} })).status,
  ).toBe(429);
  await visit('POST', `${lina}/code`);
  const ok = await visit('POST', `${lina}/sign`, {
    code: codeFor('lina@example.com'),
    values: { '1': DRAWN, '3': true },
  });
  expect(ok.status, ok.body).toBe(200);
});

test('in parallel: both asked at once; a refusal ends the request and the other link', async () => {
  const made = await call('POST', '/api/v1/sign/requests', 'dina', {
    template: ids['template'],
    name: 'Parallel agreement',
    ordered: false,
    signers: [
      { role: 'Customer', name: 'Omar', email: 'omar@example.com' },
      { role: 'Company', name: 'Rafi', email: 'rafi@padma.example' },
    ],
  });
  const R = `/api/v1/models/sign.request/${made.json.id}`;
  await call('POST', `${R}/transitions/send`, 'dina');
  const omar = linkTo('omar@example.com');
  const rafi = linkTo('rafi@padma.example');
  expect(omar).not.toBe('');
  expect(rafi).not.toBe('');
  await visit('POST', `${omar}/code`);
  const refused = await visit('POST', `${omar}/refuse`, {
    code: codeFor('omar@example.com'),
    reason: 'The price is wrong.',
  });
  expect(refused.status, refused.body).toBe(200);
  const request = (await call('GET', R, 'dina')).json;
  expect(request).toMatchObject({ state: 'refused', refusal: 'Omar: The price is wrong.' });
  expect((await visit('GET', rafi)).status).toBe(404);
});
