/**
 * The Sites ↔ Pipeline bridge on real PostgreSQL (RFC 0021): the two apps propose it; a website form may create
 * deals; a visitor's submission becomes a deal from the website in the first stage, for no salesperson, with the
 * form's inputs winning over the defaults.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contacts } from '@kosh/contacts';
import { crm } from '@kosh/crm';
import { messaging } from '@kosh/messaging';
import { planApps } from '@kosh/modules-sdk';
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
import { website } from '@kosh/website';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { websiteCrm } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [base, settings, contacts, messaging, permissions, crm, website, websiteCrm];

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let host: AppHost;
let token: string | undefined;

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function call(
  login: string | null,
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
): Promise<{ status: number; json: Json }> {
  if (login !== null && token === undefined) {
    const res = await host.server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { login, password: PASSWORD },
    });
    token = (res.json() as { token: string }).token;
  }
  const res = await host.server.app.inject({
    method,
    url,
    ...(login === null ? {} : { headers: { authorization: `Bearer ${token}` } }),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: res.statusCode, json: res.body === '' ? null : res.json() };
}

test('the plan proposes the bridge when Sites and Pipeline come', () => {
  const plan = planApps(catalogue, [], { install: ['website', 'crm'] });
  expect(plan.install.find((i) => i.name === 'website_crm')).toEqual({
    name: 'website_crm',
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
  dir = await mkdtemp(join(tmpdir(), 'kosh-website-crm-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({
      driver,
      catalogue,
      change: { install: ['settings', 'crm', 'website'] },
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
  await auth.createUser({
    login: 'maria',
    name: 'Maria',
    password: PASSWORD,
    company,
    companies: [company],
    groups: ['website.manager', 'crm.manager'],
  });
  const site = await call('maria', 'POST', '/api/v1/models/website.site', {
    name: 'Padma Traders',
    key: 'padma',
  });
  expect(site.status, JSON.stringify(site.json)).toBe(201);
}, 240_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('a form for deals is allowed; a submission becomes a deal from the website, in the first stage', async () => {
  const form = await call('maria', 'POST', '/api/v1/models/website.form', {
    name: 'Request a quote',
    key: 'quote',
    target: 'crm.deal',
    fields: {
      create: [
        {
          name: 'contact',
          label: 'Your name',
          kind: 'text',
          required: true,
          targetField: 'contactName',
        },
        { name: 'company', label: 'Company', kind: 'text', targetField: 'companyName' },
        { name: 'email', label: 'Email', kind: 'email', required: true, targetField: 'email' },
        { name: 'budget', label: 'Budget', kind: 'number', targetField: 'expectedRevenue' },
        { name: 'about', label: 'What do you need?', kind: 'textarea', targetField: 'description' },
      ],
    },
  });
  expect(form.status, JSON.stringify(form.json)).toBe(201);

  const sent = await call(null, 'POST', '/api/v1/public/sites/padma/forms/quote', {
    contact: 'Farhana Haque',
    company: 'Haque Stores',
    email: 'farhana@example.test',
    budget: '250000',
    about: '20 tonnes of rice a month.',
  });
  expect(sent.status, JSON.stringify(sent.json)).toBe(201);

  const deals = (
    await call(
      'maria',
      'GET',
      `/api/v1/models/crm.deal?fields=name,contactName,companyName,email,expectedRevenue,description,source,salesperson,stage,status`,
    )
  ).json.items as Json[];
  expect(deals).toHaveLength(1);
  const [deal] = deals;
  expect(deal).toMatchObject({
    name: 'Website enquiry',
    contactName: 'Farhana Haque',
    companyName: 'Haque Stores',
    email: 'farhana@example.test',
    description: '20 tonnes of rice a month.',
    source: 'website',
    salesperson: null,
    status: 'open',
  });
  expect(Number(deal.expectedRevenue)).toBe(250000);
  expect(deal.stage?.name ?? deal.stage).toBeTruthy();
  const stage = (
    await call('maria', 'GET', `/api/v1/models/crm.stage/${deal.stage?.id ?? deal.stage}`)
  ).json;
  expect(stage.name).toBe('New');

  const submissions = (
    await call('maria', 'GET', '/api/v1/models/website.submission?fields=resModel,resName,state')
  ).json.items;
  expect(submissions).toEqual([
    expect.objectContaining({
      resModel: 'crm.deal',
      resName: 'Website enquiry',
      state: 'received',
    }),
  ]);
});

test("the form's own name input wins over the default", async () => {
  await call('maria', 'POST', '/api/v1/models/website.form', {
    name: 'Named',
    key: 'named',
    target: 'crm.deal',
    fields: {
      create: [
        { name: 'subject', label: 'Subject', kind: 'text', required: true, targetField: 'name' },
      ],
    },
  });
  const sent = await call(null, 'POST', '/api/v1/public/sites/padma/forms/named', {
    subject: 'Rice for Eid',
  });
  expect(sent.status, JSON.stringify(sent.json)).toBe(201);
  const named = (
    await call(
      'maria',
      'GET',
      `/api/v1/models/crm.deal?filter=${encodeURIComponent(JSON.stringify({ name: 'Rice for Eid' }))}&fields=name,source`,
    )
  ).json.items;
  expect(named).toHaveLength(1);
  expect(named[0].source).toBe('website');
});
