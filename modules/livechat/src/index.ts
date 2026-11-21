/**
 * @packageDocumentation
 * `@kosh/livechat` (RFC 0034 §2.6): the **Live chat** app. A site offers a chat; the operators who are there
 * answer it from their inbox; every conversation is kept, with how long the visitor waited and what they thought.
 *
 * For a visitor, without a sign-in (the conversation is theirs by the secret `POST …/sessions` gives once, sent
 * back as `x-chat-secret`):
 * - `GET  /api/v1/public/livechat/:key`                          the channel: its name, texts, whether someone is there
 * - `GET  /api/v1/public/livechat/:key/widget`                   the chat window (English or Bangla)
 * - `POST /api/v1/public/livechat/:key/sessions`                 `{ message, name?, email?, page? }` — starts one
 * - `GET  /api/v1/public/livechat/:key/sessions/current?after=`  its state and the messages after one
 * - `POST /api/v1/public/livechat/:key/sessions/current/messages` `{ body }`
 * - `POST /api/v1/public/livechat/:key/sessions/current/close`   `{ rating? }` — ends it, or rates one that ended
 *
 * For operators:
 * - `GET  /api/v1/livechat/inbox`                  my conversations and those that wait; says "I am here"
 * - `PUT  /api/v1/livechat/presence`               `{ available }`
 * - `GET  /api/v1/livechat/sessions/:id?after=`    a conversation of my channels
 * - `POST /api/v1/livechat/sessions/:id/take` · `…/messages` `{ body }` · `…/close`
 * - `GET  /api/v1/livechat/targets`                what a conversation may become, with the installed apps
 * - `POST /api/v1/livechat/sessions/:id/route`     `{ target }` — an ended conversation becomes a record, once
 */
import { randomBytes } from 'node:crypto';
import { contacts } from '@kosh/contacts';
import { messaging } from '@kosh/messaging';
import { defineModule } from '@kosh/modules-sdk';
import { reporting } from '@kosh/reporting';
import { HttpProblem, type ModuleContext } from '@kosh/server';
import type { Worker } from '@kosh/server/orm';
import { action, form, list, pivot, search } from '@kosh/views';
import type { Env } from './.kosh/bindings.js';
import { livechatDemo } from './demo.js';
import {
  channelInfo,
  endSession,
  inboxOf,
  LivechatChannel,
  LivechatMessage,
  LivechatPresence,
  LivechatRule,
  LivechatSession,
  livechatShutro,
  type Refused,
  routeSession,
  routeTargets,
  say,
  sessionOf,
  sessionView,
  setPresence,
  startSession,
  sweepSessions,
  takeSession,
} from './module.js';
import { framedBy, pageLanguage, pageSecurity, renderUnknown, renderWidget } from './page.js';

export {
  type AssignRule,
  cleanText,
  firstName,
  isThere,
  keywordsOf,
  type Line,
  MAX_MESSAGE,
  MAX_MESSAGES,
  type Operator,
  overdue,
  PRESENCE_TTL_MS,
  pickOperator,
  pickRule,
  type RouteRule,
  subjectOf,
  transcriptOf,
  waited,
} from './engine.js';
export {
  type ChannelInfo,
  channelInfo,
  endSession,
  type InboxRow,
  inboxOf,
  LivechatChannel,
  LivechatMessage,
  LivechatPresence,
  LivechatRule,
  LivechatSession,
  livechatShutro,
  type Refused,
  type Routed,
  routeSession,
  routeTargets,
  type SessionView,
  say,
  sessionOf,
  sessionView,
  setPresence,
  startSession,
  sweepSessions,
  takeSession,
  widgetPath,
} from './module.js';

