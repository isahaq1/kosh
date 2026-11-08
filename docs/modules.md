# Modules

A Shutro ERP module is one typed manifest wrapping a Shutro module (RFC 0001). Shutro owns the data layer; the manifest
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

- `defineModule`: the Shutro module has a name; `shutro-erp` is a version range; access levels exist, each grants at least
  one group, and implies only levels of the same module; menu and action ids are `<module>.<name>` and unique.
- `loadModules(roots, { koshVersion })`: collects dependencies, orders them (dependencies first, ties by name),
  refuses cycles and two different modules with one name, checks every module's `shutro-erp` range, checks that Shutro ERP
  dependencies cover the Shutro module's dependencies, that access levels grant only groups of the module or its
  dependencies, that menu parents and actions exist, and that menu and action ids are unique across modules.

Version ranges: `1.2.3`, `^1.2.0`, `~1.2.0`, `>=1.2.0 <2.0.0`, `*`.

**The module standard** (RFC 0023, `pnpm check:modules`, run by `pnpm lint`) measures every module in `modules/`
against one list and fails on a rule a module breaks without a waiver: every model with a list has a search spec
(M2), master data is archivable rather than deleted (M3), documents have a chatter and track their state (M4), every
public model has a list and a form (V1); a print template (P1), an import template (I1), named events (E1), help on
states, selections and computed amounts (M5) and Bangla labels (T1) are reported until their passes make them
required. An exception is declared in the manifest with its reason, so it stays traceable:

```ts
standard: {
  waive: [{ rule: 'V1', model: 'stock.valuation.layer', reason: 'A ledger read in lists and pivots.' }],
},
```

## App settings (RFC 0020)

An app declares its own settings in its manifest; they appear in **Settings › App settings**, found by the Settings
search, saved through one checked and audited API. A `company` section names `res.company` fields the module adds
with `extendModel` — their type, label and default come from the field; an `installation` section keeps its own
key / values (`type` and `label` required). `editors` are the groups that may change a section (Administrators
always; none declared: administrators only); everyone who opens the app may see it.

```ts
// module.ts (Shutro)
export const CompanySales = extendModel('res.company', {
  fields: {
    saleValidityDays: f.integer({ default: 30, label: 'Quotations valid for (days, 0: no limit)' }),
    saleTerms: f.text({ label: 'Default terms and conditions' }),
  },
});
// … defineModule({ …, extensions: [CompanySales] })

// index.ts (Kosh manifest)
settings: {
  sections: [
    {
      key: 'quotations',
      label: 'Quotations',
      description: 'How long new quotations stay valid, and the terms they start with.',
      keywords: 'quote validity expiry terms',
      scope: 'company',
      editors: ['sales.manager'],
      fields: [
        { key: 'saleValidityDays', min: 0, max: 365, help: 'A new quotation is valid until its date plus these days.' },
        { key: 'saleTerms', help: 'Filled in on new quotations.' },
      ],
    },
  ],
},
```

Code reads company settings as the company's fields; installation settings with
`installationSetting(env, 'app.key', fallback)` from `@kosh/server`. A setting may show only when another of its
section has a value (`visibleWhen: { key, equals }`). A wrong declaration (an unknown company field, a type that is
not a setting type, an unknown editor group, a duplicate key) stops the server at start.

Every setting has its **history** (who, when, old → new, from the audit log). Administrators **copy** a company's
settings to another company, **export** them as a JSON file and **import** such a file — each previewed before
anything is written, each change audited like one made by hand (`POST /api/v1/settings/app-settings/copy`,
`GET …/export`, `POST …/import`). A setting that a model must obey (a required tax ID, timesheet steps) is enforced
by a constraint reading the company's field, so the API and imports obey it too (see Contacts and Projects).

## Installing, disabling, upgrading and uninstalling apps (RFC 0008)

`src/modules.ts` lists the **catalogue**: the modules this installation can install. The database records which of
them are **installed**, **disabled** or still **available** (`kosh_module`). The app host serves the installed
ones, and switches to the new set without a restart whenever apps change, on this server or another:

```ts
const host = await createAppHost({ databaseUrl, catalogue: modules, migrationsDir: 'migrations' });
await startAppHost(host, { port: 3000 });
```

**Settings → Apps** in the back-office is the App manager. It shows each app as a card with its icon, state and
what it needs, with search and filters. Install, Enable and Disable show the server's plan first: what comes along,
what goes with it, and the database changes and their SQL. Only Administrators and holders of the
**Settings / App manager** access level can use it, and the server checks this on every request
(`/api/v1/settings/apps`, `/plan`, `/apply`). An apply re-plans and refuses a plan that is no longer current, so a
stale or repeated request changes nothing. `base` and Settings are always installed.

The same from the terminal:

```sh
npx shutro-erp apps                       # ● installed  ◌ disabled  ○ available
npx shutro-erp apps install sales         # the plan (sales and what it needs), then one transaction
npx shutro-erp apps disable projects      # menus, API and access go; tables and data stay (dependents go too)
npx shutro-erp apps enable projects       # back in seconds, with its data
npx shutro-erp apps upgrade               # every app whose code is newer than its installed version
npx shutro-erp apps upgrade acme --remove-data   # an upgrade that drops columns its code no longer has
npx shutro-erp apps uninstall projects --remove-data   # the app and its data, for good (dependents too)
npx shutro-erp apps install sales --plan  # only show the plan
```

Every change is planned against the live database first: the modules (dependencies, cascades) and the schema
statements. It is then applied in **one PostgreSQL transaction**, which covers:

- the migration file, written to `migrations/`;
- the new modules' seed data, and every app's defaults (`hooks.defaults`);
- the new modules' `hooks.postInstall`;
- the installed set;
- an `apps.change` audit event.

If anything fails, nothing changes, not even the migration file. Each applied change is logged in `kosh_app_log`
with who made it, its SQL and the migration file itself. When a server did not keep the file (a recreated
container, for example), `shutro-erp migrate` and the next app change write it back from the log, byte for byte. When the
change commits, `NOTIFY kosh_apps` tells every server to switch to the new set; requests already running finish on
the old one.

A module adds its defaults (data derived from the served modules, such as approval policies from their `approvals`)
with an idempotent hook. It runs after every seed and every app install:

```ts
hooks: { defaults: async (env, modules) => `${await installTemplates(env, modules)} document template(s) installed` },
```

