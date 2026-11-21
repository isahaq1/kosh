/**
 * The data layer of Live chat (RFC 0034 §2.6): **channels** — a chat a site offers, with the operators who answer
 * it —, operators' **presence**, and **conversations** between a visitor and an operator with their **messages**.
 * A visitor has no account: a conversation is theirs by a secret the server gave them once, kept here only as its
 * hash. Everything a visitor does is done by the server as the system, by the channel's key and that secret.
 *
 * The rules are in `engine.ts`; here are the models and what the routes may do with them.
 */
import { createHash, randomBytes } from 'node:crypto';
import { contactsShutro } from '@kosh/contacts';
import { messagingShutro } from '@kosh/messaging';
import { emitting } from '@kosh/server';
import { orm } from '@kosh/server/orm';
import {
  check,
  compute,
  defineModel,
  defineModule,
  type Env,
  f,
  method,
} from './.kosh/bindings.js';
import {
  type AssignRule,
  cleanText,
  firstName,
  isThere,
  keywordsOf,
  MAX_MESSAGES,
  type Operator,
  overdue,
  pickOperator,
  pickRule,
  subjectOf,
  transcriptOf,
  waited,
} from './engine.js';

/**
 * Fields the server maintains: written by its own code (as the system) and by Administrators only. An empty list
 * would mean *everyone* — Shutro reads no groups as no restriction.
 */
const SYSTEM = ['base.admin'] as const;
const READ = ['read'] as const;
const ALL = ['read', 'write', 'create', 'unlink'] as const;
const me = { $env: 'uid' } as const;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const key = (): string => randomBytes(15).toString('base64url');
const hashOf = (secret: string): string => createHash('sha256').update(secret).digest('hex');
const ms = (value: unknown): number | null =>
  value === null || value === undefined ? null : new Date(value as string | Date).getTime();
/** Where a channel's chat window is served. */
export const widgetPath = (value: string): string =>
  `/api/v1/public/livechat/${encodeURIComponent(value)}/widget`;

export const LivechatChannel = defineModel('livechat.channel', {
  label: 'Chat channel',
  recName: 'name',
  order: ['name asc'],
  archivable: true,
  companyScoped: { required: true },
  access: { 'livechat.user': READ, 'livechat.manager': [...ALL, 'export', 'import'] },
  fields: {
    name: f.char({ required: true, help: 'What visitors read at the top of the chat window.' }),
    key: f.char({
      size: 40,
      required: true,
      default: key,
      label: 'Link key',
      groups: { write: [...SYSTEM] },
    }),
    link: f.char({
      store: true,
      label: 'Chat window',
      help: 'The address of the chat window on this server: open it from a button of your site, or frame it.',
      ...compute('livechat.channel', 'link', ['key'], (channels) => {
        for (const c of channels) c.link = widgetPath(c.key);
      }),
    }),
    operators: f.many2many('res.users', {
      relation: 'livechat_channel_operator',
      label: 'Operators',
      help: 'Who answers this channel. They see its conversations, and only its conversations.',
    }),
    assignment: f.selection(
      { turn: 'In turn', load: 'To the least busy', manual: 'Operators take them' },
      {
        required: true,
        default: 'turn',
        help: 'Who gets a new conversation among the operators who are there: the one who waited longest, the one with the fewest conversations, or whoever takes it.',
      },
    ),
    limit: f.integer({
      required: true,
      default: 3,
      label: 'Conversations at once',
      help: 'An operator in this many conversations is not given another; it waits for someone to take it.',
    }),
    welcome: f.char({
      size: 300,
      default: 'Hello! How can we help?',
      label: 'Welcome',
      help: 'What a visitor reads before they write.',
    }),
    offline: f.char({
      size: 300,
      default: 'Nobody is here right now. Leave your email and we will write back.',
      label: 'When nobody is there',
      help: 'What a visitor reads when no operator is there. Their message is kept, with their email.',
    }),
    origins: f.text({
      label: 'Sites that may frame it',
      help: 'The addresses of the sites that may show the chat window inside their pages, one per line (https://shop.example.com). Empty: none — a site then opens it in a window of its own.',
    }),
    rules: f.one2many('livechat.rule', 'channel', { label: 'Where conversations go' }),
    missAfterMin: f.integer({
      required: true,
      default: 10,
      label: 'Missed after (minutes)',
      help: 'A conversation nobody answered for this long is missed: it leaves the waiting list and is counted.',
    }),
    closeAfterMin: f.integer({
      required: true,
      default: 30,
      label: 'Closed after (quiet minutes)',
      help: 'A conversation in which nobody wrote for this long is closed.',
    }),
  },
  methods: {
    /**
     * The models a conversation may become a record of: none here; bridges add theirs (`livechat_helpdesk`:
     * `helpdesk.ticket`, `livechat_crm`: `crm.deal`).
     */
    routeTargets: method('livechat.channel', async (): Promise<string[]> => []),
    /**
     * The channels (of these) whose new conversations are not given to an operator at once: something answers
     * first, and hands over. None here; `livechat_assistant` says so for the channels it answers.
     */
    answeredFirst: method('livechat.channel', async (): Promise<number[]> => []),
  },
  sqlConstraints: {
    oneKey: { unique: ['key'], message: 'Two channels cannot share a link key.' },
    limits: {
      check: orm.sql`"limit" BETWEEN 1 AND 50 AND miss_after_min BETWEEN 1 AND 1440 AND close_after_min BETWEEN 1 AND 1440`,
      message: 'One to fifty conversations at once; missed and closed after one minute to a day.',
    },
  },
});

