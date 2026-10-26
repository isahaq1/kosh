/**
 * Internal chat (RFC 0006 part 6): public channels, private groups and direct conversations on the chatter's
 * message model (`resModel = 'mail.channel'`), one-level threads, reactions, read receipts. Every function takes
 * the caller's environment: the channel is read through its rules first (a channel they cannot see is a 404),
 * then membership decides what they may do. Posting emits `chat.message.posted` (the notification pipeline tells
 * mentioned members and the other side of a direct conversation) and announces the channel's change to the
 * gateway (`record:mail.channel:<id>`), so open conversations refresh.
 */
import { announceChange, HttpProblem, type ModuleContext } from '@kosh/server';
import type { Env } from '@kosh/server/orm';
import { attachmentsById } from '@kosh/storage';
import { MAX_TEXT, mentionIds, plainText, renderBody } from './body.js';
import {
  activeUsers,
  type ChatterContext,
  checkText,
  type MessageItem,
  messageItems,
  needMessaging,
  type UserRef,
  userNames,
} from './chatter.js';

type Row = Record<string, unknown>;
interface Rows {
  readonly ids: readonly number[];
  readonly length: number;
  load(
    spec: readonly string[] | Readonly<Record<string, true>>,
  ): Promise<Rows & { read(keys: readonly string[]): Row[] }>;
  write(values: unknown): Promise<void>;
  unlink(): Promise<void>;
}
interface Ref {
  search(q: unknown): Promise<Rows>;
  browse(ids: readonly number[]): Rows;
  create(rows: readonly unknown[]): Promise<Rows>;
}
const ref = (env: Env, name: string): Ref => env.model(name as never) as unknown as Ref;
/** x2many fields of the message: loaded with an object spec (their ids), the rest as a key list. */
const RELATIONS = new Set(['mentions', 'attachments']);
async function rows(
  env: Env,
  model: string,
  where: unknown,
  keys: readonly string[],
  extra: { order?: readonly string[]; limit?: number } = {},
): Promise<Row[]> {
  const found = await ref(env, model).search({ where, ...extra });
  if (found.length === 0) return [];
  const scalars = keys.filter((k) => !RELATIONS.has(k));
  const relations = keys.filter((k) => RELATIONS.has(k));
  let loaded = await found.load(scalars);
  if (relations.length > 0)
    loaded = await loaded.load(Object.fromEntries(relations.map((k) => [k, true] as const)));
  return loaded.read(['id', ...keys]);
}
const refuse = (status: number, type: string, title: string, detail: string): never => {
  throw new HttpProblem(status, type, title, detail);
};
const iso = (value: unknown): string | null =>
  value instanceof Date ? value.toISOString() : value == null ? null : String(value);

/** What the chat routes need from the server: the chatter's context and the driver (announcements). */
export interface ChatContext extends ChatterContext {
  readonly driver: ModuleContext['driver'];
}

