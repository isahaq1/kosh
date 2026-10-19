/**
 * The app host (RFC 0008 §5.3, "publish"): one HTTP listener, and a Kosh server built for the database's installed
 * apps. When the installed set changes (here, or on another server: `NOTIFY kosh_apps`), the host builds a server for
 * the new set, sends new requests to it, and closes the old one once its in-flight requests have finished. No
 * restart, no dropped request; a failed rebuild keeps the current server serving (and is logged).
 */
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { type InstalledApp, type KoshModule, servedModules } from '@kosh/modules-sdk';
import { APPS_CHANNEL, appsDigest, readInstalledApps } from './apps.js';
import { type Driver, pg } from './orm.js';
import { createServer, type KoshServer, type ServerOptions } from './server.js';

/** Options of {@link createAppHost}: the server's options, with the catalogue instead of a module list. */
export interface AppHostOptions extends Omit<ServerOptions, 'modules' | 'serverFactory' | 'apps'> {
  /** Every module this installation can install; the database says which are installed. */
  readonly catalogue: readonly KoshModule[];
  /** Where app changes made through the API write their migration files. Default `migrations`. */
  readonly migrationsDir?: string;
  /** Rebuild when another server changes the apps (`LISTEN kosh_apps`). Default: true. */
  readonly listen?: boolean;
  /** How long a replaced server may finish its requests before it is closed anyway. Default 30 s. */
  readonly drainMs?: number;
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

interface Generation {
  readonly number: number;
  readonly server: KoshServer;
  readonly handler: Handler;
  readonly digest: string;
  inflight: number;
  retired: boolean;
  closed?: Promise<void>;
}

/** A running host. */
export interface AppHost {
  /** The server of the current installed set. */
  readonly server: KoshServer;
  /** Incremented by every rebuild. */
  readonly generation: number;
  /** Serves one HTTP request with the current server. */
  readonly handle: Handler;
  /** Rebuilds when the installed set differs from the served one; resolves true when it rebuilt. */
  reload(): Promise<boolean>;
  /** Listens; resolves with the address (`http://host:port`). */
  listen(options?: { readonly port?: number; readonly host?: string }): Promise<string>;
  /** Stops listening and closes every server once its requests are done. Safe to call twice. */
  close(): Promise<void>;
}

const LEGACY = 'legacy';

/** The digest of what a database has installed (`legacy` before the first app change). */
async function installedDigest(
  driver: Driver,
): Promise<{ digest: string; rows: InstalledApp[] | null }> {
  const rows = await readInstalledApps(driver);
  return { rows, digest: rows === null ? LEGACY : appsDigest(rows) };
}

/** Creates the host and its first server (not listening yet). */
export async function createAppHost(options: AppHostOptions): Promise<AppHost> {
  const { catalogue, migrationsDir = 'migrations', listen = true, drainMs = 30_000 } = options;
  const probe = pg.createDriver({ url: options.databaseUrl, max: 1, applicationName: 'kosh host' });
  let current: Generation;
  let count = 0;

  const host: AppHost = {
    get server() {
      return current.server;
    },
    get generation() {
      return current.number;
    },
    handle: (req, res) => {
      const generation = current;
      generation.inflight += 1;
      res.once('close', () => {
        generation.inflight -= 1;
        if (generation.retired && generation.inflight === 0) void retire(generation);
      });
      generation.handler(req, res);
    },
    reload: () => {
      reloading = reloading.then(rebuild, rebuild);
      return reloading;
    },
    async listen(listenOptions = {}) {
      await new Promise<void>((done, fail) => {
        http.once('error', fail);
        http.listen(listenOptions.port ?? 3000, listenOptions.host ?? '0.0.0.0', () => done());
      });
      const address = http.address() as AddressInfo;
      const name = address.family === 'IPv6' ? `[${address.address}]` : address.address;
      return `http://${name}:${address.port}`;
    },
    close() {
      closing ??= (async () => {
        await stopListening?.();
        await reloading.catch(() => false);
        await new Promise<void>((done) => {
          if (!http.listening) done();
          else http.close(() => done());
          http.closeIdleConnections();
        });
        current.retired = true;
        await Promise.all(retiring);
        await retire(current);
        await Promise.all([probe.end(), listener?.end()]);
      })();
      return closing;
    },
  };

  /** Builds a server for the installed set, ready to take requests. */
  async function build(): Promise<Generation> {
    const { rows, digest } = await installedDigest(probe);
    const modules = rows === null ? [...catalogue] : servedModules(catalogue, rows);
    let handler: Handler | undefined;
    const server = await createServer({
      ...options,
      modules,
      serverFactory: (h) => {
        handler = h as Handler;
        return createHttpServer(); // never listens: the host's listener dispatches to `handler`
      },
      apps: { catalogue, migrationsDir, reload: () => host.reload() },
    });
    await server.app.ready();
    if (handler === undefined) throw new Error('Fastify did not hand over its request handler.');
    count += 1;
    return { number: count, server, handler, digest, inflight: 0, retired: false };
  }

  const retiring = new Set<Promise<void>>();
  /** Closes a replaced server when its last request is done (or after `drainMs`). */
  function retire(generation: Generation): Promise<void> {
    generation.closed ??= (async () => {
      const deadline = Date.now() + drainMs;
      while (generation.inflight > 0 && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 25));
      await generation.server.close();
    })();
    return generation.closed;
  }

  async function rebuild(): Promise<boolean> {
    if (closing !== undefined) return false;
    const { digest } = await installedDigest(probe);
    if (digest === current.digest) return false;
    let next: Generation;
    try {
      next = await build();
    } catch (error) {
      current.server.app.log.error({ err: error }, 'rebuilding for the new installed apps failed');
      return false;
    }
    const previous = current;
    current = next;
    previous.retired = true;
    current.server.app.log.info(
      { generation: current.number, modules: current.server.registry.loaded.modules.length },
      'serving the new installed apps',
    );
    const done = retire(previous).finally(() => retiring.delete(done));
    retiring.add(done);
    return true;
  }

  current = await build();
  let reloading: Promise<boolean> = Promise.resolve(false);
  let closing: Promise<void> | undefined;
  const http = createHttpServer((req, res) => host.handle(req, res));
  const listener = listen
    ? pg.createDriver({ url: options.databaseUrl, max: 1, applicationName: 'kosh apps listener' })
    : undefined;
  const stopListening = await listener?.listen(APPS_CHANNEL, (digest) => {
    if (digest !== current.digest) void host.reload();
  });
  return host;
}

/** Listens and shuts down gracefully on SIGTERM / SIGINT (in-flight requests finish first). */
export async function startAppHost(
  host: AppHost,
  options: {
    readonly port?: number;
    readonly host?: string;
    readonly onShutdown?: () => Promise<void>;
  } = {},
): Promise<string> {
  const address = await host.listen({
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.host === undefined ? {} : { host: options.host }),
  });
  const stop = (signal: string): void => {
    host.server.app.log.info({ signal }, 'shutting down');
    void host
      .close()
      .then(() => options.onShutdown?.())
      .finally(() => process.exit(0));
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
  return address;
}
