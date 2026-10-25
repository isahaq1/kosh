/**
 * @packageDocumentation
 * `@kosh/realtime` (RFC 0006 §5): the WebSocket gateway. Installed, it serves `GET /api/v1/realtime`: open screens
 * learn at once which records changed (and refetch them through the API, which checks access again) and who else
 * has a record open. A technical module every installation has; it adds no app and grants nothing.
 */
import { defineModule } from '@kosh/modules-sdk';
import { base, baseShutro, type ModuleContext } from '@kosh/server';
import { orm } from '@kosh/server/orm';
import { registerRealtime } from './gateway.js';

export {
  Gateway,
  MAX_SUBSCRIPTIONS,
  PRESENCE_CHANNEL,
  PRESENCE_TTL_MS,
  type PresenceUser,
  registerRealtime,
} from './gateway.js';

/** Package identity. */
export const PACKAGE: { readonly name: string; readonly rfc: string } = Object.freeze({
  name: '@kosh/realtime',
  rfc: 'RFC 0006',
});

/** The Shutro module: nothing of its own; the gateway needs only `base` (users and sessions). */
export const realtimeShutro: ReturnType<typeof orm.defineModule> = orm.defineModule({
  name: 'realtime',
  version: '0.1.0',
  depends: [baseShutro],
  models: [],
});

/** The realtime module. */
export const realtime: ReturnType<typeof defineModule> = defineModule({
  shutro: realtimeShutro,
  kosh: '^0.1.0',
  depends: [base],
  // Every signed-in user may connect; what they may subscribe to is checked per channel.
  accessLevels: { user: { label: 'Live updates', groups: ['base.user'] } },
  routes: async (context: ModuleContext) => {
    await registerRealtime(context);
  },
});