/** Whether an operator takes conversations, and when their inbox was last open. One row per person. */
export const LivechatPresence = defineModel('livechat.presence', {
  label: 'Operator presence',
  recName: 'user',
  order: ['id asc'],
  access: { 'livechat.user': READ, 'livechat.manager': READ },
  fields: {
    user: f.many2one('res.users', { required: true, ondelete: 'cascade', label: 'Operator' }),
    available: f.boolean({
      default: false,
      label: 'Takes conversations',
      groups: { write: [...SYSTEM] },
      help: 'Switched on and off by the operator in their inbox.',
    }),
    seenAt: f.datetime({
      label: 'Inbox last open',
      groups: { write: [...SYSTEM] },
      help: 'An operator whose inbox was not open in the last minute and a half is not there.',
    }),
  },
  sqlConstraints: { oneUser: { unique: ['user'], message: 'One presence per operator.' } },
});

export const LivechatSession = defineModel('livechat.session', {
  label: 'Conversation',
  recName: 'name',
  order: ['id desc'],
  companyScoped: { required: true },
  tracking: ['state', 'operator'],
  access: {
    'livechat.user': ['read', 'export'],
    'livechat.manager': ['read', 'unlink', 'export'],
  },
  rules: {
    // Operators: the conversations of their channels.
    channels: {
      groups: ['livechat.user'],
      perms: ['read'],
      domain: { 'channel.operators': { any: { id: me } } },
    },
    all: { groups: ['livechat.manager'], perms: [...ALL], domain: {} },
  },
  fields: {
    name: f.char({ required: true, sequence: 'livechat.session', label: 'Reference' }),
    channel: f.many2one('livechat.channel', { required: true, ondelete: 'restrict' }),
    /** SHA-256 of the visitor's secret: the secret itself is theirs alone. */
    secretHash: f.char({
      size: 64,
      required: true,
      label: 'Visitor secret (hash)',
      groups: { read: [...SYSTEM], write: [...SYSTEM] },
    }),
    visitorName: f.char({ size: 80, label: 'Visitor', groups: { write: [...SYSTEM] } }),
    visitorEmail: f.char({ size: 200, label: 'Visitor email', groups: { write: [...SYSTEM] } }),
    page: f.char({
      size: 300,
      label: 'From page',
      groups: { write: [...SYSTEM] },
      help: 'The page of the site the visitor wrote from, as their browser said.',
    }),
    lang: f.char({ size: 5, label: 'Language', groups: { write: [...SYSTEM] } }),
    operator: f.many2one('res.users', {
      ondelete: 'set null',
      label: 'Operator',
      groups: { write: [...SYSTEM] },
    }),
    someoneThere: f.boolean({
      default: false,
      label: 'An operator was there',
      groups: { write: [...SYSTEM] },
      help: 'Whether an operator was there when the visitor wrote; if not, they were asked for their email.',
    }),
    startedAt: f.datetime({ required: true, label: 'Started', groups: { write: [...SYSTEM] } }),
    assignedAt: f.datetime({ label: 'Given to the operator', groups: { write: [...SYSTEM] } }),
    answeredAt: f.datetime({ label: 'First answer', groups: { write: [...SYSTEM] } }),
    lastAt: f.datetime({ required: true, label: 'Last message', groups: { write: [...SYSTEM] } }),
    closedAt: f.datetime({ label: 'Ended', groups: { write: [...SYSTEM] } }),
    waitSeconds: f.integer({
      label: 'Waited (seconds)',
      groups: { write: [...SYSTEM] },
      help: 'From the visitor’s first message to the operator’s first answer.',
    }),
    messageCount: f.integer({ default: 0, label: 'Messages', groups: { write: [...SYSTEM] } }),
    needsPerson: f.boolean({
      default: true,
      label: 'Waits for a person',
      groups: { write: [...SYSTEM] },
      help: 'Off while the assistant has answered what the visitor asked: such a conversation is closed when it goes quiet, not missed.',
    }),
    rating: f.integer({
      label: 'Rating',
      groups: { write: [...SYSTEM] },
      help: 'One to five, given by the visitor when the conversation ends.',
    }),
    messages: f.one2many('livechat.message', 'session'),
    resModel: f.char({
      size: 80,
      label: 'Became (model)',
      groups: { write: [...SYSTEM] },
      help: 'The kind of record the conversation became when it ended: a ticket, a deal.',
    }),
    resId: f.integer({ label: 'Became (record)', groups: { write: [...SYSTEM] } }),
    resName: f.char({ label: 'Became', groups: { write: [...SYSTEM] } }),
    rule: f.many2one('livechat.rule', {
      ondelete: 'set null',
      label: 'By the rule',
      groups: { write: [...SYSTEM] },
    }),
    state: f.state({
      help: 'Waiting until an operator has it; active while they talk; closed when it ends; missed when nobody answered in time.',
      states: { waiting: 'Waiting', active: 'Active', closed: 'Closed', missed: 'Missed' },
      initial: 'waiting',
      transitions: {
        take: { from: ['waiting'], to: 'active' },
        finish: emitting('livechat.session.closed', { from: ['waiting', 'active'], to: 'closed' }),
        miss: emitting('livechat.session.missed', { from: ['waiting'], to: 'missed' }),
      },
    }),
  },
  methods: {
    /**
     * Makes the record a conversation becomes, of one of the channel's `routeTargets()`, and returns its id and
     * what it is called. Nothing here; the bridge of the target's app does it. Called as the system.
     */
    makeRecord: method(
      'livechat.session',
      async (_target: string, _about: Routed): Promise<{ id: number; name: string } | null> => null,
    ),
  },
  sqlConstraints: {
    rating: { check: orm.sql`rating IS NULL OR rating BETWEEN 1 AND 5`, message: 'One to five.' },
  },
});