The engine refuses a change in these cases:

- the database has pending migration files, or does not match its modules yet (run `shutro-erp migrate` first);
- the change would drop or alter data;
- `base` or Settings would be disabled;
- disabling would leave behind a `NOT NULL` column without a database default that a served model still has (a
  required field with a function default or a compute, added by the disabled module's `extendModel`);
- another app change happened after this one was planned.

A disabled module's tables stay part of the schema, so `shutro-erp migrate` plans with the installed and disabled modules
and never proposes dropping them.

**Uninstalling** removes an app with its data, for good; disabling stays the reversible choice. The plan lists the
apps that go with it (every installed or disabled app that depends on it) and every table and column deleted, with
its rows. Each module may refuse in `hooks.preUninstall` by throwing (Accounting refuses while posted journal
entries exist: the books are kept). On the Apps page, Uninstall asks for the app's name typed back and a code from
the authenticator app (two-factor sign-in is needed; recovery codes do not count); the CLI asks for the name unless
`--yes`, and needs `--remove-data`. One transaction then:

- keeps a **snapshot** of every table and column it deletes in `kosh_app_snapshot` (30 days; older ones are pruned
  by the next uninstall);
- drops the tables and columns;
- deletes the apps' records in the models that stay, by external id (one still used elsewhere is kept), and their
  external ids;
- removes their groups from people and from runtime roles, and the roles' rights on models that went;
- removes them from the installed set and from Shutro's module list, and writes the `apps.change` audit event.

Installing the app again starts afresh, with its seed data. `base` and Settings cannot be uninstalled.

Projects from before the App manager have no `kosh_module` yet. Until their first `shutro-erp apps` change, servers and
`shutro-erp migrate` keep treating `src/modules.ts` as the installed set. That first change records the modules that have
been migrated, and anything added to the list since then is shown as available.

**Upgrading** (RFC 0012 §5.4): when a module's code is newer than its installed version (`shutro-erp apps` shows
"installed 1.0.0: shutro-erp apps upgrade …", the Apps page an Upgrade button), `shutro-erp apps upgrade` plans the schema
difference, runs the module's data migrations (`migrations` in its Shutro module, each once, for the versions it
passes) and its seed data again, and records the new version, in one transaction with the log. Dropping columns
or tables the new code no longer has is refused with what it would drop, unless asked (`--remove-data`); going
back to an older version is refused.

## Business apps (`modules/`)

The business apps are Shutro ERP code in `modules/`, one package each: `@kosh/contacts`, `@kosh/product`,
`@kosh/sales`, `@kosh/purchase`, `@kosh/accounting` and `@kosh/project`, with the bridges `@kosh/sale_account`,
`@kosh/purchase_account` and `@kosh/sale_project`. They ship in `shutro-erp` as `shutro-erp/sales` and so on. Shutro is only the ORM: no app, module or generated app code lives in it. The framework
(`packages/`) never imports an app (`pnpm lint` checks this); only the CLI, which assembles installations, does.

An app has three parts:

- `src/module.ts` holds the data layer: Shutro models, groups, sequences and seed data, in one `defineModule`.
- `src/.kosh/` holds its **typed view**, generated and committed. `schema.d.ts` describes the models the app can
  see, and `bindings.ts` provides `defineModel`, `compute`, `check`, `onchange`, `records` and `record` typed against
  them, so computes and checks need no casts. Regenerate the view after changing models with `pnpm generate:models`.
  `pnpm lint` fails when a view is stale.
- `src/index.ts` is the Shutro ERP manifest: the app (icon, category, summary), access levels, actions, menus, views,
  search, and approval policies.

```ts
// src/module.ts
import { contactsShutro } from '@kosh/contacts';
import { compute, defineModel, defineModule, f } from './.kosh/bindings.js';

export const SaleOrder = defineModel('sale.order', {
  fields: {
    amountTotal: f.monetary({
      currency: 'currency',
      store: true,
      ...compute('sale.order', 'amountTotal', ['lines.subtotal'], (orders) => {
        for (const o of orders) o.amountTotal = o.lines.sum('subtotal', o.currency); // Money, typed
      }),
    }),
  },
});
```

The views come from Shutro's own type generator, run through Shutro ERP's single Shutro gateway (`loadCodegen` in
`@kosh/server/orm`). Their imports point at `@kosh/server/orm`, and other modules are referenced by package name.

### Price lists (`modules/product`, RFC 0028)

**Products › Price lists**: a list holds rules for a product, a category (and the categories under it) or every
product, from a quantity and between dates. Each gives a fixed price, a percent off a base, or a formula (a percent
off, plus an amount, rounded to a step, kept within a margin over the cost). The base is the list price, the cost or
another list (a list based on itself, even through others, is refused). The most specific rule wins: a product's
over a category's (the nearest first) over every product's, then the highest quantity reached.

- **Sales:** a customer's price list (on the contact) starts their orders; the order's list prices each line that
  has no price typed in, and the line says why ("Wholesale: 10 % off the list price"). A typed price is kept when
  the quantity or the list changes. Typing prices needs `sales.price_override` (Salespeople have it; take it away
  in Settings › Roles to make prices fixed). Lines of orders from before price lists keep their price.
- **Shop:** a signed-in customer's cart is priced by their list.
- **Counter:** a shop's list prices the catalogue and every line sold without a price; a customer with a list of
  their own (when Sales is installed) gets theirs.
- `priceFor(env, pricelist, product, quantity, date)` in `@kosh/product` prices one product, as the caller, and
  explains it.

### Credit control, payment terms and addresses (`modules/sale_account`, RFC 0028)

With Sales and Accounting installed, a customer has a **credit limit** (else the company's default, Settings › App
settings › Credit control). What they owe is their unpaid posted invoices (less credit notes) plus confirmed orders
not invoiced yet; confirming an order that takes them over the limit does what the company's **Credit control**
says:

- **Warn on the order:** confirmed, with the amounts on the order (**Credit**).
- **Refuse the confirmation:** refused, with what they owe and the limit.
- **Ask for an approval:** refused with a pointer to **Ask for credit approval**; the order then waits in **Credit
  approval** for an Accounting manager (the shipped *Credit approvals* policy, through the Approvals app), is
  confirmed when approved and goes back to a quotation when refused or sent back.

