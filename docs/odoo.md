# Leaving Odoo

`shutro-erp odoo import` reads a live Odoo (16 to 18) through its external API and imports its records into Shutro
ERP, each keeping its Odoo id, with a report that accounts for every record read (RFC 0034 §2.3). Nothing is
installed in Odoo and nothing is ever written to it.

## Run it

1. In Odoo, create a user who can read what is imported (or use an administrator), and give it an **API key**
   (Preferences › Account Security › New API Key). Put the key in the installation's `.env`:

   ```sh
   ODOO_PASSWORD=<the API key>
   ```

   Never on the command line: it would stay in the shell's history.

2. A dry run — everything is imported and rolled back, and the report says what would happen:

   ```sh
   shutro-erp odoo import --url https://odoo.example.com --db production --login migration@example.com
   ```

3. Fix what the report lists as failed — in Odoo (a record missing a value) or in Shutro ERP (a setting) — and run
   the dry run again until every step is ✔.

4. Import:

   ```sh
   shutro-erp odoo import --url https://odoo.example.com --db production --login migration@example.com --commit
   ```

`--company <id>` chooses the company the records belong to (default: the first); `--report <file>` where the JSON
report goes (default `odoo-import-<time>.json`, beside the printed summary).

## What is imported

In this order, each relation pointing at a record imported before it:

| Step | Odoo | Shutro ERP | Notes |
| --- | --- | --- | --- |
| units | `uom.uom` | `uom.uom` | Odoo's own units link to the seeded ones (Units, Dozens, Hours, Days, kg, g, m, L); `factor` becomes `ratio` (its inverse). Units of surface, energy and other kinds Shutro ERP does not measure are skipped. |
| accounts | `account.account` | `account.account` | Account types are the same; an account with the same code links to the installed chart. |
| taxes | `account.tax` | `account.tax` | Percent and fixed taxes of sales and purchases (15 becomes 0.15); groups and division taxes are skipped, as Shutro ERP applies several taxes per line. A tax with the same name, use and rate links. |
| categories | `product.category` | `product.category` | "All" links to the seeded one; parents set once all exist. With stock valuation: the cost method (average or FIFO; Odoo's standard price is kept as the product's cost and valued at the average), the stock valuation account and the expense account as the cost of goods sold. |
| partners | `res.partner` | `res.partner` | Companies and their people (parents set once all exist), addresses with country and state codes, tax ids, customer and vendor from Odoo's ranks, notes as text. Odoo's own users and companies are skipped. |
| products | `product.product` | `product.product` | Each variant as a product named as Odoo shows it, with its internal reference as the code, category, unit, prices, weight and volume, sales and purchase taxes. Combos are skipped. |
| warehouses | `stock.warehouse` | `stock.warehouse` | The Odoo company's (another company's are skipped), with their receipt and delivery steps; one with the same short code links to Stockroom's main warehouse. |
| locations | `stock.location` | `stock.location` | The internal locations of the warehouses imported, inside one another as in Odoo; the warehouse's stock location and its Input, Quality control, Packing and Output link to Stockroom's own. Vendors, customers, adjustment, production and transit are Stockroom's and skipped. |
| lots | `stock.lot` | `stock.lot` | Lots and serial numbers with their product and expiry date. Products also bring their tracking (by lot, by serial number). |

Archived records come too, archived. Only the fields the connected Odoo version has are read, and the Stockroom
steps run when Stockroom is installed in both.

## Ids and second runs

Every imported record gets the external id `odoo.<model>_<id>` (`odoo.res_partner_42`). A second run finds each
record by it and **updates** it instead of creating it again, so the import can run as often as needed while Odoo
stays the book of record; every record in Shutro ERP can be traced back to Odoo.

A record Shutro ERP already had (a seeded unit, an account of the installed chart) is **linked** the same way, then
kept in step with Odoo like the others.

## The report

