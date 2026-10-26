/**
 * The app host on real PostgreSQL (RFC 0008): it serves the installed apps only; when another server changes them
 * (NOTIFY), it rebuilds without a restart, new requests reach the new set, and a request running during the switch
 * finishes on the old server.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineModule as defineKoshModule, type KoshModule } from '@kosh/modules-sdk';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { applyApps, prepareApps, recordInstalledApps } from '../src/apps.js';
import { base, baseShutro } from '../src/auth/base.js';
import { type AppHost, createAppHost } from '../src/host.js';
import { type Driver, orm, pg } from '../src/orm.js';
import type { AppsContext, ModuleContext } from '../src/server.js';

const { defineGroup, defineModel, defineModule, f } = orm;

/** The app host's context, as module routes get it (Studio hands new module code over through it). */
let appsContext: AppsContext | undefined;

/** A module with one model and a public route `/api/v1/<name>/ping` (`?wait=ms` answers late). */
function app(
  name: string,
  depends: KoshModule[],
  shutroDepends: never[],
  answer: Record<string, unknown> = {},
): KoshModule {
  return defineKoshModule({
    shutro: defineModule({
      name,
      version: '1.0.0',
      depends: shutroDepends,
      groups: [defineGroup({ code: `${name}.user`, label: name })],
      models: [
        defineModel(`${name}.item`, {
          access: { [`${name}.user`]: ['read'] },
          fields: { title: f.char() },
        }),
      ],
    }),
    kosh: '^0.1.0',
    depends,
    accessLevels: { user: { label: 'User', groups: [`${name}.user`] } },
    routes: ({ app: fastify, apps }: ModuleContext) => {
      appsContext = apps;
      fastify.get(`/api/v1/${name}/ping`, { config: { public: true } }, async (request) => {
        const wait = Number((request.query as { wait?: string }).wait ?? 0);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        return { module: name, ...answer };
      });
    },
  });
}

const library = app('library', [base], [baseShutro as never]);
const shelf = app('shelf', [library], [library.shutro as never]);
const catalogue = [base, library, shelf];

let container: StartedPostgreSqlContainer;
let driver: Driver;
let dir: string;
let host: AppHost;
let url: string;

const get = async (path: string) => {
  const res = await fetch(`${url}${path}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
const change = async (c: Parameters<typeof prepareApps>[0]['change']) =>
  applyApps(await prepareApps({ driver, catalogue, change: c, dir }), {
    driver,
    dir,
    actor: 'other server',
  });
const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 25));
  expect(check()).toBe(true);
};

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18').start();
  driver = pg.createDriver({
    url: container.getConnectionUri(),
    max: 4,
    parseNumeric: orm.toDecimal,
  });
  dir = await mkdtemp(join(tmpdir(), 'kosh-host-'));
  await recordInstalledApps(driver, [], [], 'test');
  await change({ install: ['library'] });
  host = await createAppHost({
    databaseUrl: container.getConnectionUri(),
    catalogue,
    migrationsDir: dir,
    logger: false,
    auth: { secureCookies: false },
  });
  url = await host.listen({ port: 0, host: '127.0.0.1' });
}, 120_000);

afterAll(async () => {
  await host?.close();
  await driver?.end();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

test('only installed apps are served', async () => {
  expect((await get('/api/v1/library/ping')).body).toEqual({ module: 'library' });
  expect((await get('/api/v1/shelf/ping')).status).toBe(404);
});

test('a change on another server is served here without a restart', async () => {
  const before = host.generation;
  await change({ install: ['shelf'] });
  await until(() => host.generation > before);
  expect((await get('/api/v1/shelf/ping')).body).toEqual({ module: 'shelf' });
  expect(host.server.registry.loaded.modules.map((m) => m.name)).toEqual([
    'base',
    'library',
    'shelf',
  ]);
});

test('a request running during the switch finishes; the next one sees the new set', async () => {
  const before = host.generation;
  const slow = get('/api/v1/shelf/ping?wait=600');
  await new Promise((r) => setTimeout(r, 100)); // the request is running on the current server
  await change({ disable: ['shelf'] });
  await until(() => host.generation > before);
  expect(await slow).toEqual({ status: 200, body: { module: 'shelf' } });
  expect((await get('/api/v1/shelf/ping')).status).toBe(404);
});

test('reload without a change does nothing', async () => {
  const before = host.generation;
  expect(await host.reload()).toBe(false);
  expect(host.generation).toBe(before);
});

test('new code of an installed module is served at the next reload, even if NOTIFY rebuilt first', async () => {
  // The installed set is unchanged since the last rebuild: only the code is new (Kosh Studio's write mode).
  const before = host.generation;
  expect(await host.reload()).toBe(false);
  appsContext?.serveModule?.(app('library', [base], [baseShutro as never], { code: 'new' }));
  expect(await host.reload()).toBe(true);
  expect(host.generation).toBe(before + 1);
  expect((await get('/api/v1/library/ping')).body).toEqual({ module: 'library', code: 'new' });
  expect(await host.reload()).toBe(false);
});
