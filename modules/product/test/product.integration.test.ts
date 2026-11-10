/**
 * Products on real PostgreSQL (RFC 0022 step 2): the Overview served to a Products user, and the product form's
 * row of tiles, empty until Sales, Purchase or Stockroom fill it.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { product } from '../src/index.js';

const PASSWORD = 'correct horse battery';
const catalogue = [base, settings, storage, permissions, reporting, product];

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let host: AppHost;
let token: string | undefined;

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
async function call(
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
): Promise<{ status: number; json: Json }> {
  if (token === undefined) {
    const res = await host.server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { login: 'sam', password: PASSWORD },
    });
    token = (res.json() as { token: string }).token;
  }
  const res = await host.server.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: res.statusCode, json: res.body === '' ? null : res.json() };
}

const tokens = new Map<string, string>();
async function callAs(
  login: string,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  payload?: unknown,
): Promise<{ status: number; json: Json }> {
  let bearer = tokens.get(login);
  if (bearer === undefined) {
    const res = await host.server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { login, password: PASSWORD },
    });
    bearer = (res.json() as { token: string }).token;
    tokens.set(login, bearer);
  }
  const res = await host.server.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${bearer}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: res.statusCode, json: res.body === '' ? null : res.json() };
}
const enc = (filter: unknown) => encodeURIComponent(JSON.stringify(filter));

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-product-'));
  await recordInstalledApps(driver, [], [], 'test');
  await applyApps(
    await prepareApps({ driver, catalogue, change: { install: ['settings', 'product'] }, dir }),
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
    login: 'sam',
    name: 'Sam',
    password: PASSWORD,
    company,
    companies: [company],
    groups: ['product.user'],
  });
  await auth.createUser({
    login: 'pat',
    name: 'Pat',
    password: PASSWORD,
    company,
    companies: [company],
    groups: ['product.manager'],
  });
}, 240_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('the Overview (RFC 0022 step 2) to a Products user; the form has a row of tiles for the other apps', async () => {
  const overview = await call('GET', '/api/v1/reports/overview?app=product');
  expect(overview.status, JSON.stringify(overview.json)).toBe(200);
  expect(overview.json.cards.map((c: { id: string }) => c.id)).toEqual([
    'products_all',
    'goods',
    'services',
    'average_price',
    'by_category',
    'priciest',
  ]);
  const form = await call('GET', '/api/v1/views?model=product.product&type=form');
  expect(form.status, JSON.stringify(form.json)).toBe(200);
  const [row] = form.json.view.sheet;
  expect(row).toMatchObject({ kind: 'stats', id: 'related', children: [] });
});

test('variants (RFC 0030 step 4): attributes with values, a template generating its combinations less the exclusions, prices from the extras, dropped values archived, a variant keeping its own price', async () => {
  const size = (
    await callAs('pat', 'POST', '/api/v1/models/product.attribute', {
      name: 'Size',
      display: 'size',
      values: { create: [{ name: 'S' }, { name: 'M' }, { name: 'L', extraPrice: '50' }] },
    })
  ).json;
  expect(size.id, JSON.stringify(size)).toBeDefined();
  const colour = (
    await callAs('pat', 'POST', '/api/v1/models/product.attribute', {
      name: 'Colour',
      display: 'swatch',
      values: {
        create: [
          { name: 'Red', color: '#ff0000' },
          { name: 'Blue', color: '#0000ff' },
        ],
      },
    })
  ).json;
  const valuesOf = async (attribute: number) =>
    (
      await callAs(
        'pat',
        'GET',
        `/api/v1/models/product.attribute.value?filter=${enc({ attribute })}&fields=name&order=id+asc`,
      )
    ).json.items as Json[];
  const sizes = await valuesOf(size.id);
  const colours = await valuesOf(colour.id);
  const by = (list: Json[], name: string) => list.find((v) => v.name === name).id as number;
  // A T-shirt at 500 in three sizes and two colours, but no large blue one.
  const template = await callAs('pat', 'POST', '/api/v1/models/product.template', {
    name: 'T-shirt',
    listPrice: '500',
    standardPrice: '200',
    lines: {
      create: [
        { attribute: size.id, values: { set: sizes.map((v) => v.id) } },
        { attribute: colour.id, values: { set: colours.map((v) => v.id) } },
      ],
    },
    exclusions: { create: [{ values: { set: [by(sizes, 'L'), by(colours, 'Blue')] } }] },
  });
  expect(template.status, JSON.stringify(template.json)).toBe(201);
  const T = `/api/v1/models/product.template/${template.json.id}`;
  // A value of another attribute on a line is refused.
  expect(
    (
      await callAs('pat', 'POST', '/api/v1/models/product.template.line', {
        template: template.json.id,
        attribute: size.id,
        values: { set: [by(colours, 'Red')] },
      })
    ).status,
  ).toBe(422);
  const generated = await callAs('pat', 'POST', `${T}/transitions/generate`);
  expect(generated.status, JSON.stringify(generated.json)).toBe(200);
  const variantsOf = async (archived = '') =>
    (
      await callAs(
        'pat',
        'GET',
        `/api/v1/models/product.product?filter=${enc({ template: template.json.id })}&fields=name,listPrice,active,code,followsTemplatePrice&order=id+asc${archived}`,
      )
    ).json.items as Json[];
  const variants = await variantsOf();
  expect(variants.map((v) => [v.name, Number(v.listPrice)])).toEqual([
    ['T-shirt (S, Red)', 500],
    ['T-shirt (S, Blue)', 500],
    ['T-shirt (M, Red)', 500],
    ['T-shirt (M, Blue)', 500],
    ['T-shirt (L, Red)', 550],
  ]);
  expect(variants.every((v) => String(v.code).startsWith('P'))).toBe(true);
  expect((await callAs('pat', 'GET', `${T}?fields=variantCount,state`)).json).toMatchObject({
    variantCount: 5,
    state: 'ready',
  });
  // The small red one keeps its own price; the base rises to 520; M is no longer offered.
  expect(
    (
      await callAs('pat', 'PATCH', `/api/v1/models/product.product/${variants[0].id}`, {
        followsTemplatePrice: false,
        listPrice: '480',
      })
    ).status,
  ).toBe(200);
  expect((await callAs('pat', 'PATCH', T, { listPrice: '520' })).status).toBe(200);
  const [sizeLine] = (
    await callAs(
      'pat',
      'GET',
      `/api/v1/models/product.template.line?filter=${enc({ template: template.json.id, attribute: size.id })}&fields=id`,
    )
  ).json.items as Json[];
  expect(
    (
      await callAs('pat', 'PATCH', `/api/v1/models/product.template.line/${sizeLine.id}`, {
        values: { set: [by(sizes, 'S'), by(sizes, 'L')] },
      })
    ).status,
  ).toBe(200);
  expect((await callAs('pat', 'POST', `${T}/transitions/generate`)).status).toBe(200);
  const active = await variantsOf();
  expect(active.map((v) => [v.name, Number(v.listPrice)])).toEqual([
    ['T-shirt (S, Red)', 480],
    ['T-shirt (S, Blue)', 520],
    ['T-shirt (L, Red)', 570],
  ]);
  const archived = await variantsOf('&archived=only');
  expect(archived.map((v) => v.name).sort()).toEqual(['T-shirt (M, Blue)', 'T-shirt (M, Red)']);
  expect((await callAs('pat', 'GET', `${T}?fields=variantCount`)).json.variantCount).toBe(3);
  // The grid (part 2): sizes down, colours across, the excluded cell empty.
  const grid = (await callAs('pat', 'GET', `/api/v1/product/templates/${template.json.id}/grid`))
    .json;
  expect(grid.attributes).toEqual(['Size', 'Colour']);
  expect(grid.rows.map((r: Json) => r.label)).toEqual(['S', 'L']);
  expect(grid.columns.map((c: Json) => c.name)).toEqual(['Red', 'Blue']);
  const cell = (row: string, colour: string) =>
    grid.cells[`${by(sizes, row)}|${by(colours, colour)}`];
  expect(cell('S', 'Red')).toMatchObject({ name: 'T-shirt (S, Red)', listPrice: '480' });
  expect(cell('L', 'Red')).toMatchObject({ listPrice: '570' });
  expect(cell('L', 'Blue')).toBeNull();
  expect((await callAs('pat', 'GET', '/api/v1/product/templates/999999/grid')).status).toBe(404);
  // A template without attributes cannot generate.
  const bare = (await callAs('pat', 'POST', '/api/v1/models/product.template', { name: 'Plain' }))
    .json;
  expect(
    (await callAs('pat', 'POST', `/api/v1/models/product.template/${bare.id}/transitions/generate`))
      .status,
  ).toBe(409);
});