/** The worker that makes a conversation which ended what its channel's rules say; tests `drain()` it. */
export function livechatWorkers(context: Pick<ModuleContext, 'shutro'>): Worker[] {
  const route = (name: string, topic: string): Worker =>
    context.shutro.subscribe(
      name,
      topic,
      async (event, env) => {
        const id = Number((event.payload as { id?: unknown } | null)?.id);
        if (!Number.isInteger(id)) return;
        await (env as unknown as Env).asSuperuser({ reason: 'a chat routed by its rules' }, (su) =>
          routeSession(su, id),
        );
      },
      { pollMs: 5000 },
    );
  return [
    route('livechat.route.closed', 'livechat.session.closed'),
    route('livechat.route.missed', 'livechat.session.missed'),
  ];
}

const SAID = {
  unknown: [404, 'No such conversation.'],
  ended: [409, 'This conversation has ended.'],
  full: [409, 'This conversation is full: start a new one.'],
  'not-yours': [403, 'This conversation is not yours.'],
} as const;

/** What a refusal is over HTTP. */
function problem(refused: Refused): HttpProblem {
  if (refused.why === 'invalid')
    return new HttpProblem(422, `livechat-${refused.field}`, 'Another look', refused.say);
  const [status, detail] = SAID[refused.why];
  return new HttpProblem(status, `livechat-${refused.why}`, 'Live chat', detail);
}

