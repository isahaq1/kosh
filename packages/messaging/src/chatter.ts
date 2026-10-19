/**
 * The chatter of a record (RFC 0006 §5.1): messages and notes, the change log read from Shutro's audit trail,
 * followers and activities. Every function takes the caller's environment and checks the record as the caller
 * first (ACL and rules: a record they cannot see is a 404), so the chatter is exactly as visible as its record.
 * The change log is `records.trail()` as the caller, so field security leaves out the fields they may not read.
 *
 * Events for notifications (RFC 0006 part 3) are Shutro outbox events, emitted in the same transaction:
 * `mail.message.posted` and `mail.activity.assigned`.
 */
import { HttpProblem } from '@kosh/server';
import type { Env } from '@kosh/server/orm';
import {
  type AttachmentInfo,
  attachmentsById,
  checkRecord,
  removeAttachments,
} from '@kosh/storage';
import { MAX_TEXT, mentionIds, plainText, renderBody } from './body.js';
import { DEFAULT_ACTIVITY_TYPES } from './models.js';

type Row = Record<string, unknown>;
interface TrailRow {
  readonly id: number;
  readonly at: Date;
  readonly tx: string;
  readonly uid: number;
  readonly su: boolean;
  readonly action: string;
  readonly field: string | null;
  readonly old: unknown;
  readonly new: unknown;
}
interface Rows {
  readonly ids: readonly number[];
  readonly length: number;
  load(
    spec: readonly string[] | Readonly<Record<string, true>>,
  ): Promise<Rows & { read(keys: readonly string[]): Row[] }>;
  write(values: unknown): Promise<void>;
  unlink(): Promise<void>;
  trail(options: { limit?: number; before?: number }): Promise<readonly TrailRow[]>;
}
interface Ref {
  search(q: unknown): Promise<Rows>;
  browse(ids: readonly number[]): Rows;
  create(rows: readonly unknown[]): Promise<Rows>;
}
const ref = (env: Env, name: string): Ref => env.model(name as never) as unknown as Ref;
/** x2many fields of the chatter's models: loaded with an object spec (their ids), the rest as a key list. */
const RELATIONS = new Set(['mentions', 'attachments']);
async function load(
  set: Rows,
  keys: readonly string[],
): Promise<{ read(keys: readonly string[]): Row[] }> {
  const scalars = keys.filter((k) => !RELATIONS.has(k));
  const relations = keys.filter((k) => RELATIONS.has(k));
  const loaded = await set.load(scalars);
  return relations.length === 0
    ? loaded
    : loaded.load(Object.fromEntries(relations.map((k) => [k, true] as const)));
}

async function rows(
  env: Env,
  model: string,
  where: unknown,
  keys: readonly string[],
  extra: { order?: readonly string[]; limit?: number } = {},
): Promise<Row[]> {
  const found = await ref(env, model).search({ where, ...extra });
  return found.length === 0 ? [] : (await load(found, keys)).read(['id', ...keys]);
}

const refuse = (status: number, type: string, title: string, detail: string): never => {
  throw new HttpProblem(status, type, title, detail);
};

const iso = (value: unknown): string | null =>
  value instanceof Date
    ? value.toISOString()
    : value === null || value === undefined
      ? null
      : String(value);

/** Field metadata the change log needs (from the served models). */
export interface FieldMeta {
  readonly label: string;
  readonly kind: string;
  readonly target: string | null;
  readonly options: readonly (readonly [string, string])[] | null;
}
export type ModelFields = ReadonlyMap<string, ReadonlyMap<string, FieldMeta>>;

/** What the chatter routes need from the server. */
export interface ChatterContext {
  /** The served (public) models, with their fields. */
  readonly models: ModelFields;
}

const servedModels = (context: ChatterContext): ReadonlySet<string> =>
  new Set(context.models.keys());

export interface UserRef {
  readonly id: number;
  readonly name: string;
}

