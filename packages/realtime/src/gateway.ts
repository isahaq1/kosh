/**
 * The WebSocket gateway (RFC 0006 §5, RFC 0010 Phase B): `GET /api/v1/realtime` upgrades a signed-in user's
 * connection. The browser subscribes to channels and the gateway pushes:
 *
 * - **changes**: which records of a model changed (`model:<name>`, or one record: `record:<name>:<id>`), announced by
 *   the server after each commit (`NOTIFY kosh_changes`, `announceChange`). Subscribing to a model needs read access
 *   to it; to a record, the record rules must allow reading it. A change carries the model, the ids, the operation and
 *   the user, never the data: clients refetch through the API.
 * - **presence**: who else has a record open. Each browser says what it is viewing; the gateway shares that with the
 *   other nodes through `NOTIFY kosh_presence` and tells the subscribers of the record. Entries not refreshed within
 *   90 s are dropped, so a node that dies leaves no ghosts.
 *
 * PostgreSQL notifications reach every node connected to the database, so a cluster needs no other bus.
 *
 * Client → gateway messages (JSON): `{ type: 'subscribe', channels }`, `{ type: 'unsubscribe', channels }`,
 * `{ type: 'presence', model, id }` (or `model: null` to leave), `{ type: 'typing', model, id }` (a chat channel
 * the client is subscribed to), `{ type: 'ping' }`.
 * Gateway → client: `{ type: 'change', model, ids, op, by, at }`, `{ type: 'presence', model, id, users }`,
 * `{ type: 'typing', model, id, uid, name }`, `{ type: 'error', channel, reason }`, `{ type: 'pong' }`.
 */
import { randomUUID } from 'node:crypto';
import websocket, { type WebSocket } from '@fastify/websocket';
import {
  CHANGES_CHANNEL,
  type ModuleContext,
  parseChange,
  type RecordChange,
  type RequestIdentity,
  runOptionsOf,
} from '@kosh/server';
import type { Env } from '@kosh/server/orm';
import type { FastifyRequest } from 'fastify';

/** The PostgreSQL channel of presence changes. */
export const PRESENCE_CHANNEL = 'kosh_presence';
/** Subscriptions one connection may hold. */
export const MAX_SUBSCRIPTIONS = 100;
/** A presence entry not refreshed within this time is dropped. */
export const PRESENCE_TTL_MS = 90_000;

const CHANNEL =
  /^(model:[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+|record:[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+:[1-9]\d{0,15})$/;

/** A user present on a record. */
export interface PresenceUser {
  readonly uid: number;
  readonly name: string;
}

interface PresenceNote {
  readonly model: string;
  readonly id: number;
  readonly uid: number;
  readonly name: string;
  readonly on: boolean;
  readonly node: string;
  readonly at: number;
}

interface Client {
  readonly socket: WebSocket;
  readonly identity: RequestIdentity;
  readonly request: FastifyRequest;
  name: string;
  /** Resolves with the user's name (loaded after the connection is up). */
  named: Promise<string>;
  readonly channels: Set<string>;
  presence: { model: string; id: number } | null;
}

type ClientMessage =
  | { readonly type: 'subscribe' | 'unsubscribe'; readonly channels: readonly string[] }
  | { readonly type: 'presence'; readonly model: string | null; readonly id?: number }
  | { readonly type: 'typing'; readonly model: string; readonly id: number }
  | { readonly type: 'ping' };

function parseMessage(raw: string): ClientMessage | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value['type'] === 'ping') return { type: 'ping' };
    if (value['type'] === 'subscribe' || value['type'] === 'unsubscribe') {
      const channels = value['channels'];
      if (!Array.isArray(channels) || channels.length > MAX_SUBSCRIPTIONS) return null;
      if (!channels.every((c) => typeof c === 'string' && CHANNEL.test(c))) return null;
      return { type: value['type'], channels: channels as string[] };
    }
    if (value['type'] === 'typing') {
      const id = value['id'];
      if (typeof value['model'] !== 'string' || !Number.isSafeInteger(id) || (id as number) <= 0)
        return null;
      return { type: 'typing', model: value['model'], id: id as number };
    }
    if (value['type'] === 'presence') {
      if (value['model'] === null) return { type: 'presence', model: null };
      const id = value['id'];
      if (typeof value['model'] !== 'string' || !Number.isSafeInteger(id) || (id as number) <= 0)
        return null;
      return { type: 'presence', model: value['model'], id: id as number };
    }
    return null;
  } catch {
    return null;
  }
}

/** The gateway of one server: its clients, their subscriptions and what it knows of presence. */
export class Gateway {
  readonly node: string = randomUUID();
  readonly #clients = new Set<Client>();
  /** `model:id` → user → (name, last refresh, the nodes where the user has it open). */
  readonly #presence = new Map<
    string,
    Map<number, { name: string; at: number; nodes: Set<string> }>
  >();
  readonly #context: ModuleContext;
  #stops: (() => Promise<void>)[] = [];
  #sweeper: NodeJS.Timeout | undefined;

