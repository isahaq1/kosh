/**
 * The integrations platform's models (RFC 0017 §5.3): webhook subscriptions (a URL, the events it wants, the secret
 * deliveries are signed with, the user whose read rights shape the payloads) and deliveries (each event sent to a
 * subscription: the payload, every attempt's outcome, replays). Managed by `integrations.manager`.
 */
import { randomBytes } from 'node:crypto';
import { baseShutro } from '@kosh/server';
import { orm } from '@kosh/server/orm';

const { defineGroup, defineModel, defineModule, f } = orm;

const ALL = ['read', 'write', 'create', 'unlink', 'export', 'import'] as const;

/** A new signing secret. */
export const newSecret = (): string => `whsec_${randomBytes(24).toString('base64url')}`;

/** Where events are sent. */
const Subscription = defineModel('webhook.subscription', {
  label: 'Webhook',
  recName: 'name',
  companyScoped: { required: true },
  order: ['name asc', 'id asc'],
  tracking: ['url', 'events', 'active', 'runAs'],
  access: { 'integrations.manager': ALL },
  fields: {
    name: f.char({ required: true }),
    /** https (http only for localhost), on the webhook host allow-list. */
    url: f.char({ required: true, label: 'URL' }),
    /** Space-separated: `res.partner.created`, `sale.order.updated`, `account.move.posted`… */
    events: f.text({ required: true }),
    active: f.boolean({ default: true }),
    /** Deliveries carry `X-Shutro-Signature: t=<time>,v1=<HMAC-SHA256 of "<time>.<body>">`. */
    secret: f.char({ required: true, default: newSecret, label: 'Signing secret' }),
    /** Whose read rights decide what payloads contain (default: who made the webhook). */
    runAs: f.many2one('res.users', { label: 'Acts as' }),
    /** Deliveries that failed in a row (reset by a success). */
    failures: f.integer({ required: true, default: 0, label: 'Failures in a row' }),
    lastDeliveryAt: f.datetime({ label: 'Last delivery' }),
    deliveries: f.one2many('webhook.delivery', 'subscription'),
  },
});

/** One event sent to one subscription, with its attempts. */
const Delivery = defineModel('webhook.delivery', {
  label: 'Webhook delivery',
  companyScoped: { required: true },
  order: ['id desc'],
  access: { 'integrations.manager': ['read', 'export'] },
  fields: {
    subscription: f.many2one('webhook.subscription', { required: true, ondelete: 'cascade' }),
    event: f.char({ required: true }),
    /** The JSON body sent (`{ id, event, occurredAt, data }`). */
    payload: f.json({ required: true }),
    state: f.selection(
      { pending: 'Pending', done: 'Delivered', failed: 'Failed' },
      { required: true, default: 'pending' },
    ),
    attempts: f.integer({ required: true, default: 0 }),
    responseStatus: f.integer({ label: 'Response status' }),
    /** The start of the response body (2 KB). */
    responseBody: f.text({ label: 'Response' }),
    durationMs: f.integer({ label: 'Duration (ms)' }),
    error: f.text(),
    deliveredAt: f.datetime({ label: 'Delivered at' }),
    /** A replay: the delivery it sends again. */
    replayOf: f.many2one('webhook.delivery', { label: 'Replay of' }),
  },
});

export const integrationsShutro: ReturnType<typeof orm.defineModule> = defineModule({
  name: 'integrations',
  version: '0.1.0',
  depends: [baseShutro],
  groups: [
    defineGroup({
      code: 'integrations.manager',
      label: 'Integrations manager (webhooks)',
      implies: ['base.user'],
    }),
  ],
  models: [Subscription, Delivery],
});