export const CHANNEL_MODEL = 'mail.channel';
const MESSAGE_KEYS = [
  'kind',
  'author',
  'text',
  'body',
  'mentions',
  'attachments',
  'editedAt',
  'createdAt',
  'parent',
  'replyCount',
  'deletedAt',
];
const CHANNEL_KEYS = ['name', 'kind', 'description', 'public', 'lastMessageAt', 'createdBy'];
/** Emoji reactions: a short string (one grapheme or a few), never markup. */
const EMOJI = /^[^\s<>&"'`]{1,16}$/u;

export interface ChannelItem {
  readonly id: number;
  readonly name: string;
  readonly kind: 'channel' | 'group' | 'direct';
  readonly description: string | null;
  readonly public: boolean;
  /** The caller is a member. */
  readonly member: boolean;
  readonly muted: boolean;
  readonly pinned: boolean;
  /** Messages after the caller's read receipt, by others (0 for non-members). */
  readonly unread: number;
  readonly memberCount: number;
  /** The other side of a direct conversation. */
  readonly direct: UserRef | null;
  readonly lastMessageAt: string | null;
  /** The caller created it, or manages channels: they change it. */
  readonly canManage: boolean;
}

export interface ReactionItem {
  readonly emoji: string;
  readonly count: number;
  readonly mine: boolean;
}

export interface ChatMessageItem extends MessageItem {
  readonly channel: number;
  readonly parent: number | null;
  readonly replyCount: number;
  readonly reactions: readonly ReactionItem[];
  readonly deleted: boolean;
}

const isManager = (env: Env): boolean =>
  env.administrator || env.access.can('mail.channel' as never, 'unlink');

/** The channel as the caller sees it (404 when the rules hide it), with their membership. */
async function channelOf(env: Env, id: number): Promise<{ channel: Row; membership: Row | null }> {
  needMessaging(env);
  const [channel] = await rows(env, CHANNEL_MODEL, { id }, CHANNEL_KEYS);
  if (channel === undefined) return refuse(404, 'missing-record', 'Not found', 'No such channel.');
  const [membership] = await rows(env, 'mail.channel.member', { channel: id, user: env.uid }, [
    'muted',
    'pinned',
    'lastReadMessage',
  ]);
  return { channel, membership: membership ?? null };
}

async function mustBeMember(env: Env, id: number): Promise<{ channel: Row; membership: Row }> {
  const found = await channelOf(env, id);
  if (found.membership === null) refuse(403, 'forbidden', 'Forbidden', 'Join the channel first.');
  return found as { channel: Row; membership: Row };
}

/** Unread counts per channel for the caller: top-level messages by others after their read receipt (a thread reply does not make the channel unread). */
async function unreadCounts(env: Env, channels: readonly number[]): Promise<Map<number, number>> {
  if (channels.length === 0) return new Map();
  const found = await env.sql<{ channel: number; n: string }>`
    SELECT m.res_id AS channel, count(*)::text AS n
    FROM mail_message m
    JOIN mail_channel_member cm ON cm.channel_id = m.res_id AND cm.user_id = ${env.uid}
    WHERE m.res_model = ${CHANNEL_MODEL} AND m.res_id = ANY(${[...channels]}::bigint[])
      AND (cm.last_read_message_id IS NULL OR m.id > cm.last_read_message_id)
      AND m.author_id IS DISTINCT FROM ${env.uid} AND m.deleted_at IS NULL AND m.parent_id IS NULL
    GROUP BY m.res_id`;
  return new Map(found.map((r) => [Number(r.channel), Number(r.n)]));
}

async function channelItems(env: Env, channels: Row[]): Promise<ChannelItem[]> {
  const ids = channels.map((c) => c['id'] as number);
  if (ids.length === 0) return [];
  const members = await rows(env, 'mail.channel.member', { channel: { in: ids } }, [
    'channel',
    'user',
    'muted',
    'pinned',
  ]);
  const byChannel = new Map<number, Row[]>();
  for (const m of members) {
    const list = byChannel.get(m['channel'] as number) ?? [];
    list.push(m);
    byChannel.set(m['channel'] as number, list);
  }
  const others = new Set<number>();
  for (const c of channels)
    if (c['kind'] === 'direct')
      for (const m of byChannel.get(c['id'] as number) ?? [])
        if (m['user'] !== env.uid) others.add(m['user'] as number);
  const names = await userNames(env, others);
  const unread = await unreadCounts(env, ids);
  const manager = isManager(env);
  return channels.map((c) => {
    const id = c['id'] as number;
    const list = byChannel.get(id) ?? [];
    const mine = list.find((m) => m['user'] === env.uid);
    const other = c['kind'] === 'direct' ? list.find((m) => m['user'] !== env.uid) : undefined;
    const direct =
      other === undefined
        ? null
        : { id: other['user'] as number, name: names.get(other['user'] as number) ?? '' };
    return {
      id,
      name: direct === null ? String(c['name']) : direct.name,
      kind: c['kind'] as ChannelItem['kind'],
      description: c['description'] == null ? null : String(c['description']),
      public: c['public'] === true,
      member: mine !== undefined,
      muted: mine?.['muted'] === true,
      pinned: mine?.['pinned'] === true,
      unread: mine === undefined ? 0 : (unread.get(id) ?? 0),
      memberCount: list.length,
      direct,
      lastMessageAt: iso(c['lastMessageAt']),
      canManage: manager || c['createdBy'] === env.uid,
    };
  });
}

/** The caller's channels: those they belong to, and the public ones they may join. */
export async function myChannels(env: Env): Promise<ChannelItem[]> {
  needMessaging(env);
  const channels = await rows(env, CHANNEL_MODEL, {}, CHANNEL_KEYS, {
    order: ['lastMessageAt desc', 'id desc'],
    limit: 500,
  });
  return channelItems(env, channels);
}

/** One channel, as the caller sees it. */
export async function channelItem(env: Env, id: number): Promise<ChannelItem> {
  const { channel } = await channelOf(env, id);
  const [item] = await channelItems(env, [channel]);
  return item as ChannelItem;
}

function checkName(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 100)
    refuse(400, 'invalid-body', 'Invalid channel', 'name is 1 to 100 characters.');
  return (value as string).trim();
}