  constructor(context: ModuleContext) {
    this.#context = context;
  }

  /** Listens on the database channels; call once, before serving. */
  async start(): Promise<void> {
    const { driver } = this.#context;
    this.#stops.push(
      await driver.listen(CHANGES_CHANNEL, (payload) => {
        const change = parseChange(payload);
        if (change !== null) this.#deliverChange(change);
      }),
      await driver.listen(PRESENCE_CHANNEL, (payload) => {
        const note = parsePresence(payload);
        if (note !== null) this.#applyPresence(note);
      }),
    );
    this.#sweeper = setInterval(() => this.#sweep(), PRESENCE_TTL_MS / 3);
    this.#sweeper.unref();
  }

  async stop(): Promise<void> {
    if (this.#sweeper !== undefined) clearInterval(this.#sweeper);
    for (const client of this.#clients) client.socket.close(1001, 'server shutting down');
    await Promise.all(this.#stops.map((stop) => stop()));
    this.#stops = [];
  }

  /** How many connections are open (health, tests). */
  get connections(): number {
    return this.#clients.size;
  }

  /** Serves one connection. */
  async connect(socket: WebSocket, request: FastifyRequest): Promise<void> {
    const identity = request.identity;
    if (identity === null) {
      socket.close(4401, 'sign in first');
      return;
    }
    const client: Client = {
      socket,
      identity,
      request,
      name: '',
      named: Promise.resolve(''),
      channels: new Set(),
      presence: null,
    };
    this.#clients.add(client);
    // Listeners first: what the browser sends right after opening must not be lost while the name loads.
    socket.on('message', (raw) => {
      void this.#onMessage(client, raw.toString());
    });
    client.named = this.#as(client, async (env) => {
      const users = env.model('res.users' as never) as unknown as {
        browse(ids: number[]): {
          load(k: string[]): Promise<{ read(k: string[]): { name: string }[] }>;
        };
      };
      return (await users.browse([identity.user]).load(['name'])).read(['name'])[0]?.name ?? '';
    })
      .catch(() => '')
      .then((name) => {
        client.name = name;
        return name;
      });
    socket.on('close', () => {
      this.#clients.delete(client);
      if (client.presence !== null) void this.#notifyPresence(client, client.presence, false);
    });
    socket.on('error', () => socket.close());
  }

  async #onMessage(client: Client, raw: string): Promise<void> {
    const message = parseMessage(raw);
    if (message === null) {
      send(client, { type: 'error', channel: null, reason: 'invalid message' });
      return;
    }
    switch (message.type) {
      case 'ping':
        send(client, { type: 'pong' });
        return;
      case 'unsubscribe':
        for (const c of message.channels) client.channels.delete(c);
        return;
      case 'subscribe':
        for (const channel of message.channels) {
          if (client.channels.has(channel)) continue;
          if (client.channels.size >= MAX_SUBSCRIPTIONS) {
            send(client, { type: 'error', channel, reason: 'too many subscriptions' });
            continue;
          }
          if (await this.#mayRead(client, channel)) {
            client.channels.add(channel);
            const record = recordOf(channel);
            if (record !== null) send(client, this.#presenceMessage(record.model, record.id));
          } else send(client, { type: 'error', channel, reason: 'not allowed' });
        }
        return;
      case 'typing': {
        // Relayed to the record's subscribers on this node (a chat channel: its members), never stored. The
        // sender proves membership by being subscribed itself.
        const channel = `record:${message.model}:${message.id}`;
        if (!client.channels.has(channel)) return;
        await client.named;
        const typing = {
          type: 'typing',
          model: message.model,
          id: message.id,
          uid: client.identity.user,
          name: client.name,
        };
        for (const other of this.#clients)
          if (other !== client && other.channels.has(channel)) send(other, typing);
        return;
      }
      case 'presence': {
        const previous = client.presence;
        if (message.model === null) {
          client.presence = null;
          if (previous !== null) await this.#notifyPresence(client, previous, false);
          return;
        }
        const next = { model: message.model, id: message.id as number };
        if (!(await this.#mayRead(client, `record:${next.model}:${next.id}`))) {
          send(client, {
            type: 'error',
            channel: `record:${next.model}:${next.id}`,
            reason: 'not allowed',
          });
          return;
        }
        client.presence = next;
        if (previous !== null && (previous.model !== next.model || previous.id !== next.id))
          await this.#notifyPresence(client, previous, false);
        await this.#notifyPresence(client, next, true);
        return;
      }
    }
  }

  /** Runs `fn` as the client's user (the same environment a request of theirs would get). */
  #as<T>(client: Client, fn: (env: Env) => Promise<T>): Promise<T> {
    return this.#context.shutro.run(
      { ...runOptionsOf(client.request, client.identity), readOnly: false },
      fn,
    );
  }

  /** Read access for a channel: the model's ACL, and for a record its rules too. */
  async #mayRead(client: Client, channel: string): Promise<boolean> {
    const record = recordOf(channel);
    const model = record === null ? channel.slice('model:'.length) : record.model;
    try {
      return await this.#as(client, async (env) => {
        if (!env.access.can(model as never, 'read')) return false;
        if (record !== null) await env.access.checkRecords(model as never, [record.id], 'read');
        return true;
      });
    } catch {
      return false;
    }
  }

  #deliverChange(change: RecordChange): void {
    const message = { type: 'change', ...change };
    for (const client of this.#clients) {
      if (client.channels.has(`model:${change.model}`)) {
        send(client, message);
        continue;
      }
      const concerned =
        change.ids.length === 0
          ? [...client.channels].some((c) => c.startsWith(`record:${change.model}:`))
          : change.ids.some((id) => client.channels.has(`record:${change.model}:${id}`));
      if (concerned) send(client, message);
    }
  }

  async #notifyPresence(
    client: Client,
    where: { model: string; id: number },
    on: boolean,
  ): Promise<void> {
    await client.named; // presence carries the name
    const note: PresenceNote = {
      model: where.model,
      id: where.id,
      uid: client.identity.user,
      name: client.name,
      on,
      node: this.node,
      at: Date.now(),
    };
    await this.#context.driver
      .query({ text: 'SELECT pg_notify($1, $2)', params: [PRESENCE_CHANNEL, JSON.stringify(note)] })
      .catch((error: unknown) =>
        this.#context.app.log.warn({ err: error }, 'presence notify failed'),
      );
  }

  #applyPresence(note: PresenceNote): void {
    const key = `${note.model}:${note.id}`;
    const users =
      this.#presence.get(key) ??
      new Map<number, { name: string; at: number; nodes: Set<string> }>();
    const entry = users.get(note.uid) ?? { name: note.name, at: note.at, nodes: new Set<string>() };
    if (note.on) {
      entry.nodes.add(note.node);
      entry.at = note.at;
      entry.name = note.name;
      users.set(note.uid, entry);
    } else {
      entry.nodes.delete(note.node);
      if (entry.nodes.size === 0) users.delete(note.uid);
    }
    if (users.size === 0) this.#presence.delete(key);
    else this.#presence.set(key, users);
    this.#broadcastPresence(note.model, note.id);
  }

  #sweep(): void {
    const cutoff = Date.now() - PRESENCE_TTL_MS;
    for (const [key, users] of this.#presence) {
      let changed = false;
      for (const [uid, entry] of users)
        if (entry.at < cutoff) {
          users.delete(uid);
          changed = true;
        }
      if (users.size === 0) this.#presence.delete(key);
      if (changed) {
        const [model, id] = [
          key.slice(0, key.lastIndexOf(':')),
          Number(key.slice(key.lastIndexOf(':') + 1)),
        ];
        this.#broadcastPresence(model, id);
      }
    }
    // Clients refresh their own presence every 30 s; the gateway refreshes what it knows of them too.
    for (const client of this.#clients)
      if (client.presence !== null) void this.#notifyPresence(client, client.presence, true);
  }

  #presenceMessage(model: string, id: number) {
    const users: PresenceUser[] = [
      ...(this.#presence.get(`${model}:${id}`) ?? new Map()).entries(),
    ].map(([uid, entry]) => ({ uid, name: entry.name }));
    return { type: 'presence', model, id, users };
  }

  #broadcastPresence(model: string, id: number): void {
    const channel = `record:${model}:${id}`;
    const message = this.#presenceMessage(model, id);
    for (const client of this.#clients) if (client.channels.has(channel)) send(client, message);
  }
}

