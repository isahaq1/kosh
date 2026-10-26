/**
 * @packageDocumentation
 * `@kosh/notify` (RFC 0006 §5.2–5.4): notifications. Part 1 is the in-app inbox: outbox events (mentions, approvals
 * requested and decided, activities assigned) become each recipient's notifications after their access to the record
 * is re-checked as them, served by `/api/v1/notifications` and shown live by the bell in the header
 * (`@kosh/notify/web`). Part 4 is the email channel (`@kosh/mail`), part 5 web push (VAPID, the service worker in
 * the starter's `public/sw.js`); digests, SMS and WhatsApp come next.
 */
import { inboundConfigFromEnv, type Mailer, mailerFromEnv, replyAddress } from '@kosh/mail';
import { defineModule } from '@kosh/modules-sdk';
import { base, type ModuleContext } from '@kosh/server';
import { type DeliveryContext, deliveryWorker } from './email.js';
import { fallbackWorker } from './fallback.js';
import { inboxWorkers, mayRead } from './inbox.js';
import { type Messenger, messengerFromEnv } from './messenger.js';
import { notifyShutro } from './models.js';
import { type Pusher, pusherFromEnv } from './push.js';
import { registerNotifyRoutes } from './routes.js';

export { renderDigest, scheduleDigest, sendDigest } from './digest.js';
export {
  DELIVER_JOB,
  type DeliveryContext,
  deliver,
  deliveryWorker,
  queueMessages,
  renderEmail,
  renderText,
} from './email.js';
export { BOUNCED_TOPIC, fallbackWorker, fallsBack, queueFallback } from './fallback.js';
export { handleEvent, type InboxContext, inboxWorkers, mayRead, TOPICS } from './inbox.js';
export { DIGEST_JOB, MAX_ATTEMPTS } from './jobs.js';
export { interpolate, sentence, TEXTS, textsFor } from './messages.js';
export {
  createMemoryMessenger,
  createTwilioMessenger,
  type Messenger,
  messengerFromEnv,
  normalizePhone,
  type TextChannel,
  type TextMessage,
  type TwilioOptions,
} from './messenger.js';
export { CHANNELS, type Channel, KINDS, type Kind, notifyShutro } from './models.js';
export { defaultEnabled, deliverySettingsOf, emailModeOf, holdUntil } from './prefs.js';
export {
  createMemoryPusher,
  createWebPusher,
  generateVapidKeys,
  type Pusher,
  type PushPayload,
  type PushSubscriptionInput,
  pusherFromEnv,
  queuePush,
  sendPush,
  subscribePush,
  unsubscribePush,
  type VapidKeys,
} from './push.js';
export { isQuiet, type QuietSettings, quietUntil } from './quiet.js';
export { type NotificationItem, registerNotifyRoutes, unreadCount } from './routes.js';

/** Package identity. */
export const PACKAGE: { readonly name: string; readonly rfc: string } = Object.freeze({
  name: '@kosh/notify',
  rfc: 'RFC 0006',
});

/** What an installation may set instead of the environment (`SMTP_*`, `VAPID_*`, `KOSH_BASE_URL`). */
export interface NotifyOptions {
  readonly mailer?: Mailer | undefined;
  readonly pusher?: Pusher | undefined;
  /** The SMS / WhatsApp provider; default: Twilio from the environment, or none. */
  readonly messenger?: Messenger | undefined;
  readonly baseUrl?: string | undefined;
  /** Start the outbox subscribers and the delivery worker (default: unless `KOSH_SCHEDULES=off`). */
  readonly workers?: boolean | undefined;
}

/** The notifications module with explicit providers (tests, installations wiring their own). */
export function notifyModule(options: NotifyOptions = {}): ReturnType<typeof defineModule> {
  return defineModule({
    shutro: notifyShutro,
    kosh: '^0.1.0',
    depends: [base],
    accessLevels: { user: { label: 'Notifications', groups: ['base.user'] } },
    privateModels: [
      'notify.notification',
      'notify.preference',
      'notify.settings',
      'notify.push_subscription',
    ],
    routes: (context: ModuleContext) => {
      const pusher = options.pusher ?? pusherFromEnv();
      registerNotifyRoutes(context, { pusher });
      // Background work is off in the CLI (kosh init, migrate), like the schedules.
      if (!(options.workers ?? process.env['KOSH_SCHEDULES'] !== 'off')) return;
      const mailer = options.mailer ?? mailerFromEnv();
      const messenger = options.messenger ?? messengerFromEnv();
      const inbound = inboundConfigFromEnv();
      const delivery: DeliveryContext = {
        shutro: context.shutro,
        driver: context.driver,
        ...(mailer === undefined ? {} : { mailer }),
        ...(pusher === undefined ? {} : { pusher }),
        ...(messenger === undefined ? {} : { messenger }),
        baseUrl: options.baseUrl ?? process.env['KOSH_BASE_URL'] ?? 'http://localhost:5173',
        ...(inbound === undefined
          ? {}
          : { replyAddress: (target) => replyAddress(inbound, target) }),
      };
      const inbox = { ...context, ...delivery };
      const workers = [
        ...inboxWorkers(inbox),
        // Held deliveries check the recipient's access again when they are released (RFC 0006 §8.5).
        deliveryWorker({
          ...delivery,
          mayRead: (uid, company, model, id) => mayRead(inbox, uid, company, model, id),
        }),
        // Bounced emails fall back to the recipient's fallback channel (RFC 0006 §8.4).
        fallbackWorker(delivery),
      ];
      for (const w of workers) w.start();
      context.app.addHook('onClose', async () => {
        await Promise.all(workers.map((w) => w.stop()));
      });
    },
  });
}

/** The notifications module: a technical module every installation has; it adds no app and grants nothing. */
export const notify: ReturnType<typeof defineModule> = notifyModule();
