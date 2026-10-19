/**
 * Views, actions and searches (RFC 0004) on real PostgreSQL: validated at startup, extended by another module,
 * served per user (unreadable fields removed, buttons the user cannot run dropped), searches compiled by
 * `@kosh/search` accepted by the generated API (relation paths included), and saved views private or shared.
 */
import { defineModule as defineKoshModule } from '@kosh/modules-sdk';
import { compileSearch } from '@kosh/search';
import { list } from '@kosh/views';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  type Authenticator,
  createServer,
  type KoshServer,
  type ServedView,
} from '../src/index.js';
import { orm } from '../src/orm.js';
import { contacts } from './fixtures/contacts.js';
import { type Services, startServices } from './support/services.js';

const USERS: Record<string, { user: number; groups: string[] }> = {
  alice: { user: 1, groups: ['contacts.user'] },
  maria: { user: 2, groups: ['contacts.manager'] },
  bob: { user: 3, groups: ['base.user'] },
};
const authenticate: Authenticator = async (request) => {
  const u = USERS[String(request.headers['x-test-user'])];
  return u === undefined ? null : { user: u.user, company: 1, companies: [1], groups: u.groups };
};

// Another module extends the contacts form by anchors.
const { defineModule } = orm;
const crm = defineKoshModule({
  shutro: defineModule({
    name: 'crm',
    version: '0.1.0',
    depends: [contacts.shutro as never],
    models: [],
    groups: [orm.defineGroup({ code: 'crm.user', label: 'CRM', implies: ['contacts.user'] })],
  }),
  kosh: '^0.1.0',
  depends: [contacts],
  accessLevels: { user: { label: 'CRM user', groups: ['crm.user'] } },
  viewExtensions: [
    {
      view: 'res.partner.form',
      operations: [
        {
          insertAfter: 'main',
          nodes: [{ kind: 'component', id: 'crm_pipeline', component: 'crm.Pipeline' }],
        },
        { setAttrs: 'phone', attrs: { label: 'Mobile' } },
      ],
    },
  ],
  search: {
    'res.partner': {
      fields: ['phone'],
      filters: { noEmail: { label: 'No email', domain: { email: null } } },
    },
  },
});

let services: Services;
let server: KoshServer;
const call = (
  url: string,
  as: string,
  init: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown } = {},
) =>
  server.app.inject({
    method: init.method ?? 'GET',
    url,
    headers: { 'x-test-user': as },
    ...(init.body === undefined ? {} : { payload: init.body as object }),
  });

beforeAll(async () => {
  services = await startServices();
  server = await createServer({
    databaseUrl: services.databaseUrl,
    modules: [crm],
    authenticate,
    logger: false,
  });
  for (const statement of orm.createTableStatements(server.registry.registry))
    await server.driver.query(statement);
  for (const text of [
    "INSERT INTO res_users (login, name) VALUES ('alice', 'Alice'), ('maria', 'Maria'), ('bob', 'Bob')",
    "INSERT INTO res_currency (name) VALUES ('BDT')",
    "INSERT INTO res_company (name, currency_id) VALUES ('Dhaka Ltd', 1)",
    "INSERT INTO res_partner (name, email, is_company, company_id, stage, active) VALUES ('Acme', 'a@acme.test', true, 1, 'lead', true), ('Beta', NULL, false, NULL, 'customer', true)",
  ])
    await server.driver.query({ text, params: [] });
}, 240_000);

afterAll(async () => {
  await server?.close();
  await services?.stop();
});

describe('served views', () => {
  test('the form, extended by crm, for a user: no restricted field, no button they cannot run', async () => {
    const res = await call('/api/v1/views/res.partner.form', 'alice');
    expect(res.statusCode).toBe(200);
    const served = res.json() as ServedView;
    if (served.view.type !== 'form') throw new Error('form');
    expect(served.view.sheet.map((n) => n.id)).toEqual(['main', 'crm_pipeline', 'finance']);
    const finance = served.view.sheet[2];
    expect(finance?.kind === 'group' && finance.children).toEqual([]); // creditLimit is managers-only
    expect(served.fields['res.partner']).not.toHaveProperty('creditLimit');
    expect(served.view.header.buttons.map((b) => b.id)).toEqual(['qualify']); // lose needs contacts.mark_lost
    const main = served.view.sheet[0];
    expect(main?.kind === 'group' && main.children.find((c) => c.id === 'phone')).toMatchObject({
      label: 'Mobile',
    });
    expect(served.fields['res.partner']?.['stage']).toMatchObject({
      kind: 'state',
      options: [
        { value: 'lead', label: 'Lead' },
        { value: 'customer', label: 'Customer' },
        { value: 'lost', label: 'Lost' },
      ],
    });
    expect(served.transitions).toEqual([
      { name: 'qualify', field: 'stage', from: ['lead'], to: 'customer' },
    ]);
    expect(served.operations).toEqual({ create: true, write: true, unlink: false });
  });

  test('managers get the restricted field and every button', async () => {
    const served = (await call('/api/v1/views/res.partner.form', 'maria')).json() as ServedView;
    if (served.view.type !== 'form') throw new Error('form');
    expect(served.view.header.buttons.map((b) => b.id)).toEqual(['qualify', 'lose']);
    expect(served.fields['res.partner']?.['creditLimit']).toMatchObject({
      kind: 'decimal',
      readonly: false,
    });
  });

  test('default views by model and type; no access: 403; unknown: 404', async () => {
    const kanban = (
      await call('/api/v1/views?model=res.partner&type=kanban', 'alice')
    ).json() as ServedView;
    expect(kanban.view).toMatchObject({
      id: 'res.partner.kanban',
      type: 'kanban',
      groupBy: 'stage',
    });
    const listView = (
      await call('/api/v1/views?model=res.partner&type=list', 'alice')
    ).json() as ServedView;
    expect(listView.view.type === 'list' && listView.view.columns.map((c) => c.id)).toEqual([
      'name',
      'email',
      'phone',
      'stage',
    ]);
    expect((await call('/api/v1/views/res.partner.form', 'bob')).statusCode).toBe(403);
    expect((await call('/api/v1/views/nope', 'alice')).statusCode).toBe(404);
  });
});

