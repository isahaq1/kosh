/**
 * The generated REST API and OpenAPI document (RFC 0002 §6.3–6.4) on real PostgreSQL: CRUD with ETags and If-Match,
 * search parameters, field security, ACL, validation problems, transitions, onchange, aggregates, idempotency keys
 * (including concurrent retries), the caller's metadata, and the OpenAPI document.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { type Authenticator, createServer, type KoshServer } from '../src/index.js';
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

let services: Services;
let server: KoshServer;
const P = '/api/v1/models/res.partner';

type Call = {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  url: string;
  as?: string;
  body?: unknown;
  headers?: Record<string, string>;
};
const call = (c: Call) =>
  server.app.inject({
    method: c.method ?? 'GET',
    url: c.url,
    headers: { ...(c.as === undefined ? {} : { 'x-test-user': c.as }), ...c.headers },
    ...(c.body === undefined ? {} : { payload: c.body as Record<string, unknown> }),
  });

beforeAll(async () => {
  services = await startServices();
  server = await createServer({
    databaseUrl: services.databaseUrl,
    modules: [contacts],
    authenticate,
    logger: false,
  });
  for (const statement of orm.createTableStatements(server.registry.registry))
    await server.driver.query(statement);
  for (const text of [
    "INSERT INTO res_users (login, name) VALUES ('alice', 'Alice'), ('maria', 'Maria'), ('bob', 'Bob')",
    "INSERT INTO res_currency (name) VALUES ('BDT')",
    "INSERT INTO res_company (name, currency_id) VALUES ('Dhaka Ltd', 1)",
  ])
    await server.driver.query({ text, params: [] });
}, 240_000);

afterAll(async () => {
  await server?.close();
  await services?.stop();
});

describe('CRUD', () => {
  test('create, read, list, update with If-Match, delete', async () => {
    const created = await call({
      method: 'POST',
      url: P,
      as: 'alice',
      body: { name: 'Acme', email: 'hello@acme.test' },
    });
    expect(created.statusCode).toBe(201);
    const acme = created.json();
    expect(acme).toMatchObject({
      name: 'Acme',
      email: 'hello@acme.test',
      stage: 'lead',
      isCompany: false,
    });
    expect(created.headers['location']).toBe(`${P}/${acme.id}`);
    const etag = String(created.headers['etag']);
    expect(etag).toMatch(/^"\d+"$/);

    expect((await call({ url: `${P}/${acme.id}`, as: 'alice' })).json()).toEqual(acme);
    await call({ method: 'POST', url: P, as: 'alice', body: { name: 'Globex', isCompany: true } });
    const listed = await call({
      url: `${P}?filter=${encodeURIComponent('{"name":{"ilike":"%e%"}}')}&order=name%20desc&fields=name,isCompany&count=true`,
      as: 'alice',
    });
    expect(listed.json()).toEqual({
      items: [
        { id: expect.any(Number), name: 'Globex', isCompany: true },
        { id: acme.id, name: 'Acme', isCompany: false },
      ],
      count: 2,
    });

    const updated = await call({
      method: 'PATCH',
      url: `${P}/${acme.id}`,
      as: 'alice',
      body: { phone: '+880 1700' },
      headers: { 'if-match': etag },
    });
    expect([updated.statusCode, updated.json().phone]).toEqual([200, '+880 1700']);
    expect(updated.headers['etag']).not.toBe(etag);
    // Someone saved since this ETag was read: refused, not overwritten.
    const stale = await call({
      method: 'PATCH',
      url: `${P}/${acme.id}`,
      as: 'alice',
      body: { phone: 'old view' },
      headers: { 'if-match': etag },
    });
    expect(stale.json()).toMatchObject({
      status: 412,
      type: 'https://kosh.dev/problems/stale-record',
    });

    // ACL: users may not delete; managers may.
    expect((await call({ method: 'DELETE', url: `${P}/${acme.id}`, as: 'alice' })).statusCode).toBe(
      403,
    );
    expect((await call({ method: 'DELETE', url: `${P}/${acme.id}`, as: 'maria' })).json()).toEqual({
      deleted: 1,
    });
    expect((await call({ url: `${P}/${acme.id}`, as: 'alice' })).statusCode).toBe(404);
  });

  test('problems: validation, bad parameters, unknown model, no access', async () => {
    expect((await call({ method: 'POST', url: P, as: 'alice', body: {} })).json()).toMatchObject({
      status: 422,
    });
    expect(
      (
        await call({ method: 'POST', url: P, as: 'alice', body: { name: 'X', isCompany: 'yes' } })
      ).json(),
    ).toMatchObject({ status: 422 });
    expect((await call({ url: `${P}?filter=not-json`, as: 'alice' })).json()).toMatchObject({
      status: 400,
      type: 'https://kosh.dev/problems/invalid-filter',
    });
    expect(
      (await call({ url: `${P}?filter=${encodeURIComponent('{"nope":1}')}`, as: 'alice' })).json(),
    ).toMatchObject({ status: 400, type: 'https://kosh.dev/problems/invalid-domain' });
    expect((await call({ url: `${P}?order=nope`, as: 'alice' })).statusCode).toBe(400);
    expect((await call({ url: `${P}?limit=5000`, as: 'alice' })).statusCode).toBe(400);
    expect((await call({ url: '/api/v1/models/no.such', as: 'alice' })).json()).toMatchObject({
      status: 404,
      type: 'https://kosh.dev/problems/unknown-model',
    });
    expect((await call({ url: P, as: 'bob' })).statusCode).toBe(403);
    expect((await call({ url: P })).statusCode).toBe(401);
  });
});

describe('field security', () => {
  test('restricted fields are hidden from defaults, refused when asked, and not writable', async () => {
    const id = (
      await call({
        method: 'POST',
        url: P,
        as: 'maria',
        body: { name: 'Initech', creditLimit: '50000.00' },
      })
    ).json().id;
    expect((await call({ url: `${P}/${id}`, as: 'maria' })).json().creditLimit).toBe('50000'); // exact decimals in canonical form
    expect((await call({ url: `${P}/${id}`, as: 'alice' })).json()).not.toHaveProperty(
      'creditLimit',
    );
    expect((await call({ url: `${P}/${id}?fields=creditLimit`, as: 'alice' })).statusCode).toBe(
      403,
    );
    expect(
      (await call({ method: 'PATCH', url: `${P}/${id}`, as: 'alice', body: { creditLimit: '1' } }))
        .statusCode,
    ).toBe(403);
    const meta = (await call({ url: '/api/v1/meta/res.partner', as: 'alice' })).json();
    expect(meta.fields.map((f: { key: string }) => f.key)).not.toContain('creditLimit');
    expect(meta.operations).toMatchObject({
      read: true,
      create: true,
      unlink: false,
      export: false,
    });
    expect(meta.fields.find((f: { key: string }) => f.key === 'stage')).toMatchObject({
      readonly: true,
      options: [
        { value: 'lead', label: 'Lead' },
        { value: 'customer', label: 'Customer' },
        { value: 'lost', label: 'Lost' },
      ],
    });
  });
});

describe('transitions, onchange, aggregates', () => {
  test('transitions run guards and states; unknown ones are 404, invalid ones 409', async () => {
    const id = (
      await call({ method: 'POST', url: P, as: 'alice', body: { name: 'Umbrella' } })
    ).json().id;
    const qualified = await call({
      method: 'POST',
      url: `${P}/${id}/transitions/qualify`,
      as: 'alice',
    });
    expect([qualified.statusCode, qualified.json().stage]).toEqual([200, 'customer']);
    expect(
      (await call({ method: 'POST', url: `${P}/${id}/transitions/qualify`, as: 'alice' }))
        .statusCode,
    ).toBe(409);
    expect(
      (await call({ method: 'POST', url: `${P}/${id}/transitions/fly`, as: 'alice' })).statusCode,
    ).toBe(404);
    expect(
      (await call({ method: 'PATCH', url: `${P}/${id}`, as: 'alice', body: { stage: 'lead' } }))
        .statusCode,
    ).toBe(422); // states change by transitions only
  });

  test('onchange suggests values; aggregate groups', async () => {
    const changed = await call({
      method: 'POST',
      url: `${P}/onchange`,
      as: 'alice',
      body: { values: { name: 'Wayne Enterprises' }, changed: ['name'] },
    });
    expect(changed.json().values).toMatchObject({ email: 'wayne.enterprises@example.com' });
    const malformed = await call({
      method: 'POST',
      url: `${P}/onchange`,
      as: 'alice',
      body: { values: { name: 'x' }, field: 'name' },
    });
    expect(malformed.statusCode).toBe(400); // a bad body is the caller's problem, not a 500
    const totals = await call({
      method: 'POST',
      url: `${P}/aggregate`,
      as: 'alice',
      body: { groupBy: ['isCompany'], measures: { n: 'count' }, order: ['isCompany'] },
    });
    expect(totals.json().rows).toEqual([
      { isCompany: false, n: expect.any(Number) },
      { isCompany: true, n: expect.any(Number) },
    ]);
  });
});

describe('idempotency keys', () => {
  test('a retried create replays the first response; reusing a key for another request is refused', async () => {
    const first = await call({
      method: 'POST',
      url: P,
      as: 'alice',
      body: { name: 'Once Ltd' },
      headers: { 'idempotency-key': 'create-once-1' },
    });
    const retry = await call({
      method: 'POST',
      url: P,
      as: 'alice',
      body: { name: 'Once Ltd' },
      headers: { 'idempotency-key': 'create-once-1' },
    });
    expect([first.statusCode, retry.statusCode]).toEqual([201, 201]);
    expect(retry.json().id).toBe(first.json().id);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    const other = await call({
      method: 'POST',
      url: P,
      as: 'alice',
      body: { name: 'Twice Ltd' },
      headers: { 'idempotency-key': 'create-once-1' },
    });
    expect(other.json()).toMatchObject({
      status: 422,
      type: 'https://kosh.dev/problems/idempotency-key-reused',
    });
    // Keys are per user.
    expect(
      (
        await call({
          method: 'POST',
          url: P,
          as: 'maria',
          body: { name: 'Once Ltd' },
          headers: { 'idempotency-key': 'create-once-1' },
        })
      ).json().id,
    ).not.toBe(first.json().id);
    const [n] = await server.driver.query<{ n: number }>({
      text: "SELECT count(*)::int AS n FROM res_partner WHERE name = 'Once Ltd'",
      params: [],
    });
    expect(n?.n).toBe(2);
  });

  test('concurrent retries with one key create once', async () => {
    const send = () =>
      call({
        method: 'POST',
        url: P,
        as: 'alice',
        body: { name: 'Race Ltd' },
        headers: { 'idempotency-key': 'race-1' },
      });
    const results = await Promise.all([send(), send(), send()]);
    expect(new Set(results.map((r) => r.json().id)).size).toBe(1);
    expect(results.filter((r) => r.headers['idempotent-replayed'] === 'true')).toHaveLength(2);
    const [n] = await server.driver.query<{ n: number }>({
      text: "SELECT count(*)::int AS n FROM res_partner WHERE name = 'Race Ltd'",
      params: [],
    });
    expect(n?.n).toBe(1);
  });

  test('a failed request stores nothing: its retry runs again', async () => {
    expect(
      (
        await call({
          method: 'POST',
          url: P,
          as: 'alice',
          body: {},
          headers: { 'idempotency-key': 'fail-1' },
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await call({
          method: 'POST',
          url: P,
          as: 'alice',
          body: { name: 'Fixed Ltd' },
          headers: { 'idempotency-key': 'fail-1' },
        })
      ).statusCode,
    ).toBe(201);
  });
});

describe('OpenAPI', () => {
  test('the document describes every model, its schemas, transitions and problems; it needs authentication', async () => {
    expect((await call({ url: '/api/v1/openapi.json' })).statusCode).toBe(401);
    const doc = (await call({ url: '/api/v1/openapi.json', as: 'alice' })).json();
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        P,
        `${P}/{id}`,
        `${P}/aggregate`,
        `${P}/onchange`,
        `${P}/{id}/transitions/qualify`,
        `${P}/{id}/transitions/lose`,
        '/api/v1/models/res.users',
      ]),
    );
    const schemas = doc.components.schemas;
    expect(schemas.ResPartnerCreate.required).toEqual(['name']);
    expect(schemas.ResPartner.properties.stage).toMatchObject({
      type: 'string',
      enum: ['lead', 'customer', 'lost'],
    });
    expect(schemas.ResPartner.properties.creditLimit).toMatchObject({
      type: ['string', 'null'],
      pattern: '^-?\\d+(\\.\\d+)?$',
    });
    expect(schemas.ResPartnerUpdate.properties).not.toHaveProperty('stage'); // states change by transitions only
    expect(schemas.ResPartnerUpdate.properties).not.toHaveProperty('createdAt');
    expect(doc.paths[P].post.parameters.map((p: { name: string }) => p.name)).toContain(
      'Idempotency-Key',
    );
    expect(doc.paths[`${P}/{id}`].patch.responses['412']).toBeDefined();
  });
});
