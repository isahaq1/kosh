/**
 * @packageDocumentation
 * `@kosh/messaging` (RFC 0006): the chatter of every record — messages and internal notes with @mentions and
 * attachments, followers, scheduled activities, and the change log read from Shutro's audit trail — exactly as
 * visible as the record itself. The chatter component is in `@kosh/messaging/web`.
 */
import { defineModule } from '@kosh/modules-sdk';
import { base, type ModuleContext } from '@kosh/server';
import type { Env } from '@kosh/server/orm';
import { storage } from '@kosh/storage';
import { installActivityTypes } from './chatter.js';
import { messagingShutro } from './models.js';
import { registerChatterRoutes } from './routes.js';

export { MAX_TEXT, mentionIds, plainText, renderBody } from './body.js';
export {
  type ActivityItem,
  activityTypes,
  type ChangeItem,
  type Chatter,
  type ChatterContext,
  type Cursor,
  cancelActivity,
  chatterOf,
  completeActivity,
  deleteMessage,
  editMessage,
  type FieldChange,
  type FieldMeta,
  installActivityTypes,
  type MessageItem,
  type ModelFields,
  myActivities,
  pageSize,
  postMessage,
  scheduleActivity,
  setFollower,
  type TimelineItem,
  type UserRef,
  updateActivity,
} from './chatter.js';
export { DEFAULT_ACTIVITY_TYPES } from './models.js';
export { chatterContext, registerChatterRoutes } from './routes.js';
export { messagingShutro };

/** Package identity. */
export const PACKAGE: { readonly name: string; readonly rfc: string } = Object.freeze({
  name: '@kosh/messaging',
  rfc: 'RFC 0006',
});

/** The Kosh module: install it for the chatter (forms with `chatter: true` show it). */
export const messaging: ReturnType<typeof defineModule> = defineModule({
  shutro: messagingShutro,
  kosh: '^0.1.0',
  depends: [base, storage],
  accessLevels: { user: { label: 'Messaging', groups: ['messaging.user'] } },
  privateModels: ['mail.message', 'mail.follower', 'mail.activity', 'mail.activity.type'],
  routes: (context: ModuleContext) => registerChatterRoutes(context),
  hooks: {
    defaults: async (env) => `${await installActivityTypes(env as Env)} activity type(s) installed`,
  },
});
