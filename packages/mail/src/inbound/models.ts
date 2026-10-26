/**
 * The inbound email log (RFC 0006 §7.1): one row per message received, exactly once (`messageId` is unique),
 * with what became of it: posted on a record, quarantined for an administrator (no target, or a sender the
 * record does not know), discarded, or dropped (automatic). Private: reached through the mail routes only, by
 * `mail.manager`.
 */
import { messagingShutro } from '@kosh/messaging';
import { orm } from '@kosh/server/orm';

const { defineGroup, defineModel, defineModule, f } = orm;

export const INBOUND_STATES = [
  'received',
  'posted',
  'quarantined',
  'discarded',
  'dropped',
] as const;
export type InboundState = (typeof INBOUND_STATES)[number];

const InboundMessage = defineModel('mail.inbound_message', {
  label: 'Inbound email',
  order: ['id desc'],
  access: { 'mail.manager': ['read', 'write', 'unlink'] },
  indexes: [{ fields: ['messageId'], unique: true }, { fields: ['state'] }],
  fields: {
    messageId: f.char({ required: true, size: 998 }),
    from: f.char({ label: 'From' }),
    fromName: f.char(),
    /** The recipients, comma-separated. */
    to: f.text(),
    subject: f.char({ size: 998 }),
    /** The reply (quotes cut), what was or would be posted. */
    text: f.text(),
    /** The sanitized HTML, for the quarantine page. */
    html: f.text(),
    receivedAt: f.datetime({ required: true, default: () => new Date() }),
    state: f.selection(
      {
        received: 'Received',
        posted: 'Posted',
        quarantined: 'Quarantined',
        discarded: 'Discarded',
        dropped: 'Dropped',
      },
      { required: true, default: 'received' },
    ),
    /** Why it was quarantined or dropped (`no-target`, `sender-unknown`, `no-access`, `automatic`). */
    reason: f.char(),
    /** The record the message was posted on, or the one it was meant for. */
    resModel: f.char(),
    resId: f.integer(),
    /** The user the reply address named. */
    recipient: f.many2one('res.users', { ondelete: 'set null' }),
    postedMessage: f.many2one('mail.message', { ondelete: 'set null' }),
    attachmentCount: f.integer({ required: true, default: 0 }),
    /** The source (raw message or provider JSON), for a retry; large messages are kept without it. */
    raw: f.text(),
  },
});

export const mailShutro: ReturnType<typeof orm.defineModule> = defineModule({
  name: 'mail',
  version: '0.1.0',
  depends: [messagingShutro],
  groups: [
    defineGroup({
      code: 'mail.manager',
      label: 'Email manager (inbound email)',
      implies: ['base.user', 'messaging.user'],
    }),
  ],
  models: [InboundMessage],
});