function checkUsers(value: unknown, what: string): number[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > 500 ||
    !value.every((u) => Number.isSafeInteger(u) && (u as number) > 0)
  )
    refuse(400, 'invalid-body', 'Invalid channel', `${what} is a list of user ids.`);
  return [...new Set(value as number[])];
}

/** Active users of the caller's company among `ids` (the fence of groups and directs). */
async function companyUsers(env: Env, ids: readonly number[]): Promise<number[]> {
  if (ids.length === 0) return [];
  const found = await rows(
    env,
    'res.users',
    {
      id: { in: [...ids] },
      or: [{ company: env.companyId }, { companies: { any: { id: env.companyId } } }],
    },
    [],
  );
  return found.map((u) => u['id'] as number);
}

async function addMembers(env: Env, channel: number, users: readonly number[]): Promise<number> {
  const existing = new Set(
    (await rows(env, 'mail.channel.member', { channel, user: { in: [...users] } }, ['user'])).map(
      (m) => m['user'] as number,
    ),
  );
  const missing = users.filter((u) => !existing.has(u));
  if (missing.length > 0)
    await ref(env, 'mail.channel.member').create(missing.map((user) => ({ channel, user })));
  return missing.length;
}

/** Creates a public channel (managers) or a private group (anyone); the creator is a member. */
export async function createChannel(
  env: Env,
  input: {
    readonly kind?: unknown;
    readonly name?: unknown;
    readonly description?: unknown;
    readonly public?: unknown;
    readonly members?: unknown;
  },
): Promise<ChannelItem> {
  needMessaging(env);
  const kind = input.kind ?? 'group';
  if (kind !== 'channel' && kind !== 'group')
    refuse(400, 'invalid-body', 'Invalid channel', "kind is 'channel' or 'group'.");
  if (kind === 'channel' && !isManager(env))
    refuse(403, 'forbidden', 'Forbidden', 'Public channels are created by messaging managers.');
  const name = checkName(input.name);
  const description =
    input.description == null || input.description === '' ? null : String(input.description);
  if (description !== null && description.length > 500)
    refuse(400, 'invalid-body', 'Invalid channel', 'description is at most 500 characters.');
  const wanted = checkUsers(input.members, 'members');
  const members = await companyUsers(env, wanted);
  if (members.length !== wanted.length)
    refuse(400, 'invalid-body', 'Invalid channel', 'members are active users of your company.');
  const created = await ref(env, CHANNEL_MODEL).create([
    { name, kind, description, public: kind === 'channel' && input.public === true },
  ]);
  const id = created.ids[0] as number;
  await addMembers(env, id, [env.uid, ...members.filter((u) => u !== env.uid)]);
  return channelItem(env, id);
}

