# kosh

A modern ERP framework on TypeScript, PostgreSQL and the [Shutro](https://github.com/isahaq1/shutro) ORM: typed end
to end (models → REST + OpenAPI → generated client → React UI), permissions enforced on the server, metadata-driven
views, reporting and communication.

- [Development setup](docs/development.md) — `pnpm install`, `docker compose up -d`, `pnpm build`, `pnpm test`,
  `pnpm test:e2e`, `pnpm bench`
- [Modules](docs/modules.md) · [Server and API](docs/server.md) · [Permissions](docs/permissions.md) ·
  [Views and UI](docs/ui.md) · [Reporting](docs/reporting.md) · [Chatter and attachments](docs/messaging.md)
- [Design RFCs](docs/rfcs/README.md) · [Benchmarks](docs/benchmarks.md) · [Kosh against Odoo](docs/comparison.md)

**Getting started** (terminal and Docker, modules, migrations, seed data, users, every command):
[scripts/npm-readme.md](scripts/npm-readme.md), also the [npm page](https://www.npmjs.com/package/kosh-erp).

Install and set up in one command: `npm create kosh-erp@latest my-erp` (or `npm install kosh-erp` then
`npx kosh init`; Shutro comes with it) ([kosh-erp](https://www.npmjs.com/package/kosh-erp);
entry points `kosh-erp`, `kosh-erp/views`, `kosh-erp/ui`, …). `pnpm pack:npm` assembles it from the workspace
packages (`scripts/pack-npm.ts`); the workspace links a sibling Shutro checkout (`../shutro`) for development.