/** What a bridge is given to make a record of a conversation. */
export interface Routed {
  readonly session: number;
  readonly company: number;
  /** The start of the visitor's first message. */
  readonly subject: string;
  /** The conversation as text: a line per message. */
  readonly transcript: string;
  readonly visitorName: string | null;
  readonly visitorEmail: string | null;
  readonly page: string | null;
  /** The operator who answered, if anybody did. */
  readonly operator: number | null;
  readonly outcome: 'closed' | 'missed';
}

/** The rules whose target no installed app makes records of. */
async function badTargets(env: Env, ids: readonly number[]): Promise<number[]> {
  if (ids.length === 0) return [];
  const allowed = await env.model('livechat.channel').browse([]).routeTargets();
  const rules = await env
    .model('livechat.rule')
    .browse([...ids] as never)
    .load(['target']);
  return [...rules].filter((r) => !allowed.includes(r.target)).map((r) => r.id as number);
}

const RULE_ON = { any: 'However it ended', missed: 'Missed', closed: 'Closed' } as const;

/**
 * Where a channel's conversations go when they end: the first rule, in order, that a conversation meets makes it
 * a record of another app — a ticket, a deal — with what was said.
 */
export const LivechatRule = defineModel('livechat.rule', {
  label: 'Chat routing rule',
  recName: 'name',
  order: ['channel asc', 'sequence asc', 'id asc'],
  archivable: true,
  access: { 'livechat.user': READ, 'livechat.manager': [...ALL, 'export', 'import'] },
  fields: {
    name: f.char({ required: true }),
    channel: f.many2one('livechat.channel', { required: true, ondelete: 'cascade' }),
    sequence: f.integer({ required: true, default: 10 }),
    on: f.selection(RULE_ON, {
      required: true,
      default: 'any',
      label: 'When it',
      help: 'Missed: nobody answered in time. Closed: it was answered and ended. Or either.',
    }),
    keywords: f.text({
      label: 'And the visitor wrote',
      help: 'Words separated by commas: any of them, as whole words, in what the visitor wrote. Empty: whatever they wrote.',
    }),
    page: f.char({
      size: 200,
      label: 'From a page with',
      help: 'A part of the address of the page they wrote from, such as /pricing. Empty: any page.',
    }),
    target: f.char({
      size: 80,
      required: true,
      label: 'It becomes',
      help: 'The model of the record made: helpdesk.ticket with Helpdesk, crm.deal with Pipeline — when Live chat is installed with them.',
    }),
  },
  constraints: {
    knownTarget: {
      ...check('livechat.rule', ['target'], (rules) =>
        badTargets(rules.env as unknown as Env, rules.ids as readonly number[]),
      ),
      message:
        'No installed app makes that of a conversation. With Helpdesk: helpdesk.ticket; with Pipeline: crm.deal.',
    },
  },
});

const MESSAGE_KINDS = {
  visitor: 'Visitor',
  operator: 'Operator',
  assistant: 'Assistant',
  system: 'Note',
} as const;