/** The direct conversation with `user` (a user of the caller's company), made on first use. */
export async function directChannel(env: Env, user: number): Promise<ChannelItem> {
  needMessaging(env);
  if (user === env.uid) refuse(400, 'invalid-body', 'Invalid channel', 'Talk to someone else.');
  if ((await companyUsers(env, [user])).length === 0)
    refuse(404, 'missing-record', 'Not found', 'No such user in your company.');
  const pairKey = `${Math.min(env.uid, user)}:${Math.max(env.uid, user)}`;
  const [existing] = await rows(env, CHANNEL_MODEL, { pairKey }, []);
  if (existing !== undefined) return channelItem(env, existing['id'] as number);
  const created = await ref(env, CHANNEL_MODEL).create([
    { name: pairKey, kind: 'direct', pairKey },
  ]);
  const id = created.ids[0] as number;
  await addMembers(env, id, [env.uid, user]);
  return channelItem(env, id);
}

/** Joins a public channel. */
export async function joinChannel(env: Env, id: number): Promise<ChannelItem> {
  const { channel, membership } = await channelOf(env, id);
  if (membership === null) {
    if (channel['public'] !== true)
      refuse(403, 'forbidden', 'Forbidden', 'A member has to add you to this group.');
    await addMembers(env, id, [env.uid]);
  }
  return channelItem(env, id);
}

/** Leaves a channel or group (a direct conversation stays). */
export async function leaveChannel(env: Env, id: number): Promise<void> {
  const { channel } = await mustBeMember(env, id);
  if (channel['kind'] === 'direct')
    refuse(400, 'invalid-body', 'Invalid request', 'A direct conversation is not left.');
  const own = await ref(env, 'mail.channel.member').search({
    where: { channel: id, user: env.uid },
  });
  await own.unlink();
}

/** Renames a channel, changes its description or members (its creator or a manager); mute or pin it (any member). */
export async function updateChannel(
  env: Env,
  id: number,
  input: {
    readonly name?: unknown;
    readonly description?: unknown;
    readonly add?: unknown;
    readonly remove?: unknown;
    readonly muted?: unknown;
    readonly pinned?: unknown;
  },
): Promise<ChannelItem> {
  const { channel, membership } = await channelOf(env, id);
  const manages = isManager(env) || channel['createdBy'] === env.uid;
  const changes: Row = {};
  if (input.name !== undefined) changes['name'] = checkName(input.name);
  if (input.description !== undefined)
    changes['description'] = input.description == null ? null : String(input.description);
  const add = checkUsers(input.add, 'add');
  const remove = checkUsers(input.remove, 'remove');
  if (
    (Object.keys(changes).length > 0 || add.length > 0 || remove.length > 0) &&
    (!manages || channel['kind'] === 'direct')
  )
    refuse(
      403,
      'forbidden',
      'Forbidden',
      'Only its creator or a messaging manager changes a channel.',
    );
  if (Object.keys(changes).length > 0) await ref(env, CHANNEL_MODEL).browse([id]).write(changes);
  if (add.length > 0) {
    const users = await companyUsers(env, add);
    if (users.length !== add.length)
      refuse(400, 'invalid-body', 'Invalid channel', 'add lists active users of your company.');
    await addMembers(env, id, users);
  }
  if (remove.length > 0) {
    const gone = await ref(env, 'mail.channel.member').search({
      where: { channel: id, user: { in: remove } },
    });
    if (gone.length > 0) await gone.unlink();
  }
  if (membership !== null && (input.muted !== undefined || input.pinned !== undefined)) {
    const own: Row = {};
    if (input.muted !== undefined) own['muted'] = input.muted === true;
    if (input.pinned !== undefined) own['pinned'] = input.pinned === true;
    await ref(env, 'mail.channel.member')
      .browse([membership['id'] as number])
      .write(own);
  }
  return channelItem(env, id);
}