Orders also carry **Invoice to** and **Deliver to** (contacts) and **Payment terms**; the invoice goes to the invoice
address with the order's payment terms, else the customer's (**Customer payment terms** on the contact).

### Invoicing by what was delivered, down payments (`modules/sale_account`, RFC 0028)

A product is invoiced on **Ordered quantities** (the default) or **Delivered quantities** (Products › a product ›
Invoice). Each order line knows what is **Invoiced** (its invoice lines, less credit notes); **Create invoice**
invoices what is due now — ordered, or delivered by Stockroom when it is installed (services count as delivered) — so
an order can have several invoices, and is refused when nothing is due ("Nothing to invoice now"). The order is
*Invoiced* when every ordered quantity is. **Invoice a down payment** invoices the **Down payment %** or **amount**
typed on a confirmed order (on the company's *Down payment* service, made on first use), never beyond the order's
total; the next invoice deducts every down payment not deducted yet. Several orders are invoiced at once with the
list's bulk actions. Orders invoiced before this keep their invoice links (a migration matches the lines).

### Bills by what was received, the three-way check (`modules/purchase_account`, RFC 0028)

Purchases follow the product's **Invoice** policy too: **Create bill** bills what is due — ordered, or received by
Stockroom for products on *Delivered quantities* — so an order can have several bills, and is refused when nothing is
due. Each order line knows what is **Billed** (its bill lines, less refunds); the order is *Billed* when every
ordered quantity is. On the bill, each line shows **Ordered / received / billed** for its order line, flagged
*more than received* or *more than ordered* before anyone posts it. Orders billed before this keep their bill links.

### Deals to quotations (`modules/sale_crm`, RFC 0028)

With Pipeline and Sales installed, an open deal has **New quotation**: a new quotation for the deal's customer, by its
salesperson, linked to the deal (**Deal** on the order). The deal shows its **Quotations** and what was **Ordered**.
Confirming a quotation wins its deal (the first winning stage); when every quotation of a deal is cancelled, the
deal is lost, with the reason *Every quotation was cancelled*. Both follow the orders through the outbox, once each
(`sale.order.confirmed`, `sale.order.cancelled`).

A form button may **open** a new record of another model filled from the record instead of running a transition
(`{ kind: 'button', id, label, open: { model, action?, values: { deal: { $record: 'id' } } } }`), and a view
extension may append buttons to a form's header (`{ append: 'header', nodes }`).

### Quotation templates and optional products (`modules/sales`, RFC 0028)

**Sales › Configuration › Quotation templates** (Sales managers): lines, optional lines, how many days quotations
stay valid, terms. A draft quotation with a **Quotation template** gets **Fill from template**: its lines, its
optional products (**Optional products** on the order, offered to the customer), its validity and its terms. An
optional product's **Add** (`POST /api/v1/models/sale.order.option/:id/transitions/add`) makes it a line of the open
quotation, once — priced by the order's list unless the option has a price of its own.

In the portal, a sent quotation shows its **Optional products**; the customer adds what they want before accepting.
The portal checks the quotation is theirs and still waiting, adds the option as the system, posts it on the
quotation's thread and audits it. Any portal document may offer options the same way (`options` in its declaration:
the one2many, its fields, `offered`, `when` and the item's `add` transition;
`POST /api/portal/v1/documents/:key/:id/options/:option/add`).

### Bank statements (`modules/accounting`, RFC 0029)