/** What was said. Never changed: a conversation is kept as it happened. */
export const LivechatMessage = defineModel('livechat.message', {
  label: 'Chat message',
  recName: 'body',
  order: ['id asc'],
  access: { 'livechat.user': READ, 'livechat.manager': READ },
  rules: {
    channels: {
      groups: ['livechat.user'],
      perms: ['read'],
      domain: { 'session.channel.operators': { any: { id: me } } },
    },
    all: { groups: ['livechat.manager'], perms: ['read'], domain: {} },
  },
  fields: {
    session: f.many2one('livechat.session', { required: true, ondelete: 'cascade' }),
    kind: f.selection(MESSAGE_KINDS, {
      required: true,
      label: 'From',
      help: 'The visitor, the operator, the assistant, or a note the server wrote: who joined, how it ended.',
    }),
    user: f.many2one('res.users', { ondelete: 'set null', label: 'Operator' }),
    author: f.char({ size: 80, label: 'Name' }),
    body: f.text({ required: true, label: 'Message' }),
    at: f.datetime({ required: true, label: 'At' }),
  },
});

// ---- what the routes do, as the system

/** A channel as its visitors see it. */
export interface ChannelInfo {
  readonly id: number;
  readonly company: number;
  readonly name: string;
  readonly welcome: string;
  readonly offline: string;
  /** An operator is there, and may be given a conversation. */
  readonly online: boolean;
  /** The channel's setting of the sites that may frame its window. */
  readonly origins: string;
}

interface Channel {
  readonly id: number;
  readonly company: number;
  readonly name: string;
  readonly welcome: string;
  readonly offline: string;
  readonly assignment: AssignRule;
  readonly limit: number;
  readonly missAfterMin: number;
  readonly closeAfterMin: number;
  readonly origins: string;
  readonly operators: readonly { readonly id: number; readonly name: string }[];
}

async function channelBy(su: Env, where: Record<string, unknown>): Promise<Channel | null> {
  const all = su.withFlags({ checkCompany: false }) as Env;
  const [c] = await all
    .model('livechat.channel')
    .search({ where: where as never, limit: 1 })
    .then((found) => found.load({ company: true, operators: true }));
  if (c === undefined) return null;
  return {
    id: c.id as number,
    company: c.company.id as number,
    name: c.name,
    welcome: c.welcome ?? '',
    offline: c.offline ?? '',
    assignment: c.assignment as AssignRule,
    limit: c.limit,
    missAfterMin: c.missAfterMin,
    closeAfterMin: c.closeAfterMin,
    origins: c.origins ?? '',
    operators: [...c.operators].map((u) => ({ id: u.id as number, name: u.name })),
  };
}

/** The channel's operators as the engine reads them: who is there, how busy, whose turn. */
async function operatorsOf(su: Env, channel: Channel, now: number): Promise<Operator[]> {
  const all = su.withFlags({ checkCompany: false }) as Env;
  const ids = channel.operators.map((o) => o.id);
  if (ids.length === 0) return [];
  const presence = new Map(
    [
      ...(await all
        .model('livechat.presence')
        .search({ where: { user: { in: ids } } as never })
        .then((found) => found.load({ user: true }))),
    ].map((p) => [p.user.id as number, p]),
  );
  const out: Operator[] = [];
  for (const id of ids) {
    const p = presence.get(id);
    const sessions = all.model('livechat.session');
    const open = await sessions.search({ where: { operator: id, state: 'active' } as never });
    const [last] = await sessions.search({
      where: { operator: id, assignedAt: { isNull: false } } as never,
      order: ['assignedAt desc'],
      limit: 1,
    });
    out.push({
      id,
      there:
        p !== undefined && isThere({ available: p.available === true, seenAt: ms(p.seenAt) }, now),
      open: open.length,
      lastAssignedAt: last === undefined ? null : ms(last.assignedAt),
    });
  }
  return out;
}

/** The channel a key opens, with whether somebody is there; `null`: no such channel (or archived). */
export async function channelInfo(
  su: Env,
  channelKey: string,
  now: number = Date.now(),
): Promise<ChannelInfo | null> {
  const channel = await channelBy(su, { key: channelKey });
  if (channel === null) return null;
  const operators = await operatorsOf(su, channel, now);
  return {
    id: channel.id,
    company: channel.company,
    name: channel.name,
    welcome: channel.welcome,
    offline: channel.offline,
    online: operators.some((o) => o.there),
    origins: channel.origins,
  };
}

async function addMessage(
  su: Env,
  session: number,
  message: { kind: keyof typeof MESSAGE_KINDS; user?: number; author: string; body: string },
  now: number,
): Promise<number> {
  const made = await su.model('livechat.message').create([
    {
      session,
      kind: message.kind,
      user: message.user ?? null,
      author: message.author.slice(0, 80),
      body: message.body,
      at: new Date(now),
    } as never,
  ]);
  return made.ids[0] as number;
}

/** Gives a waiting conversation to an operator, and says so in it. */
async function giveTo(su: Env, session: number, operator: number, now: number): Promise<void> {
  const sessions = su.model('livechat.session').browse([session as never]);
  const [user] = await su
    .model('res.users')
    .browse([operator as never])
    .load(['name']);
  await sessions.write({ operator, assignedAt: new Date(now) } as never);
  await su.flush();
  await sessions.take();
  await addMessage(
    su,
    session,
    { kind: 'system', author: '', body: `${firstName(user?.name) || 'An operator'} joined.` },
    now,
  );
  await su.flush();
}