export interface MessageItem {
  readonly type: 'message';
  readonly id: number;
  readonly kind: 'comment' | 'note' | 'activity' | 'system';
  readonly at: string;
  readonly author: UserRef | null;
  readonly body: string;
  /** The source text, for its author to edit. */
  readonly text: string | null;
  readonly mentions: readonly UserRef[];
  readonly attachments: readonly AttachmentInfo[];
  readonly editedAt: string | null;
  readonly mine: boolean;
}

export interface FieldChange {
  readonly field: string;
  readonly label: string;
  readonly kind: string;
  readonly old: unknown;
  readonly new: unknown;
  /** Labels of selection values and display names of records, when the caller may read them. */
  readonly oldLabel?: string;
  readonly newLabel?: string;
}

export interface ChangeItem {
  readonly type: 'change';
  /** The newest trail row id of the change. */
  readonly id: number;
  readonly at: string;
  readonly author: UserRef | null;
  /** `create` (the record was created) or `write` (tracked fields changed). */
  readonly action: 'create' | 'write';
  readonly changes: readonly FieldChange[];
}

export type TimelineItem = MessageItem | ChangeItem;

export interface ActivityItem {
  readonly id: number;
  readonly type: { readonly id: number; readonly name: string; readonly icon: string };
  readonly summary: string | null;
  readonly note: string | null;
  readonly deadline: string;
  readonly assignee: UserRef | null;
  readonly createdBy: number | null;
  readonly done: boolean;
  /** The caller created it or is its assignee: they may edit, complete or cancel it. */
  readonly mine: boolean;
}

export interface Cursor {
  readonly beforeMessage?: number;
  readonly beforeChange?: number;
}

export interface Chatter {
  readonly items: readonly TimelineItem[];
  /** The next (older) page, or `null` when this was the last one. */
  readonly next: Cursor | null;
  readonly followers: readonly UserRef[];
  readonly following: boolean;
  readonly activities: readonly ActivityItem[];
  /** The caller may manage followers other than themselves (write access to the record). */
  readonly canManageFollowers: boolean;
}

/** Names of users (archived ones too: authors of old messages). */
async function userNames(env: Env, ids: Iterable<number>): Promise<Map<number, string>> {
  const wanted = [...new Set(ids)].filter((id) => Number.isSafeInteger(id) && id > 0);
  if (wanted.length === 0) return new Map();
  const found = await rows(
    env,
    'res.users',
    { id: { in: wanted }, active: { in: [true, false] } },
    ['name'],
  );
  return new Map(found.map((u) => [u['id'] as number, String(u['name'])]));
}

const userRef = (names: ReadonlyMap<number, string>, id: unknown): UserRef | null =>
  typeof id === 'number' && names.has(id) ? { id, name: names.get(id) as string } : null;

/** Display names the caller may read (none without read access to the target model). */
async function displayNames(
  env: Env,
  target: string,
  ids: readonly number[],
): Promise<Map<number, string>> {
  if (ids.length === 0 || !env.access.can(target as never, 'read')) return new Map();
  const found = await rows(env, target, { id: { in: [...ids] } }, ['displayName']);
  return new Map(found.map((r) => [r['id'] as number, String(r['displayName'])]));
}

const MESSAGE_KEYS = [
  'kind',
  'author',
  'text',
  'body',
  'mentions',
  'attachments',
  'editedAt',
  'createdAt',
];

async function messageItems(
  env: Env,
  context: ChatterContext,
  found: Row[],
): Promise<MessageItem[]> {
  const people = new Set<number>();
  const attachmentIds: number[] = [];
  for (const m of found) {
    if (typeof m['author'] === 'number') people.add(m['author']);
    for (const u of (m['mentions'] as number[] | null) ?? []) people.add(u);
    attachmentIds.push(...((m['attachments'] as number[] | null) ?? []));
  }
  const names = await userNames(env, people);
  const files = new Map(
    (await attachmentsById(env, servedModels(context), attachmentIds)).map(
      ({ key: _key, ...a }) => [a.id, a],
    ),
  );
  return found.map((m) => {
    const mine = m['author'] === env.uid;
    return {
      type: 'message',
      id: m['id'] as number,
      kind: m['kind'] as MessageItem['kind'],
      at: iso(m['createdAt']) ?? '',
      author: userRef(names, m['author']),
      body: String(m['body']),
      text: mine ? String(m['text']) : null,
      mentions: ((m['mentions'] as number[] | null) ?? [])
        .map((u) => userRef(names, u))
        .filter((u): u is UserRef => u !== null),
      attachments: ((m['attachments'] as number[] | null) ?? [])
        .map((id) => files.get(id))
        .filter((a): a is AttachmentInfo => a !== undefined),
      editedAt: iso(m['editedAt']),
      mine,
    };
  });
}

