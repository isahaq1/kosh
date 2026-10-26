# kosh-erp

**Kosh** is an ERP framework for Node.js, TypeScript and PostgreSQL, built on the
[Shutro](https://www.npmjs.com/package/shutro) ORM. Define a model once and get a REST API with OpenAPI, a typed
client, list / form / kanban / pivot / graph / calendar / gantt / map / dashboard views, exports, PDF documents and a
chatter on every record. Permissions are checked on the server on every route.

- [Requirements](#requirements)
- [Install with the terminal](#install-with-the-terminal)
- [Install with Docker](#install-with-docker)
- [Project structure](#project-structure)
- [Modules](#modules): structure, create, install, remove
- [Migrations](#migrations): schema and per-module data migrations
- [Seed data](#seed-data): per-module seeders
- [Users and roles](#users-and-roles)
- [Configuration (.env)](#configuration-env)
- [Command reference](#command-reference)
- [Entry points](#entry-points) · [Troubleshooting](#troubleshooting)

## Requirements

- **Node.js 24** or later (`node --version`)
- **PostgreSQL 16** or later, or **Docker** (Kosh can start PostgreSQL for you)
- An authenticator app for the administrator's second factor (Google Authenticator, Microsoft Authenticator,
  1Password, …)

## Install with the terminal

One command creates the project, installs Kosh and asks for everything it needs:

```sh
npm create kosh-erp@latest my-erp   # the project my-erp
npm create kosh-erp@latest          # asks for the project name first
```

(`pnpm create kosh-erp my-erp` and `yarn create kosh-erp my-erp` work too.) In an existing folder:

```sh
npm install kosh-erp      # Shutro, the ORM, comes with it
npx kosh init
```

The setup asks for what the installation needs. Press **Enter** to keep the value in `[brackets]`:

| Question | Example | Notes |
|---|---|---|
| PostgreSQL | `1` your server, `2` start one in Docker | `2` needs Docker Desktop running; it writes `compose.yaml` and starts the `db` service |
| Username, password, port, host, database name | `postgres`, (hidden), `5432`, `localhost`, `my_erp` | for `1`; a missing database is created after you confirm; if nothing answers, it offers Docker instead |
| Company name, currency | `Padma Traders`, `BDT` | the first company; more companies later |
| Language, time zone | `bn`, `Asia/Dhaka` | the administrator's |
| Administrator login, name, email, password | `admin`, …, 12+ characters | the password is typed hidden and stored only as a hash |
| Apps | `permissions,reporting,messaging` | roles and approvals, reports and documents, chatter and attachments |
| File storage | `1` a folder, `2` S3-compatible | S3, SeaweedFS, MinIO; the bucket is created |
| Valkey/Redis URL | empty | optional: rate limits and caches shared by several servers |
| API port | `3000` | |
| Authenticator code | `123456` | scan the printed secret, type a code; **keep the recovery codes** it prints |

Then it writes the project, creates the database tables (`migrations/0001_init.sql`), the company and the
administrator, and loads the apps' default data (`npm create kosh-erp` also installs the back-office's build tools;
after `npx kosh init`, run `npm install` once). Start it:

```sh
npm start            # the API on http://localhost:3000
npm run web          # the back-office on http://localhost:5173, in a second terminal
```

Sign in with the administrator's login, password and a code from the authenticator app.

**Without questions** (scripts, CI): pass the answers as flags (after `--` with `npm create kosh-erp`).

```sh
npm create kosh-erp@latest my-erp -- --yes --docker-db --admin-password "a long passphrase here"

npx kosh init --yes \
  --database-url postgres://postgres:postgres@localhost:5432/my_erp --create-database \
  --company "Padma Traders" --currency BDT --lang bn --tz Asia/Dhaka \
  --admin-login admin --admin-password "a long passphrase here" \
  --apps permissions,reporting,messaging --storage-dir ./var/attachments --port 3000
```

With `--yes` nothing is asked, so the authenticator is not enrolled: run `npx kosh init` again in a terminal to
enrol it (administrator rights wait for it). `npx kosh init --help` lists every flag. Replies by email: set `MAIL_INBOUND_DOMAIN` in `.env` (the secrets are generated) and point your email provider's inbound webhook at `/api/v1/mail/inbound` with the `MAIL_INBOUND_WEBHOOK_SECRET`. `--demo` (or a yes to the
question after the apps) loads a sample company with contacts, products, orders, invoices and projects, made by
the demo users `dina`, `rahim`, `karim` and `sumi` (one shared password, printed at the end); not for production.

## Install with Docker

`kosh init` writes `Dockerfile`, `compose.yaml`, `nginx.conf` and `.dockerignore` into every project.

**PostgreSQL in Docker, the app on your machine** (development):

```sh
npm create kosh-erp@latest my-erp   # answer 2 to "PostgreSQL": it starts the db service for you
cd my-erp && npm start              # the API; npm run web for the back-office
```

or start the database yourself first:

```sh
docker compose up -d db      # uses POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB / POSTGRES_PORT from .env
```

**Everything in Docker** (a server, a demo):

```sh
npm create kosh-erp@latest my-erp   # once: the project, .env, tables, administrator (answer 2 for PostgreSQL)
cd my-erp
docker compose up -d --build        # db + api + web; the back-office on http://localhost:8080
```

| Service | What | Port |
|---|---|---|
| `db` | PostgreSQL 18, data in the `db` volume | `127.0.0.1:5432` (`POSTGRES_PORT`) |
| `api` | the Kosh API; runs `kosh migrate` on every start, then serves | inside the network (`api:3000`) |
| `web` | nginx with the built back-office, `/api` proxied to `api` | `8080` (`WEB_PORT`) |

Useful commands:

```sh
docker compose logs -f api                       # the API's log
docker compose exec api npx kosh migrate status  # any kosh command inside the container
docker compose exec api npx kosh seed
docker compose up -d --build api                 # after changing modules: rebuild and migrate
docker compose down                              # stop (volumes keep the data)
docker compose exec db pg_dump -U kosh my_erp > backup.sql   # a backup
```

Behind HTTPS, set `KOSH_SECURE_COOKIES: "true"` in `compose.yaml`. To use a PostgreSQL server outside Docker, set
`DOCKER_DATABASE_URL` in `.env` (an address the container can reach, not `localhost`).

## Project structure

```text
my-erp/
├── .env                    settings and credentials (not committed)
├── package.json            scripts: start, web, build:web, migrate, seed, docker:up
├── migrations/             versioned schema migrations: 0001_init.sql, 0002_update.sql, … (commit them)
├── src/
│   ├── modules.ts          the installed modules: base, the apps, your modules
│   ├── server.ts           the API server (npm start)
│   ├── modules/            your modules (kosh module create <name>)
│   │   └── library/
│   │       ├── index.ts        the module: groups, access levels, app, menus, actions, views
│   │       ├── models.ts       its models (fields, access per group, record rules)
│   │       ├── data.ts         its seed data
│   │       └── migrations.ts   its data migrations
│   └── web/
│       ├── main.tsx        the back-office (React): renderers of each installed app
│       └── index.css       Tailwind + Kosh's design tokens
├── index.html, vite.config.ts   the back-office build (npm run web / build:web)
├── Dockerfile, compose.yaml, nginx.conf, .dockerignore
└── var/attachments/        uploaded files (with folder storage)
```

## Modules

A module is a folder with its models and a manifest. Create one:

```sh
npx kosh module create library
npx kosh migrate             # creates its tables, records it, loads its seed data
```

It writes `src/modules/library/` and adds `library` to `src/modules.ts`. After `npm start` and a reload of the
back-office, the **Library** app appears for the administrator.

**`models.ts`**: models and their fields, with access per group (nobody has access by default):

```ts
import { orm } from 'kosh-erp/orm';
const { defineModel, f } = orm;

export const Book = defineModel('library.book', {
  archivable: true,
  access: {
    'library.user': ['read', 'write', 'create'],
    'library.manager': ['read', 'write', 'create', 'unlink', 'export', 'import'],
  },
  order: ['title asc'],
  fields: {
    title: f.char({ required: true }),
    isbn: f.char({ index: 'unique' }),
    author: f.many2one('res.partner'),
    price: f.decimal({ scale: 2 }),
    state: f.state({
      states: { draft: 'Draft', available: 'Available', lent: 'Lent' },
      initial: 'draft',
      transitions: { publish: { from: ['draft'], to: 'available' }, lend: { from: ['available'], to: 'lent' } },
    }),
  },
});
```

**`index.ts`**: the module: its Shutro part (name, version, groups, models, seed data, data migrations) and its
Kosh part (access levels, app, menus, actions, views):

```ts
import { base, baseShutro } from 'kosh-erp';
import { defineModule } from 'kosh-erp/modules-sdk';
import { orm } from 'kosh-erp/orm';
import { form, list } from 'kosh-erp/views';
import { data } from './data.ts';
import { migrations } from './migrations.ts';
import { Book } from './models.ts';

export const libraryShutro = orm.defineModule({
  name: 'library',
  version: '0.1.0',                 // raise it when data migrations must run
  depends: [baseShutro],
  groups: [
    orm.defineGroup({ code: 'library.user', label: 'Library user', implies: ['base.user'] }),
    orm.defineGroup({ code: 'library.manager', label: 'Library manager', implies: ['library.user'] }),
  ],
  models: [Book],
  data,
  migrations,
});

export const library = defineModule({
  shutro: libraryShutro,
  kosh: '^0.1.0',
  depends: [base],                  // also messaging, reporting, other modules
  accessLevels: {                   // what administrators grant (roles: library.user, library.manager)
    user: { label: 'User', groups: ['library.user'] },
    manager: { label: 'Manager', groups: ['library.manager'], implies: ['user'] },
  },
  app: { code: 'library', label: 'Library', icon: 'box', sequence: 50 },
  actions: { 'library.action_books': { model: 'library.book', label: 'Books', views: ['list', 'form'] } },
  menus: [
    { id: 'library.root', label: 'Library', app: 'library' },
    { id: 'library.books', parent: 'library.root', label: 'Books', action: 'library.action_books' },
  ],
  views: {
    'library.book.list': list(Book, { columns: ['title', 'isbn', 'author', 'state'] }),
    'library.book.form': form(Book, (f) => ({
      header: { statusbar: 'state', buttons: [f.button('publish', { primary: true, label: 'Publish' })] },
      sheet: [f.group('main', ['title', 'isbn', 'author', 'price'])],
      chatter: true,                // messages, activities and the change log (needs messaging)
    })),
  },
});
```

**Install a module**: list it in `src/modules.ts`, then migrate:

```ts
// src/modules.ts
import { base } from 'kosh-erp';
import { messaging } from 'kosh-erp/messaging';
import { library } from './modules/library/index.ts';

export const modules = [base, messaging, library];
```

```sh
npx kosh migrate    # tables, the module's version (shutro_module), its seed data
```

A module published on npm installs the same way: `npm install <package>`, import it in `src/modules.ts`, then
`npx kosh migrate`. Installing does not give anyone access: grant its roles to users ([Users and roles](#users-and-roles)).

**Remove a module**: take it out of `src/modules.ts`; `npx kosh migrate` then plans dropping its tables, which is
destructive: it stops for review, and `npx kosh migrate --allow-destructive` applies it. Back up first.

## Migrations

```sh
npx kosh migrate                   # plan + apply + seed
npx kosh migrate --plan            # only write the plan, to review it
npx kosh migrate --name add_isbn   # name the new file (migrations/0002_add_isbn.sql)
npx kosh migrate status            # applied and pending files
npx kosh migrate --allow-destructive
```

- **Schema migrations** are SQL files in `migrations/`. `kosh migrate` compares your modules with the live database
  and writes the differences as the next file (`0002_update.sql`), applies every pending file in order (each in its
  own transaction, recorded in `shutro_migration`), then loads the seed data. Commit the files: a deployment runs the
  same ones (the Docker `api` service runs `kosh migrate` on start).
- **Destructive changes** (dropping a column or a table, narrowing a type) are written but not applied without
  `--allow-destructive`. A file written earlier and not applied yet is applied first.
- **Per-module data migrations** change existing data when a module is upgraded. Declare them in the module's
  `migrations.ts` and raise the module's `version`; each runs once, in version order, when the installed version
  goes past it (never on a fresh install):

```ts
// src/modules/library/migrations.ts
import type { DataMigration } from 'kosh-erp/orm';

export const migrations: DataMigration[] = [
  {
    version: '0.2.0',
    description: 'ISBNs without dashes',
    up: async ({ sql }) => {
      await sql`UPDATE library_book SET isbn = replace(isbn, '-', '')`;
    },
  },
];
```

```sh
# index.ts: version: '0.2.0'
npx kosh migrate    # … module library: 0.1.0 → 0.2.0, data migration library@0.2.0
```

## Seed data

Each module declares its seed data in `data.ts` as records with external ids (`library.book_welcome`). Seeding is
idempotent: new records are created, changed ones updated, records removed from the list deleted, and `noupdate`
records created once and then left to the users.

```ts
// src/modules/library/data.ts
import { orm } from 'kosh-erp/orm';

export const data = [
  orm.record('res.partner', 'author_tagore', { name: 'Rabindranath Tagore' }),
  orm.record('library.book', 'book_gitanjali', {
    title: 'Gitanjali',
    author: orm.ref('res.partner', 'library.author_tagore'),   // by external id
  }),
  orm.record('library.book', 'book_sample', { title: 'Sample' }, { noupdate: true }),
];
```

```sh
npx kosh seed                 # every module's seed data, and the apps' defaults
npx kosh seed library         # one module (or several: kosh seed library inventory)
```

`kosh migrate` seeds too (skip with `--no-seed`). The apps' defaults are also seeded: approval policies
(permissions), document templates (reporting), activity types (messaging); users may edit them afterwards.

## Users and roles

```sh
npx kosh user create rahim --name "Rahim Uddin" --email rahim@example.com --roles library.user,messaging.user
npx kosh user password rahim     # a new password (asked, hidden)
```

Roles are the groups of the installed modules' access levels (`library.user`, `library.manager`,
`reporting.user`, `messaging.user`, …; `base.admin` is the administrator). Users see an app only when one of
their roles grants it. Administrators manage roles, field security and grants in the admin API
(`/api/v1/admin/...`, with the permissions app) and every change is audited.

## Configuration (.env)

| Variable | Meaning |
|---|---|
| `DATABASE_URL` | PostgreSQL: `postgres://user:password@host:5432/database` |
| `PORT`, `HOST` | the API's port (3000) and address (127.0.0.1; 0.0.0.0 in Docker) |
| `KOSH_STORAGE_DIR` | attachments in this folder, or: |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_REGION` | S3-compatible storage |
| `KOSH_ATTACHMENT_MAX_BYTES` | upload limit (25 MB) |
| `VALKEY_URL` | optional Valkey/Redis: rate limits and caches across servers |
| `KOSH_SECURE_COOKIES` | `true` behind HTTPS (default in production), `false` for plain HTTP |
| `KOSH_SCHEDULES` | `off` stops the scheduled-report ticker on this server |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_PORT` | the Docker `db` service |
| `DOCKER_DATABASE_URL`, `WEB_PORT` | Docker: another database for `api`; the back-office's port (8080) |

## Command reference

Run them in the project folder (`npx kosh …`, or `npm run migrate` / `npm run seed`). They read `.env` and
`src/modules.ts` (`--modules <file>` for another list).

| Command | What |
|---|---|
| `kosh init [folder]` | set up an installation (questions, or flags with `--yes`); again later to enrol 2FA |
| `kosh migrate` | apply pending files, plan what is missing into a new file and apply it, run data migrations, seed |
| `kosh migrate --plan` · `--name <n>` · `--allow-destructive` · `--no-seed` | review only · file name · drops · no seeding |
| `kosh migrate status` | applied and pending migration files |
| `kosh seed [module …]` | seed data of all modules, or of those named |
| `kosh module create <name>` | a new module in `src/modules/<name>/`, listed in `src/modules.ts` |
| `kosh user create <login>` | a user: `--name`, `--email`, `--roles`, `--password` (asked when missing) |
| `kosh user password <login>` | a new password |
| `kosh generate client` | a typed API client for your front-end (`--out src/api/kosh.gen.ts`) |
| `npm start` · `npm run web` · `npm run build:web` | the API · the back-office (dev) · the back-office build (`dist/`) |
| `npm run docker:up` | `docker compose up -d --build` |

## Entry points

| Import | What |
|---|---|
| `kosh-erp` | the server: `createServer`, `startServer`, `base`, REST + OpenAPI, sessions and 2FA |
| `kosh-erp/orm` | Shutro (models, fields, groups, records, migrations) as Kosh uses it |
| `kosh-erp/modules-sdk` | `defineModule`: manifests, access levels, menus, actions |
| `kosh-erp/views`, `kosh-erp/search` | view definitions (`list`, `form`, `kanban`, `pivot`, …) and the search layer |
| `kosh-erp/permissions` | roles, field security, approvals (`/web`: the approval panel) |
| `kosh-erp/reporting` | pivots, exports, documents, scheduled reports (`/web`: the report views) |
| `kosh-erp/messaging`, `kosh-erp/storage` | the chatter, activities, attachments (`/web`: the chatter) |
| `kosh-erp/ui` | the React app shell, design system and renderers; `kosh-erp/ui/styles.css` the tokens |
| `kosh-erp/cli` | the `kosh` command's functions |

## Troubleshooting

- **"PostgreSQL did not answer"**: nothing listens at that host and port. Start your PostgreSQL service, or
  answer `2` (Docker) to the first question; Docker Desktop must be running.
- **"password authentication failed"**: the user or password in `DATABASE_URL` is wrong.
- **Signed in but no apps**: the user has no role granting them (`kosh user create … --roles`); administrators need
  their authenticator enrolled (`npx kosh init` again).
- **Sign-in works on the API but not in the browser over plain HTTP**: `KOSH_SECURE_COOKIES=false`.
- **Lost the phone**: sign in with one of the recovery codes `kosh init` printed.
- **"It drops or changes existing data"**: `kosh migrate` found a destructive change; read the new file in
  `migrations/`, back up, then `npx kosh migrate --allow-destructive`.

Documentation, design notes and the source: https://github.com/isahaq1/kosh

## Author

**Isahaq**, hmisahaq01@gmail.com, mobile +8801852376598

## License

MIT