export type Refused =
  | { readonly ok: false; readonly why: 'unknown' | 'ended' | 'full' | 'not-yours' }
  | { readonly ok: false; readonly why: 'invalid'; readonly field: string; readonly say: string };

export interface StartInput {
  readonly name?: unknown;
  readonly email?: unknown;
  readonly page?: unknown;
  readonly lang?: unknown;
  readonly message?: unknown;
}

/**
 * A visitor starts a conversation (RFC 0034 §2.6): their first message is kept, and — when an operator is there
 * and the channel gives conversations out — it goes to one. When nobody is there the visitor must leave an email,
 * so that somebody can write back. Returns the secret the conversation is theirs by: it is not kept.
 */
export async function startSession(
  su: Env,
  channelKey: string,
  input: StartInput,
  now: number = Date.now(),
): Promise<
  { ok: true; secret: string; session: number; online: boolean; waiting: boolean } | Refused
> {
  const channel = await channelBy(su, { key: channelKey });
  if (channel === null) return { ok: false, why: 'unknown' };
  const body = cleanText(input.message);
  if (body === '')
    return { ok: false, why: 'invalid', field: 'message', say: 'Write your message.' };
  const email = cleanText(input.email, 200);
  if (email !== '' && !EMAIL.test(email))
    return {
      ok: false,
      why: 'invalid',
      field: 'email',
      say: 'An email address looks like name@example.com.',
    };
  const operators = await operatorsOf(su, channel, now);
  const online = operators.some((o) => o.there);
  if (!online && email === '')
    return {
      ok: false,
      why: 'invalid',
      field: 'email',
      say: 'Nobody is here right now: leave your email so that we can write back.',
    };
  const secret = randomBytes(24).toString('base64url');
  const name = cleanText(input.name, 80).replace(/\n/g, ' ');
  const lang = cleanText(input.lang, 5).toLowerCase();
  const made = await su.model('livechat.session').create([
    {
      channel: channel.id,
      company: channel.company,
      secretHash: hashOf(secret),
      visitorName: name === '' ? null : name,
      visitorEmail: email === '' ? null : email.toLowerCase(),
      page: cleanText(input.page, 300).replace(/\n/g, ' ') || null,
      lang: /^[a-z]{2}(-[a-z]{2})?$/.test(lang) ? lang : null,
      someoneThere: online,
      startedAt: new Date(now),
      lastAt: new Date(now),
      messageCount: 1,
    } as never,
  ]);
  const session = made.ids[0] as number;
  await addMessage(su, session, { kind: 'visitor', author: name, body }, now);
  await su.flush();
  // A channel answered first by something else keeps its new conversations waiting: it hands them over.
  const held = (
    await (su.withFlags({ checkCompany: false }) as Env)
      .model('livechat.channel')
      .browse([channel.id as never])
      .answeredFirst()
  ).includes(channel.id);
  const operator = held ? null : pickOperator(operators, channel.assignment, channel.limit);
  if (operator !== null) await giveTo(su, session, operator, now);
  return { ok: true, secret, session, online, waiting: operator === null };
}

/** The conversation a visitor's secret opens in a channel, or `null`. */
export async function sessionOf(
  su: Env,
  channelKey: string,
  secret: string,
): Promise<number | null> {
  if (secret.length < 20 || secret.length > 80) return null;
  const channel = await channelBy(su, { key: channelKey });
  if (channel === null) return null;
  const all = su.withFlags({ checkCompany: false }) as Env;
  const [found] = await all.model('livechat.session').search({
    where: { channel: channel.id, secretHash: hashOf(secret) } as never,
    limit: 1,
  });
  return found === undefined ? null : (found.id as number);
}

/** A conversation as either side reads it: its state, who answers, and the messages after one they have. */
export interface SessionView {
  readonly id: number;
  readonly state: string;
  /** The operator's first name: what a visitor sees of them. */
  readonly operator: string | null;
  readonly messages: readonly {
    readonly id: number;
    readonly kind: string;
    readonly author: string;
    readonly body: string;
    readonly at: string;
  }[];
}

export async function sessionView(su: Env, session: number, after = 0): Promise<SessionView> {
  const all = su.withFlags({ checkCompany: false }) as Env;
  const [s] = await all
    .model('livechat.session')
    .browse([session as never])
    .load({ operator: true });
  const messages = await all.model('livechat.message').search({
    where: { session, id: { gt: Math.max(0, after) } } as never,
    order: ['id asc'],
    limit: MAX_MESSAGES,
  });
  return {
    id: session,
    state: s?.state ?? 'closed',
    operator: s?.operator == null ? null : firstName(s.operator.name),
    messages: [...messages].map((m) => ({
      id: m.id as number,
      kind: m.kind,
      // A visitor reads first names only; operators read theirs too.
      author: m.kind === 'operator' ? firstName(m.author) : (m.author ?? ''),
      body: m.body,
      at: new Date(m.at as never).toISOString(),
    })),
  };
}