/**
 * Trail rows grouped into changes (one per transaction), with labels and display names; `oldest` is the oldest
 * trail row of each change (the cursor below it).
 */
async function changeItems(
  env: Env,
  context: ChatterContext,
  model: string,
  trail: readonly TrailRow[],
): Promise<{ readonly item: ChangeItem; readonly oldest: number }[]> {
  const fields = context.models.get(model) ?? new Map<string, FieldMeta>();
  const groups: TrailRow[][] = [];
  for (const row of trail) {
    if (row.action !== 'create' && row.action !== 'write') continue;
    if (row.action === 'write' && (row.field === null || !fields.has(row.field))) continue;
    const last = groups[groups.length - 1];
    if (last !== undefined && last[0]?.tx === row.tx && last[0]?.action === row.action)
      last.push(row);
    else groups.push([row]);
  }
  // Display names of many2one values, per target model, as the caller.
  const byTarget = new Map<string, Set<number>>();
  for (const row of trail) {
    const meta = row.field === null ? undefined : fields.get(row.field);
    if (meta?.kind !== 'many2one' || meta.target === null) continue;
    const ids = byTarget.get(meta.target) ?? new Set<number>();
    for (const v of [row.old, row.new]) if (typeof v === 'number') ids.add(v);
    byTarget.set(meta.target, ids);
  }
  const names = new Map<string, Map<number, string>>();
  for (const [target, ids] of byTarget)
    names.set(target, await displayNames(env, target, [...ids]));
  const people = await userNames(
    env,
    groups.map((g) => g[0]?.uid ?? 0),
  );
  const label = (meta: FieldMeta, value: unknown): string | undefined => {
    if (value === null || value === undefined) return undefined;
    if (meta.options !== null) return meta.options.find(([v]) => v === value)?.[1];
    if (meta.kind === 'many2one' && meta.target !== null && typeof value === 'number')
      return names.get(meta.target)?.get(value);
    return undefined;
  };
  return groups.map((group) => {
    const first = group[0] as TrailRow;
    const changes: FieldChange[] = [];
    if (first.action === 'write')
      for (const row of [...group].reverse()) {
        const meta = fields.get(row.field as string) as FieldMeta;
        const oldLabel = label(meta, row.old);
        const newLabel = label(meta, row.new);
        changes.push({
          field: row.field as string,
          label: meta.label,
          kind: meta.kind,
          old: row.old,
          new: row.new,
          ...(oldLabel === undefined ? {} : { oldLabel }),
          ...(newLabel === undefined ? {} : { newLabel }),
        });
      }
    return {
      item: {
        type: 'change',
        id: first.id,
        at: first.at.toISOString(),
        author: first.su ? null : userRef(people, first.uid),
        action: first.action as 'create' | 'write',
        changes,
      },
      oldest: Math.min(...group.map((r) => r.id)),
    };
  });
}

async function activitiesOf(env: Env, model: string, id: number): Promise<ActivityItem[]> {
  const found = await rows(
    env,
    'mail.activity',
    { resModel: model, resId: id, done: false },
    ['type', 'summary', 'note', 'deadline', 'assignee', 'createdBy', 'done'],
    { order: ['deadline asc', 'id asc'] },
  );
  return activityItems(env, found);
}

