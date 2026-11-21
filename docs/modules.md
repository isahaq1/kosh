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

### Landed costs (`modules/stock_account`, RFC 0030)

Freight, customs duty, insurance or LC charges belong to the goods they brought in. A product marked **Landed cost**
(with its default **Split**: by quantity, weight, volume, value or equally) is such a cost. **Stockroom › Landed
costs** (stock valuation users prepare, Accounting posts) names the done **receipts** and the **costs** — each with
its amount and split — and shows, before posting, how they are shared: each receipt line's part, what goes to the
stock still on hand and what to the cost of goods sold for what has already left. **Post** adds the on-hand part to
the receipt lines' value and to the average cost of average-costed products, the rest to the cost of goods sold, in
one entry against each cost's expense account (where its bill put it), once. A vendor bill with landed-cost lines
makes a draft in one call (`POST /api/v1/stockroom/landed-costs/from-bill/:id`); the split comes from
`GET /api/v1/stockroom/landed-costs/:id/preview`. Products have a **Weight (kg)** and a **Volume (m³)** for the
splits (and the Shop's delivery fees).

### Returns (`modules/stock`, with the order and valuation bridges, RFC 0030)

A done delivery or receipt has **Return**: each line with what was done and what can still come back (returns in
progress count, so nothing is returned twice), a quantity for each, a **reason** (Stockroom › Configuration › Return
reasons: damaged, wrong item, not as ordered, surplus, quality to start with) and a note. The return is a transfer
the other way — a customer's goods back in, goods back to the vendor — linked to the original (*Return of*) and line
by line, carrying the order it belongs to, with the lots taken back from the original's. It is confirmed, and
validated like any transfer. **Stockroom › Returns** lists them; group them by reason, product or partner.

With valuation (`stock_account`) a return moves at the original's cost: goods going back to the vendor leave at
what they came in at (off their own layer with FIFO), a customer's goods come back at what they went out at — not
at today's average. On orders, what came back is subtracted: a sales line's *Delivered* and a purchase line's
*Received* count the returns, and *Returned* shows them (`sale_stock`, `purchase_stock`). **Credit note for returns** on a sales order (`sale_account`) and **Vendor refund for returns** on a purchase order (`purchase_account`) draft the credit note for what came back once it is validated — the returned quantity, as far as it is invoiced beyond what is still delivered (or received), at the line's price — so a return is credited once, whatever the invoicing policy. The routes:
`GET /api/v1/stockroom/pickings/:id/returnable` and `POST /api/v1/stockroom/pickings/:id/return`
(`{ lines: [{ move, quantity }], reason, note?, location? }`), for Stockroom users.

#### Purchase requests and the line tracker (RFC 0032 §3.4)

Anyone with the *Requester* level asks Purchase for products by a **purchase request** (Purchase › Purchase requests):
the products, how many, by when, a priority and, if known, a preferred vendor; the **estimated amount** (the lines at
the products' cost) is what the approval levels go by. Submitted, the request goes to the requester's **department
head** (Workforce), then to a Purchase manager above an amount; approvers may lower quantities. Buyers see approved
requests, assign themselves to lines and press **Make requests for quotation**: one RFQ per vendor — the vendor the
vendor prices choose for each line (RFC 0030), else the preferred vendor; a line with neither refuses the whole and
says which product —, its lines linked back and priced by the vendor prices. The **line tracker** (Purchase › Request
lines) follows every line through the chain — approved, RFQ made, ordered, done, cancelled — with what was approved,
is on RFQs, ordered and still to buy, filtered by status and by buyer. With Requests (`indent_purchase`), **Ask Purchase
for the shortfall** on an approved indent drafts a purchase request for what the store lacks, its lines linked to the
indent's, for the requester to submit.

**RFQs to vendors** (Purchase › RFQs to vendors): the same lines asked of several vendors by a response deadline —
local or import, with the delivery date, payment terms and whether a technical comparison comes first. **Ask several
vendors** on an approved purchase request makes one from what is left to buy. Sending it makes a **vendor response**
per vendor and emails each a **quote link** (single use until submitted, valid a day past the deadline, only its
digest kept): a page where the vendor prices the lines, gives a delivery date and terms, saves and comes back, then
submits once — audited with their address; a buyer may make a new link (`POST /api/v1/purchase/responses/:id/link`)
to paste or email, or type the quotation in. A submitted response moves the RFQ to *Responses received*; the request
line tracker counts the lines on an RFQ. The Purchase overview counts RFQs waiting and with responses.

**Comparative statements** (Purchase › Comparative statements): **Fill from the RFQ** fills the workspace —
every line against every vendor who quoted, with the CS quantity, the quote, two negotiation rounds (each sets the
final price), the final price and the total; the **lowest** final price of each line is marked. The buyer selects
the lines to award (to one vendor, or several when the statement allows it), submits it through the approval engine
(a Purchase manager, the director above an amount) and **confirms** it: one purchase order per selected vendor at the
final prices, linked to the request lines, and the RFQ is *ordered*. When the RFQ asks for a **technical comparison
first**, an engineer scores every vendor who quoted (out of 100, whether they meet the specifications), a Purchase
manager approves it and its confirmation ranks the responses — only then may the financial statement be submitted.

**Orders, agreements, work acceptance, vendor requests.** A purchase order carries its **PO type** (general, service,
capital), **sourcing** (local or import), the **advance** agreed and the **agreement** it draws on; with Stockroom,
the vendor's on-time delivery rate stands beside the expected arrival; with budgets, **Check budget** says where the
order stands before it is submitted; with stock valuation, an **estimated landed cost** and the estimated total cost.
An **agreement** (Purchase › Agreements: a blanket order or framework contract) fixes a vendor's prices and
quantities for a period: orders that name it take its prices (the line says so), and submitting one beyond its dates,
products or quantities is refused. A **work acceptance** (Purchase › Work acceptance) is drawn from an order's service
lines; once accepted, the service is billed up to what was accepted. A **vendor request** (Purchase › Vendor requests)
asks for a new vendor — name, address, NID, trade licence, proprietor — and, approved by a Purchase manager, makes the
contact marked as a vendor; until then nobody can order from them.

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
days by the person's working calendar (Working time: holidays are not charged), keeps to the year's balance, never overlaps, and is decided by
the line manager (`POST /api/v1/workforce/leaves/:id/decide`) or HR — never by the person asking. Personal details
and wages are for HR managers only. Install it with `shutro-erp apps install hr`.

For groups of companies (RFC 0032 §3.2, after Paragon's `pg_employee`), the employee also has a job title, a work
mobile, tags, a **unit head** beside the line manager, a coach, the **property** (mill, farm, depot) they work for,
an **expense approver** — who approves their expense reports first (Spend's level *Approver* asks for it, the Spend
approvers standing in when it is empty) — and a **leave approver**, who then decides their leave instead of the line
manager (HR managers still may), and their time zone. Contracts take an **employment type** (Workforce ›
Configuration › Employment types: name, code, country). In a manifest, `approver: { employee: 'unitHead' }` makes a
level decided by a person on the requester's employee record.

#### The depot's screens (RFC 0032 §3.3)

**My operations** (Stockroom's first menu, `GET /api/v1/stockroom/operations`): a card per warehouse and kind of
transfer — receipts, deliveries, internal moves — with what is **ready** (reserved in full, or a receipt confirmed),
**waiting** (confirmed, not all reserved) and **late** (not done, scheduled before today), counted as the user; each
count opens the transfers it counts. Every transfer carries **additional information** (responsible, carrier,
tracking reference, the lines' weight) and **transport details** at the gate: vehicle, driver and mobile, the
transport vendor and date, gate in / out, the freight bill, additions and deductions to it (unloading, a short
weight), extra products that came along (empty bags, pallets), gate and QC notes. A receipt may **deduct from the
supplier** an amount they bear. With `stock_account`, validating a transfer drafts — once — the transport vendor's
freight bill (the freight with its additions and deductions) and, for such a receipt, a vendor refund to the supplier;
an accountant completes the accounts and posts them.

**Stock ledger** (Stockroom › Stock ledger; `GET /api/v1/stockroom/ledger?from&to&mode&warehouses&categories`): for a
period and the chosen warehouses (or every one), each product's opening quantity, what came in by **movement type**
— purchase receipt, sales return, production, transfer in, adjustment, other — and what went out — sales delivery,
purchase return, production, transfer out, internal use, scrap, adjustment, other —, and the closing; or every
movement of the period. The type comes from where the goods came from and went to (location usages), never typed by
hand; goods in transit count only when their location is chosen. With `stock_account`, people who may read the
valuation see each figure's value (from the valuation layers; a transfer without one at the product's cost). The
**stock report** (`GET /api/v1/stockroom/stock`) lists what the scope holds now per product and location: on hand,
reserved, available, and what confirmed transfers will bring in or take out. Both download as XLSX or PDF (the export
right; audited).

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
production order with the valid bill (with `production`); a rule may be ordered automatically, or snoozed.

**Routes**: a warehouse may receive in two steps (Input, then stock) or three (with Quality control) and deliver in
two (a pick into Output) or three (pick, pack, deliver); each step is a transfer of its own, made or reserved when
the one before it is done. **Putaway rules** say where received products (or categories) go inside a location. A
reorder rule may order **for each delivery** (make to order) — on a transfer, a request for quotation or a
production order — or **dropship**: the vendor delivers to the customer on a dropship transfer, with its own request
for quotation, never through stock.

#### Product groups

A **product group** (Products › Configuration › Product groups) is the company's own way of putting products
together across categories — a brand, a line, a season, what one buyer looks after —, in a tree, with a short
code, a colour and a responsible person. A product (and a template, whose variants inherit it) is in one group;
the product list shows it, searches find products by their group's name, and lists group by it. The group's page
counts its products and opens them. (Requests has its own *product groups* that name approvers by category.)

#### Variants (RFC 0030 step 4)

**Attributes** (Products › Configuration › Attributes: size, colour…, shown as a list, radio buttons, colour
swatches or sizes) have **values** with a colour and an **extra price**. A **product template** (Products › Product
templates) is the family — name, kind, category, unit, sales price and cost, taxes, picture — with the attributes
and the values it offers and the **exclusions** (values that do not go together). **Generate variants** makes one
product per combination, so every app keeps working on products as before: each variant has the template's values,
its own code, barcode, cost and picture, and a sales price of the template's plus its values' extras — unless
**Price from the template** is switched off and it keeps its own. Generating again keeps existing variants (reactivated
and repriced), makes the new combinations and archives the ones no longer offered; nothing is deleted.

On a quotation or a purchase order, **Add variants from a template…** opens the grid (RFC 0030 step 5 part 1):
pick the template, the server lays its variants out as a matrix — the first attributes down, the last across; a
combination that does not exist is an empty cell — type the quantities, and one line is added per variant, priced
by the server as any line (`GET /api/v1/product/templates/{id}/grid`).

On the **Shop**, a variant's card names its family and values, and its page carries the **choosers**: the
template's attributes with the values offered (display, colour, extra price) and every published variant with its
values, price, picture and availability, for the storefront to swap as the visitor picks. At the **Counter**, the
variants of a template fold into one family tile ("from" the lowest price); tapping it opens the chooser and the
variant picked joins the sale (part 2).

### Production (`modules/production`, RFC 0021)

Bills of materials with versions and effective dates, work centres with their cost per hour, and production orders
that list what is required, available and short, and what they will cost, before they start. Confirm reserves the
components through Stockroom; Produce consumes them and puts the product in stock. Install it with
`shutro-erp apps install production`. With Accounting, `production_account` values what is made at what it consumed plus its
operations, and Work in progress clears with each order. Bills may make by-products that carry a share of the
cost; scrap (Stockroom › Scrap) is recorded with its reason, on an order or anywhere. Confirmed orders get their
work orders scheduled at the work centres (Production › Work orders, a Gantt); `GET /api/v1/production/capacity`
gives each centre's load by day.

#### Bills in depth (RFC 0031 step 2)

A bill has a **kind**: *standard* (components in quantities), *formula* (components as **ratios** of the batch adding
up to 100 %, scaled to any quantity) or *packaging* (a pack of the product, with its pack size). Lines carry a
**loss %**, the **net** quantity (what goes in) and the **gross** one (what the order consumes); the bill's **unit
cost** rolls the components (gross) and the operations up. **Specifications** (Production › Configuration ›
Specification parameters, with each product's value) give a formula a range per parameter and show the value its lines
reach, weighted by their shares. **Component eligibility** limits which product categories may be components of each
kind of bill in a company; a refused line says why. Bills have a state — Draft, Under review, Active, Inactive —
with **Submit for review** (components, ratios adding up, specifications within range), approval through the engine,
**Create revision** (a copy as the next version, in draft) and a **costing history** written on activation. Whether
bills must be approved before use is a company setting (Settings › App settings › Production); off, drafts make
products too. Work centres get minimum and maximum batches, setup and cleanup minutes, an OEE target, alternatives
and, with Accounting, an expense account; **shifts** (name, start, end) await the schedules of step 4.

#### Production plans (RFC 0031 step 3)

A **production plan** (Production › Production plans) says what to make in a period: per line a product, its bill,
the quantity, a work centre and a slot (start, end), and the packaging bill of a second stage. **Generate forecast**
explodes every line through every level of its bills — a component with a usable bill of its own is made, not bought
— into **materials** with what is required, on hand in the warehouse, on order (confirmed receipts) and short.
**Procure the shortages** orders each through the warehouse's reorder rule for the product (made when there is none:
make for a product with a usable bill, buy from its preferred vendor price; without either the material says so):
a request for quotation chosen by the vendor prices with Purchase, a production order for a made component; the
material says which document, or why nothing was ordered. Submitting checks **capacity**: a line below or above its
work centre's batch limits, or needing more minutes (setup and cleanup included) than the centre's hours over the
slot, is refused and says why on the line. Approved through the engine, **Schedule the orders** makes one confirmed
production order per line, linked both ways; the **Plan schedule** is a Gantt of the lines by work centre.

#### Schedules and two-stage production (RFC 0031 step 4)

A **batch** (Production › Batches, `production.schedule`) is one run of a product at a work centre in a slot, with a
batch number (`BATCH/2026/00001`), a target, a shift and, for a packed product, the **packaging bill** of its second
stage. **Schedule the orders** on an approved plan splits each line into batches by the work centre's maximum batch
(the slot divided among them). **Check stock** runs the pre-flight — each component's required, available, deficit
and surplus —; **Confirm** makes the *make* order and, with a packaging bill, the *pack* order with the make order as
its **source**. The pack order waits: when the make order produces, its output goes into the lot named after the
batch (a product tracked by lot; the lot expires after the product's **shelf life**), the pack order is confirmed
and its bulk is reserved from that **source lot**. Orders record the stage, **Start** (the actual start), the
produced quantity set before producing, the **consumed** quantity (the bulk for a pack order, the components in the
product's own unit otherwise), the **process loss** and its percentage, and the **yield** against the bill's expected
loss and tolerance; the batch is in progress when an order starts and done when all are. The **Batch label** prints
the batch number, manufacturing and expiry dates and the product's **maximum retail price** with a QR of the batch.

#### Overheads and costing (RFC 0031 step 5, `production_account`)

A **costing master** (Production › Costing masters) on a product or a category, valid between dates, lists
overheads: a fixed amount per order, a percentage of the materials consumed or an amount per unit produced, each
with the **overhead account** it is absorbed into (rate changes are in the audit log). When an order produces, its
overheads are applied once for what it consumed and produced (the lines on the order, **Overhead** and **Full
cost** beside materials and operations), the product is valued at the full cost and the overheads are posted into
Work in progress against their accounts. At month end an **overhead allocation** (Production › Overhead
allocations) works the month out — each account's **actual** (its debits in the month) against what the month's
done orders **absorbed** — and spreads the difference over those orders by produced quantity or by full cost, onto
the stock still on hand (the layers and the average cost) and the cost of what was sold; **Post** books it once and
closes the month: a second allocation for the month is refused.

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

### Requests (`modules/indent`, RFC 0032)

A section asks its store for goods by an **indent**: the store (the company's first warehouse by default), where the
goods are used (an *internal-use* location — Stockroom's shared `Internal use`, or one per section), the date they are
needed, a priority shown as stars, and the products with what the store holds of each. Submitted, it goes through the
approval engine: the requester's **department head**, then the **approvers of the products' groups** (Requests ›
Configuration › Product groups, by product category), with Requests managers standing in when nobody is named; each
level may lower a quantity, never raise it. A store keeper presses **Issue**: one internal transfer from the store to
the internal-use location, reserved like any transfer, validated partly or at once in Stockroom (the rest on a
backorder that stays with the indent); issued goods leave stock and, with `stock_account`, are valued as consumed.
Each line shows what was approved, issued and is still owed; the requester **acknowledges** what arrived. Requesters
see their own indents and those they decide, store keepers every indent of their companies. Install it with
`shutro-erp apps install indent`.

A **transfer** indent asks the store to send stock to another warehouse (*Goes to*: that warehouse's stock location).
**Issue** makes the **Stock Transfer Note** from the store into its **Transit** location (made the first time, held as
the company's stock but not the warehouse's); validating it makes the **Stock Receive Note** from transit to the other
warehouse for exactly what was shipped, reserved on the goods in transit. A partial receipt leaves the rest in transit
on a backorder; **Write off the shortage**, with its reason, takes what never arrived out of transit as an inventory
adjustment (a loss with `stock_account`). Lines show shipped, in transit, received and short; the indent is settled
when everything approved was received or written off.

```ts
// A manifest's approval level whose approvers the record names (RFC 0027): `approvalUsers('groups')` on the model.
{ name: 'Product group approvers', approver: { record: 'groups' }, approverRole: 'indent.manager' }
```

Manifests may now declare levels decided by `'department_head'`, `'department_approvers'` or `{ record: key }`, beside
`'manager'` and `{ field }`.

### Attendance (`modules/attendance`, RFC 0024)

Shifts (night shifts included) and rosters; check-in from the phone inside a site's geofence, at a kiosk by badge or
PIN (set on the employee's form; five wrong PINs lock the person for 15 minutes), from a device file (ZKTeco's log
or a CSV, each punch once), or **from the machines themselves** (see *Attendance machines that push* below); public holidays; and each person's day — worked time with the break deducted, late,
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

**The customer of a sale** is named at the till by what they say: a phone number — matched on its digits,
however it was written down — or an email address. The till finds **one** contact or none, never a list (two
contacts with the same number are not found: a till is no way to browse the customers), and only for people with
a role at the Counter. A customer with a price list of their own sees their prices on the tiles and in the cart:
the till shows what the sale will charge. The next sale starts without a customer.

```http
GET /api/v1/counter/customers?shop=1&q=01711000111   { "customer": { "partner", "name", "note", "ownPrices" } }
GET /api/v1/counter/catalogue?shop=1&partner=42      the catalogue at that customer's prices
```

Another app may know customers another way: it overrides `findCustomer` of `pos.shop` (Loyalty at the Counter
adds the loyalty card's number, and says what the card holds in `note`).

### Live chat (`modules/livechat`, RFC 0034)

A chat your site offers, answered by the people who are there. Install it with `shutro-erp apps install livechat`.

- **Channels** (*Live chat › Configuration › Channels*): a name visitors read, the **operators** who answer it, how
  conversations are given out — **in turn** (to the operator who waited longest for one), **to the least busy**, or
  **taken by hand** —, how many an operator has at once, what visitors read before they write and when nobody is
  there, and after how long a conversation left alone is **missed** (nobody answered) or **closed** (nobody wrote).
- **The chat window** is a page of this server (the channel's *Chat window* address): no sign-in, nothing loaded
  from elsewhere, English or Bangla (`?lang=bn`, or the browser's language), light and dark, keyboard and screen
  reader. Open it from a button of your site. It is **framed by nobody** unless the channel names the sites that
  may (*Sites that may frame it*, one address per line).
- **A conversation is its visitor's by a secret** the server gives once, when it starts; only its hash is kept.
  Without it — or with it on another channel — there is nothing to read. Everything said is kept as text and
  written as text: markup is never run.
- **Who is there**: an operator who switched *Taking conversations* on in *Live chat › Inbox* and whose inbox was
  open in the last minute and a half. A new conversation goes to one of them; when all are at their limit it
  **waits** in the inbox of every operator of the channel until one takes it.
- **Nobody there**: the visitor is asked for an **email**, their message is kept, and the conversation is missed
  when its time is up — with the address to write back to.
- **The inbox**: the conversations that wait and those you are in, the one that is open, your answer, *End the
  conversation*. Only the operator a conversation was given to answers and ends it.
- **Kept**: every conversation with its messages, how long the visitor waited for the first answer, whether an
  operator was there, and the rating (one to five) the visitor gave at the end. *Conversations* lists them; the
  overview shows who waits now, the month, the average wait and rating; a transcript prints from the form.

Operators (`livechat.user`) see the conversations of **their channels** only; managers (`livechat.manager`) see
all and set the channels up. What happened is the server's to write: nobody edits a conversation.

```http
GET  /api/v1/public/livechat/<key>                           { "name", "welcome", "offline", "online" }
GET  /api/v1/public/livechat/<key>/widget                    the chat window
POST /api/v1/public/livechat/<key>/sessions                  { "message", "name"?, "email"?, "page"? }
                                                             → 201 { "secret", "online", "session" }
GET  /api/v1/public/livechat/<key>/sessions/current?after=7  x-chat-secret: …  → state, operator, new messages
POST /api/v1/public/livechat/<key>/sessions/current/messages { "body" }
POST /api/v1/public/livechat/<key>/sessions/current/close    { "rating"? }

GET  /api/v1/livechat/inbox                 operators: also says "I am here"
PUT  /api/v1/livechat/presence              { "available": true }
GET  /api/v1/livechat/sessions/<id>?after=  POST …/take · …/messages { "body" } · …/close
```

A site that draws its own chat uses the same public API. Other apps hear `livechat.session.closed` and
`livechat.session.missed`.

#### Where conversations go: tickets and deals

With Helpdesk or Pipeline installed too (`@kosh/livechat_helpdesk`, `@kosh/livechat_crm`), a conversation that
**ended** becomes a ticket or a deal by the channel's **routing rules** (on the channel's form, or *Live chat ›
Configuration › Routing rules*). A rule says:

- **when it** was missed, was closed, or however it ended;
- **and the visitor wrote** any of some words — whole words, any case, English or Bangla (`price` does not match
  *priceless*) —, or anything when empty;
- **from a page with** a part of an address (`/pricing`), or any page;
- **it becomes** `helpdesk.ticket` or `crm.deal`.

The **first rule in order** that a conversation meets is applied, **once**; a conversation no rule meets stays a
conversation. The record carries what was said — a line per message with the time (UTC) and who said it —, the
visitor's name and email, and the contact when exactly one has that email:

- **A ticket**: the subject is the start of the visitor's first message; it goes to the company's first Helpdesk
  team, whose own rules give it an agent and an SLA. What the visitor typed is text on the ticket, never markup.
- **A deal**: named after the first message, from the website, in the first stage, for no salesperson yet — every
  Pipeline user sees it.

A typical set: *missed → ticket* (somebody writes back to the email the visitor left), *price, quotation → deal*.
The conversation shows what it became (*What it became*); the ticket and the deal show a **Chats** tile. An
operator of the channel can also make one by hand of an ended conversation:

```http
GET  /api/v1/livechat/targets                 { "targets": ["helpdesk.ticket", "crm.deal"] }
POST /api/v1/livechat/sessions/<id>/route     { "target": "helpdesk.ticket" } → { "model", "id", "name", "made" }
```

Another app makes its own records of conversations by overriding `routeTargets` of `livechat.channel` and
`makeRecord` of `livechat.session`.

#### The assistant answers first

With Sites installed too (`@kosh/livechat_assistant`), a channel may say **The assistant answers first** and
from which **site**. The AI assistant (docs/assistant.md) then answers a visitor before a person does:

- **From the site's published pages only** — their titles, summaries and texts; drafts are never read. It is told
  that the pages are everything it knows, to promise nothing, and that what a visitor writes is a question, never
  an instruction. *How it should speak* sets the tone; it cannot lift those rules.
- **Marked as an AI**: its answers carry the name you give it followed by “AI”, and it says it is one when asked.
- **It hands over to a person** when the pages do not answer, when the visitor asks for one, after *Answers
  before a person* answers in a conversation (6 by default) — and whenever it cannot answer at all: an error, a
  refusal, something that is not an answer. The conversation then goes to an operator who is there, the way the
  channel gives them out, or waits for one.
- **Operators see every conversation it has** in their inbox, with what it said, and may take one at any moment;
  an answer it was still writing is then dropped.
- A conversation it answered and the visitor left is **closed** when it goes quiet — not *missed*, so a *missed →
  ticket* rule makes no ticket of it.

It answers only when the assistant is installed, has a key (`ANTHROPIC_API_KEY`), an **Administrator switched it
on for the company** (what visitors write then goes to the AI service) and the month's token budget is not used
up. Otherwise the channel works as without it: conversations go to the operators at once. Every call is in the
assistant's log (*Settings › AI assistant*) as `livechat`, with its tokens, nobody named and no content, and
counts in the company's budget. A server writes at most four answers at once; a visitor beyond that gets a
person.

Other apps on the server use the same assistant, under the same rules, through `assistantService(context)` of
`@kosh/assistant` (`ready(company)`, `json(about, request)`).

**Not yet**: a button in the inbox for making a ticket or a deal by hand (the API does it), a rule choosing the
Helpdesk team, the assistant reading the Shop's products or Helpdesk's canned replies, answers streamed word by
word, typing indicators, files in a conversation, a chat block for Sites pages. The window and the inbox ask the
server every few seconds rather than holding a socket open.

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

## Attendance machines that push

A ZKTeco machine can send each punch to the server by itself, within seconds (the vendor's push protocol, "ADMS").

1. **Reach**: the machine calls `http(s)://<your server>/iclock/…`. Your reverse proxy must route `/iclock/` to the
   server (it is not under `/api`), on an address and port the machines can reach.
2. **On the machine**: *Menu › Comm › Cloud Server Setting* — the server's address and port (and *Enable Domain
   Name* / *HTTPS* where its firmware has them).
3. **In Attendance › Configuration › Devices**: add the machine by its **serial number** (*Menu › System info*), name
   it, choose its site, status *Active*. Or let it knock first: an unregistered machine is listed as *Waiting for
   approval* with its serial number and address — open it, name it, set it *Active*.
4. **People**: each employee's *Device user ID* (their number on the machine), as for device files.

From then on: *Device punches* lists every line received with what became of it — *Counted*, *Second tap* (within a
minute), *Unpaired* (a check-in never closed within sixteen hours), *Unknown person* (set the employee's Device user
ID; the punches are taken at the device's next punch), *Day already approved* (approved days are never changed). A
machine that was offline sends its backlog later, in any order: the days come out the same.

**Safety.** The protocol has no password — a machine is its serial number. So: only registered, active machines are
heard; set *Only from addresses* to the site's public address where it has one; use https where the firmware
supports it, or a VPN from the site. A machine can only add punches of people who exist; it reads nothing.

Tested with a simulated machine; **try your own model on a test server first** — firmware versions differ.

## Official tours

A person sent away on the company's business asks for a **tour** in *Workforce › Tours*: the dates, where to, the
purpose, how they travel and the advance they need. It is numbered (`TOUR/2026/0001`) and shows its working days by
the person's working calendar.

- **Who decides**: the person's leave approver; when they have none, their manager; or an HR manager. Never the
  traveller — HR managers do not decide their own. *Refuse* and *Cancel the tour* need the *note of the decision*
  first; write it, then press the button.
- A tour may not overlap another tour or an approved leave of the same person.
- **In Attendance**, a working day inside an approved tour without a punch is **On tour** — not absent. Weekends and
  holidays inside the tour stay what they are; a day with punches is computed from them. Compute the period's days
  after approving tours, as you do after approving leave.
- **In Payroll**, `PRESENT_DAYS` includes the days on tour; `TOUR_DAYS` is their number, for a rule that pays a daily
  allowance on the payslip (`TOUR_DAYS * 500`).
- **With Spend**: a tour that asks for an advance drafts the **cash advance** for the traveller when it is approved,
  once; they submit it and it is approved and paid like any advance. An expense report may name its tour (*For the
  tour*, an approved tour of the same person); the tour's form shows what was **Advanced** and **Claimed**.
- Print *Tour order* from the form; `hr.tour.approved` is an event automations and webhooks can listen to.

## Repeating events (Agenda)

*Agenda › Repeating events*: a meeting that happens again by a rule. Fill in the first meeting (title, start, end,
who is invited, the room), then how it repeats:

| | |
| --- | --- |
| *Repeats every* / *Every* | every 1 week, every 2 weeks, every 3 months… |
| *On these days* | for a series by week: the weekdays (none ticked: the first meeting's weekday) |
| *In the month, on* | the same day (the 31st becomes the month's last day); the same weekday (*the second Tuesday*); the last such weekday (*the last Friday*); **the first / the last working day** |
| *On a weekend or a holiday* | keep it that day, skip it, or move it to the working day before or after — by the company's working calendar (Working time) |
| *Ends* | after a number of times, or on a date; one of the two is needed, at most 366 occurrences |

The form says the rule back in words (*Every 2 weeks on Tuesday and Thursday, 10 times*). **Generate** makes the
occurrences: each is an ordinary event — it holds the room, has its own attendees and answers, and can be moved or
cancelled alone. If the room is taken on one of the dates, nothing is generated and the date is named.

Changing the series and pressing **Generate** again redoes the occurrences still to come. It never rewrites the
past, an occurrence you ticked *Keep as it is*, or one you moved to another time yourself. **Stop the series** removes
the occurrences still to come (not the ones you kept or moved).

## Invitations and calendar addresses (Agenda)

**Send invitations** (on an event, by its organizer): each attendee with an email address — people of the company
and contacts — gets the meeting by email with an `invite.ics` their mail client and calendar read. After you change
the time or the place, press it again: they get an *Updated invitation* that replaces the event they have.
Cancelling an event that was sent emails the cancellation to those who were invited. Nothing is emailed by saving.

- Email must be configured (`SMTP_URL`, `MAIL_FROM`); without it the button does nothing but note the time.
- An answer given in the mail client goes to the organizer's mailbox, not into Agenda. People of the company
  answer in Agenda.
- To invite people to a repeating event, send its occurrences, or share a calendar address.

**My calendar address** (*Agenda › My calendar address › New*, then Save): a secret link to paste into Google
Calendar (*Other calendars › From URL*), Outlook (*Add calendar › Subscribe from web*) or a phone. It shows the events
you organize or attend (not the ones you declined), from a month back to about a year ahead; the other calendar
refreshes it on its own schedule (often every few hours). Anyone who has the link reads those events: do not share
it. Delete it to close it — a new one has a new secret. `KOSH_BASE_URL` must be the address your server is reached
at, as the link is built from it.

## Subscriptions

The **Subscriptions** app (`@kosh/subscription`, RFC 0034 §2.5) bills a customer again and again without anyone
remembering to. It needs Accounting, Products and Contacts; its invoices are ordinary customer invoices, so
sending, follow-ups, payments and the portal work as for any invoice.

- **Plans** (Subscriptions › Configuration › Plans): bills every *n* days, weeks, months or years; a **trial** in
  days before the first invoice; *Post the invoices* — off, each invoice is a draft for a person to check.
- **A subscription**: a customer, a plan, a start day, a price list and payment terms if wanted, and its lines.
  A line is billed **every period** (a quantity) or **by usage** (what was recorded since the last invoice). Its
  price is the one typed in, else the price list's, else the product's list price; a discount in percent; the
  product's sales taxes unless others are chosen.
- **Start** needs at least one line. **Pause** stops the invoices; **Resume** starts them again — a period that fell
  due during the pause is not billed afterwards: billing starts again on the day it is resumed. **Close** needs the
  reason the customer left, and is for good.
- **Invoices make themselves**: every hour a running server invoices each subscription whose next invoice date has
  come, **one invoice per subscription and period** — two servers, a retry or a crash in the middle make no second
  one. A subscription left behind (a server that was down) catches up, up to twelve periods at once. Monthly
  periods keep the day they started on: started on the 31st, it bills on 28 February and on 31 March again.
  A manager may also run what is due now: `POST /api/v1/subscriptions/run`.
- **Usage** (Subscriptions › Usage, the import screen, or the API): so many units on a day against a line billed
  by usage. Each record goes on the next invoice once, and cannot be changed after that.
- **Apply changes**: when the lines of a running subscription change in the middle of a period already invoiced,
  the difference is invoiced — or credited with a credit note — for the days left in that period, to the paisa.
  Without it, the change simply counts from the next invoice.
- **What it is worth**: *Per period* and **MRR** (the amount brought to a month: a yearly 12 000 is 1 000 a month;
  nothing while it is not running) on each subscription. The overview shows MRR, running subscriptions, started
  and closed this month, MRR by plan, why customers left, and the largest; the **cohort** view shows retention by
  the month they started.

Roles: **User** makes subscriptions and records usage (and reads invoices); **Manager** also keeps the plans and
runs what is due. The billing dates, the periods invoiced and what each line was billed are the server's: nobody
but an Administrator can write them through the API.

```ts
import { invoiceDue, invoiceSubscription, applyChanges } from '@kosh/subscription';

await invoiceDue(env); // every running subscription of the company that is due today
await invoiceSubscription(env, id); // one subscription, every period that is due
await applyChanges(env, id); // invoice or credit a change for the days left
```

Another app feeds usage by creating `subscription.usage` records (`line`, `date`, `quantity`, `note`).
**Not yet**: usage fed by Counter sales or timesheets through bridges, card payments taken by themselves at each
invoice, upgrades chosen by the customer in the portal.

## Projects billed to customers

`@kosh/project_billing` (RFC 0034 §2.5) is proposed whenever Projects and Accounting are installed. It turns the
hours people log into invoices the customer can check, without anyone retyping them.

- **Rate cards** (Projects › Configuration › Rate cards): what an hour is sold for. A line names a person, a role,
  a kind of task, or several of them; **the most specific line wins** — a person before a role, a role before a
  kind of task — and the card has a rate for everyone else. A senior consultant at 3 000, Rafi at 4 000 whatever
  his role, travel at 500 for those nobody names.
- **On the project** (the *Money* group): *Billed to the customer*, its rate card, and the service it is invoiced
  as (the income account and the sales taxes come from that product).
- **Approval**. A timesheet line is *To submit*, *Submitted*, *Approved* or *Refused*. Its author submits it; a
  Projects manager approves or refuses it — **never their own**, and a refusal says why. Submitted and approved
  hours do not change and are not deleted: they are reopened first (approved ones by a manager). On approval the
  rate is taken from the card **and frozen on the hour**: a dearer card tomorrow does not move what was approved.
  On a billed project an hour without a rate is not approved; switch off *Billable* for time the customer does not
  pay for.
- **Billing milestones** (Projects › Billing › Billing milestones): a fixed price for something delivered, beside
  the hours or instead of them. *Reached* puts it on the next statement; with a task, not before the task is done.
- **Billing statements** (Projects › Billing, or *New billing statement* on a project): choose the day up to which
  hours count and press **Make the invoice**. The statement gathers the project's approved billable hours up to
  that day and its reached milestones, and makes **one draft customer invoice** — a line per person and rate with
  the days it covers, a line per milestone — on the project's cost centre. The statement prints with every hour
  behind the invoice. **Each hour and milestone is invoiced once**: a second statement for the same days finds
  nothing. A statement is **released** only after its invoice was cancelled; its hours can then be invoiced again.

Roles: people who log time submit their own hours and do not see rates; **Projects managers** approve hours, mark
milestones reached and read statements; **Project billing** keeps rate cards and milestones and makes statements
(it includes Projects manager and invoicing). The rate, the amount, who approved and the statement of an hour are
the server's: they cannot be written through the API.

```ts
import { rateFor } from '@kosh/project_billing';

rateFor(lines, { user, role, category }, card.defaultRate); // { rate: '3000.00', source: 'role' } | null
```

### What a project earned

On every refresh of a project's figures (hourly, and *Refresh* on the project), the *Money* group also shows, to
Projects managers:

| Figure | What it is |
| --- | --- |
| **Invoiced revenue** | the income of posted customer invoices and credit notes on the project's cost centre, from the books |
| **Work in progress** | approved billable hours and reached milestones that are on no **posted** invoice yet, at what they sell for |
| **Profit** | invoiced revenue and work in progress, less labour (timesheets at each person's cost) and the costs booked on the cost centre — bills, expenses, production |
| **Margin %** | profit as a share of invoiced revenue and work in progress |

Each **phase** (Projects › Phases) shows its labour cost, what it earned — the approved billable hours on its
tasks and the milestones tied to them — and the difference. Costs booked in Accounting belong to the project, not
to a phase.

### Revenue recognition

At a month's end, work that is done and approved but not invoiced yet is revenue of that month. *Projects ›
Billing › Revenue recognition*: choose the day and press **Recognise**. For every billed project, its work in
progress on that day is booked in one entry — debit *1180 Accrued income*, credit the sales journal's income
account **on the project's cost centre** — and **reversed the day after**, so the invoices that follow are not
counted twice. The recognition lists each project with its hours and amounts and prints. One recognition a day
per company; a posted one does not change. The entries are in the *Revenue recognition* journal (`REVR`).

A posted recognition cannot be cancelled from here: it has already reversed itself, and a wrong one is corrected
in Accounting like any entry. Fixed-price work is recognised when a milestone is reached, not by percentage of
completion.

```ts
import { unbilledOf, postRecognition } from '@kosh/project_billing';

await unbilledOf(env, projectId, '2027-02-28'); // { hours, time, milestones }
```

## Leave accruals

`@kosh/hr_accrual` (RFC 0034 §2.5) is proposed whenever Workforce and Payroll are installed. Without it, a leave
type gives so many days a calendar year. With it, a leave type can have an **accrual plan**: its days are earned
month by month, by a formula. Give people the **Leave balances** role to see its screens.

- **A plan** (Workforce › Configuration › Accrual plans) belongs to one leave type; a type has one active plan.
  *Days a month* is a formula in Payroll's formula language — numbers, `+ - * /`, `min`, `max`,
  `round`, `if(…)` — evaluated for each person and month:

  | Formula | What it gives |
  | --- | --- |
  | `10 / 12` | ten days a year, in twelve parts |
  | `WORKED_DAYS / 18` | a day for every eighteen days worked |
  | `if(SERVICE_YEARS >= 5, 2, 1.5)` | more after five years |
  | `if(MONTH == 1, 10, 0)` | ten days every January |

  It may read `SERVICE_MONTHS`, `SERVICE_YEARS` (full, at the month's end), `WORKED_DAYS` (approved attendance
  days present or on tour), `WORKING_DAYS` (by the person's working calendar), `MONTH` and `BALANCE`. A formula
  that does not read is refused when the plan is saved.
- **Limits**: *Probation* — nothing accrues before so many full months of service; *Never above* — the balance
  stops accruing at the cap, and accrues again when leave makes room; *Carried into a new year* — what is above
  it on 1 January is lost (empty: everything is carried, 0: nothing); *Carried days expire after month* — carried
  days are used first, and those not used by the end of that month are lost.
- **The run**: every six hours a running server writes each person's months that are over to the **leave ledger**
  (Workforce › Leave ledger) — once: the balance remembers the last month accrued, so a second server or a second
  run adds nothing. A person needs a joining date; they accrue from the month they joined or the plan's first
  month, whichever is later. `POST /api/v1/leave-accruals/run` does it now (HR managers).
- **The ledger** holds every day earned, lost at a year's start, expired, or given. HR managers add
  **adjustments** — an opening balance from the old system, days given, a correction (the import screen takes a
  whole sheet of them). A line is never changed or deleted: a mistake is corrected by another line.
- **Balances** (Workforce › Leave balances; each person their own, managers their team's, HR everyone's):
  the balance now, what is available after leave already asked for, accrued and taken this year, **the balance
  on 31 December**, and carried days that will expire with their date.
- **Asking for leave**: a leave of a type with a plan is checked against the balance **on the day it starts** —
  what will have accrued by then counts, and so does every other leave waiting or approved. The type's days per
  year no longer apply.
- **Any date**: `GET /api/v1/leave-accruals/projection?employee=&type=&date=` returns the balance on that day and
  the months that lead to it (accrued, taken, lost), with the carried days about to expire. Months to come assume
  the person's working days are worked.

```ts
import { accrueLeave, projectLeave } from '@kosh/hr_accrual';

await accrueLeave(env); // the company's months that are over, once
await projectLeave(env, employeeId, leaveTypeId, '2027-12-31'); // { balance: '2.50', steps, expiring }
```

### Paying days out

A plan may let people be **paid for days they did not take** (*Paying days out* on the plan):

- *Days that stay* — a payout never takes the balance below this.
- *A day is worth* — a formula: `WAGE / 30`, `WAGE * 0.6 / 26`. It may read `WAGE` (the monthly wage of the
  running contract), `DAYS`, `BALANCE` and `SERVICE_YEARS`.
- *Payroll input* — the code the amount reaches Payroll under (`LEAVE_ENCASH`).

The person asks (Workforce › Leave payouts: the plan, the days, the month it is paid in) and submits; an **HR
manager approves — never their own** — or refuses with a reason. Approving checks the balance **on that day**,
values a day on the person's running contract, takes the days from the ledger (*Paid out*) and leaves the amount
as a **Payroll input of that month**. The month's payroll run pays it, through a rule of the person's salary
structure that reads the input:

| Code | Category | Formula |
| --- | --- | --- |
| `LEAVE_ENCASH` | Allowance | `INPUT_LEAVE_ENCASH` |

Approval is refused, in words, when the plan does not pay days out, the days are more than may be paid, the person
has no running contract with a wage, or their structure has no such rule. An approved payout does not change; a
mistake is corrected by an adjustment in the ledger and by the payroll officer on the input.

### Bangladesh

With Bangladesh payroll (`l10n_bd_payroll`) both structures have the `LEAVE_ENCASH` rule — taxed in the month
it is paid, not projected over the year — and each company gets three plans, **switched off**, for HR to check
against the Labour Act 2006 (sections 115 to 117), the Labour Rules 2015 and the company's own rules, then
activate (Workforce › Configuration › Accrual plans, filter *Archived*):

| Leave | Plan | Carried | Paid out |
| --- | --- | --- | --- |
| Casual | 10 days each January: `if(MONTH == 1, 10, 0)` | no | no |
| Sick | 14 days each January: `if(MONTH == 1, 14, 0)` | no | no |
| Earned | a day for 18 worked, after a year: `WORKED_DAYS / 18` | up to 40 days | yes, `WAGE / 30` a day |

Until a plan is switched on, its leave type keeps its days per year. Someone who joins after January is given
their share of casual and sick leave as an adjustment.

## Surveys

The **Surveys** app (`@kosh/survey`, RFC 0034 §2.6) is one engine for every questionnaire: customer feedback, a
screening before an interview, an event's evaluation, a qualification form. Odoo has a survey app; this one adds
anonymity that is kept by the server, scores against what each respondent was actually asked, and NPS and CSAT
without a spreadsheet.

- **Questions** (written on the survey while it is a draft): a line of text, a paragraph, a number, yes or no,
  one of several choices, several choices, a rating in stars (2 to 10), the 0-to-10 *would you recommend us*
  question, a date. Each may be required.
- **Logic**: a question may be *asked only when* an earlier question's answer *is*, *is not*, *is more than*,
  *is less than* a value, or *is answered*. A choice is named by its label. A question that is not asked hides the
  ones that wait for it, and takes no answer — whatever was sent for it is dropped.
- **Points**: a choice has points (below zero takes away); a rating or a recommendation scores its value times
  *points per step*. A response's score is counted **against what the questions it was asked could give**, so a
  short path through the survey is not a low score. With a *pass mark %*, a response passes or does not.
- **Who answers**: *anyone with the link* — one address, any number of times — or *invited people only*: each
  invitation (Surveys › Invitations) has a link of its own, **good once**.
- **Anonymous**: nothing that names the respondent is kept — no name, email, contact or invitation on the
  response; the invitation is only marked as answered.
- **Open, close**: a survey opens only when it holds together (a question, choices where they are needed, every
  condition on an earlier question and a value it can have). Open, its questions do not change; with responses it
  cannot go back to draft — duplicate it. Closed, it takes no answers.
- **Results**: each response with its answers, score and outcome; on the survey the number of responses, the
  average score, **NPS** (promoters 9–10 less detractors 0–6, in percent) and **CSAT** (the share of ratings in
  the top two fifths of their scale); Surveys › Answers counts every question's answers.

### The public page

`/api/v1/public/surveys/<key>/page` is one self-contained document: no sign-in, no framework, nothing loaded from
elsewhere, a strict content security policy, never cached or framed. It works with a keyboard and a screen
reader, in light and dark, on a phone, in English or Bangla (`?lang=bn`, or the browser's language). It shows and
hides questions as they are answered; **the server reviews every answer again** and returns each problem with its
question.

A site that draws its own form uses the data instead:

```http
GET  /api/v1/public/surveys/<key>          the questions as they are asked — never the points
POST /api/v1/public/surveys/<key>          { "answers": { "<question id>": 9, … }, "name": "…", "email": "…" }
     201 { "thanks": "…" }    422 { "errors": [{ "question": 12, "title": "…", "problem": "needs an answer" }] }
     404 unknown key          410 closed, or an invitation already used
GET  /api/v1/surveys/<id>/results          signed in: every question with its count, average, NPS / CSAT, choices
```

```ts
import { review, nps, csat } from '@kosh/survey';

review(questions, { 1: 3, 2: 'Late' }); // { answers, errors, score, maxScore } — the engine, without a database
```

Roles: **User** invites people and reads responses and results; **Manager** writes surveys.
An invitation may say what record it is about (`resModel`, `resId`); the response carries it, for the apps that
ask on behalf of a ticket, an applicant or a registration.

### Invitations by email

An invitation with an email address is **emailed once** — when it is made, or when its survey opens if it was
made while the survey was a draft: the survey's name and introduction, and a button to the person's own link, in
English or Bangla (the invitation's language, which is also the page's). It needs a mailer and the server's
public address (`KOSH_BASE_URL`); without them the links are still there to copy, and the emails go out once both
are set.

### Asking by itself

*Surveys › Automatic invitations* is one rule for every app: **when** something happens, **who** is concerned,
and optionally **an answer written back** on the record.

| To ask… | When | For each of | Only when | Name / email in |
| --- | --- | --- | --- | --- |
| a customer after their ticket is solved | `helpdesk.ticket.solved` | | | `subject` / `email`, contact in `partner` |
| those who came to an event | `event.event.ended` | `registrations` | `state` is `attended` | `name` / `email`, language in `lang` |
| every new applicant (a screening) | `hiring.applicant.created` | | | `name` / `email` |
| the customer of a new deal (a qualification) | `crm.deal.created` | | | `name` / `email`, contact in `partner` |

*When* is a named event of an installed app, or any model followed by `.created`;
`GET /api/v1/surveys/events` lists the events on offer. Each person is asked **once per survey and record**; the
invitation and the response say what they are about, so the answers can be read beside the ticket, the applicant
or the registration. A rule that does not hold together — an unknown event, a field that is not on the record —
is refused when it is saved; one that fails later says why in *Last problem*. Surveys does not wait for its own
events.

**An answer on the record**: choose a rating, a recommendation or a number question and a number field of the
record. For Helpdesk: the survey's five-star question into `rating` — the ticket's rating, and Helpdesk's own
satisfaction figures, then come from the survey. Switch off *Ask for a rating* on the team, so the customer gets
one email and not two. Nothing is written back from an anonymous survey.

## The careers page

`@kosh/website_hiring` (RFC 0034 §2.6) is proposed whenever Sites and Hiring are installed. Give people the
**Careers page** role to see its fields.

- **On an opening**: *On the careers page*, the place of work, the employment as candidates should read it, and
  *Applications until*. An opening is shown while it is published, open, and not past that date.
- **The site** reads the openings and takes applications without a sign-in:

  ```http
  GET  /api/v1/public/sites/<site>/careers          { "site": "…", "openings": [{ "id", "name", "department",
                                                    "location", "employment", "closingDate", "description" }] }
  GET  /api/v1/public/sites/<site>/careers/<id>     one of them (404 when it is not shown)
  POST /api/v1/public/sites/<site>/careers/<id>/apply
       { "name": "…", "email": "…", "phone": "…", "cover": "…",
         "cv": { "name": "CV", "mediaType": "application/pdf", "data": "<base64>" } }
       201 { "message": "Thank you — your application is in." }
       422 a name and an email address are needed; the CV is a PDF, a Word or OpenDocument text or plain text,
           at most 5 MB        409 this address already applied for this opening        410 not taking applications
  ```

  Only what a candidate should read leaves the server — never the hiring manager, the headcount or the other
  applicants.
- **An application** is an applicant like any other: from the *Website*, in the first stage, with the letter on
  the record and the CV among its attachments. One per email address and opening. A form field named `website`
  that no person fills marks a robot: it is thanked, and nothing is kept.
- **Emails to candidates**: give a stage an *Email subject* and an *Email text* (Hiring › Configuration ›
  Stages) and every candidate who reaches it is emailed **once** — also the first stage, as "we received your
  application" — and again if they come back to it after another stage. The text may use `{{name}}`,
  `{{opening}}` and `{{company}}`; empty lines separate paragraphs. Refused candidates are not emailed. It needs
  a mailer.

To screen applicants, add an automatic invitation in Surveys on `hiring.applicant.created`.

**Not yet**: the CV read by the assistant on an applicant that already exists (the assistant fills a *new*
applicant from a CV: Applicants › Fill from a document), a careers page drawn by Sites itself (the site's
front end draws it from this API), one email per language.

## Loyalty

The **Loyalty** app (`@kosh/loyalty`, RFC 0034 §2.6) gives customers points for what they buy. It needs Sales;
orders of the Shop are Sales orders, so they earn too.

- **A program** (Loyalty › Programs): what a point is worth, whether every customer joins with their first
  confirmed order or only those given a card, how many months tiers count, and after how many months unused
  points expire. One program runs at a time.
- **Earning rules**: *so many points for every so much*, before taxes and after discounts — on the whole order, or
  on the lines of one product or one category; from a minimum order; between dates, for a campaign. Every rule
  that applies gives its points: a point for every 100 and three more for every 100 of drinks is two rules.
- **Tiers**: points earned in the program's window put a customer in a tier, and the tier multiplies what their
  next orders earn (Gold: × 1.5), rounded down.
- **Preview before it runs**: on a draft, **Preview** runs the rules over the confirmed orders of a past period —
  the month before this one unless you give dates — and writes on the program how many orders would have earned,
  the points, **what they are worth** at the value of a point, and **that as a share of the sales**. Nothing is
  earned by looking, and no card is made. Tiers are left out: nobody has one before the program starts. To try
  other rules, duplicate the program.
- **Earning**: once the program is launched, an order earns when it is **confirmed** — once, however often the
  event is delivered — on the customer's card, and the points are on the order. A **cancelled** order gives them
  back, once. An order worth less than a rule's step, or a return, earns nothing.
- **Cards and the ledger** (Loyalty › Cards, Points): each card has its number, its balance, what it earned lately
  and its tier, and every movement: earned, taken back, expired, adjustment. Managers add **adjustments** — opening
  points from an old scheme (the import screen takes a sheet), a gift, a correction; a card never goes below zero
  by hand, and a line is never changed or deleted.
- **Expiry**: once a day a running server writes off, on each card, the points that are older than the program
  allows and that nothing has used — the oldest points count as spent first. Once: the line itself makes the next
  day's answer zero. `POST /api/v1/loyalty/age` does it now (managers).
- An ended program gives nothing more; cards keep their points.

Roles: **User** reads cards and gives a customer a card; **Manager** writes programs and adjustments.

```ts
import { earn, preview, tierOf, expiredPoints } from '@kosh/loyalty';

earn(rules, { date: '2027-03-10', lines }, tier); // { points, byRule, multiplier } — the engine, no database
```

### Spending points, wallets and gift cards

On a **quotation** (Sales › an order, while it is a draft): type *Points to spend* and / or the code of a *Gift
card or wallet*, and press **Apply points and credit**.

- **Points** come off at the value of a point, as a line below zero — after taxes, like a payment. No more than the
  card holds, nor than the share of the order the program lets points pay (*Points pay at most %*), and not fewer
  than *Spent from*. What cannot be taken is refused in words: *Only 250 point(s) can be spent on this order…*
- **A gift card or a wallet** (Loyalty › Wallets and gift cards) pays what the order still comes to, or all it
  holds. A **gift card** pays for whoever has its code; a **wallet** only for its customer. Each has a code the
  server makes, an optional last day, and its own ledger: a manager **loads** it with a line; orders write the rest.
- **Held at once**: the points leave the card and the money leaves the gift card when they are applied, so two
  quotations cannot spend the same balance. Pressing the button again after a change gives back what was held
  first — never both. A **cancelled** order gives everything back, once.
- A confirmed order **earns on what is left to pay**: points spent are not earned again.

```ts
import { redeemLimit, voucherUse } from '@kosh/loyalty';

redeemLimit({ balance: 300, pointValue: 200, orderTotal: 100_000, maxPercent: 50 }); // { points: 250, amount: 50_000 }
```

### Promotions and *buy X get Y*

A **promotion** (Loyalty › Promotions) takes something off an order by itself — no card, no points:

| Gives | What it does |
| --- | --- |
| *A percentage off* | its share of the whole order, or of the lines of one product or category |
| *An amount off* | so much off, never more than what it applies to is worth |
| *Buy some, get some free* | of every *Buy* + *Get* units of what it applies to, the **cheapest** *Get* are free; with a *Free product*, *Get* units of it for every *Buy* bought, as many as are on the order |

Each may ask for a **minimum order**, run **between dates**, and need a **code** typed on the order.

- **Preview before it runs**: on a draft, **Preview** runs it over the confirmed orders of a past period and writes
  how many it would have applied to, **what it would have taken off**, **that as a share of the sales**, and the
  units given free. A promotion with a code is counted as if every customer had typed it — the most it can cost.
  No order is touched.
- **On a quotation**: **Apply promotions** takes every running promotion that applies, each as a line below zero
  with its name. Pressed again, they are worked out anew — never twice.
- **Together or alone**: promotions add up. One marked *Not with other promotions* is taken **alone** when that
  gives the customer more than the others together; otherwise it is left out. What is taken off never passes what
  the goods are worth.
- **With points and gift cards**: promotions come first. If points or a gift card were already applied, pressing
  Apply promotions works them out again on what the order now comes to.
- A wrong code is refused in words. Ended promotions leave the orders that took them as they are.

```ts
import { applyPromotions, discountOf, previewPromotion } from '@kosh/loyalty';

applyPromotions(promotions, { date: '2027-03-10', code: 'EID27', lines }); // [{ promotion, amount, freeUnits }]
```

### In the Shop

With the Shop installed too (`@kosh/website_sale_loyalty`), a visitor's cart takes part:

- **Promotions go on every cart by themselves**, each time the shop prices it — a line added, the delivery
  method, the coupon, the address at checkout — and follow it: never twice. The cart's `discount` includes them;
  they are not among its goods.
- **A promotion code** and **a gift card** are typed. What does not work is refused in words, and the cart is left
  as it was. A gift card pays what the cart comes to, **delivery included**, or all it holds, and is worked out
  again whenever the cart changes — what it held is given back first.
- **A code that stops working** while the cart is open — its promotion ended, the card expired — is taken off the
  cart at its next change, rather than breaking it; what was held goes back.
- **The placed order earns points** for its customer like any confirmed order, on the goods as paid — not on the
  delivery fee. The Shop's own coupons stay, beside the promotions.

```http
PUT /api/v1/public/shop/<site>/cart/promotion   { "code": "EID27" }   the cart, with `loyalty`; "" takes it off
PUT /api/v1/public/shop/<site>/cart/gift-card   { "code": "GC-…" }    the cart, with what the card paid
GET /api/v1/public/shop/<site>/cart/loyalty     { "promotions": [{ "name", "amount" }], "promoCode",
                                                  "giftCard", "giftCardPaid" }
```

Spending **points** needs a signed-in customer, which the Shop does not have: points are spent on Sales orders.

### At the Counter

With the Counter installed too (`@kosh/pos_loyalty`):

- **The card names the customer.** The cashier types the loyalty card's number — or the phone number, the email
  address — and the till shows the customer with the card, its points and its tier.
- **A paid sale with a customer earns points**, on what it came to before taxes, by the same rules and tiers as
  a Sales order — **once**, however often the device sends the sale, and also for a sale rung up offline and
  sent later. A sale nobody is named on earns nothing. The sale shows its points (*Loyalty points*).
- **Goods that come back give points back**: a refund takes the share of the sale's points that everything
  returned from it so far is of it — all of them once everything is back —, never more than the sale earned and
  never more than the card holds.

**Not yet at the Counter**: spending points, promotions and gift cards at the till (a sale made offline cannot
ask the server what a code is worth, and a gift card is a way to pay that the session's entry must book).

**Not yet**: gift cards sold as a product, points, credit and promotions on a quotation already sent,
a discount that lowers the tax of the order — promotion lines, like the Shop's amount coupons, come off without
tax.
