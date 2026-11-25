/**
 * What the activity log records (decided 2026-11-25): **every business record** — masters, documents and their
 * lines — logs its creation, each change (the field, the old and the new value) and its deletion. Shutro tracks by
 * default (`tracking: { default: 'all' }`, Shutro 0.3.9); this is what Kosh leaves out, and why:
 *
 * - **sign-in internals** (`auth.*`, `oauth.*`): sessions, credentials, tokens and keys. Sign-ins and permission
 *   changes have audit rows of their own (`audit_event`, Shutro's `security` rows); their tables hold secrets.
 * - **queues, deliveries and logs**: notifications, outgoing and inbound mail, webhook deliveries, automation
 *   runs, report outputs, raw device punches, presence, sync state. They are records *of* activity already, written
 *   by the server many times a minute: logging them would log the log.
 * - **the chatter itself**: messages, reactions, followers — the timeline that shows the log. (Attachments,
 *   scheduled activities, approval requests and votes, invitations and settings are business facts: logged.)
 * - **secret and bulky fields** on any model: what the server keeps hashed, sealed or as a token, and binary, JSON
 *   and rich-text values (a description's every keystroke would be kept twice, for ever).
 *
 * What a model tracks explicitly (`tracking: [...]`, `tracking: true` on a field) stays tracked whatever this says.
 * Values in the log are shown through field security: a field a person may not read is not in their timeline.
 */

/** Models left out whole, by name. */
const MODELS: readonly RegExp[] = [
  /^(auth|oauth|notify)\./,
  /^mail\.(message|message\.reaction|follower|outgoing|inbound_message|channel\.member)$/,
  /^automation\.(run|cursor)$/,
  /^report\.output$/,
  /^livechat\.(presence|message)$/,
  /^attendance\.device\.punch$/,
  /^calendar\.sync\./,
  /^kosh\.(image|merge)$/,
  /^assistant\.call$/,
  /^webhook\.(delivery|inbound)$/,
  /^(delivery\.shipment|approval)\.event$/,
  /^audit\.event$/,
  /^portal\.announcement$/,
  // Named by what they are — not `.event`, `.run` or `.state`: Agenda's events, payroll runs and a country's
  // states are business records.
  /\.(log|cursor|presence)$/,
];

/** Fields whose value is a secret the server keeps, by key. */
const SECRET = /(secret|token|hash|sealed|password|passcode|pin|otp|signature)$/i;

/** Kinds whose values are too large to keep twice. */
const BULKY: ReadonlySet<string> = new Set(['binary', 'json', 'html']);

/** Whether the activity log leaves out `model` (called without a field) or one of its fields. */
export function leftOutOfTrail(
  model: string,
  field?: { readonly key: string; readonly kind: string },
): boolean {
  if (field === undefined) return MODELS.some((pattern) => pattern.test(model));
  return BULKY.has(field.kind) || SECRET.test(field.key);
}