async function activityItems(env: Env, found: Row[]): Promise<ActivityItem[]> {
  const types = new Map(
    (
      await rows(
        env,
        'mail.activity.type',
        {
          id: { in: [...new Set(found.map((a) => a['type'] as number))] },
          active: { in: [true, false] },
        },
        ['name', 'icon'],
      )
    ).map((t) => [t['id'] as number, t]),
  );
  const names = await userNames(
    env,
    found.map((a) => a['assignee'] as number),
  );
  return found.map((a) => {
    const type = types.get(a['type'] as number);
    return {
      id: a['id'] as number,
      type: {
        id: a['type'] as number,
        name: String(type?.['name'] ?? ''),
        icon: String(type?.['icon'] ?? 'circle-check'),
      },
      summary: (a['summary'] as string | null) ?? null,
      note: (a['note'] as string | null) ?? null,
      deadline: String(a['deadline']),
      assignee: userRef(names, a['assignee']),
      createdBy: (a['createdBy'] as number | null) ?? null,
      done: a['done'] === true,
      mine: a['createdBy'] === env.uid || a['assignee'] === env.uid,
    };
  });
}

async function followersOf(env: Env, model: string, id: number): Promise<UserRef[]> {
  const found = await rows(env, 'mail.follower', { resModel: model, resId: id }, ['user']);
  const names = await userNames(
    env,
    found.map((f) => f['user'] as number),
  );
  return found
    .map((f) => userRef(names, f['user']))
    .filter((u): u is UserRef => u !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function canWrite(env: Env, model: string, id: number): Promise<boolean> {
  if (!env.access.can(model as never, 'write')) return false;
  try {
    await (
      env.access as unknown as {
        checkRecords(m: string, ids: readonly number[], p: 'write'): Promise<void>;
      }
    ).checkRecords(model, [id], 'write');
    return true;
  } catch (error) {
    if (error instanceof Error && error.name === 'AccessError') return false;
    throw error;
  }
}

function needMessaging(env: Env): void {
  if (!env.access.can('mail.message' as never, 'read'))
    refuse(403, 'forbidden', 'Forbidden', 'The chatter needs the Messaging access level.');
}

/** Newest first; within one transaction, messages before the field changes they came with. */
function newestFirst(a: TimelineItem, b: TimelineItem): number {
  if (a.at !== b.at) return a.at < b.at ? 1 : -1;
  if (a.type !== b.type) return a.type === 'message' ? -1 : 1;
  return b.id - a.id;
}

/** Clamps a page size. */
export function pageSize(value: unknown, fallback = 30): number {
  const n = Number(value ?? fallback);
  return Number.isSafeInteger(n) && n > 0 ? Math.min(n, 100) : fallback;
}

/**
 * A page of the record's timeline (newest first: messages and changes merged by time), with its followers and
 * open activities.
 */
export async function chatterOf(
  env: Env,
  context: ChatterContext,
  model: string,
  id: number,
  cursor: Cursor = {},
  limit = 30,
): Promise<Chatter> {
  needMessaging(env);
  await checkRecord(env, servedModels(context), model, id);
  const messages = await rows(
    env,
    'mail.message',
    {
      resModel: model,
      resId: id,
      ...(cursor.beforeMessage === undefined ? {} : { id: { lt: cursor.beforeMessage } }),
    },
    MESSAGE_KEYS,
    { order: ['id desc'], limit: limit + 1 },
  );
  const trail = await ref(env, model)
    .browse([id])
    .trail({
      limit: limit + 1,
      ...(cursor.beforeChange === undefined ? {} : { before: cursor.beforeChange }),
    });
  const changes = await changeItems(env, context, model, trail);
  const oldest = new Map(changes.map((c) => [c.item.id, c.oldest]));
  const merged: TimelineItem[] = [
    ...(await messageItems(env, context, messages)),
    ...changes.map((c) => c.item),
  ].sort(newestFirst);
  const items = merged.slice(0, limit);
  const more = merged.length > limit || messages.length > limit || trail.length > limit;
  const lastMessage = [...items].reverse().find((i) => i.type === 'message');
  const shown = items.filter((i) => i.type === 'change').map((i) => oldest.get(i.id) as number);
  // Below the oldest change shown; with no change at all on this page (only skipped rows: untracked fields,
  // superuser markers), past those rows; otherwise the changes not shown yet come next.
  const beforeChange =
    shown.length > 0
      ? Math.min(...shown)
      : changes.length === 0 && trail.length > 0
        ? Math.min(...trail.map((r) => r.id))
        : cursor.beforeChange;
  const followers = await followersOf(env, model, id);
  return {
    items,
    next: more
      ? {
          ...(lastMessage === undefined
            ? cursor.beforeMessage === undefined
              ? {}
              : { beforeMessage: cursor.beforeMessage }
            : { beforeMessage: lastMessage.id }),
          ...(beforeChange === undefined ? {} : { beforeChange }),
        }
      : null,
    followers,
    following: followers.some((f) => f.id === env.uid),
    activities:
      cursor.beforeMessage === undefined && cursor.beforeChange === undefined
        ? await activitiesOf(env, model, id)
        : [],
    canManageFollowers: await canWrite(env, model, id),
  };
}

async function ensureFollower(env: Env, model: string, id: number, user: number): Promise<void> {
  const existing = await ref(env, 'mail.follower').search({
    where: { resModel: model, resId: id, user },
  });
  if (existing.length === 0)
    await ref(env, 'mail.follower').create([{ resModel: model, resId: id, user }]);
}

function checkText(text: unknown): string {
  if (typeof text !== 'string' || text.trim() === '' || text.length > MAX_TEXT)
    refuse(400, 'invalid-body', 'Invalid message', `text is 1 to ${MAX_TEXT} characters.`);
  return text as string;
}

/** Active users among `ids` (mentions of unknown or archived users are left as plain text). */
async function activeUsers(env: Env, ids: readonly number[]): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  const found = await rows(env, 'res.users', { id: { in: [...ids] } }, ['name']);
  return new Map(found.map((u) => [u['id'] as number, String(u['name'])]));
}

/** Posts a message or a note on a record; the author follows the record from then on. */
export async function postMessage(
  env: Env,
  context: ChatterContext,
  model: string,
  id: number,
  input: { readonly kind?: unknown; readonly text?: unknown; readonly attachments?: unknown },
): Promise<MessageItem> {
  needMessaging(env);
  const kind = input.kind ?? 'note';
  if (kind !== 'comment' && kind !== 'note')
    refuse(400, 'invalid-body', 'Invalid message', "kind is 'comment' or 'note'.");
  const text = checkText(input.text);
  const attachments = input.attachments ?? [];
  if (
    !Array.isArray(attachments) ||
    attachments.length > 20 ||
    !attachments.every((a) => Number.isSafeInteger(a) && (a as number) > 0)
  )
    refuse(400, 'invalid-body', 'Invalid message', 'attachments is a list of at most 20 ids.');
  const files = attachments as number[];
  const models = servedModels(context);
  await checkRecord(env, models, model, id);
  const found = await attachmentsById(env, models, files);
  if (found.some((a) => a.resModel !== model || a.resId !== id || a.createdBy !== env.uid))
    refuse(
      400,
      'invalid-attachment',
      'Invalid attachment',
      'Attach your own uploads to this record.',
    );
  if (files.length > 0) {
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
  const users = await activeUsers(env, mentionIds(text));
  const created = await ref(env, 'mail.message').create([
    {
      resModel: model,
      resId: id,
      kind,
      author: env.uid,
      text,
      body: renderBody(text, users),
      mentions: { set: [...users.keys()] },
      attachments: { set: files },
    },
  ]);
  await ensureFollower(env, model, id, env.uid);
  const [row] = (await load(created, MESSAGE_KEYS)).read(['id', ...MESSAGE_KEYS]);
  await env.emit('mail.message.posted', {
    model,
    id,
    message: row?.['id'],
    kind,
    author: env.uid,
    mentions: [...users.keys()],
    preview: plainText(text, users).slice(0, 200),
  });
  const [item] = await messageItems(env, context, [row as Row]);
  return item as MessageItem;
}

async function ownMessage(env: Env, context: ChatterContext, messageId: number): Promise<Row> {
  needMessaging(env);
  const [message] = await rows(env, 'mail.message', { id: messageId }, [
    'resModel',
    'resId',
    'kind',
    'author',
    'attachments',
  ]);
  if (message === undefined) return refuse(404, 'missing-record', 'Not found', 'No such message.');
  await checkRecord(
    env,
    servedModels(context),
    String(message['resModel']),
    Number(message['resId']),
  );
  if (message['author'] !== env.uid && !env.administrator)
    refuse(403, 'forbidden', 'Forbidden', 'Only the author changes a message.');
  if (message['kind'] !== 'comment' && message['kind'] !== 'note')
    refuse(
      400,
      'invalid-message',
      'Not editable',
      'Activity and system entries cannot be changed.',
    );
  return message;
}

/** Edits the text of the caller's own message or note. */
export async function editMessage(
  env: Env,
  context: ChatterContext,
  messageId: number,
  input: { readonly text?: unknown },
): Promise<MessageItem> {
  await ownMessage(env, context, messageId);
  const text = checkText(input.text);
  const users = await activeUsers(env, mentionIds(text));
  const message = ref(env, 'mail.message').browse([messageId]);
  await message.write({
    text,
    body: renderBody(text, users),
    mentions: { set: [...users.keys()] },
    editedAt: new Date(),
  });
  const [row] = (await load(message, MESSAGE_KEYS)).read(['id', ...MESSAGE_KEYS]);
  const [item] = await messageItems(env, context, [row as Row]);
  return item as MessageItem;
}

/** Deletes the caller's own message or note and its attachments; returns the object keys to delete. */
export async function deleteMessage(
  env: Env,
  context: ChatterContext,
  messageId: number,
): Promise<string[]> {
  const message = await ownMessage(env, context, messageId);
  const files = (message['attachments'] as number[] | null) ?? [];
  await ref(env, 'mail.message').browse([messageId]).unlink();
  return removeAttachments(env, servedModels(context), files);
}

/** Follows (`follow: true`) or unfollows a record, for the caller or (with write access) another user. */
export async function setFollower(
  env: Env,
  context: ChatterContext,
  model: string,
  id: number,
  input: { readonly user?: unknown; readonly follow?: unknown },
): Promise<readonly UserRef[]> {
  needMessaging(env);
  await checkRecord(env, servedModels(context), model, id);
  const user = input.user === undefined ? env.uid : Number(input.user);
  if (!Number.isSafeInteger(user) || user <= 0)
    refuse(400, 'invalid-body', 'Invalid follower', 'user is a user id.');
  if (typeof input.follow !== 'boolean')
    refuse(400, 'invalid-body', 'Invalid follower', 'follow is true or false.');
  if (user !== env.uid && !(await canWrite(env, model, id)))
    refuse(
      403,
      'forbidden',
      'Forbidden',
      'Managing other followers needs write access to the record.',
    );
  if (input.follow === true) {
    if ((await activeUsers(env, [user])).size === 0)
      refuse(400, 'invalid-body', 'Invalid follower', `No active user ${user}.`);
    await ensureFollower(env, model, id, user);
  } else {
    const existing = await ref(env, 'mail.follower').search({
      where: { resModel: model, resId: id, user },
    });
    if (existing.length > 0) await existing.unlink();
  }
  return followersOf(env, model, id);
}

function checkDate(value: unknown, what: string): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(Date.parse(value))
  )
    refuse(400, 'invalid-body', 'Invalid activity', `${what} is a date (YYYY-MM-DD).`);
  return value as string;
}

