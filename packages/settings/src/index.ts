/**
 * @packageDocumentation
 * `@kosh/settings` (RFC 0008, RFC 0019): the Settings app. Its App manager lists the installed, disabled and
 * available apps and installs, enables or disables them (`/api/v1/settings/apps`); it cannot be disabled. Changing
 * apps needs the Administrator role or the `settings.apps` access level. Its Company page sets the current company's
 * name, number grouping and brand colour (`settings.company`, RFC 0018). People (RFC 0019 §3.2) invites, deactivates
 * and gives roles to the installation's users (`settings.people`).
 */
import { mailerFromEnv } from '@kosh/mail';
import { defineModule, type KoshModule } from '@kosh/modules-sdk';
import { base, baseShutro, type ModuleContext } from '@kosh/server';
import { orm } from '@kosh/server/orm';
import { registerCompanyRoutes } from './company.js';
import { type PeopleOptions, registerPeopleRoutes } from './people.js';
import { registerAppRoutes } from './routes.js';

export { type CompanySettings, registerCompanyRoutes } from './company.js';
export {
  type Assignment,
  INVITATION_DAYS,
  type PeopleOptions,
  registerPeopleRoutes,
} from './people.js';
export { type AppInfo, type PlanInfo, PROTECTED_APPS, registerAppRoutes } from './routes.js';

/** Package identity. */
export const PACKAGE: { readonly name: string; readonly rfc: string } = Object.freeze({
  name: '@kosh/settings',
  rfc: 'RFC 0008',
});

/** A one-time link that lets an invited person choose their password. Private: read through the People routes. */
const Invitation = orm.defineModel('settings.invitation', {
  label: 'Invitation',
  order: ['id desc'],
  access: {},
  fields: {
    user: orm.f.many2one('res.users', { required: true, ondelete: 'cascade' }),
    tokenHash: orm.f.char({ required: true, index: 'unique' }),
    expiresAt: orm.f.datetime({ required: true }),
    usedAt: orm.f.datetime(),
    invitedBy: orm.f.many2one('res.users', { ondelete: 'set null' }),
  },
});

/** The Shutro module: the Settings groups and invitations. */
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
    orm.defineGroup({ code: 'settings.people', label: 'People manager', implies: ['base.user'] }),
  ],
  models: [Invitation],
});

/** The Settings app with explicit options (tests): the back-office's address and the mailer of invitations. */
export function settingsModule(options: Partial<PeopleOptions> = {}): KoshModule {
  return defineModule({
    shutro: settingsShutro,
    kosh: '^0.1.0',
    depends: [base],
    app: {
      code: 'settings',
      label: 'Settings',
      icon: 'settings',
      sequence: 1000,
      category: 'Administration',
      summary: 'Apps, people and the settings of this installation',
    },
    accessLevels: {
      apps: { label: 'App manager', groups: ['settings.apps'] },
      company: { label: 'Company settings', groups: ['settings.company'] },
      people: { label: 'People manager', groups: ['settings.people'] },
    },
    privateModels: ['settings.invitation'],
    actions: {
      'settings.action_overview': { type: 'client', page: 'settings.Overview', label: 'Settings' },
      'settings.action_apps': { type: 'client', page: 'settings.Apps', label: 'Apps' },
      'settings.action_company': { type: 'client', page: 'settings.Company', label: 'Company' },
      'settings.action_people': { type: 'client', page: 'settings.People', label: 'People' },
    },
    menus: [
      { id: 'settings.root', label: 'Settings', app: 'settings' },
      // The overview first (the app's home), then the sections in groups (RFC 0019 §3.1). Modules add their
      // settings under `settings.group_apps`.
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
      { id: 'settings.group_people', parent: 'settings.root', label: 'People', sequence: 20 },
      {
        id: 'settings.people',
        parent: 'settings.group_people',
        label: 'People',
        action: 'settings.action_people',
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
      registerPeopleRoutes(context, {
        baseUrl: options.baseUrl ?? process.env['KOSH_BASE_URL'] ?? 'http://localhost:5173',
        mailer: 'mailer' in options ? options.mailer : mailerFromEnv(),
      });
    },
  });
}

/** The Settings app (the back-office's address and the mailer from the environment). */
export const settings: KoshModule = settingsModule();