**Accounting › Reconcile bank** (accountants with the reconcile permission): import a statement of a bank or cash
journal — CSV (name the date, label and amount columns; `debit` / `credit` columns work too), OFX or CAMT.053 —;
a line imported twice (the same journal, date, amount and reference) is skipped. Then each open line in turn
(J / K to move): the open invoices, bills and credit notes it may pay, proposed with why ("the same amount,
INV/2026/00042 in the label, the same partner"); **Match** registers the payment from the statement's journal, posted
and reconciled. A line that pays nothing is **written off** to an account (bank charges, interest). **Bank
statements** lists them; a statement closes when every line is matched and its opening balance plus its lines is its
closing balance. A journal with a **bank feed** (`registerBankFeed(feed)`, then the journal's *Bank feed*) pulls new
lines into a statement (`POST /api/v1/accounting/journals/:id/pull`); real banks are adapters like the test feed.

**Reconciliation rules** (Accounting › Configuration, set up by Accounting managers) match the routine lines for
you. Each says which lines — journals, money in or out, *label contains*, an amount range, a partner — and what to
do: **match the document** (the open document of the same amount the proposals rank first; nothing happens when
none has it), **write off** to an account with a label, or **only suggest** (the rule is shown on the line). They run
in sequence on every import (as the importing accountant) and with **Run rules** on the Reconcile bank page; the
first that applies and can act wins. Each automatic match counts on the rule (*Applied*) and is in the audit log. A
rule's **dry run** (`GET /api/v1/accounting/reconcile-rules/:id/dry-run?days=90`) says how many lines of those days
it applies to, its hit rate and what it would do to the open ones, without changing anything. **Recently matched**
lines have **Undo** (`POST /api/v1/accounting/statement-lines/:id/undo`): a payment comes off its documents and is
reversed, a write-off is reversed, and the line is open again.

### Vendor prices (`modules/purchase`, `modules/purchase_stock`, RFC 0030)

**Purchase › Vendor prices** (buyers) records what each vendor charges: for a product or for every product of a
category, their code and name for it, the currency, **from what quantity** (one row per price break), between which
dates, how many **lead days** they take, and whether they are **preferred**. Prices come in through the import
screen too (the *Vendor prices* template).

A purchase line's price is the one typed in, else the order's vendor's price for the line's quantity and the
order's date, else the product's cost; the line shows the vendor's code and **why** ("Padma Cement's price from
100; 2 days to arrive.", "Typed in."). A typed price is kept when the quantity or the vendor changes. A reorder rule
that buys orders from the preferred vendor if one fits, else the **cheapest that arrives within the rule's lead
days** (else the cheapest), else the rule's own vendor; Replenishment says so in the rule's explanation ("Bought from
Jamuna Supplies: Jamuna Supplies is the cheapest of 2; arrives in 4 days, in time."), and the request for quotation
expects the goods after the vendor's lead days.

A vendor's contact shows their **scorecard** for the last twelve months (`GET
/api/v1/purchase/vendors/:id/scorecard`, with Purchase with receipts): the confirmed orders, the share of receipts
done by the expected date, the average days from order to receipt, and the last price of what is bought most
against the year's average — computed from the orders the user may read. `vendorPriceFor(env, { product, quantity,
date, vendor?, currency?, needBy? })` gives other modules the same choice with its sentence.

### Fiscal positions and accounts (`modules/accounting`, RFC 0029)

**Where a line posts.** A product line posts to its own account if one is set, else to what an app proposes (a
purchase order's receipt account), else to the product's **Income account** (sales) or **Expense account**
(purchases), else to its category's, else to the journal's default account. What a customer owes posts to their
**Receivable account**, what we owe a vendor to their **Payable account**, else to the company's. Accounts of
another company are never used (products and categories are shared).

**Fiscal positions** (Accounting › Configuration, Accounting managers) map taxes — a tax to another, or to none — and
accounts. A document uses the position chosen on it, else the contact's **Fiscal position**, else the first position
marked **Apply by itself** whose conditions the contact meets: countries (`BD, IN`, or `!BD` for any but Bangladesh),
states (`IN-MH`) and whether they have a tax number. Taxes are mapped when the document is confirmed, and the
position is then written on it. A draft invoice or bill shows **When confirmed**: the position and why it applies,
each line's taxes after the mapping, its account and where it came from, and the receivable or payable account
(`GET /api/v1/accounting/moves/:id/preview`).

```ts
// An export position: no VAT, sales on their own account.
await api.create('account.fiscal.position', {
  name: 'Export', autoApply: true, countries: '!BD',
  taxes: { create: [{ taxSrc: vat15, taxDest: null }] },
  accounts: { create: [{ accountSrc: sales, accountDest: exportSales }] },
});
```

### Payment follow-ups (`modules/accounting`, RFC 0029)

**Follow-up levels** (Accounting › Configuration, Accounting managers) say how late an invoice must be — days past
its due date —, how the customer is reminded (email, SMS, WhatsApp), the text (subject, email body and a short text
for messages, each language its own; `{{partner}}`, `{{company}}`, `{{amount}}`, `{{days}}`, `{{invoices}}`,
`{{count}}`, `{{link}}`), and whether sales stop. A company starts with three: a first reminder at 15 days, a second
with a text at 30, and a final notice at 60 that stops sales. Once a day each customer with overdue invoices gets one
reminder for the highest level their oldest invoice reached, with every overdue invoice and — with the portal
installed — its link to pay (`KOSH_PORTAL_URL`); a level is sent once, and a customer who paid starts over. Each
reminder is noted on the invoices' chatter and logged (Accounting › Reporting › Reminders sent).

**Accounting › Follow-ups** lists who is late: how much, how many days, the level reached, the last one sent and when.
**Send now** sends the reminder of the level reached at once (even when it was sent, or the customer is paused);
**Pause** holds the daily reminders until a date, with the customer's promise. While a customer is at a level that
stops sales, their sales orders cannot be confirmed (`sale_account`), until they pay. Email needs `SMTP_URL`; texts a
Twilio account (`TWILIO_*`). The routes: `GET /api/v1/accounting/followups`,
`POST /api/v1/accounting/followups/:partner/send` and `POST /api/v1/accounting/followups/:partner/pause`
(`{ until: 'YYYY-MM-DD' | null, note? }`), for accountants.

### Sending documents (`@kosh/mail`, RFC 0029)

A document declared **sendable** has **Send** beside Print on its form: invoices and credit notes once posted, sales
orders and quotations, purchase orders and requests for quotation. The dialog is filled from the document's **email
template** in the customer's language (the contact's *Language*: English or Bangla) — the address, the subject, the
message, the PDF — and everything can be changed before sending; a customer without an address is said so. Sending
renders the PDF, stores it on the record, posts the message with the PDF on the chatter and queues the email, which
the outbox sends once (`mail.outgoing`: queued, sent or failed with the reason; **Email › Sent** for Email managers).
The dialog says how often the document was sent already. Templates are data: **Email › Email templates** (Email
managers) edits the subject and body of each language, with `{{name}}`, `{{partner.name}}`, `{{amountTotal}}` or
`{{company.name}}` placeholders, and the document template attached.

A module ships its own:

```ts
defineModule({
  // ...
  mailTemplates: [
    {
      key: 'quotation',
      name: 'Quotation',
      model: 'sale.order',
      document: 'sales.quotation', // the document template sent as a PDF (module.key)
      subject: '{{company.name}}: {{name}}',
      body: 'Dear {{partner.name}},\n\nPlease find attached {{name}} of {{amountTotal}}.',
      translations: { bn_BD: { subject: '…', body: '…' } },
    },
  ],
  sendable: [{ model: 'sale.order', template: 'sales.quotation', partner: 'partner' }],
});
```

**Send by email** in a list's bar of selected rows sends each document to its own partner, with its own template,
language and PDF (at most 100 at once); the ones that cannot go — no address, not posted — are skipped and the
reason given. A customer whose contact has **Send invoices by email** (Accounting, on the contact) gets each invoice
and credit note by itself when it is posted, as the user who posted it: a sendable document's
`autoSend: { topic, flag }` sends it when `topic` is emitted for the record and the partner's boolean `flag` is set.

`when` limits Send to records in a state (`{ state: 'posted' }`). The routes: `GET /api/v1/mail/sendable`,
`GET /api/v1/mail/compose/:model/:id`, `POST /api/v1/mail/send/:model/:id` (`{ to, cc?, subject, body, attach? }`)
and `POST /api/v1/mail/send-many/:model` (`{ ids }`), as the user: who cannot read the record cannot send it. Email needs `SMTP_URL` (and `MAIL_FROM`) and
file storage for the PDF.

### Projects for programmes (`modules/project`, RFC 0026)

Projects carries a programme's structure, not only a to-do list. Configuration holds **project types**, **task
categories** (optionally of a type) and **tags**. A project has a code (`PRJ-0001`, numbered per company), a type, a
sponsor, an owner, a priority, a risk level, a location, its scope, assumptions and constraints, and may sit inside a
**programme** (`parentProject`; no cycles, shown as a hierarchy). Inside it are **phases** (nested, with a manager,
the person responsible, dates and a status) and **work packages** (in a phase or directly in the project, with their
deliverables). Tasks sit in them (the work package sets the phase; all are kept in the task's own project), have
**sub-tasks**, several **assignees**, tags and a **milestone** flag, and wait for other tasks through
**dependencies** (`project.task.link`, with a lag in days; never a circle). A task waiting for one that is not done is
*blocked*.

Progress is computed, never typed: a task is 100 when done, else its sub-tasks' share done; a work package, a phase and
a project weigh their top-level tasks by planned hours (a task without any weighs one hour). A phase or work package
may be set by hand (`progressOverride`), and shows as such. The project's page shows the **structure** as a tree —
phases, work packages and tasks with their progress — read as the user, so record rules decide what appears.

**Plans** come before projects. A plan (`PLAN-0001`) states the objectives, expected outcome, strategic goal, the
planned dates and an estimated budget; it is submitted for approval through the approval engine (the *Project plans*
policy: the sponsor, or a Projects manager when there is none, and above 1 000 000 a Projects manager too), so the
Approvals inbox, deadlines, delegation and decisions from email all apply. Once approved, *Start the project* makes
the project from it with the plan's dates and approved budget as its **baseline**; the project shows how many days
its deadline moved against it. The baseline (and the approved budget) are written by the system or by Projects
managers alone; *Take the baseline again* on a plan in progress copies the current dates of its projects, phases and
work packages. App settings › Projects › *Require an approved plan* refuses projects without one, except inside a
programme and those made by sales orders. A plan is seen by who wrote it, its manager and its sponsor.

A project's **team** lists its members: the person, a **role** (Configuration › Roles, each with a default hourly
cost), their **allocation** of working time, their own hourly cost and the dates they are in it. A member whose
projects take more than all their time on some day of those dates is **over-allocated** — flagged on the form as soon
as the allocation is typed, before saving. Projects › **Workload** shows people by weeks, each cell the person's peak
allocation that week, over 100 % in red (Projects managers see everyone; others themselves; `GET
/api/v1/projects/workload?from=&weeks=`). Each timesheet **costs** its hours at the person's hourly cost in that
project on that day, else their role's default; the project adds them up as its **labour cost**. Hourly costs, a
timesheet's cost and a project's labour cost are Projects managers' to see and set — the server leaves them out for
everyone else.

**Money and health.** A project's **budget** is its lines (what for, a category, a phase or work package, planned).
Its **actual cost** is labour plus the costs **booked** on its cost centre; **committed** costs are purchase orders on
it not billed yet; what is **left in the budget** is the budget less both. With Accounting, the bridge
`project_account` gives each project its **cost centre** (coded like the project) the first time its figures are
refreshed, and posted expense lines on it are booked; with Purchase too, `project_purchase` adds the orders not yet
billed — once billed and posted they count as booked, never twice. The money is Projects managers' to see.

A project's **health** — on track, at risk, off track — is what its figures say: progress against the share of time
gone (at risk from 10 points behind, off track from 25), past its deadline and not done, milestones late, the budget
used (at risk from 90 %, off track beyond it); thresholds in App settings › Projects › Health. The figures and the
health refresh hourly and on *Refresh the figures* (`POST /api/v1/projects/refresh`, Projects managers), which also
marks phases past their end as **late**. A manager may set the health by hand with the reason; the figures stay
underneath and both are in the history. The Projects overview shows projects by health, plans waiting for a decision
and phases overdue.

**Schedule.** Tasks have a start besides their deadline. The project's page shows its **schedule**: the top-level
tasks as bars over the weeks, the baseline as a thin bar beneath each, arrows from a task to what waits for it, and
the **critical path** in red — the tasks with no day to spare, by the critical path method over the dependencies and
their lags (`GET /api/v1/projects/:id/schedule`). When a task slips, *Move waiting tasks* moves what starts before it
is finished to the day after (plus the lag), keeping each one's length, and what waits for those in turn. A task may
**repeat** every n days, weeks or months until a date: once done, the next one is made with its dates moved.

**Control.** Projects › Control holds each project's **risks** (probability and impact from 1 to 5, the score and its
level, the owner, mitigation and contingency), **issues** (severity, owner, a resolution before they are resolved),
**change requests** (a new deadline or baseline budget with the reason and impact, decided through Approvals by the
sponsor and a Projects manager, then applied to the project and its baseline with what they were kept) and weekly
**status reports** (the health and progress filled in with the open risks and issues; sent, the report is posted on
the project for its followers, the sponsor among them).

### Focus (`modules/todo`, RFC 0021)

To-dos for the people who use them: their own, or on lists shared with colleagues, with due dates, priorities and
checklists. Install it with `shutro-erp apps install todo` and give people the *Focus › User* access level; their
open to-dos due today appear on the home page.

### Agenda (`modules/calendar`, RFC 0021)

Meetings with attendees from the company and outside, rooms that are never double-booked, private events others see
as *busy*, one-click answers and free / busy for several people and rooms (`GET /api/v1/agenda/busy`). Install it
with `shutro-erp apps install calendar`; *Agenda › User* for everyone, *Manager* for those who manage rooms and the
default length (Settings › App settings › Agenda).

### Pipeline (`modules/crm`, RFC 0021)

Deals on a board of stages, each with its probability and the fields it requires (a proposal needs its revenue and
close date); won by reaching a winning stage, lost with a reason; the weighted forecast by salesperson and month;
duplicates by email, phone or company (`GET /api/v1/pipeline/deals/:id/duplicates`). Install it with
`shutro-erp apps install crm`; *Pipeline › Salesperson* or *Manager*.

### Workforce (`modules/hr`, RFC 0021)

Employees (separate from users), the org chart, departments, positions, contracts and leave. Leave counts working
days by the weekend set in App settings › Workforce, keeps to the year's balance, never overlaps, and is decided by
the line manager (`POST /api/v1/workforce/leaves/:id/decide`) or HR — never by the person asking. Personal details
and wages are for HR managers only. Install it with `shutro-erp apps install hr`.

### Hiring (`modules/recruitment`, RFC 0021)

Openings for Workforce positions with a headcount, applicants on a board of stages, and scorecards each interviewer
keeps to themselves (the average shows to all). **Hire** (`POST /api/v1/hiring/applicants/:id/hire`, hiring
managers) makes the Workforce employee, moves the applicant to the hired stage and closes the opening when it is
filled; it is the only way to hire. One application per email and opening; expected salaries for hiring managers
only. Install it with `shutro-erp apps install recruitment`.

### Stockroom (`modules/stock`, RFC 0021)

Warehouses, a tree of locations, and the Transfer — one document for receipts, deliveries and internal moves —
with one status (Draft, Waiting, Ready, Done, Cancelled). Lines may be in any unit of the product's unit category and
are converted exactly. Reservations take only what is available and say what they are for; a transfer out of stock
is validated only when everything is reserved, so stock never goes below zero. Quantities change only through
validated transfers. Every company gets its main warehouse `WH`. Install it with `shutro-erp apps install stock`.
With Sales or Purchase, the `sale_stock` / `purchase_stock` bridges make each confirmed order's delivery or
receipt, once, and show what is delivered or received on the order. A transfer can be validated in part: the
done quantities move, and the rest goes to a backorder that stays with its order. Counts list what a location
holds, take scans from a phone (`POST /api/v1/stockroom/counts/:id/scan`) and, applied by a manager, adjust the
stock through validated adjustment transfers. Products can be tracked by lot (with expiry dates, first expiry
first out) or by serial number; every lot shows where it is and where it went. With Accounting, the
`stock_account` bridge values the stock (average cost or FIFO) and posts each receipt, delivery and count
adjustment at once; Stockroom › Valuation shows the stock's value. With Purchase too, `purchase_stock_account`
values receipts at the order's price and has vendor bills clear Goods received not billed, the difference going
to Price differences.

**Replenishment** (RFC 0024): reorder rules keep a product between a minimum and a maximum in a warehouse. Each
rule's forecast — on hand, less what is going out, plus what is coming in and what is on order — is refreshed hourly;
below the minimum, Stockroom › Replenishment proposes enough to reach the maximum (in steps of the rule's multiple)
and says why, in words. The chosen rules are ordered by their method: a transfer from another warehouse, a request
for quotation to the vendor (with `purchase_stock`; purchase orders say which warehouse they are delivered to), or a
production order with the valid bill (with `mrp`); a rule may be ordered automatically, or snoozed.

**Routes**: a warehouse may receive in two steps (Input, then stock) or three (with Quality control) and deliver in
two (a pick into Output) or three (pick, pack, deliver); each step is a transfer of its own, made or reserved when
the one before it is done. **Putaway rules** say where received products (or categories) go inside a location. A
reorder rule may order **for each delivery** (make to order) — on a transfer, a request for quotation or a
production order — or **dropship**: the vendor delivers to the customer on a dropship transfer, with its own request
for quotation, never through stock.

### Production (`modules/mrp`, RFC 0021)

Bills of materials with versions and effective dates, work centres with their cost per hour, and production orders
that list what is required, available and short, and what they will cost, before they start. Confirm reserves the
components through Stockroom; Produce consumes them and puts the product in stock. Install it with
`shutro-erp apps install mrp`. With Accounting, `mrp_account` values what is made at what it consumed plus its
operations, and Work in progress clears with each order. Bills may make by-products that carry a share of the
cost; scrap (Stockroom › Scrap) is recorded with its reason, on an order or anywhere. Confirmed orders get their
work orders scheduled at the work centres (Production › Work orders, a Gantt); `GET /api/v1/production/capacity`
gives each centre's load by day.

### Asset Care (`modules/maintenance`, RFC 0021)

Equipment with asset tags, warranty and meters that only count up; preventive plans by time or by meter whose
orders are made when due (hourly, or `POST /api/v1/assetcare/plans/run`), with checklists ticked before an order is
done; breakdowns that put equipment down until repaired; reliability (failures, downtime, MTTR, MTBF, availability)
from `GET /api/v1/assetcare/reliability`. Install it with `shutro-erp apps install maintenance`. With Stockroom,
`maintenance_stock` reserves an order's spare parts when it starts and consumes them when it is finished.

### Trade Finance (`modules/trade_finance`, RFC 0021)

Import and export letters of credit under UCP 600: the amount with its tolerance, at sight or usance, the shipment
and expiry dates; amendments applied once accepted; presentations whose discrepancies are waived or refused, with
their maturity, drawn within the LC and paid until it is settled; limits per bank and currency that issuing never
passes; alerts on shipment and expiry dates (`GET /api/v1/trade/alerts`). Install it with
`shutro-erp apps install trade_finance`. With Accounting, `trade_finance_account` posts LC margins (and their
release), payments and bank charges (expensed) in the LC's bank journal. Shipments are recorded against an LC;
with Purchase or Sales, an LC is opened from its order (`trade_finance_purchase`, `trade_finance_sale`).

### Event Hub (`modules/event`, RFC 0021)

Events with sessions and ticket types; registrations confirmed while seats remain (the event's and the ticket's),
else on a waiting list that moves up in order when a seat frees; check-in once by the code on the ticket
(`POST /api/v1/eventhub/checkin`, what a phone scanning the QR sends). Install it with
`shutro-erp apps install event`. Tickets print with their QR (the `qr` block of document layouts); the event's
check-in box takes a scanner, the keyboard or the phone's camera. Attendees get a confirmation with their code and
thanks after the event (SMTP from `SMTP_URL`); with Accounting, `event_account` invoices paid places.

### Sites (`modules/website`, RFC 0021)

Websites per company: pages built from blocks (a hero, text, an image, a call to action, a form) with a live preview
on the page form, published or draft, in English or Bangla with their translations linked; forms whose submissions
become contacts (or what another app adds to `targets()` on `website.form`), a bot's caught by a honeypot and kept
as spam. Install it with `shutro-erp apps install website`. The public site — the Next.js site later, or any other —
reads the public API, which needs no sign-in and is rate limited per address:

```
GET  /api/v1/public/sites/padma?lang=bn                 the site and its menu
GET  /api/v1/public/sites/padma/page?path=/about&lang=en a published page: blocks, forms, translations
POST /api/v1/public/sites/padma/forms/contact            { "name": "…", "email": "…" } → 201 { "message" }
```

A form fills plain fields only (text, numbers, dates) of the model it creates; each value is checked (required,
email, phone, date, length). Public reads are kept 30 seconds per server and sent with `Cache-Control`. With
Pipeline, `website_crm` lets a form create deals: they arrive from the website in the first stage, for no
salesperson yet, so every Pipeline user sees them.

## An app's overview (RFC 0022 §3.2)

```ts
overview: {
  cards: [
    { id: 'sales_month', title: 'Sales this month', kind: 'kpi', model: 'sale.order', measure: 'sum:amountTotal',
      filter: { state: { in: ['sale', 'done'] } }, comparison: { field: 'dateOrder', mode: 'previous' }, w: 3 },
    { id: 'by_month', title: 'Sales by month', kind: 'chart', model: 'sale.order', measure: 'sum:amountTotal',
      groupBy: 'dateOrder:month', chart: 'bar', w: 8 },
  ],
},
```

An app that depends on `reporting` declares its overview: KPI, chart, pivot and list cards (`count` or `op:field`
measures, a filter, a group-by, a comparison with the previous period or last year, a width in twelfths). The
module gets an *Overview* action and menu, first in the app; `reporting` installs the cards as a shared dashboard
keyed by the module (once; a changed dashboard is kept), and the page shows them to any user of the app, each card
computed with that user's rights.

### Spend (`modules/expense`, RFC 0024)

Expenses with their receipts, categories with a policy the server enforces at submission (a receipt above an amount,
limits per expense and per month that need a reason and a manager's approval when passed, rates per day or per
kilometre), reports approved through the approval engine with likely duplicates flagged, and cash advances that later
reports settle. With Accounting (`expense_account`), an approved report is booked as one entry and reimbursed from
the cash or bank journal chosen on it; advances are paid out and returned through their journal. Install it with
`shutro-erp apps install expense`.

### Attendance (`modules/attendance`, RFC 0024)

Shifts (night shifts included) and rosters; check-in from the phone inside a site's geofence, at a kiosk by badge or
PIN (set on the employee's form; five wrong PINs lock the person for 15 minutes), or from a device file (ZKTeco's log
or a CSV, each punch once); public holidays; and each person's day — worked time with the break deducted, late,
early, absent, on leave, overtime past the shift's threshold in its steps and all of it on weekends and holidays —
approved by an Attendance manager before Payroll reads it. Days follow the time zone in App settings › Attendance.
Install it with `shutro-erp apps install attendance`.

### Payroll (`modules/payroll`, RFC 0024)

A country-neutral engine: salary structures of rules written in a small, safe formula language (`WAGE * 0.6`,
`BASIC / 30 * ABSENT_DAYS`, `slab('TAX', …)`), parameters and slab tables kept as data with effective dates, monthly
runs whose payslips explain every line, Attendance's approved days and overtime, one-off inputs, loans repaid run by
run, corrections that never edit an approved run, and payment files for banks, bKash, Nagad and Rocket. With
Accounting (`payroll_account`) an approved run is booked as one entry and paid from the bank. Install it with
`shutro-erp apps install payroll`.

```ts
// A rule (Payroll › Configuration › Salary rules)
{ code: 'OVERTIME', category: 'allowance', formula: 'BASIC / 208 * OVERTIME_RATE * OVERTIME_HOURS',
  condition: 'OVERTIME_HOURS > 0' }
```

### Bangladesh payroll (`modules/l10n_bd_payroll`, RFC 0024)

Proposed with the Bangladesh localization and Payroll: the *standard* and *garments (RMG)* structures with overtime at
the shift's rate of the basic ÷ 208, festival bonuses after a year's service in a run marked as a festival run,
absence on the basic, provident fund for members (a per-person value `PF_MEMBER = 1`), and income tax deducted at
source from the year's projection, the exemption, the slab table in force, the investment rebate (a per-person value
`INVESTMENT`) and the minimum tax, spread over the months left. Every rate is a parameter or a slab table with its
dates and a note of its source — **verify them against the year's Finance Act and NBR circular before use**.

### Helpdesk (`modules/helpdesk`, RFC 0024)

Teams with business hours and assignment in turn or by load; tickets from the back-office or by email to `helpdesk@`
(the sender becomes the customer; replies thread back into the ticket); SLA policies by team, priority and customer
in business hours, with the resolution clock paused while waiting on the customer and resumed when they write back;
the status on track, at risk, breached or met; canned replies; merging; and the customer's rating through a one-time
link. Install it with `shutro-erp apps install helpdesk`.

### Fixed assets (`modules/account_asset`, RFC 0024)

In Accounting: asset categories with their accounts, method and life; assets from posted bills (a line on a
category's asset account becomes a draft asset) or by hand; depreciation boards — straight line from the date of use,
declining balance switching to straight line, units of production by usage — posted month by month, once each, with
the asset's cost centre; disposal and sale with the gain or loss; revaluation and impairment; and a tax book at each
category's tax rate beside the accounting book. Journal lines carry an optional **cost centre** (Accounting ›
Configuration › Cost centres), with a *By cost centre* report. Install it with `shutro-erp apps install account_asset`.

### Budgets (`modules/account_budget`, RFC 0024)

In Accounting: budgets for a period with lines by cost centre and / or account; each line's actual (posted), committed
(confirmed purchase orders not billed yet), left and used; and a control on purchase orders — beyond a *warn* line an
order needs an Accounting manager's approval as well, beyond a *block* line it is refused with the shortfall. Purchase
order lines carry the cost centre, which their bills keep. Install it with `shutro-erp apps install account_budget`.

### Shop (`modules/website_sale`, RFC 0024)

In Sites: a site marked *Shop* sells its published products through a public API for a storefront — the catalogue
(search, categories, prices, sorting, English and Bangla), a cart held by a secret token and priced by the server,
the delivery methods with their fee (fixed, by weight, or by zone such as Dhaka and outside; free from an amount) and
checkout with cash on delivery (confirmed within the site's limit) or an online payment through the payment
providers, which confirms, invoices and pays the order once the provider confirms. Install it with
`shutro-erp apps install website_sale`.

```
GET  /api/v1/public/shop/padma/products?q=cement&sort=price&lang=bn
POST /api/v1/public/shop/padma/cart                          → { token }  (then the x-cart-token header)
PUT  /api/v1/public/shop/padma/cart/lines                    { "product": 7, "quantity": 2 }
GET  /api/v1/public/shop/padma/carriers?city=Dhaka
POST /api/v1/public/shop/padma/checkout                      { name, email, phone, street, city, carrier, payment: "cod" }
GET  /api/v1/public/shop/padma/order                         the placed order, its payment and its shipments
```

Delivery methods may name a courier: a confirmed shop order then gets a shipment to book (Sites › Shipments), tracked
to delivery with the cash collected; couriers are adapters (the test courier now; Pathao, Steadfast and RedX with
their credentials). With Stockroom, `website_sale_stock` shows in stock / few left / out of stock and can keep carts
within what is available. Coupons (a percentage, an amount or free delivery, with minimums, dates and use limits),
one reminder for a cart left with an email (with a code that restores it), a sitemap of the site's pages and
products, search titles, and product pictures served publicly complete the Shop.

### Approvals (`modules/approvals`, RFC 0025)

Every approval of every app in one place: **To approve** as cards (the record, who asked, how long it waits, each
level as a step), decided one by one or many at once, from the keyboard too; **My requests**, withdrawn while they
wait; **What I decided**. Levels are decided by a role, named people, the requester's manager or a person on the
record — any one, all, or a number of them —; a request may be sent back for changes (a new round when resubmitted).
Levels may have a deadline (a reminder at half, then escalation to a role), approvers may say who decides for them
while away, and each approver gets the request by email with a one-time link to a confirmation page. Approvals
managers edit the policies on screen, with a preview of which of the last 50 records each level would have asked
about. Install it with `shutro-erp apps install approvals`.

**Requests** of any kind go through it too. A **category** (Business trip, Payment, Purchase request, General ship;
Approvals managers add their own) says which fields a request asks for — amount, period, contact, location,
quantity, lines, a file — each not asked, optional or required, and what an approved request leads to. Each category
has its own policy on requests, made with its first request (the requester's manager, else an Approvals manager) and
edited like any policy. Whoever may decide a request reads it; nobody else does. With Purchase, the bridge
`approvals_purchase` lets request lines name products and turns an approved *Purchase request* into a request for
quotation to its contact, shown on the request. An app offers an outcome by extending `approval.ask.outcomes()` and
`runOutcome()`.

### Documents (`modules/documents`, RFC 0024)

Folders (open, or kept to their members), documents with tags and versions — each upload a version, the latest the
document's file —, one search over documents and every record's attachments the user may read, share links with
an expiry and an optional password, and requests that email a person a link to upload a file into the right
folder (reminded once when late). Install it with `shutro-erp apps install documents`.

```
POST /api/v1/documents/upload?folder=3        (the raw body is the file, X-Filename its name)
POST /api/v1/documents/12/versions            a new version
GET  /api/v1/documents/search?q=contract      documents and record attachments
POST /api/v1/documents/shares                 { "document": 12, "days": 7, "password": "…" } → { url }
```

### Sign (`modules/sign`, RFC 0024)

Templates — a PDF with fields per signer's role (signature, initials, date, text, checkbox) — and requests from a
template, from any record, to signers in order or all at once. Each signer gets a link by email, confirms with a
one-time code, draws their signature on the page (a phone too) or refuses with why; the last signature seals the PDF
(the values stamped in, a certificate page, its hashes kept) and stores it in Documents and on the record. Install it
with `shutro-erp apps install sign`.

### Counter (`modules/pos`, RFC 0021)

Point of sale: shops with their payment methods, cashiers' sessions with opening and closing counts (a difference
needs a reason), sales with lines, taxes, several payments and the change, each accepted once by the device's
reference. The register (*Counter › Register*) sells from a tablet or a phone: products as tiles, search and a
barcode box, the cart, the payment dialog, the receipt. Install it with `shutro-erp apps install pos`.
A sale made offline waits on the device and goes when the network is back; a closed session books one entry in
the shop's sales journal and, with Stockroom (`pos_stock`), leaves stock as one delivery; receipts go by email or
text from the register. A refund is a negative sale with a reason, linked to the original: cashiers refund the
sales of their own open session, managers (`pos.refund_any`) any sale. Quantities are typed on the register for
weighed goods.

## Demo data (RFC 0008 §5.8)

`npx shutro-erp init --demo` (or a yes to the question after the apps) loads every installed app's demo data: a sample
company with contacts, products, orders at every stage, approvals waiting, posted and paid invoices, projects and
timesheets, made by the demo users `dina` (manager of every app), `rahim` (sales, invoicing), `karim`
(purchasing) and `sumi` (projects) with one shared password that the installer prints. In this repository
`pnpm demo` starts a throwaway installation of every app with the demo data (PostgreSQL from `DATABASE_URL` or a
container) and tells how to point the back-office at it.

An app seeds its demo data with `hooks.demo` in its manifest: a function of a `DemoContext` whose `as(user, fn)`
runs `fn` as a demo user (created with the groups it names on first use), so the data goes through the same
audit, sequences, approvals and record rules as real data. Seeders run once per module, in dependency order
(`kosh_module.demo_at`), and may look up what earlier seeders made by name (`idByName`). Demo data is never loaded
without being asked for, and the flag is not meant for production databases.

**Default access is none.** Each app declares its own groups and access levels. A salesperson (`sales.user`) gets
read access to contacts and products through the groups it implies, and sees only their own orders (a record
rule). Managers see every order of their companies.

| App | Models | Workflow and rules |
| --- | --- | --- |
| Contacts | `res.partner` (companies and people, customers and vendors, addresses, tax ID) | email format check |
| Products | `product.product` (numbered P00001…), `product.category`, `uom.uom`, `account.tax` | units as editable seed data; several taxes per line, in sequence (a country's come with its localization) |
| Sales | `sale.order` (SO/2026/00001…), `sale.order.line` | quotation → sent → order → locked; lines required to confirm; discount and VAT per line; totals in the order's currency |
| Purchase | `purchase.order` (PO/2026/00001…), `purchase.order.line` | RFQ → submit → approvals (manager > 100,000, director > 1,000,000, editable) → order; the last approval confirms |
| Bangladesh (`l10n_bd`) | BIN and TIN on `res.partner` and `res.company`; the Bangladesh chart, VAT / SD / AT taxes, VDS and TDS withholdings | installed with Accounting for a company in Bangladesh (`shutro-erp init --country BD`): sets up each company without a chart, July–June year, lakh grouping; BIN 13 and TIN 12 digits checked (RFC 0016) |
| India (`l10n_in`) | GSTIN and PAN on `res.partner` and `res.company`, HSN / SAC on `product.product`; the India chart, GST with CGST / SGST / IGST components, cess, reverse charge, TDS | installed with Accounting for a company in India (`shutro-erp init --country IN`): April–March year, lakh grouping; CGST + SGST within the company's state, IGST otherwise (RFC 0016) |