For each step: the records read, and how many were created, updated, linked to an existing record, skipped (with
the reason) and failed (with Shutro ERP's answer, the Odoo id and the name). Read + nothing lost: created + updated +
linked + skipped + failed equals read. The exit code is 1 when anything failed.

The import runs as the system with the reason `odoo import` in the audit log, in one transaction; each record is in
a savepoint of its own, so one refused record is a line in the report, not the end of the import.

## The books at the cut-off

With `--cutoff <date>`, the import also brings the books as they stood at the end of that day, and proves it:

```sh
shutro-erp odoo import --url … --db … --login … --cutoff 2026-06-30           # a dry run, with the proof
shutro-erp odoo import --url … --db … --login … --cutoff 2026-06-30 --commit
```

- **The opening entry**, dated the cut-off and posted: every balance-sheet account at its Odoo balance; the profit
  and loss accounts at this fiscal year's balance, so the year's reports carry on; the earlier years' result on the
  company's retained earnings account. The fiscal year starts in the company's first month (Settings › App settings
  › Accounting), or at `--year-start <date>`.
- **Open items**: every line still open on a receivable or payable account in Odoo. An invoice, credit note or bill
  becomes a Kosh document of the same kind for what is left to pay — Odoo's number as its reference, its dates
  kept, posted to the partner's receivable or payable account as in Odoo — so it is paid, followed up and reconciled
  in Kosh. Another open item (an advance, a payment not matched yet) is a line of the opening entry with its partner.
- **The stock on hand**, when Stockroom is installed in both: Odoo's quants in its internal locations, as one
  validated **inventory adjustment per location** (from Stockroom's adjustment location, each lot on its line), so
  the stock arrives as all stock does — with its transfer, its lot history and its line in the stock ledger. With
  stock valuation (`stock_account`), each line comes in at Odoo's value (its unit cost to six places) and the
  adjustment is dated the cut-off in the books; the opening entry takes what it posted into account, so every account
  still ends at Odoo's balance. A quantity below zero in Odoo is refused and listed: count it in Odoo first.
- Both meet on an **Opening balances (from Odoo)** account (code `OPENING`), which nets to zero.

Then the **reconciliation**, read from Kosh's posted books in the same transaction (so a dry run proves it too):

| Check | Equal when |
| --- | --- |
| trial balance | each account's balance at the cut-off is Odoo's (this year's for profit and loss, the earlier years' result added to retained earnings) |
| receivables and payables | each partner's balance on each receivable and payable account is Odoo's |
| opening balances account | it nets to zero |
| open documents | every open invoice, credit note and bill of Odoo is in Kosh |
| stock on hand | each product's quantity in each location and lot is Odoo's |
| stock value | with stock valuation, each product's value at the cut-off is Odoo's, to the cent |

Each difference is a line of the report with the account, partner or document, Odoo's figure and Kosh's. A second run
finds the opening and each location's adjustment by its cut-off and does not make them again; the checks run every
time.

Odoo valuing stock periodically (the default) keeps no stock value in its books: the stock still comes in at Odoo's
value, and the opening entry brings the stock account back to Odoo's balance; from the cut-off on, Kosh values stock
as it moves. Post the stock's value at the cut-off when your accountant decides how.

Run it with no posting and no stock moved in Odoo after the cut-off (the open items and the stock are read as they
are now): at the end of a month, before anyone enters the next one, or on a copy of the database.

## Not yet

Open sales and purchase orders, employees and projects come next (RFC 0034 step 3); the incremental sync for a parallel run and the cut-over after that (step 4). Until then, see
[the pilot playbook](pilot.md) for loading those through the import screen.

## Tested against a real Odoo

`packages/cli/test/odoo.integration.test.ts` runs the importer against Odoo 18 with its demo data, recorded with
`KOSH_CERTIFY=live` and replayed in every test run (see [integrations.md](integrations.md), Certified against the
sandboxes): the dry run keeps nothing, every record is accounted for, a second run creates nothing, and the books
at the cut-off — 13 open invoices, credit notes and bills among them, a bill of the year before — and the stock — 19
quants in two locations, two lots of one product, worth 3,067.50 in an Office Furniture category valued in real time
at the average cost, one cost of 33.333 — reconcile with Odoo in every check.