function optionalText(value: unknown, what: string, max: number): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > max)
    refuse(
      400,
      'invalid-body',
      'Invalid activity',
      `${what} is a text of at most ${max} characters.`,
    );
  return value as string;
}

/** Plans an activity on a record for an assignee (the assignee is told: `mail.activity.assigned`). */
export async function scheduleActivity(
  env: Env,
  context: ChatterContext,
  model: string,
  id: number,
  input: {
    readonly type?: unknown;
    readonly summary?: unknown;
    readonly note?: unknown;
    readonly deadline?: unknown;
    readonly assignee?: unknown;
  },
): Promise<ActivityItem> {
  needMessaging(env);
  await checkRecord(env, servedModels(context), model, id);
  const type = Number(input.type);
  if (!Number.isSafeInteger(type) || type <= 0)
    refuse(400, 'invalid-body', 'Invalid activity', 'type is an activity type id.');
  if ((await rows(env, 'mail.activity.type', { id: type }, [])).length === 0)
    refuse(400, 'invalid-body', 'Invalid activity', `No activity type ${type}.`);
  const assignee = input.assignee === undefined ? env.uid : Number(input.assignee);
  if (!Number.isSafeInteger(assignee) || (await activeUsers(env, [assignee])).size === 0)
    refuse(400, 'invalid-body', 'Invalid activity', 'assignee is an active user.');
  const values = {
    resModel: model,
    resId: id,
    type,
    summary: optionalText(input.summary, 'summary', 200),
    note: optionalText(input.note, 'note', 4000),
    deadline: checkDate(input.deadline, 'deadline'),
    assignee,
  };
  const created = await ref(env, 'mail.activity').create([values]);
  const activityId = created.ids[0] as number;
  await env.emit('mail.activity.assigned', {
    model,
    id,
    activity: activityId,
    assignee,
    deadline: values.deadline,
    by: env.uid,
  });
  const [item] = await activityItems(
    env,
    await rows(env, 'mail.activity', { id: activityId }, [
      'type',
      'summary',
      'note',
      'deadline',
      'assignee',
      'createdBy',
      'done',
    ]),
  );
  return item as ActivityItem;
}