function recordOf(channel: string): { model: string; id: number } | null {
  if (!channel.startsWith('record:')) return null;
  const at = channel.lastIndexOf(':');
  return { model: channel.slice('record:'.length, at), id: Number(channel.slice(at + 1)) };
}

function parsePresence(payload: string): PresenceNote | null {
  try {
    const v = JSON.parse(payload) as Partial<PresenceNote>;
    if (
      typeof v.model !== 'string' ||
      typeof v.id !== 'number' ||
      typeof v.uid !== 'number' ||
      typeof v.name !== 'string' ||
      typeof v.on !== 'boolean' ||
      typeof v.node !== 'string' ||
      typeof v.at !== 'number'
    )
      return null;
    return { model: v.model, id: v.id, uid: v.uid, name: v.name, on: v.on, node: v.node, at: v.at };
  } catch {
    return null;
  }
}

function send(client: Client, message: unknown): void {
  if (client.socket.readyState === client.socket.OPEN) client.socket.send(JSON.stringify(message));
}

/** Registers the gateway on the server: the WebSocket route, and the database listeners until the app closes. */
export async function registerRealtime(context: ModuleContext): Promise<Gateway> {
  const { app } = context;
  const gateway = new Gateway(context);
  await app.register(websocket, { options: { maxPayload: 16 * 1024 } });
  await gateway.start();
  app.addHook('onClose', async () => gateway.stop());
  app.get('/api/v1/realtime', { websocket: true }, (socket, request) => {
    void gateway.connect(socket, request);
  });
  return gateway;
}
