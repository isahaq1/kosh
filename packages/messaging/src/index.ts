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
import { registerChatRoutes } from './chat-routes.js';
import { installActivityTypes } from './chatter.js';
import { messagingShutro } from './models.js';
import { registerChatterRoutes } from './routes.js';

export { MAX_TEXT, mentionIds, plainText, renderBody } from './body.js';
export {
  CHANNEL_MODEL,
  type ChannelItem,
  type ChatContext,
  type ChatMessageItem,
  channelItem,
  channelMessages,
  createChannel,
  deleteChatMessage,
  directChannel,
  editChatMessage,
  joinChannel,
  leaveChannel,
  markRead,
  myChannels,
  postChatMessage,
  type ReactionItem,
  react,
  unreact,
  updateChannel,
} from './chat.js';
export { registerChatRoutes } from './chat-routes.js';
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
  app: {
    code: 'chat',
    label: 'Chat',
    icon: 'chat',
    sequence: 90,
    category: 'Communication',
    summary: 'Channels, groups and direct messages with your colleagues',
  },
  actions: {
    'messaging.action_chat': { type: 'client', page: 'messaging.Chat', label: 'Chat' },
  },
  menus: [
    { id: 'chat.root', label: 'Chat', app: 'chat' },
    { id: 'chat.chat', parent: 'chat.root', label: 'Chat', action: 'messaging.action_chat' },
  ],
  attachable: ['mail.channel'],
  accessLevels: {
    user: { label: 'Messaging (chatter, chat)', groups: ['messaging.user'] },
    manager: {
      label: 'Manager (public chat channels)',
      groups: ['messaging.manager'],
      implies: ['user'],
    },
  },
  privateModels: [
    'mail.message',
    'mail.follower',
    'mail.activity',
    'mail.activity.type',
    'mail.message.reaction',
    'mail.channel',
    'mail.channel.member',
  ],
  routes: (context: ModuleContext) => {
    registerChatterRoutes(context);
    registerChatRoutes(context);
  },
  hooks: {
    defaults: async (env) => `${await installActivityTypes(env as Env)} activity type(s) installed`,
  },
});