async function involvedActivity(
  env: Env,
  context: ChatterContext,
  activityId: number,
): Promise<Row> {
  needMessaging(env);
  const [activity] = await rows(env, 'mail.activity', { id: activityId }, [
    'resModel',
    'resId',
    'type',
    'summary',
    'assignee',
    'createdBy',
    'done',
  ]);
  if (activity === undefined)
    return refuse(404, 'missing-record', 'Not found', 'No such activity.');
  await checkRecord(
    env,
    servedModels(context),
    String(activity['resModel']),
    Number(activity['resId']),
  );
  if (activity['createdBy'] !== env.uid && activity['assignee'] !== env.uid && !env.administrator)
    refuse(403, 'forbidden', 'Forbidden', 'Only its creator or assignee changes an activity.');
  if (activity['done'] === true)
    refuse(409, 'activity-done', 'Activity done', 'This activity is done already.');
  return activity;
}

/** Changes an open activity (its creator or assignee). */
export async function updateActivity(
  env: Env,
  context: ChatterContext,
  activityId: number,
  input: {
    readonly summary?: unknown;
    readonly note?: unknown;
    readonly deadline?: unknown;
    readonly assignee?: unknown;
  },
): Promise<void> {
  const activity = await involvedActivity(env, context, activityId);
  const values: Record<string, unknown> = {};
  if (input.summary !== undefined) values['summary'] = optionalText(input.summary, 'summary', 200);
  if (input.note !== undefined) values['note'] = optionalText(input.note, 'note', 4000);
  if (input.deadline !== undefined) values['deadline'] = checkDate(input.deadline, 'deadline');
  if (input.assignee !== undefined) {
    const assignee = Number(input.assignee);
    if (!Number.isSafeInteger(assignee) || (await activeUsers(env, [assignee])).size === 0)
      refuse(400, 'invalid-body', 'Invalid activity', 'assignee is an active user.');
    values['assignee'] = assignee;
  }
  await ref(env, 'mail.activity').browse([activityId]).write(values);
  if (values['assignee'] !== undefined && values['assignee'] !== activity['assignee'])
    await env.emit('mail.activity.assigned', {
      model: activity['resModel'],
      id: activity['resId'],
      activity: activityId,
      assignee: values['assignee'],
      deadline: values['deadline'] ?? null,
      by: env.uid,
    });
}