/**
 * Something is said in a conversation — by its visitor, or by an operator (`user`). The first thing an operator
 * says is the answer the visitor waited for. Refused once the conversation has ended, or is full.
 */
export async function say(
  su: Env,
  session: number,
  from: { readonly user?: number; readonly name?: string },
  text: unknown,
  now: number = Date.now(),
): Promise<{ ok: true; message: number; waiting: boolean } | Refused> {
  const all = su.withFlags({ checkCompany: false }) as Env;
  const sessions = all.model('livechat.session').browse([session as never]);
  const [s] = await sessions.load({ operator: true });
  if (s === undefined) return { ok: false, why: 'unknown' };
  if (s.state === 'closed' || s.state === 'missed') return { ok: false, why: 'ended' };
  if ((s.messageCount ?? 0) >= MAX_MESSAGES) return { ok: false, why: 'full' };
  const body = cleanText(text);
  if (body === '') return { ok: false, why: 'invalid', field: 'body', say: 'Write your message.' };
  const byOperator = from.user !== undefined;
  if (byOperator && (s.operator?.id as number | undefined) !== from.user)
    return { ok: false, why: 'not-yours' };
  const message = await addMessage(
    all,
    session,
    {
      kind: byOperator ? 'operator' : 'visitor',
      ...(byOperator ? { user: from.user as number } : {}),
      author: byOperator ? (from.name ?? '') : (s.visitorName ?? ''),
      body,
    },
    now,
  );
  const started = ms(s.startedAt) ?? now;
  await sessions.write({
    lastAt: new Date(now),
    messageCount: (s.messageCount ?? 0) + 1,
    ...(byOperator && s.answeredAt === null
      ? { answeredAt: new Date(now), waitSeconds: waited(started, now) }
      : {}),
    // What the visitor asks now is not answered yet.
    ...(!byOperator && s.state === 'waiting' ? { needsPerson: true } : {}),
  } as never);
  await all.flush();
  return { ok: true, message, waiting: !byOperator && s.state === 'waiting' };
}

/**
 * The assistant says something in a conversation nobody has yet (RFC 0034 §2.6) — only while it waits: once an
 * operator has it, or it ended, what the assistant would have said is dropped. `answered` says whether what the
 * visitor asked was answered; if not, the conversation waits for a person. Returns the message, or `null`.
 */
export async function sayAsAssistant(
  su: Env,
  session: number,
  said: { readonly author: string; readonly body: unknown; readonly answered: boolean },
  now: number = Date.now(),
): Promise<number | null> {
  const all = su.withFlags({ checkCompany: false }) as Env;
  const sessions = all.model('livechat.session').browse([session as never]);
  const [s] = await sessions.load(['state', 'messageCount']);
  if (s === undefined || s.state !== 'waiting' || (s.messageCount ?? 0) >= MAX_MESSAGES)
    return null;
  const body = cleanText(said.body);
  if (body === '') return null;
  const message = await addMessage(
    all,
    session,
    { kind: 'assistant', author: cleanText(said.author, 80).replace(/\n/g, ' '), body },
    now,
  );
  await sessions.write({
    lastAt: new Date(now),
    messageCount: (s.messageCount ?? 0) + 1,
    needsPerson: !said.answered,
  } as never);
  await all.flush();
  return message;
}

/**
 * A conversation that waits is handed over to a person: given to an operator who is there, by the channel's way
 * of giving them out — or left waiting, for one to take, when nobody can be given it. Returns the operator.
 */
export async function handOver(
  su: Env,
  session: number,
  now: number = Date.now(),
): Promise<number | null> {
  const all = su.withFlags({ checkCompany: false }) as Env;
  const sessions = all.model('livechat.session').browse([session as never]);
  const [s] = await sessions.load({ channel: true });
  if (s === undefined || s.state !== 'waiting') return null;
  await sessions.write({ needsPerson: true } as never);
  await all.flush();
  const channel = await channelBy(all, { id: s.channel.id });
  if (channel === null) return null;
  const operator = pickOperator(
    await operatorsOf(all, channel, now),
    channel.assignment,
    channel.limit,
  );
  if (operator !== null) await giveTo(all, session, operator, now);
  return operator;
}

/** An operator of the channel takes a conversation that waits. */
export async function takeSession(
  su: Env,
  session: number,
  operator: number,
  now: number = Date.now(),
): Promise<{ ok: true } | Refused> {
  const all = su.withFlags({ checkCompany: false }) as Env;
  const [s] = await all
    .model('livechat.session')
    .browse([session as never])
    .load({ channel: { operators: true } });
  if (s === undefined) return { ok: false, why: 'unknown' };
  if (![...s.channel.operators].some((u) => (u.id as number) === operator))
    return { ok: false, why: 'not-yours' };
  if (s.state !== 'waiting') return { ok: false, why: 'ended' };
  await giveTo(all, session, operator, now);
  return { ok: true };
}

