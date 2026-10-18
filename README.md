# kosh

A modern ERP framework on TypeScript, PostgreSQL and the [Shutro](https://github.com/isahaq1/shutro) ORM: typed end
to end (models → REST + OpenAPI → generated client → React UI), permissions enforced on the server, metadata-driven
views, reporting and communication.

- [Development setup](docs/development.md) — `pnpm install`, `docker compose up -d`, `pnpm build`, `pnpm test`,
  `pnpm test:e2e`, `pnpm bench`
- [Modules](docs/modules.md) · [Server and API](docs/server.md) · [Permissions](docs/permissions.md) ·
  [Views and UI](docs/ui.md) · [Reporting](docs/reporting.md) · [Chatter and attachments](docs/messaging.md)
- [Design RFCs](docs/rfcs/README.md) · [Benchmarks](docs/benchmarks.md) · [Kosh against Odoo](docs/comparison.md)

Shutro is linked from a sibling checkout (`../shutro`) until `shutro@0.2.0` is published to npm.