/** Marks an activity done (with optional feedback) and logs it in the chatter. */
export async function completeActivity(
  env: Env,
  context: ChatterContext,
  activityId: number,
  input: { readonly feedback?: unknown },
): Promise<MessageItem> {
  const activity = await involvedActivity(env, context, activityId);
  const feedback = optionalText(input.feedback, 'feedback', 4000);
  await ref(env, 'mail.activity')
    .browse([activityId])
    .write({ done: true, doneAt: new Date(), ...(feedback === null ? {} : { feedback }) });
  const [type] = await rows(
    env,
    'mail.activity.type',
    { id: activity['type'], active: { in: [true, false] } },
    ['name'],
  );
  const summary =
    activity['summary'] === null || activity['summary'] === undefined
      ? ''
      : `: ${activity['summary']}`;
  const text = `**${String(type?.['name'] ?? '').replace(/\*/g, '')} done**${summary}${feedback === null ? '' : `\n\n${feedback}`}`;
  const created = await ref(env, 'mail.message').create([
    {
      resModel: activity['resModel'],
      resId: activity['resId'],
      kind: 'activity',
      author: env.uid,
      text,
      body: renderBody(text, new Map()),
    },
  ]);
  const [row] = (await load(created, MESSAGE_KEYS)).read(['id', ...MESSAGE_KEYS]);
  const [item] = await messageItems(env, context, [row as Row]);
  return item as MessageItem;
}