function registerLivechatRoutes(context: ModuleContext, sweeps: boolean): void {
  const { app, shutro } = context;
  // A visitor has no account, and many share an address: starting conversations is limited more than reading.
  const pub = { config: { auth: false } };
  const starting = {
    config: { auth: false, rateLimit: { max: 12, timeWindow: '1 minute' } },
    bodyLimit: 16 * 1024,
  };
  const writing = { ...pub, bodyLimit: 16 * 1024 };
  const base = '/api/v1/public/livechat/:key';
  const keyOf = (params: unknown): string =>
    String((params as { key?: unknown }).key ?? '').slice(0, 60);
  const secretOf = (headers: Record<string, unknown>): string =>
    String(headers['x-chat-secret'] ?? '').slice(0, 100);
  // Everything a visitor does is done as the system, by the channel's key and their secret.
  const asSystem = <T>(
    reason: string,
    fn: (env: Env) => Promise<T>,
    company?: number,
  ): Promise<T> =>
    shutro.bootstrap({ reason, ...(company === undefined ? {} : { company }) }, (env) =>
      fn(env as unknown as Env),
    );
  const unknown = (): HttpProblem =>
    new HttpProblem(404, 'livechat-unknown', 'Live chat', 'This link does not open a chat.');
  /** The visitor's conversation, or 404 — the same answer whatever was wrong. */
  const mine = async (env: Env, request: { params: unknown; headers: unknown }) => {
    const id = await sessionOf(
      env,
      keyOf(request.params),
      secretOf(request.headers as Record<string, unknown>),
    );
    if (id === null) throw unknown();
    return id;
  };

  app.get(base, pub, async (request, reply) => {
    const info = await asSystem('a chat channel shown', (env) =>
      channelInfo(env, keyOf(request.params)),
    );
    if (info === null) throw unknown();
    void reply.header('cache-control', 'no-store');
    return { name: info.name, welcome: info.welcome, offline: info.offline, online: info.online };
  });

  app.get(`${base}/widget`, pub, async (request, reply) => {
    const key = keyOf(request.params);
    const query = request.query as { lang?: unknown; page?: unknown };
    const language = pageLanguage(query.lang, request.headers['accept-language']);
    const info = await asSystem('a chat window shown', (env) => channelInfo(env, key));
    const nonce = randomBytes(16).toString('base64');
    void reply
      .type('text/html; charset=utf-8')
      .headers(pageSecurity(nonce, framedBy(info?.origins)));
    if (info === null) return reply.code(404).send(renderUnknown(language));
    return reply.send(
      renderWidget(info, {
        key,
        base: `/api/v1/public/livechat/${encodeURIComponent(key)}`,
        language,
        nonce,
        page: typeof query.page === 'string' ? query.page.slice(0, 300) : '',
      }),
    );
  });

  app.post(`${base}/sessions`, starting, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const key = keyOf(request.params);
    const info = await asSystem('a chat channel shown', (env) => channelInfo(env, key));
    if (info === null) throw unknown();
    // A field people do not see: what fills it is not a person. It is told all went well, and nothing is kept.
    if (typeof body['website'] === 'string' && body['website'].trim() !== '')
      return reply.code(201).send({
        secret: randomBytes(24).toString('base64url'),
        online: info.online,
        session: { id: 0, state: 'waiting', operator: null, messages: [] },
      });
    const started = await asSystem(
      'a chat started by a visitor',
      async (env) => {
        const made = await startSession(env, key, {
          name: body['name'],
          email: body['email'],
          page: body['page'],
          lang: body['lang'],
          message: body['message'],
        });
        if (!made.ok) return made;
        return { ...made, view: await sessionView(env, made.session) };
      },
      info.company,
    );
    if (!started.ok) throw problem(started);
    return reply
      .code(201)
      .send({ secret: started.secret, online: started.online, session: started.view });
  });

  app.get(`${base}/sessions/current`, pub, async (request, reply) => {
    const after = Number((request.query as { after?: unknown }).after ?? 0);
    void reply.header('cache-control', 'no-store');
    return asSystem('a chat read by its visitor', async (env) =>
      sessionView(env, await mine(env, request), Number.isSafeInteger(after) ? after : 0),
    );
  });

  app.post(`${base}/sessions/current/messages`, writing, async (request, reply) => {
    const body = (request.body ?? {}) as { body?: unknown };
    const said = await asSystem('a chat message from a visitor', async (env) =>
      say(env, await mine(env, request), {}, body.body),
    );
    if (!said.ok) throw problem(said);
    return reply.code(201).send({ id: said.message });
  });

  app.post(`${base}/sessions/current/close`, writing, async (request) => {
    const body = (request.body ?? {}) as { rating?: unknown };
    return asSystem('a chat ended by its visitor', async (env) => {
      const id = await mine(env, request);
      const ended = await endSession(env, id, { rating: body.rating });
      if (!ended.ok) throw problem(ended);
      return sessionView(env, id);
    });
  });

  // ---- operators

  /** The caller is an operator; the work is then done as the system, for them. */
  const asOperator = <T>(
    request: {
      env: <R>(fn: (env: unknown) => Promise<R>, options?: { write: boolean }) => Promise<R>;
    },
    reason: string,
    fn: (su: Env, user: number, name: string) => Promise<T>,
    session?: number,
  ): Promise<T> =>
    request.env(
      async (raw) => {
        const env = raw as Env;
        if (!(env.administrator || env.groups.has('livechat.user')))
          throw new HttpProblem(403, 'access', 'Live chat', 'This needs a role of Live chat.');
        // Their own right to the conversation decides: its channel is one of theirs, or they manage Live chat.
        if (session !== undefined) {
          const seen = await env
            .model('livechat.session')
            .search({ where: { id: session as never }, limit: 1 });
          if (seen.length === 0)
            throw new HttpProblem(404, 'missing-record', 'Not found', 'No such conversation.');
        }
        const user = env.userId as number;
        return env.asSuperuser({ reason }, async (su) => {
          const [who] = await su
            .model('res.users')
            .browse([user as never])
            .load(['name']);
          return fn(su, user, who?.name ?? '');
        });
      },
      { write: true },
    );
  const idOf = (params: unknown): number => {
    const id = Number((params as { id?: unknown }).id);
    if (!Number.isSafeInteger(id) || id <= 0)
      throw new HttpProblem(400, 'bad-request', 'Which conversation', 'Give its id.');
    return id;
  };

  app.get('/api/v1/livechat/inbox', async (request) =>
    asOperator(request as never, 'a chat inbox open', async (su, user) => {
      await setPresence(su, user, undefined);
      return inboxOf(su, user);
    }),
  );

  app.put('/api/v1/livechat/presence', async (request) => {
    const available = (request.body as { available?: unknown } | null)?.available;
    if (typeof available !== 'boolean')
      throw new HttpProblem(400, 'invalid-input', 'Available', 'Send `available`: true or false.');
    return asOperator(request as never, 'an operator’s presence', async (su, user) => ({
      available: await setPresence(su, user, available),
    }));
  });

  app.get('/api/v1/livechat/sessions/:id', async (request) => {
    const id = idOf(request.params);
    const after = Number((request.query as { after?: unknown }).after ?? 0);
    return asOperator(
      request as never,
      'a chat read by an operator',
      (su) => sessionView(su, id, Number.isSafeInteger(after) ? after : 0),
      id,
    );
  });

  app.post('/api/v1/livechat/sessions/:id/take', async (request) => {
    const id = idOf(request.params);
    return asOperator(
      request as never,
      'a chat taken by an operator',
      async (su, user) => {
        const taken = await takeSession(su, id, user);
        if (!taken.ok) throw problem(taken);
        return sessionView(su, id);
      },
      id,
    );
  });

  app.post(
    '/api/v1/livechat/sessions/:id/messages',
    { bodyLimit: 16 * 1024 },
    async (request, reply) => {
      const id = idOf(request.params);
      const body = (request.body ?? {}) as { body?: unknown };
      const said = await asOperator(
        request as never,
        'a chat message from an operator',
        (su, user, name) => say(su, id, { user, name }, body.body),
        id,
      );
      if (!said.ok) throw problem(said);
      return reply.code(201).send({ id: said.message });
    },
  );

  app.post('/api/v1/livechat/sessions/:id/close', async (request) => {
    const id = idOf(request.params);
    return asOperator(
      request as never,
      'a chat ended by its operator',
      async (su, user) => {
        const ended = await endSession(su, id, { user });
        if (!ended.ok) throw problem(ended);
        return sessionView(su, id);
      },
      id,
    );
  });

  app.get('/api/v1/livechat/targets', async (request) =>
    asOperator(request as never, 'what a chat may become', async (su) => ({
      targets: await routeTargets(su),
    })),
  );

  app.post('/api/v1/livechat/sessions/:id/route', async (request) => {
    const id = idOf(request.params);
    const target = String((request.body as { target?: unknown } | null)?.target ?? '').slice(0, 80);
    return asOperator(
      request as never,
      'a chat made a record by an operator',
      async (su) => {
        if (!(await routeTargets(su)).includes(target))
          throw new HttpProblem(
            422,
            'livechat-target',
            'Another look',
            'No installed app makes that of a conversation.',
          );
        const routed = await routeSession(su, id, target);
        if (routed === null)
          throw new HttpProblem(
            409,
            'livechat-open',
            'Live chat',
            'A conversation becomes a record once it has ended.',
          );
        return routed;
      },
      id,
    );
  });

  if (!sweeps) return;
  const workers = livechatWorkers(context);
  for (const w of workers) w.start();
  app.addHook('onClose', async () => {
    for (const w of workers) await w.stop();
  });
  // Once a minute: what nobody answered is missed, what went quiet is closed. A second server finds nothing left.
  const timer = setInterval(() => {
    void asSystem('chats left alone', (env) => sweepSessions(env)).catch((error: unknown) =>
      app.log.warn({ err: error }, 'live chat conversations were not swept'),
    );
  }, 60_000);
  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));
}

