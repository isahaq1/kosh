# Modules

A Kosh module is one typed manifest wrapping a Shutro module (RFC 0001). Shutro owns the data layer; the manifest
adds the app, access levels, menus, actions, views, hooks and translations.

```ts
import { defineModule } from '@kosh/modules-sdk';
import { contactsShutro } from './models/module.ts'; // Shutro defineModule: models, groups, permissions, data

export const contacts = defineModule({
  shutro: contactsShutro,                       // name and version come from here
  kosh: '^0.1.0',                               // framework versions this module runs on
  depends: [base],                              // must cover the Shutro module's depends
  app: { code: 'contacts', label: 'Contacts', icon: 'users' },
  accessLevels: {                               // required: installing a module grants nothing
    user: { label: 'User', groups: ['contacts.user'] },
    manager: { label: 'Manager', groups: ['contacts.manager'], implies: ['user'] },
  },
  actions: { 'contacts.action_partners': { /* RFC 0004 */ } },
  menus: [
    { id: 'contacts.root', label: 'Contacts', app: 'contacts' },
    { id: 'contacts.partners', parent: 'contacts.root', label: 'Contacts', action: 'contacts.action_partners' },
  ],
});
```

## What is checked

- `defineModule`: the Shutro module has a name; `kosh` is a version range; access levels exist, each grants at least
  one group, and implies only levels of the same module; menu and action ids are `<module>.<name>` and unique.
- `loadModules(roots, { koshVersion })`: collects dependencies, orders them (dependencies first, ties by name),
  refuses cycles and two different modules with one name, checks every module's `kosh` range, checks that Kosh
  dependencies cover the Shutro module's dependencies, that access levels grant only groups of the module or its
  dependencies, that menu parents and actions exist, and that menu and action ids are unique across modules.

Version ranges: `1.2.3`, `^1.2.0`, `~1.2.0`, `>=1.2.0 <2.0.0`, `*`.

## Installing, disabling and enabling apps (RFC 0008)

`src/modules.ts` lists the **catalogue**: the modules this installation can install. The database records which of
them are **installed**, **disabled** or still **available** (`kosh_module`). Servers serve the installed ones:

```ts
const server = await createServer({ databaseUrl, modules: await installedModules(databaseUrl, modules) });
```

```sh
npx kosh apps                       # ● installed  ◌ disabled  ○ available
npx kosh apps install sales         # the plan (sales and what it needs), then one transaction
npx kosh apps disable projects      # menus, API and access go; tables and data stay (dependents go too)
npx kosh apps enable projects       # back in seconds, with its data
npx kosh apps install sales --plan  # only show the plan
```

Every change is planned against the live database first: the modules (dependencies, cascades) and the schema
statements. It is then applied in **one PostgreSQL transaction**, which covers the migration file (written to
`migrations/`), the new modules' seed data and app defaults, their `hooks.postInstall`, and the installed set. If
anything fails, nothing changes, not even the migration file. Each applied change is logged in `kosh_app_log` with
who made it and its SQL.

The engine refuses a change in these cases:

- the database has pending migration files, or does not match its modules yet (run `kosh migrate` first);
- the change would drop or alter data;
- `base` would be disabled;
- disabling would leave behind a `NOT NULL` column without a database default that a served model still has (a
  required field with a function default or a compute, added by the disabled module's `extendModel`);
- another app change happened after this one was planned.

A disabled module's tables stay part of the schema, so `kosh migrate` plans with the installed and disabled modules
and never proposes dropping them. Restart the API after a change; hot reload comes with the Apps page (RFC 0008 step
2). Removing an app together with its data comes in a later step.

Projects from before the App manager have no `kosh_module` yet. Until their first `kosh apps` change, servers and
`kosh migrate` keep treating `src/modules.ts` as the installed set. That first change records the modules that have
been migrated, and anything added to the list since then is shown as available.
