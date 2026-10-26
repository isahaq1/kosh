/**
 * The chatter's models (RFC 0006 §5.1). All private: they are reached only through the chatter routes, which check
 * the record a row belongs to as the caller first. Rules keep messages editable by their author only, and
 * activities by their creator or assignee.
 */

import { orm } from '@kosh/server/orm';
import { storageShutro } from '@kosh/storage';

const { defineGroup, defineModel, defineModule, f } = orm;

const target = {
  resModel: f.char({ required: true, label: 'Model' }),
  resId: f.integer({ required: true, label: 'Record' }),
};

/** A message on a record: a comment (to followers), an internal note, or an activity / system entry. */
const Message = defineModel('mail.message', {
  access: { 'messaging.user': ['read', 'create', 'write', 'unlink'] },
  rules: {
    own: {
      groups: ['messaging.user'],
      perms: ['write', 'unlink'],
      domain: { author: { $env: 'uid' } },
    },
  },
  indexes: [{ fields: ['resModel', 'resId'] }],
  order: ['id desc'],
  fields: {
    ...target,
    kind: f.selection(
      { comment: 'Message', note: 'Note', activity: 'Activity', system: 'System' },
      { required: true, default: 'note' },
    ),
    author: f.many2one('res.users', { ondelete: 'set null' }),
    /** A message that came by email from someone who is not a user (RFC 0006 part 7): the sender. */
    authorEmail: f.char(),
    authorName: f.char(),
    /** What the author wrote (a small markdown subset, mentions as `@[Name](user:12)`). */
    text: f.text({ required: true }),
    /** HTML rendered from `text` on the server, escaped by construction. */
    body: f.text({ required: true }),
    mentions: f.many2many('res.users', { relation: 'mail_message_mention' }),
    attachments: f.many2many('storage.attachment', { relation: 'mail_message_attachment' }),
    editedAt: f.datetime(),
    /** Chat (RFC 0006 part 6): the thread a reply belongs to (one level), its replies, and its reactions. */
    parent: f.many2one('mail.message', { ondelete: 'cascade' }),
    replyCount: f.integer({ required: true, default: 0 }),
    reactions: f.one2many('mail.message.reaction', 'message'),
    /** Removed by a channel manager: the text is gone, the row keeps the thread whole. */
    deletedAt: f.datetime(),
  },
});

/** A user's reaction to a chat message (one per emoji and user). */
const Reaction = defineModel('mail.message.reaction', {
  access: { 'messaging.user': ['read', 'create', 'unlink'] },
  rules: {
    own: { groups: ['messaging.user'], perms: ['unlink'], domain: { user: { $env: 'uid' } } },
  },
  indexes: [{ fields: ['message', 'user', 'emoji'], unique: true }],
  fields: {
    message: f.many2one('mail.message', { required: true, ondelete: 'cascade' }),
    user: f.many2one('res.users', { required: true, ondelete: 'cascade' }),
    emoji: f.char({ required: true, size: 16 }),
  },
});

/**
 * A chat channel (RFC 0006 part 6): a public channel of the company, a private group, or a direct conversation of
 * two users. Members read and post; a public channel is readable by every user of the company and joinable.
 * Managers (`messaging.manager`) and a group's creator change it; the rules below are the fence.
 */
const Channel = defineModel('mail.channel', {
  label: 'Chat channel',
  recName: 'name',
  archivable: true,
  companyScoped: { required: true },
  access: {
    'messaging.user': ['read', 'create', 'write'],
    'messaging.manager': ['read', 'create', 'write', 'unlink'],
  },
  rules: {
    visible: {
      groups: ['messaging.user'],
      perms: ['read'],
      domain: { or: [{ public: true }, { members: { any: { user: { $env: 'uid' } } } }] },
    },
    creator: {
      groups: ['messaging.user'],
      perms: ['write'],
      domain: { createdBy: { $env: 'uid' } },
    },
    // Managers run every channel they can see (public ones, and groups they belong to), not read every group.
    all: { groups: ['messaging.manager'], perms: ['write', 'unlink'], domain: {} },
  },
  indexes: [{ fields: ['pairKey'], unique: true }, { fields: ['lastMessageAt'] }],
  order: ['lastMessageAt desc', 'id desc'],
  fields: {
    name: f.char({ required: true }),
    kind: f.selection(
      { channel: 'Channel', group: 'Group', direct: 'Direct' },
      { required: true, default: 'channel' },
    ),
    description: f.char(),
    /** Readable and joinable by every user of the company (channels only). */
    public: f.boolean({ default: false }),
    members: f.one2many('mail.channel.member', 'channel'),
    /** Direct conversations only: `<smaller user id>:<larger user id>`, so a pair has one. */
    pairKey: f.char(),
    lastMessageAt: f.datetime(),
  },
});

