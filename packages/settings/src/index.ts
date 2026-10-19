/**
 * @packageDocumentation
 * `@kosh/settings` (RFC 0008): the Settings app. Its App manager lists the installed, disabled and available apps and
 * installs, enables or disables them (`/api/v1/settings/apps`, the Settings → Apps page). Every installation has it;
 * it cannot be disabled. Changing apps needs the Administrator role or the `settings.apps` access level.
 */
import { defineModule } from '@kosh/modules-sdk';
import { base, baseShutro, type ModuleContext } from '@kosh/server';
import { orm } from '@kosh/server/orm';
import { registerAppRoutes } from './routes.js';

export { type AppInfo, type PlanInfo, PROTECTED_APPS, registerAppRoutes } from './routes.js';

/** Package identity. */
export const PACKAGE: { readonly name: string; readonly rfc: string } = Object.freeze({
  name: '@kosh/settings',
  rfc: 'RFC 0008',
});

/** The Shutro module: the App manager group. */
export const settingsShutro: ReturnType<typeof orm.defineModule> = orm.defineModule({
  name: 'settings',
  version: '0.1.0',
  depends: [baseShutro],
  groups: [
    orm.defineGroup({ code: 'settings.apps', label: 'App manager', implies: ['base.user'] }),
  ],
  models: [],
});

/** The Settings app. */
export const settings: ReturnType<typeof defineModule> = defineModule({
  shutro: settingsShutro,
  kosh: '^0.1.0',
  depends: [base],
  app: {
    code: 'settings',
    label: 'Settings',
    icon: 'settings',
    sequence: 1000,
    category: 'Administration',
    summary: 'Apps, and the settings of this installation',
  },
  accessLevels: {
    apps: { label: 'App manager', groups: ['settings.apps'] },
  },
  actions: {
    'settings.action_apps': { type: 'client', page: 'settings.Apps', label: 'Apps' },
  },
  menus: [
    { id: 'settings.root', label: 'Settings', app: 'settings' },
    { id: 'settings.apps', parent: 'settings.root', label: 'Apps', action: 'settings.action_apps' },
  ],
  routes: (context: ModuleContext) => registerAppRoutes(context),
});