async function reactionItems(
  env: Env,
  messages: readonly number[],
): Promise<Map<number, ReactionItem[]>> {
  const out = new Map<number, ReactionItem[]>();
  if (messages.length === 0) return out;
  const found = await rows(
    env,
    'mail.message.reaction',
    { message: { in: [...messages] } },
    ['message', 'user', 'emoji'],
    { order: ['id asc'] },
  );
  const counts = new Map<string, ReactionItem & { count: number; mine: boolean }>();
  for (const r of found) {
    const key = `${r['message']}:${r['emoji']}`;
    const item = counts.get(key) ?? { emoji: String(r['emoji']), count: 0, mine: false };
    item.count += 1;
    if (r['user'] === env.uid) item.mine = true;
    counts.set(key, item);
    if (!out.has(r['message'] as number)) out.set(r['message'] as number, []);
  }
  for (const [key, item] of counts) {
    const message = Number(key.slice(0, key.indexOf(':')));
    out.get(message)?.push(item);
  }
  return out;
}

async function chatItems(env: Env, context: ChatContext, found: Row[]): Promise<ChatMessageItem[]> {
  const base = await messageItems(env, context, found);
  const reactions = await reactionItems(
    env,
    found.map((m) => m['id'] as number),
  );
  return base.map((item, i) => {
    const row = found[i] as Row;
    const deleted = row['deletedAt'] != null;
    return {
      ...item,
      body: deleted ? '' : item.body,
      text: deleted ? null : item.text,
      channel: row['resId'] as number,
      parent: (row['parent'] as number | null) ?? null,
      replyCount: Number(row['replyCount'] ?? 0),
      reactions: reactions.get(item.id) ?? [],
      deleted,
    };
  });
}

/** A page of a channel's messages (newest first; `before` pages back), or of one thread (`thread`, oldest first). */
export async function channelMessages(
  env: Env,
  context: ChatContext,
  id: number,
  options: {
    readonly before?: number | undefined;
    readonly limit: number;
    readonly thread?: number | undefined;
  },
): Promise<{ items: readonly ChatMessageItem[]; next: number | null }> {
  const { channel, membership } = await channelOf(env, id);
  if (membership === null && channel['public'] !== true)
    refuse(403, 'forbidden', 'Forbidden', 'Join the channel first.');
  const where: Row = { resModel: CHANNEL_MODEL, resId: id };
  if (options.thread === undefined) where['parent'] = null;
  else where['parent'] = options.thread;
  if (options.before !== undefined) where['id'] = { lt: options.before };
  const found = await rows(env, 'mail.message', where, [...MESSAGE_KEYS, 'resId'], {
    order: [options.thread === undefined ? 'id desc' : 'id asc'],
    limit: options.limit + 1,
  });
  const page = found.slice(0, options.limit);
  const items = await chatItems(env, context, page);
  const last = page[page.length - 1];
  return {
    items,
    next: found.length > options.limit && last !== undefined ? (last['id'] as number) : null,
  };
}

