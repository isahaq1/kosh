/**
 * @packageDocumentation
 * `@kosh/notify` (RFC 0006 §5.2–5.4): notifications. Part 1 is the in-app inbox: outbox events (mentions, approvals
 * requested and decided, activities assigned) become each recipient's notifications after their access to the record
 * is re-checked as them, served by `/api/v1/notifications` and shown live by the bell in the header
 * (`@kosh/notify/web`). Channel adapters (email, web push) and digests come next.
 */
import { defineModule } from '@kosh/modules-sdk';
import { base, type ModuleContext } from '@kosh/server';
import { inboxWorkers } from './inbox.js';
import { notifyShutro } from './models.js';
import { registerNotifyRoutes } from './routes.js';

export { handleEvent, type InboxContext, inboxWorkers, TOPICS } from './inbox.js';
export { CHANNELS, type Channel, KINDS, type Kind, notifyShutro } from './models.js';
export { type NotificationItem, registerNotifyRoutes, unreadCount } from './routes.js';

/** Package identity. */
export const PACKAGE: { readonly name: string; readonly rfc: string } = Object.freeze({
  name: '@kosh/notify',
  rfc: 'RFC 0006',
});

/** The notifications module: a technical module every installation has; it adds no app and grants nothing. */
export const notify: ReturnType<typeof defineModule> = defineModule({
  shutro: notifyShutro,
  kosh: '^0.1.0',
  depends: [base],
  accessLevels: { user: { label: 'Notifications', groups: ['base.user'] } },
  privateModels: ['notify.notification', 'notify.preference'],
  routes: (context: ModuleContext) => {
    registerNotifyRoutes(context);
    // Background work is off in the CLI (kosh init, migrate), like the schedules.
    if (process.env['KOSH_SCHEDULES'] === 'off') return;
    const workers = inboxWorkers(context);
    for (const w of workers) w.start();
    context.app.addHook('onClose', async () => {
      await Promise.all(workers.map((w) => w.stop()));
    });
  },
});
