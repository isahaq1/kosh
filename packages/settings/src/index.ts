/**
 * @packageDocumentation
 * `@kosh/settings` (RFC 0008): the Settings app. Its App manager lists the installed, disabled and available apps and
 * installs, enables or disables them (`/api/v1/settings/apps`, the Settings → Apps page). Every installation has it;
 * it cannot be disabled. Changing apps needs the Administrator role or the `settings.apps` access level. Its Company
 * page sets the current company's name, number grouping and brand colour (`settings.company`, RFC 0018).
 */
import { defineModule } from '@kosh/modules-sdk';
import { base, baseShutro, type ModuleContext } from '@kosh/server';
import { orm } from '@kosh/server/orm';
import { registerCompanyRoutes } from './company.js';
import { registerAppRoutes } from './routes.js';

export { type CompanySettings, registerCompanyRoutes } from './company.js';
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
    orm.defineGroup({
      code: 'settings.company',
      label: 'Company settings',
      implies: ['base.user'],
    }),
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
    company: { label: 'Company settings', groups: ['settings.company'] },
  },
  actions: {
    'settings.action_overview': { type: 'client', page: 'settings.Overview', label: 'Settings' },
    'settings.action_apps': { type: 'client', page: 'settings.Apps', label: 'Apps' },
    'settings.action_company': { type: 'client', page: 'settings.Company', label: 'Company' },
  },
  menus: [
    { id: 'settings.root', label: 'Settings', app: 'settings' },
    // The overview first (the app's home), then the sections in groups (RFC 0019 §3.1). Modules add their settings
    // under `settings.group_apps`.
    {
      id: 'settings.overview',
      parent: 'settings.root',
      label: 'Overview',
      action: 'settings.action_overview',
      sequence: 0,
    },
    { id: 'settings.group_workspace', parent: 'settings.root', label: 'Workspace', sequence: 10 },
    {
      id: 'settings.company',
      parent: 'settings.group_workspace',
      label: 'Company',
      action: 'settings.action_company',
      sequence: 1,
    },
    { id: 'settings.group_apps', parent: 'settings.root', label: 'Apps', sequence: 40 },
    {
      id: 'settings.apps',
      parent: 'settings.group_apps',
      label: 'App manager',
      action: 'settings.action_apps',
      sequence: 1,
    },
  ],
  routes: (context: ModuleContext) => {
    registerAppRoutes(context);
    registerCompanyRoutes(context);
  },
});