/** Posts in a channel (members only), at the top level or as a reply in a thread. */
export async function postChatMessage(
  env: Env,
  context: ChatContext,
  id: number,
  input: { readonly text?: unknown; readonly parent?: unknown; readonly attachments?: unknown },
): Promise<ChatMessageItem> {
  const { channel } = await mustBeMember(env, id);
  const text = checkText(input.text);
  const attachments = input.attachments ?? [];
  if (
    !Array.isArray(attachments) ||
    attachments.length > 20 ||
    !attachments.every((a) => Number.isSafeInteger(a) && (a as number) > 0)
  )
    refuse(400, 'invalid-body', 'Invalid message', 'attachments is a list of at most 20 ids.');
  const files = attachments as number[];
  if (files.length > 0) {
    const found = await attachmentsById(env, new Set(context.models.keys()), files);
    if (
      found.length !== files.length ||
      found.some((a) => a.resModel !== CHANNEL_MODEL || a.resId !== id || a.createdBy !== env.uid)
    )
      refuse(
        400,
        'invalid-attachment',
        'Invalid attachment',
        'Attach your own uploads to this channel.',
      );
    const used = await rows(
      env,
      'mail.message',
      { attachments: { any: { id: { in: files } } } },
      [],
    );
    if (used.length > 0)
      refuse(
        400,
        'invalid-attachment',
        'Invalid attachment',
        'An attachment belongs to another message.',
      );
  }
  let parent: number | null = null;
  if (input.parent !== undefined && input.parent !== null) {
    parent = Number(input.parent);
    const [top] = await rows(
      env,
      'mail.message',
      { id: parent, resModel: CHANNEL_MODEL, resId: id, parent: null },
      [],
    );
    if (!Number.isSafeInteger(parent) || top === undefined)
      refuse(
        400,
        'invalid-body',
        'Invalid message',
        'parent is a top-level message of the channel.',
      );
  }
  const users = await activeUsers(env, mentionIds(text));
  const created = await ref(env, 'mail.message').create([
    {
      resModel: CHANNEL_MODEL,
      resId: id,
      kind: 'comment',
      author: env.uid,
      text,
      body: renderBody(text, users),
      mentions: { set: [...users.keys()] },
      attachments: { set: files },
      parent,
    },
  ]);
  const messageId = created.ids[0] as number;
  if (parent !== null)
    await env.sql`UPDATE mail_message SET reply_count = reply_count + 1 WHERE id = ${parent}`;
  // The channel's order in the sidebar: a member's post moves it up (members may not write the channel row).
  await env.sql`UPDATE mail_channel SET last_message_at = now() WHERE id = ${id}`;
  // The author has read their own message.
  await ref(env, 'mail.channel.member')
    .browse([
      (await rows(env, 'mail.channel.member', { channel: id, user: env.uid }, []))[0]?.[
        'id'
      ] as number,
    ])
    .write({ lastReadMessage: messageId });
  const members = await rows(env, 'mail.channel.member', { channel: id, muted: false }, ['user']);
  const direct =
    channel['kind'] === 'direct'
      ? members.map((m) => m['user'] as number).filter((u) => u !== env.uid)
      : [];
  await env.emit('chat.message.posted', {
    model: CHANNEL_MODEL,
    id,
    message: messageId,
    author: env.uid,
    mentions: [...users.keys()].filter((u) => members.some((m) => m['user'] === u)),
    direct,
    preview: plainText(text, users).slice(0, 200),
  });
  announceChange(env, context.driver, { model: CHANNEL_MODEL, ids: [id], op: 'update' });
  const [row] = await rows(env, 'mail.message', { id: messageId }, [...MESSAGE_KEYS, 'resId']);
  const [item] = await chatItems(env, context, [row as Row]);
  return item as ChatMessageItem;
}

/** Marks the channel read up to `message` (the newest by default). */
export async function markRead(
  env: Env,
  id: number,
  message?: number,
): Promise<{ unread: number }> {
  const { membership } = await mustBeMember(env, id);
  let upTo = message;
  if (upTo === undefined) {
    const [newest] = await rows(env, 'mail.message', { resModel: CHANNEL_MODEL, resId: id }, [], {
      order: ['id desc'],
      limit: 1,
    });
    upTo = newest?.['id'] as number | undefined;
  }
  if (upTo !== undefined)
    await ref(env, 'mail.channel.member')
      .browse([membership['id'] as number])
      .write({ lastReadMessage: upTo });
  const unread = await unreadCounts(env, [id]);
  return { unread: unread.get(id) ?? 0 };
}

async function chatMessage(env: Env, messageId: number): Promise<Row> {
  const [message] = await rows(env, 'mail.message', { id: messageId, resModel: CHANNEL_MODEL }, [
    'resId',
    'author',
    'parent',
    'deletedAt',
  ]);
  if (message === undefined) return refuse(404, 'missing-record', 'Not found', 'No such message.');
  await mustBeMember(env, message['resId'] as number);
  return message;
}

