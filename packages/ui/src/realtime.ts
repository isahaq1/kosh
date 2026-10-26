/**
 * The browser side of the realtime gateway (`@kosh/realtime`): one WebSocket per tab, reconnecting with backoff,
 * that re-subscribes everything after a reconnect. Screens subscribe to a model or a record and get told when it
 * changed (they refetch through the API) and who else has a record open. Without a server that offers the gateway,
 * the client stays quiet: screens simply do not update live.
 */

export interface ChangeEvent {
  readonly model: string;
  /** Empty: many records of the model. */
  readonly ids: readonly number[];
  readonly op: 'create' | 'update' | 'delete';
  readonly by: number;
  readonly at: number;
}
export interface PresenceUser {
  readonly uid: number;
  readonly name: string;
}

export interface RealtimeClient {
  /** Told of changes on the channel (`model:<name>` or `record:<name>:<id>`); returns the way to stop. */
  subscribe(channel: string, handler: (event: ChangeEvent) => void): () => void;
  /** Told who has the record open (needs a subscription to the record's channel to receive anything). */
  onPresence(
    model: string,
    id: number,
    handler: (users: readonly PresenceUser[]) => void,
  ): () => void;
  /** Says this tab has the record open; returns the way to leave. One record per tab. */
  setPresence(model: string, id: number): () => void;
  /** Told that someone is typing on a record (a chat channel) this tab is subscribed to. */
  onTyping(model: string, id: number, handler: (user: PresenceUser) => void): () => void;
  /** Says this user is typing on a record (a chat channel) this tab is subscribed to. */
  sendTyping(model: string, id: number): void;
  readonly connected: boolean;
  close(): void;
}

export interface RealtimeOptions {
  /** Default: `/api/v1/realtime` on the page's origin. */
  readonly url?: string;
  readonly WebSocket?: typeof WebSocket;
}

const HEARTBEAT_MS = 25_000;
const MAX_BACKOFF_MS = 30_000;

/** Creates the client and connects. */
export function createRealtimeClient(options: RealtimeOptions = {}): RealtimeClient {
  const Impl = options.WebSocket ?? globalThis.WebSocket;
  const url =
    options.url ??
    `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v1/realtime`;
  const channels = new Map<string, Set<(event: ChangeEvent) => void>>();
  const presenceHandlers = new Map<string, Set<(users: readonly PresenceUser[]) => void>>();
  const typingHandlers = new Map<string, Set<(user: PresenceUser) => void>>();
  let presence: { model: string; id: number } | null = null;
  let socket: WebSocket | null = null;
  let closed = false;
  let attempts = 0;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const send = (message: unknown) => {
    if (socket !== null && socket.readyState === Impl.OPEN) socket.send(JSON.stringify(message));
  };
  const connect = () => {
    if (closed) return;
    socket = new Impl(url);
    socket.onopen = () => {
      attempts = 0;
      if (channels.size > 0) send({ type: 'subscribe', channels: [...channels.keys()] });
      if (presence !== null) send({ type: 'presence', ...presence });
      heartbeat = setInterval(() => {
        send({ type: 'ping' });
        if (presence !== null) send({ type: 'presence', ...presence });
      }, HEARTBEAT_MS);
    };
    socket.onmessage = (e) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(String(e.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (message['type'] === 'change') {
        const event = message as unknown as ChangeEvent;
        for (const [channel, handlers] of channels) {
          const [kind, model, id] = channel.split(':');
          if (model !== event.model) continue;
          if (kind === 'model' || event.ids.length === 0 || event.ids.includes(Number(id)))
            for (const handler of handlers) handler(event);
        }
      } else if (message['type'] === 'presence') {
        const key = `${String(message['model'])}:${String(message['id'])}`;
        for (const handler of presenceHandlers.get(key) ?? [])
          handler((message['users'] as PresenceUser[] | undefined) ?? []);
      } else if (message['type'] === 'typing') {
        const key = `${String(message['model'])}:${String(message['id'])}`;
        const user = { uid: Number(message['uid']), name: String(message['name'] ?? '') };
        for (const handler of typingHandlers.get(key) ?? []) handler(user);
      }
    };
    socket.onclose = (e) => {
      if (heartbeat !== undefined) clearInterval(heartbeat);
      socket = null;
      // 4401: not signed in. The page will send the user to sign in; no point retrying.
      if (closed || e.code === 4401) return;
      attempts += 1;
      setTimeout(connect, Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(attempts, 5)));
    };
    socket.onerror = () => socket?.close();
  };
  connect();

  return {
    get connected() {
      return socket !== null && socket.readyState === Impl.OPEN;
    },
    subscribe(channel, handler) {
      let handlers = channels.get(channel);
      if (handlers === undefined) {
        handlers = new Set();
        channels.set(channel, handlers);
        send({ type: 'subscribe', channels: [channel] });
      }
      handlers.add(handler);
      return () => {
        handlers?.delete(handler);
        if (handlers?.size === 0) {
          channels.delete(channel);
          send({ type: 'unsubscribe', channels: [channel] });
        }
      };
    },
    onPresence(model, id, handler) {
      const key = `${model}:${id}`;
      const handlers = presenceHandlers.get(key) ?? new Set();
      handlers.add(handler);
      presenceHandlers.set(key, handlers);
      return () => {
        handlers.delete(handler);
        if (handlers.size === 0) presenceHandlers.delete(key);
      };
    },
    onTyping(model, id, handler) {
      const key = `${model}:${id}`;
      const handlers = typingHandlers.get(key) ?? new Set();
      handlers.add(handler);
      typingHandlers.set(key, handlers);
      return () => {
        handlers.delete(handler);
        if (handlers.size === 0) typingHandlers.delete(key);
      };
    },
    sendTyping(model, id) {
      send({ type: 'typing', model, id });
    },
    setPresence(model, id) {
      presence = { model, id };
      send({ type: 'presence', model, id });
      return () => {
        if (presence?.model === model && presence.id === id) {
          presence = null;
          send({ type: 'presence', model: null });
        }
      };
    },
    close() {
      closed = true;
      if (heartbeat !== undefined) clearInterval(heartbeat);
      socket?.close(1000, 'page closed');
    },
  };
}
