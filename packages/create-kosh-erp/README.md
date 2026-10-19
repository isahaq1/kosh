# create-kosh-erp

Install [Kosh](https://www.npmjs.com/package/kosh-erp) and set it up in one command:

```sh
npm create kosh-erp@latest my-erp   # the project my-erp
npm create kosh-erp@latest          # asks for the project name first
```

It creates the project folder, installs `kosh-erp` (Shutro comes with it), then asks for:

- the PostgreSQL database: your server (username, password, port, host, database name; a missing database is
  created), or one started in Docker for you
- the company (name, currency, language, time zone)
- the administrator (login, name, email, password) and its authenticator app
- the apps (roles and approvals, reports and documents, chatter and attachments)
- file storage (a folder or S3), Valkey (optional), the API port

and sets everything up: the project files and `.env`, the database tables, the administrator, the seed data, and
the back-office's build tools. Then:

```sh
cd my-erp
npm start        # the API
npm run web      # the back-office → http://localhost:5173
```

Options for `kosh init` go after `--`:

```sh
npm create kosh-erp@latest my-erp -- --docker-db
npm create kosh-erp@latest my-erp -- --yes --database-url postgres://user:pass@localhost:5432/my_erp \
  --create-database --company "Padma Traders" --admin-password "a long passphrase here"
```

`pnpm create kosh-erp` and `yarn create kosh-erp` work too. The full guide (Docker, modules, migrations, seed data,
users, every command) is on the [kosh-erp page](https://www.npmjs.com/package/kosh-erp).

## Author

**Isahaq**, hmisahaq01@gmail.com, mobile +8801852376598

## License

MIT