/** The conversation ends: by its visitor (who may rate it, one to five) or by its operator. Once. */
export async function endSession(
  su: Env,
  session: number,
  by: { readonly user?: number; readonly rating?: unknown },
  now: number = Date.now(),
): Promise<{ ok: true } | Refused> {
  const all = su.withFlags({ checkCompany: false }) as Env;
  const sessions = all.model('livechat.session').browse([session as never]);
  const [s] = await sessions.load({ operator: true });
  if (s === undefined) return { ok: false, why: 'unknown' };
  const rating = Number(by.rating);
  const rated = by.user === undefined && Number.isInteger(rating) && rating >= 1 && rating <= 5;
  if (s.state === 'closed' || s.state === 'missed') {
    // A visitor may still rate a conversation that ended, once.
    if (!rated || s.rating !== null || s.state === 'missed') return { ok: false, why: 'ended' };
    await sessions.write({ rating } as never);
    await all.flush();
    return { ok: true };
  }
  if (by.user !== undefined && (s.operator?.id as number | undefined) !== by.user)
    return { ok: false, why: 'not-yours' };
  await sessions.write({ closedAt: new Date(now), ...(rated ? { rating } : {}) } as never);
  await all.flush();
  await sessions.finish();
  await addMessage(
    all,
    session,
    {
      kind: 'system',
      author: '',
      body: by.user === undefined ? 'The visitor left.' : 'The operator ended the conversation.',
    },
    now,
  );
  await all.flush();
  return { ok: true };
}

/**
 * What time does (RFC 0034 §2.6): conversations nobody answered in the channel's time are missed, and those gone
 * quiet are closed. Run by every server once a minute; a second run finds nothing left. Returns what it did.
 */
export async function sweepSessions(
  su: Env,
  now: number = Date.now(),
): Promise<{ missed: number; closed: number }> {
  const all = su.withFlags({ checkCompany: false }) as Env;
  const open = await all
    .model('livechat.session')
    .search({ where: { state: { in: ['waiting', 'active'] } } as never, limit: 1000 })
    .then((found) => found.load({ channel: true }));
  let missed = 0;
  let closed = 0;
  for (const s of open) {
    const what = overdue(
      {
        state: s.state as 'waiting' | 'active',
        lastAt: ms(s.lastAt) ?? now,
        answered: s.needsPerson === false,
      },
      now,
      { missAfterMin: s.channel.missAfterMin, closeAfterMin: s.channel.closeAfterMin },
    );
    if (what === null) continue;
    const one = all.model('livechat.session').browse([s.id as never]);
    await one.write({ closedAt: new Date(now) } as never);
    await all.flush();
    if (what === 'miss') {
      await one.miss();
      missed += 1;
    } else {
      await one.finish();
      await addMessage(
        all,
        s.id as number,
        { kind: 'system', author: '', body: 'Closed: nobody wrote for a while.' },
        now,
      );
      closed += 1;
    }
    await all.flush();
  }
  return { missed, closed };
}

/** An operator's inbox says "I am here" — and, when asked, whether they take conversations. */
export async function setPresence(
  su: Env,
  user: number,
  available: boolean | undefined,
  now: number = Date.now(),
): Promise<boolean> {
  const all = su.withFlags({ checkCompany: false }) as Env;
  const [mine] = await all
    .model('livechat.presence')
    .search({ where: { user } as never, limit: 1 });
  if (mine === undefined) {
    await all
      .model('livechat.presence')
      .create([{ user, available: available === true, seenAt: new Date(now) } as never]);
    await all.flush();
    return available === true;
  }
  await all
    .model('livechat.presence')
    .browse([mine.id as never])
    .write({
      seenAt: new Date(now),
      ...(available === undefined ? {} : { available }),
    } as never);
  await all.flush();
  return available ?? mine.available === true;
}

/** A conversation in an operator's inbox. */
export interface InboxRow {
  readonly id: number;
  readonly name: string;
  readonly channel: string;
  readonly state: string;
  readonly visitor: string;
  readonly email: string | null;
  readonly page: string | null;
  readonly startedAt: string;
  readonly lastAt: string;
  readonly messageCount: number;
  readonly mine: boolean;
  readonly last: string;
}