/** Cancels (removes) an open activity. */
export async function cancelActivity(
  env: Env,
  context: ChatterContext,
  activityId: number,
): Promise<void> {
  await involvedActivity(env, context, activityId);
  await ref(env, 'mail.activity').browse([activityId]).unlink();
}

/** The activity types, in order. */
export async function activityTypes(
  env: Env,
): Promise<{ id: number; name: string; icon: string; days: number }[]> {
  needMessaging(env);
  return (
    await rows(env, 'mail.activity.type', {}, ['name', 'icon', 'days'], {
      order: ['sequence asc', 'id asc'],
    })
  ).map((t) => ({
    id: t['id'] as number,
    name: String(t['name']),
    icon: String(t['icon']),
    days: Number(t['days'] ?? 0),
  }));
}

/**
 * The caller's open activities on records they can still read (assignments on records they lost access to are
 * left out), by deadline, with each record's display name.
 */
export async function myActivities(
  env: Env,
  context: ChatterContext,
): Promise<
  (ActivityItem & { readonly model: string; readonly resId: number; readonly record: string })[]
> {
  needMessaging(env);
  const found = await rows(
    env,
    'mail.activity',
    { assignee: env.uid, done: false },
    ['resModel', 'resId', 'type', 'summary', 'note', 'deadline', 'assignee', 'createdBy', 'done'],
    { order: ['deadline asc', 'id asc'], limit: 500 },
  );
  const byModel = new Map<string, number[]>();
  for (const a of found) {
    const model = String(a['resModel']);
    if (!context.models.has(model)) continue;
    byModel.set(model, [...(byModel.get(model) ?? []), Number(a['resId'])]);
  }
  const visible = new Map<string, Map<number, string>>();
  for (const [model, ids] of byModel) visible.set(model, await displayNames(env, model, ids));
  const kept = found.filter(
    (a) => visible.get(String(a['resModel']))?.has(Number(a['resId'])) === true,
  );
  const items = await activityItems(env, kept);
  return items.map((item, i) => {
    const a = kept[i] as Row;
    const model = String(a['resModel']);
    const resId = Number(a['resId']);
    return { ...item, model, resId, record: visible.get(model)?.get(resId) ?? '' };
  });
}

/** Installs the default activity types that do not exist yet (by key). */
export async function installActivityTypes(env: Env): Promise<number> {
  let created = 0;
  for (const spec of DEFAULT_ACTIVITY_TYPES) {
    const existing = await ref(env, 'mail.activity.type').search({
      where: { key: spec.key, active: { in: [true, false] } },
    });
    if (existing.length > 0) continue;
    await ref(env, 'mail.activity.type').create([spec]);
    created++;
  }
  return created;
}