/** A member of a channel: their read receipt, mute and pin. */
const ChannelMember = defineModel('mail.channel.member', {
  companyScoped: { required: true },
  access: { 'messaging.user': ['read', 'create', 'write', 'unlink'] },
  rules: {
    own: {
      groups: ['messaging.user'],
      perms: ['write', 'unlink'],
      domain: { user: { $env: 'uid' } },
    },
    all: { groups: ['messaging.manager'], perms: ['write', 'unlink'], domain: {} },
  },
  indexes: [{ fields: ['channel', 'user'], unique: true }],
  fields: {
    channel: f.many2one('mail.channel', { required: true, ondelete: 'cascade' }),
    user: f.many2one('res.users', { required: true, ondelete: 'cascade' }),
    lastReadMessage: f.many2one('mail.message', { ondelete: 'set null' }),
    muted: f.boolean({ default: false }),
    pinned: f.boolean({ default: false }),
  },
});

/** A user following a record: notified of its messages (RFC 0006 part 3). */
const Follower = defineModel('mail.follower', {
  access: { 'messaging.user': ['read', 'create', 'unlink'] },
  indexes: [{ fields: ['resModel', 'resId', 'user'], unique: true }],
  fields: {
    ...target,
    user: f.many2one('res.users', { required: true, ondelete: 'cascade' }),
  },
});

/** A kind of activity: to-do, call, meeting, ... (default days ahead for the deadline, a lucide icon name). */
const ActivityType = defineModel('mail.activity.type', {
  archivable: true,
  access: { 'messaging.user': ['read'] },
  order: ['sequence asc', 'id asc'],
  fields: {
    name: f.char({ required: true, translate: true }),
    key: f.char({ index: 'unique' }),
    icon: f.char({ default: 'circle-check' }),
    days: f.integer({ default: 0 }),
    sequence: f.integer({ default: 10 }),
  },
});

/** A planned activity on a record, assigned to a user, due on a date. */
const Activity = defineModel('mail.activity', {
  access: { 'messaging.user': ['read', 'create', 'write', 'unlink'] },
  rules: {
    involved: {
      groups: ['messaging.user'],
      perms: ['write', 'unlink'],
      domain: { or: [{ createdBy: { $env: 'uid' } }, { assignee: { $env: 'uid' } }] },
    },
  },
  indexes: [{ fields: ['resModel', 'resId'] }, { fields: ['assignee', 'done', 'deadline'] }],
  order: ['deadline asc', 'id asc'],
  fields: {
    ...target,
    type: f.many2one('mail.activity.type', { required: true }),
    summary: f.char(),
    note: f.text(),
    deadline: f.date({ required: true }),
    assignee: f.many2one('res.users', { required: true }),
    done: f.boolean({ default: false }),
    doneAt: f.datetime(),
    feedback: f.text(),
  },
});

export const messagingShutro: ReturnType<typeof orm.defineModule> = defineModule({
  name: 'messaging',
  version: '0.1.0',
  depends: [storageShutro],
  groups: [
    defineGroup({
      code: 'messaging.user',
      label: 'Messaging',
      implies: ['base.user', 'storage.user'],
    }),
    defineGroup({
      code: 'messaging.manager',
      label: 'Messaging manager (public chat channels)',
      implies: ['messaging.user'],
    }),
  ],
  models: [Message, Follower, ActivityType, Activity, Reaction, Channel, ChannelMember],
});

/** The activity types installed with the module (`key` keeps reinstalls from duplicating them). */
export const DEFAULT_ACTIVITY_TYPES: readonly {
  readonly key: string;
  readonly name: string;
  readonly icon: string;
  readonly days: number;
  readonly sequence: number;
}[] = [
  { key: 'messaging.todo', name: 'To-do', icon: 'list-todo', days: 5, sequence: 1 },
  { key: 'messaging.call', name: 'Call', icon: 'phone', days: 2, sequence: 2 },
  { key: 'messaging.meeting', name: 'Meeting', icon: 'users', days: 0, sequence: 3 },
  { key: 'messaging.email', name: 'Email', icon: 'mail', days: 2, sequence: 4 },
  { key: 'messaging.upload', name: 'Upload document', icon: 'upload', days: 5, sequence: 5 },
];