/** An operator's inbox: their conversations, and those that wait in their channels. */
export async function inboxOf(
  su: Env,
  user: number,
): Promise<{ available: boolean; channels: number; sessions: InboxRow[] }> {
  const all = su.withFlags({ checkCompany: false }) as Env;
  const channels = await all
    .model('livechat.channel')
    .search({ where: { operators: { any: { id: user } } } as never });
  const [presence] = await all
    .model('livechat.presence')
    .search({ where: { user } as never, limit: 1 });
  const ids = channels.ids as readonly number[];
  const found =
    ids.length === 0
      ? []
      : [
          ...(await all
            .model('livechat.session')
            .search({
              where: {
                channel: { in: [...ids] },
                or: [{ state: 'waiting' }, { state: 'active', operator: user }],
              } as never,
              order: ['id asc'],
              limit: 100,
            })
            .then((rows) => rows.load({ channel: true, operator: true }))),
        ];
  const sessions: InboxRow[] = [];
  for (const s of found) {
    const [last] = await all.model('livechat.message').search({
      where: { session: s.id, kind: { in: ['visitor', 'operator'] } } as never,
      order: ['id desc'],
      limit: 1,
    });
    sessions.push({
      id: s.id as number,
      name: s.name,
      channel: s.channel.name,
      state: s.state,
      visitor: s.visitorName ?? s.visitorEmail ?? '',
      email: s.visitorEmail ?? null,
      page: s.page ?? null,
      startedAt: new Date(s.startedAt as never).toISOString(),
      lastAt: new Date(s.lastAt as never).toISOString(),
      messageCount: s.messageCount ?? 0,
      mine: (s.operator?.id as number | undefined) === user,
      last: (last?.body ?? '').slice(0, 140),
    });
  }
  return { available: presence?.available === true, channels: ids.length, sessions };
}

/** The models a conversation may become a record of, with the installed apps. */
export async function routeTargets(env: Env): Promise<string[]> {
  return env.model('livechat.channel').browse([]).routeTargets();
}

/**
 * A conversation that ended becomes a record of another app (RFC 0034 §2.6) — **once**: by the first rule of its
 * channel that it meets, or as `target` when an operator says so. The record is made by the target's bridge, with
 * what was said; the conversation keeps what it became. Returns it, or `null` when nothing was made.
 */
export async function routeSession(
  su: Env,
  session: number,
  target?: string,
): Promise<{ model: string; id: number; name: string; made: boolean } | null> {
  const all = su.withFlags({ checkCompany: false }) as Env;
  const sessions = all.model('livechat.session').browse([session as never]);
  const [s] = await sessions.load({ channel: true, operator: true, messages: true });
  if (s === undefined) return null;
  if (s.resModel !== null && s.resId !== null)
    return { model: s.resModel, id: s.resId, name: s.resName ?? '', made: false };
  if (s.state !== 'closed' && s.state !== 'missed') return null;
  const lines = [...s.messages].sort((a, b) => (a.id as number) - (b.id as number));
  const said = lines.filter((m) => m.kind === 'visitor').map((m) => m.body);
  let rule: number | null = null;
  let model = target ?? null;
  if (model === null) {
    const rules = await all
      .model('livechat.rule')
      .search({ where: { channel: s.channel.id } as never, order: ['sequence asc', 'id asc'] });
    const picked = pickRule(
      [...rules].map((r) => ({
        id: r.id as number,
        on: r.on as 'any' | 'closed' | 'missed',
        keywords: keywordsOf(r.keywords),
        page: r.page ?? null,
        target: r.target,
      })),
      { outcome: s.state, said: said.join('\n'), page: s.page ?? null },
    );
    if (picked === null) return null;
    rule = picked.id;
    model = picked.target;
  }
  if (!(await routeTargets(all)).includes(model)) return null;
  const made = await sessions.makeRecord(model, {
    session,
    company: s.company.id as number,
    subject: subjectOf(said[0] ?? ''),
    transcript: transcriptOf(
      lines.map((m) => ({
        kind: m.kind,
        author: m.author ?? '',
        body: m.body,
        at: new Date(m.at as never).toISOString(),
      })),
      { visitor: s.visitorName ?? 'Visitor', operator: s.operator?.name ?? 'Operator' },
    ),
    visitorName: s.visitorName ?? null,
    visitorEmail: s.visitorEmail ?? null,
    page: s.page ?? null,
    operator: (s.operator?.id as number | undefined) ?? null,
    outcome: s.state,
  });
  if (made === null) return null;
  await sessions.write({
    resModel: model,
    resId: made.id,
    resName: made.name.slice(0, 200),
    rule,
  } as never);
  await all.flush();
  return { model, id: made.id, name: made.name, made: true };
}

export const livechatShutro = defineModule({
  name: 'livechat',
  version: '0.1.0',
  depends: [contactsShutro, messagingShutro],
  groups: [
    orm.defineGroup({
      code: 'livechat.user',
      label: 'Live chat operator',
      implies: ['contacts.user', 'messaging.user'],
    }),
    orm.defineGroup({
      code: 'livechat.manager',
      label: 'Live chat manager',
      implies: ['livechat.user'],
    }),
  ],
  sequences: [
    orm.defineSequence({
      code: 'livechat.session',
      prefix: 'CHAT/{year}/',
      padding: 5,
      reset: 'yearly',
    }),
  ],
  models: [LivechatChannel, LivechatPresence, LivechatSession, LivechatMessage, LivechatRule],
});