describe('search', () => {
  test('merged across modules, filtered per user, and accepted by the API', async () => {
    const spec = (await call('/api/v1/search/res.partner', 'alice')).json();
    expect(spec.fields).toEqual(['name', 'email', 'company.name', 'phone']);
    expect(Object.keys(spec.filters)).toEqual(['companies', 'leads', 'customers', 'noEmail']); // bigCredit needs creditLimit
    const managerSpec = (await call('/api/v1/search/res.partner', 'maria')).json();
    expect(Object.keys(managerSpec.filters)).toContain('bigCredit');

    const compiled = compileSearch(spec, {
      facets: [{ field: 'company.name', values: ['dhaka'] }],
      filters: ['leads', 'customers'],
    });
    const res = await call(
      `/api/v1/models/res.partner?fields=name&filter=${encodeURIComponent(JSON.stringify(compiled.where))}`,
      'alice',
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().items.map((r: { name: string }) => r.name)).toEqual(['Acme']);
  });
});

describe('saved views', () => {
  test('private to their owner unless shared', async () => {
    const mine = await call('/api/v1/models/kosh.saved_view', 'alice', {
      method: 'POST',
      body: { name: 'My leads', targetModel: 'res.partner', state: { x: ['leads'] } },
    });
    expect(mine.statusCode, mine.body).toBe(201);
    const shared = await call('/api/v1/models/kosh.saved_view', 'alice', {
      method: 'POST',
      body: {
        name: 'Team customers',
        targetModel: 'res.partner',
        state: { x: ['customers'] },
        shared: true,
      },
    });
    expect(shared.statusCode).toBe(201);
    const seen = await call('/api/v1/models/kosh.saved_view?fields=name', 'maria');
    expect(seen.json().items.map((v: { name: string }) => v.name)).toEqual(['Team customers']);
    const edit = await call(`/api/v1/models/kosh.saved_view/${shared.json().id}`, 'maria', {
      method: 'PATCH',
      body: { name: 'Mine now' },
    });
    expect([403, 404]).toContain(edit.statusCode);
  });
});

describe('validation at startup', () => {
  test('a view on an unknown field, or extending an unknown anchor, stops the server from starting', async () => {
    const broken = defineKoshModule({
      shutro: defineModule({
        name: 'broken',
        version: '0.1.0',
        depends: [contacts.shutro as never],
        models: [],
        groups: [orm.defineGroup({ code: 'broken.user', label: 'B' })],
      }),
      kosh: '^0.1.0',
      depends: [contacts],
      accessLevels: { user: { label: 'B', groups: ['broken.user'] } },
      views: { 'broken.list': list('res.partner', { columns: ['name', 'colour'] }) },
    });
    await expect(
      createServer({ databaseUrl: services.databaseUrl, modules: [broken], logger: false }),
    ).rejects.toThrow(/View 'broken.list': unknown field 'colour'/);
    const badAnchor = defineKoshModule({
      shutro: defineModule({
        name: 'bad_anchor',
        version: '0.1.0',
        depends: [contacts.shutro as never],
        models: [],
        groups: [orm.defineGroup({ code: 'bad_anchor.user', label: 'B' })],
      }),
      kosh: '^0.1.0',
      depends: [contacts],
      accessLevels: { user: { label: 'B', groups: ['bad_anchor.user'] } },
      viewExtensions: [{ view: 'res.partner.form', operations: [{ remove: 'nowhere' }] }],
    });
    await expect(
      createServer({ databaseUrl: services.databaseUrl, modules: [badAnchor], logger: false }),
    ).rejects.toThrow(/no node has the id 'nowhere'/);
  });
});

describe('global search (the command palette)', () => {
  test('finds records by name in the models of visible menus, with the action that opens them', async () => {
    const res = await call('/api/v1/find?q=acm', 'alice');
    expect(res.statusCode).toBe(200);
    expect(res.json().results).toEqual([
      expect.objectContaining({
        model: 'res.partner',
        displayName: 'Acme',
        action: 'contacts.action_partners',
        app: 'contacts',
      }),
    ]);
    // Wildcards are literal: "%" matches nothing here.
    expect((await call('/api/v1/find?q=%25', 'alice')).json().results).toEqual([]);
  });

  test('users who cannot open the app find nothing; bad queries are refused', async () => {
    expect((await call('/api/v1/find?q=acm', 'bob')).json().results).toEqual([]);
    expect((await call('/api/v1/find?q=', 'alice')).statusCode).toBe(400);
    expect((await call('/api/v1/find?q=a&limit=99', 'alice')).statusCode).toBe(400);
  });
});