/** Adds the caller's reaction to a message of a channel they belong to. */
export async function react(
  env: Env,
  context: ChatContext,
  messageId: number,
  emoji: unknown,
): Promise<readonly ReactionItem[]> {
  if (typeof emoji !== 'string' || !EMOJI.test(emoji))
    refuse(400, 'invalid-body', 'Invalid reaction', 'emoji is a short symbol.');
  const message = await chatMessage(env, messageId);
  const existing = await rows(
    env,
    'mail.message.reaction',
    { message: messageId, user: env.uid, emoji },
    [],
  );
  if (existing.length === 0)
    await ref(env, 'mail.message.reaction').create([{ message: messageId, user: env.uid, emoji }]);
  announceChange(env, context.driver, {
    model: CHANNEL_MODEL,
    ids: [message['resId'] as number],
    op: 'update',
  });
  return (await reactionItems(env, [messageId])).get(messageId) ?? [];
}

/** Removes the caller's reaction. */
export async function unreact(
  env: Env,
  context: ChatContext,
  messageId: number,
  emoji: unknown,
): Promise<readonly ReactionItem[]> {
  const message = await chatMessage(env, messageId);
  const existing = await ref(env, 'mail.message.reaction').search({
    where: { message: messageId, user: env.uid, emoji: String(emoji) },
  });
  if (existing.length > 0) await existing.unlink();
  announceChange(env, context.driver, {
    model: CHANNEL_MODEL,
    ids: [message['resId'] as number],
    op: 'update',
  });
  return (await reactionItems(env, [messageId])).get(messageId) ?? [];
}

/** Edits the caller's own chat message. */
export async function editChatMessage(
  env: Env,
  context: ChatContext,
  messageId: number,
  input: { readonly text?: unknown },
): Promise<ChatMessageItem> {
  const message = await chatMessage(env, messageId);
  if (message['author'] !== env.uid)
    refuse(403, 'forbidden', 'Forbidden', 'Only the author changes a message.');
  if (message['deletedAt'] != null)
    refuse(400, 'invalid-message', 'Not editable', 'The message was removed.');
  const text = checkText(input.text);
  const users = await activeUsers(env, mentionIds(text));
  await ref(env, 'mail.message')
    .browse([messageId])
    .write({
      text,
      body: renderBody(text, users),
      mentions: { set: [...users.keys()] },
      editedAt: new Date(),
    });
  announceChange(env, context.driver, {
    model: CHANNEL_MODEL,
    ids: [message['resId'] as number],
    op: 'update',
  });
  const [row] = await rows(env, 'mail.message', { id: messageId }, [...MESSAGE_KEYS, 'resId']);
  const [item] = await chatItems(env, context, [row as Row]);
  return item as ChatMessageItem;
}

/**
 * Removes a chat message: its author deletes it outright (a top-level message with replies keeps a placeholder);
 * a manager or the channel's creator removes anyone's (the text goes, the row stays, audited).
 */
export async function deleteChatMessage(
  env: Env,
  context: ChatContext,
  messageId: number,
): Promise<void> {
  const message = await chatMessage(env, messageId);
  const channelId = message['resId'] as number;
  const { channel } = await channelOf(env, channelId);
  const manages = isManager(env) || channel['createdBy'] === env.uid;
  if (message['author'] !== env.uid && !manages)
    refuse(403, 'forbidden', 'Forbidden', 'Only the author or a manager removes a message.');
  const [withReplies] = await rows(
    env,
    'mail.message',
    { id: messageId, replyCount: { gt: 0 } },
    [],
  );
  if (message['author'] === env.uid && withReplies === undefined) {
    await ref(env, 'mail.message').browse([messageId]).unlink();
    if (message['parent'] != null)
      await env.sql`UPDATE mail_message SET reply_count = greatest(reply_count - 1, 0) WHERE id = ${message['parent']}`;
  } else
    await env.asSuperuser(
      { reason: `chat message ${messageId} removed by ${env.uid}` },
      async (su) => {
        await ref(su, 'mail.message')
          .browse([messageId])
          .write({ text: '', body: '', mentions: { set: [] }, deletedAt: new Date() });
      },
    );
  announceChange(env, context.driver, { model: CHANNEL_MODEL, ids: [channelId], op: 'update' });
}

export { MAX_TEXT };
