/**
 * The notification models (RFC 0006 §5.3–5.4): one `notify.notification` per recipient and event, translated by
 * the client from its `kind` and `params` (so a user reads it in their own language), and the recipient's
 * `notify.preference` per kind and channel. Both are private models: the inbox subscriber writes them, the routes
 * read and mark them, and every user sees only their own (record rules).
 */
import { baseShutro } from '@kosh/server';
import { orm } from '@kosh/server/orm';

const { defineModel, defineModule, f } = orm;

/** What a notification is about; the client translates `notify.kinds.<kind>` with the `params`. */
export const KINDS = [
  'mention',
  'approval.requested',
  'approval.decided',
  'activity.assigned',
  'chat.direct',
  'email.bounced',
  'automation',
] as const;
export type Kind = (typeof KINDS)[number];
/** Delivery channels; `inapp` is the inbox, the others come with their adapters (SMS and WhatsApp opt in). */
export const CHANNELS = ['inapp', 'email', 'webpush', 'sms', 'whatsapp'] as const;
export type Channel = (typeof CHANNELS)[number];

const Notification = defineModel('notify.notification', {
  label: 'Notification',
  order: ['createdAt desc', 'id desc'],
  access: { 'base.user': ['read', 'write'] },
  rules: {
    own: { groups: ['base.user'], perms: ['read', 'write'], domain: { user: { $env: 'uid' } } },
  },
  fields: {
    user: f.many2one('res.users', { required: true, ondelete: 'cascade' }),
    kind: f.char({ required: true }),
    /** What the message needs: names, a preview, a state (JSON, never HTML). */
    params: f.json({ required: true, default: {} }),
    resModel: f.char({ required: true }),
    resId: f.integer({ required: true }),
    actor: f.many2one('res.users', { ondelete: 'set null' }),
    company: f.many2one('res.company', { ondelete: 'cascade' }),
    readAt: f.datetime(),
  },
});

const Preference = defineModel('notify.preference', {
  label: 'Notification preference',
  access: { 'base.user': ['read', 'write', 'create', 'unlink'] },
  rules: {
    own: {
      groups: ['base.user'],
      perms: ['read', 'write', 'create', 'unlink'],
      domain: { user: { $env: 'uid' } },
    },
  },
  fields: {
    user: f.many2one('res.users', { required: true, ondelete: 'cascade' }),
    kind: f.char({ required: true }),
    channel: f.char({ required: true }),
    enabled: f.boolean({ required: true, default: true }),
    /**
     * Email only (RFC 0006 §8.1): `instant`, `daily` (in the digest) or `off`. Unset: `enabled` decides
     * (`instant` or `off`), so rows from before the digests need no migration.
     */
    mode: f.char({ size: 10 }),
  },
  sqlConstraints: {
    onePerKindAndChannel: {
      unique: ['user', 'kind', 'channel'],
      message: 'One preference per kind and channel.',
    },
  },
});

/** One attempt stream of a notification on a channel (the system's: no user access). */
const Delivery = defineModel('notify.delivery', {
  label: 'Notification delivery',
  order: ['id desc'],
  access: {},
  fields: {
    notification: f.many2one('notify.notification', { required: true, ondelete: 'cascade' }),
    channel: f.char({ required: true }),
    state: f.selection(
      {
        pending: 'Pending',
        sent: 'Sent',
        failed: 'Failed',
        skipped: 'Skipped',
        bounced: 'Bounced',
        held: 'Held (quiet hours)',
        digest: 'In the next digest',
      },
      { required: true, default: 'pending' },
    ),
    /** `held`: not sent before this instant (the end of the recipient's quiet hours). */
    notBefore: f.datetime(),
    /** The delivery this one replaces on the recipient's fallback channel (RFC 0006 §8.4). */
    fallbackOf: f.many2one('notify.delivery', { ondelete: 'set null' }),
    attempts: f.integer({ required: true, default: 0 }),
    error: f.text(),
    providerId: f.char(),
    sentAt: f.datetime(),
  },
});

/** A user's notification settings (RFC 0006 §8.1): quiet hours, the digest hour, the fallback channel. */
const Settings = defineModel('notify.settings', {
  label: 'Notification settings',
  access: { 'base.user': ['read', 'write', 'create'] },
  rules: {
    own: {
      groups: ['base.user'],
      perms: ['read', 'write', 'create'],
      domain: { user: { $env: 'uid' } },
    },
  },
  fields: {
    user: f.many2one('res.users', { required: true, ondelete: 'cascade', index: 'unique' }),
    /** `HH:MM` in the user's time zone; with `quietTo`, the daily quiet hours (may cross midnight). */
    quietFrom: f.char({ size: 5 }),
    quietTo: f.char({ size: 5 }),
    /** Whole days off: `["fri", "sat"]`. */
    quietDays: f.json(),
    /** When the daily digest goes out, `HH:MM` in the user's time zone. */
    digestHour: f.char({ size: 5, required: true, default: '08:00' }),
    /** The channel that takes over when another cannot deliver (`none`: no fallback). */
    fallback: f.char({ size: 10, required: true, default: 'email' }),
  },
});

/** A browser's push subscription on one device (its owner creates, sees and removes it). */
const PushSubscription = defineModel('notify.push_subscription', {
  label: 'Push subscription',
  access: { 'base.user': ['read', 'write', 'create', 'unlink'] },
  rules: {
    own: {
      groups: ['base.user'],
      perms: ['read', 'write', 'create', 'unlink'],
      domain: { user: { $env: 'uid' } },
    },
  },
  fields: {
    user: f.many2one('res.users', { required: true, ondelete: 'cascade' }),
    endpoint: f.char({ required: true, size: 2000, index: 'unique' }),
    p256dh: f.char({ required: true, size: 500 }),
    auth: f.char({ required: true, size: 200 }),
    userAgent: f.char({ size: 200 }),
    lastSeenAt: f.datetime(),
  },
});

export const notifyShutro: ReturnType<typeof orm.defineModule> = defineModule({
  name: 'notify',
  version: '0.2.0',
  depends: [baseShutro],
  models: [Notification, Preference, Delivery, Settings, PushSubscription],
});