export interface LivechatOptions {
  /** Run the once-a-minute round that ends conversations left alone (default: unless `KOSH_SCHEDULES=off`). */
  readonly workers?: boolean | undefined;
}

/** Live chat with explicit options (tests: the round run by hand). */
export function livechatModule(options: LivechatOptions = {}): ReturnType<typeof defineModule> {
  return defineModule({
    shutro: livechatShutro,
    kosh: '^0.1.0',
    hooks: { demo: livechatDemo },
    depends: [contacts, messaging, reporting],
    app: {
      code: 'livechat',
      label: 'Live chat',
      icon: 'livechat',
      sequence: 63,
      category: 'Marketing',
      summary:
        'A chat your site offers, answered by the operators who are there, every conversation kept',
    },
    // Bangla for the labels it serves (RFC 0023 §3.1; `pnpm i18n:extract`).
    i18n: { bn: () => import('./i18n/bn.js') },
    accessLevels: {
      user: { label: 'Operator (answers the channels they are on)', groups: ['livechat.user'] },
      manager: { label: 'Manager (channels, every conversation)', groups: ['livechat.manager'] },
    },
    routes: (context: ModuleContext) =>
      registerLivechatRoutes(context, options.workers ?? process.env['KOSH_SCHEDULES'] !== 'off'),
    // Exceptions to the module standard (RFC 0023), each with its reason.
    standard: {
      waive: [
        {
          rule: 'I1',
          model: 'livechat.session',
          reason:
            'A conversation is what a visitor and an operator said; there is nothing to import.',
        },
      ],
    },
    events: [
      { topic: 'livechat.session.closed', model: 'livechat.session', label: 'Chat ended' },
      {
        topic: 'livechat.session.missed',
        model: 'livechat.session',
        label: 'Chat missed (nobody answered in time)',
      },
    ],
    documents: [
      {
        key: 'livechat_transcript',
        name: 'Chat transcript',
        model: 'livechat.session',
        layout: {
          paper: 'A4',
          header: '{{company.name}}',
          footer: 'Page {{page}} of {{pages}}',
          blocks: [
            { kind: 'heading', id: 'title', text: 'Conversation {{name}}', level: 1 },
            {
              kind: 'fields',
              id: 'who',
              items: [
                { label: 'Channel', bind: 'channel.name' },
                { label: 'Visitor', bind: 'visitorName' },
                { label: 'Email', bind: 'visitorEmail' },
                { label: 'Operator', bind: 'operator.name' },
                { label: 'Started', bind: 'startedAt' },
                { label: 'Waited (seconds)', bind: 'waitSeconds' },
                { label: 'Rating', bind: 'rating' },
              ],
            },
            {
              kind: 'table',
              id: 'messages',
              bind: 'messages',
              columns: [
                { label: 'At', bind: 'at' },
                { label: 'From', bind: 'kind' },
                { label: 'Name', bind: 'author' },
                { label: 'Message', bind: 'body' },
              ],
            },
          ],
        },
      },
    ],
    importTemplates: [
      {
        key: 'livechat_channel',
        model: 'livechat.channel',
        label: 'Chat channels',
        columns: [
          { header: 'Name', field: 'name' },
          { header: 'Given out', field: 'assignment' },
          { header: 'Conversations at once', field: 'limit' },
          { header: 'Welcome', field: 'welcome' },
          { header: 'When nobody is there', field: 'offline' },
        ],
      },
      {
        key: 'livechat_rule',
        model: 'livechat.rule',
        label: 'Chat routing rules',
        columns: [
          { header: 'Name', field: 'name' },
          { header: 'Channel', field: 'channel' },
          { header: 'When it', field: 'on' },
          { header: 'And the visitor wrote', field: 'keywords' },
          { header: 'It becomes', field: 'target' },
        ],
      },
    ],
    // The Overview (RFC 0022 step 2): who waits now, and how the month went.
    overview: {
      cards: [
        {
          id: 'waiting',
          title: 'Waiting now',
          kind: 'kpi',
          model: 'livechat.session',
          measure: 'count',
          filter: { state: 'waiting' },
          w: 3,
        },
        {
          id: 'month',
          title: 'Conversations this month',
          kind: 'kpi',
          model: 'livechat.session',
          measure: 'count',
          comparison: { field: 'startedAt', mode: 'previous' },
          w: 3,
        },
        {
          id: 'wait',
          title: 'Average wait (seconds)',
          kind: 'kpi',
          model: 'livechat.session',
          measure: 'avg:waitSeconds',
          w: 3,
        },
        {
          id: 'rating',
          title: 'Average rating',
          kind: 'kpi',
          model: 'livechat.session',
          measure: 'avg:rating',
          w: 3,
        },
        {
          id: 'by_state',
          title: 'Conversations by outcome',
          kind: 'chart',
          model: 'livechat.session',
          measure: 'count',
          groupBy: 'state',
          chart: 'bar',
          w: 6,
        },
        {
          id: 'by_month',
          title: 'Conversations by month',
          kind: 'chart',
          model: 'livechat.session',
          measure: 'count',
          groupBy: 'startedAt:month',
          chart: 'line',
          w: 6,
        },
        {
          id: 'by_operator',
          title: 'By operator',
          kind: 'pivot',
          model: 'livechat.session',
          measure: 'count',
          groupBy: 'operator',
          w: 12,
        },
      ],
    },
    actions: {
      'livechat.action_inbox': { type: 'client', page: 'livechat.Inbox', label: 'Inbox' },
      'livechat.action_sessions': action(LivechatSession, {
        label: 'Conversations',
        views: ['list', 'form', 'pivot'],
      }),
      'livechat.action_channels': action(LivechatChannel, {
        label: 'Channels',
        views: ['list', 'form'],
      }),
      'livechat.action_rules': action(LivechatRule, {
        label: 'Routing rules',
        views: ['list', 'form'],
      }),
      'livechat.action_messages': action(LivechatMessage, {
        label: 'Messages',
        views: ['list', 'form'],
      }),
      'livechat.action_presence': action(LivechatPresence, {
        label: 'Operators',
        views: ['list', 'form'],
      }),
    },
    menus: [
      { id: 'livechat.root', label: 'Live chat', app: 'livechat' },
      {
        id: 'livechat.inbox',
        parent: 'livechat.root',
        label: 'Inbox',
        action: 'livechat.action_inbox',
        sequence: 1,
      },
      {
        id: 'livechat.sessions',
        parent: 'livechat.root',
        label: 'Conversations',
        action: 'livechat.action_sessions',
        sequence: 2,
      },
      { id: 'livechat.config', parent: 'livechat.root', label: 'Configuration', sequence: 9 },
      {
        id: 'livechat.channels',
        parent: 'livechat.config',
        label: 'Channels',
        action: 'livechat.action_channels',
        sequence: 1,
      },
      {
        id: 'livechat.rules',
        parent: 'livechat.config',
        label: 'Routing rules',
        action: 'livechat.action_rules',
        sequence: 2,
      },
      {
        id: 'livechat.presence',
        parent: 'livechat.config',
        label: 'Operators',
        action: 'livechat.action_presence',
        sequence: 3,
      },
    ],
    views: {
      'livechat.channel.list': list(LivechatChannel, {
        columns: ['name', 'assignment', 'limit', 'operators', 'link'],
      }),
      'livechat.channel.form': form(LivechatChannel, (k) => ({
        header: { buttons: [] },
        sheet: [
          k.stats('related', [
            {
              id: 'channel_sessions',
              label: 'Conversations',
              model: LivechatSession,
              where: { channel: { $record: 'id' } },
              action: 'livechat.action_sessions',
            },
          ]),
          k.group('main', ['name', 'operators', 'assignment', 'limit'], {
            description:
              'The operators answer from Live chat › Inbox. A conversation goes to one who is there — their inbox open, taking conversations — or waits for one to take it.',
          }),
          k.group('texts', ['welcome', 'offline'], { label: 'What visitors read' }),
          k.group('time', ['missAfterMin', 'closeAfterMin'], { label: 'Left alone' }),
          k.lines('rules', [
            { field: 'sequence', id: 'rule_sequence' },
            { field: 'name', id: 'rule_name' },
            { field: 'on', id: 'rule_on' },
            { field: 'keywords', id: 'rule_keywords' },
            { field: 'page', id: 'rule_page' },
            { field: 'target', id: 'rule_target' },
          ]),
          k.group('share', ['link', 'origins'], {
            label: 'On your site',
            description:
              'Add the chat window’s address to your server’s address and open it from a button of your site. To show it inside your pages, name the sites that may.',
          }),
        ],
      })),
      'livechat.presence.list': list(LivechatPresence, {
        columns: ['user', 'available', 'seenAt'],
      }),
      'livechat.presence.form': form(LivechatPresence, (k) => ({
        header: { buttons: [] },
        sheet: [k.group('main', ['user', 'available', 'seenAt'])],
      })),
      'livechat.session.list': list(LivechatSession, {
        columns: [
          'name',
          'channel',
          'visitorName',
          'visitorEmail',
          'operator',
          'startedAt',
          'waitSeconds',
          'messageCount',
          'resName',
          { field: 'rating', widget: 'rating' },
          { field: 'state', widget: 'badge' },
        ],
        decorations: {
          danger: { state: 'missed' },
          warning: { state: 'waiting' },
          neutral: { state: 'closed' },
        },
      }),
      'livechat.session.form': form(LivechatSession, (k) => ({
        header: { statusbar: 'state', buttons: [] },
        sheet: [
          k.group('main', ['name', 'channel', 'operator', 'visitorName', 'visitorEmail', 'page']),
          k.group(
            'times',
            ['startedAt', 'answeredAt', 'closedAt', 'waitSeconds', 'someoneThere', 'rating'],
            { label: 'How it went' },
          ),
          k.group('became', ['resName', 'resModel', 'resId', 'rule'], {
            label: 'What it became',
            description:
              'A conversation that ended becomes a ticket or a deal by its channel’s routing rules, once, with what was said.',
          }),
          k.lines(
            'messages',
            [
              { field: 'at', id: 'message_at' },
              { field: 'kind', id: 'message_kind' },
              { field: 'author', id: 'message_author' },
              { field: 'body', id: 'message_body' },
            ],
            { readonlyWhen: {} },
          ),
        ],
        chatter: true,
      })),
      'livechat.session.pivot': pivot(LivechatSession, {
        rows: ['operator'],
        cols: ['state'],
        measures: ['count', { avg: 'waitSeconds' }, { avg: 'rating' }],
      }),
      'livechat.rule.list': list(LivechatRule, {
        columns: ['channel', 'sequence', 'name', 'on', 'keywords', 'page', 'target'],
      }),
      'livechat.rule.form': form(LivechatRule, (k) => ({
        header: { buttons: [] },
        sheet: [
          k.group('main', ['name', 'channel', 'sequence'], {
            description:
              'When a conversation of the channel ends, the first rule it meets, in order, makes it a record of another app — with what was said, the visitor and their email.',
          }),
          k.group('when', ['on', 'keywords', 'page'], { label: 'When' }),
          k.group('then', ['target'], { label: 'Then' }),
        ],
      })),
      'livechat.message.list': list(LivechatMessage, {
        columns: ['session', 'at', 'kind', 'author', 'body'],
      }),
      'livechat.message.form': form(LivechatMessage, (k) => ({
        header: { buttons: [] },
        sheet: [k.group('main', ['session', 'at', 'kind', 'author', 'user', 'body'])],
      })),
    },
    search: {
      'livechat.channel': search(LivechatChannel, { fields: ['name'], groupBy: ['assignment'] }),
      'livechat.presence': search(LivechatPresence, {
        fields: ['user.name'],
        filters: { available: { label: 'Taking conversations', domain: { available: true } } },
      }),
      'livechat.session': search(LivechatSession, {
        fields: ['name', 'visitorName', 'visitorEmail'],
        filters: {
          waiting: { label: 'Waiting', domain: { state: 'waiting' }, group: 'state' },
          active: { label: 'Active', domain: { state: 'active' }, group: 'state' },
          missed: { label: 'Missed', domain: { state: 'missed' }, group: 'state' },
          closed: { label: 'Closed', domain: { state: 'closed' }, group: 'state' },
          mine: { label: 'Mine', domain: { operator: { $env: 'uid' } } },
        },
        groupBy: ['channel', 'operator', 'state', 'startedAt:month'],
      }),
      'livechat.rule': search(LivechatRule, {
        fields: ['name', 'keywords'],
        groupBy: ['channel', 'target', 'on'],
      }),
      'livechat.message': search(LivechatMessage, {
        fields: ['body', 'author'],
        groupBy: ['session', 'kind'],
      }),
    },
  });
}

export const livechat: ReturnType<typeof defineModule> = livechatModule();
