# kosh-erp

**Kosh**: a modern ERP framework on TypeScript, PostgreSQL and the [Shutro](https://www.npmjs.com/package/shutro)
ORM. Define a model once and get a REST API with OpenAPI, a generated typed client, list / form / kanban / pivot /
graph / calendar / gantt / map / dashboard views, exports, PDF documents and a chatter, with permissions enforced on
the server for every route.

```sh
npm install kosh-erp shutro
# the back-office UI also needs React (peer dependencies):
npm install react react-dom @tanstack/react-query i18next react-i18next
```

Node.js 24 or later, ESM only, PostgreSQL 16 or later.

## Entry points

| Import | What |
|---|---|
| `kosh-erp` | the server: `createServer`, `startServer`, modules `base`, REST + OpenAPI, sessions and 2FA |
| `kosh-erp/orm` | Shutro (models, fields, groups) as Kosh uses it |
| `kosh-erp/modules-sdk` | `defineModule`: manifests, access levels, menus, actions |
| `kosh-erp/views`, `kosh-erp/search` | view definitions (`list`, `form`, `kanban`, `pivot`, …) and the search layer |
| `kosh-erp/permissions` | roles, field security, approvals (`/web`: the approval panel) |
| `kosh-erp/reporting` | pivots, exports, documents, scheduled reports (`/web`: the report views) |
| `kosh-erp/messaging`, `kosh-erp/storage` | the chatter, activities, attachments on S3 (`/web`: the chatter) |
| `kosh-erp/ui` | the React app shell, design system and renderers; `kosh-erp/ui/styles.css` the tokens |
| `kosh-erp/cli` | `kosh generate client` and friends (also the `kosh` command) |

```ts
import { defineModule } from 'kosh-erp/modules-sdk';
import { base, createServer, startServer } from 'kosh-erp';
import { orm } from 'kosh-erp/orm';
import { form, list } from 'kosh-erp/views';
```

```css
/* the app's stylesheet (Tailwind CSS v4) */
@import 'tailwindcss';
@import 'kosh-erp/ui/styles.css';
@source '../node_modules/kosh-erp/dist';
```

Documentation, design RFCs and an example app: https://github.com/isahaq1/kosh

## Author

**Isahaq**, hmisahaq01@gmail.com, mobile +8801852376598

## License

MIT
