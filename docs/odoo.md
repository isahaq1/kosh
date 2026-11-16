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
| categories | `product.category` | `product.category` | "All" links to the seeded one; parents set once all exist. |
| taxes | `account.tax` | `account.tax` | Percent and fixed taxes of sales and purchases (15 becomes 0.15); groups and division taxes are skipped, as Shutro ERP applies several taxes per line. A tax with the same name, use and rate links. |
| accounts | `account.account` | `account.account` | Account types are the same; an account with the same code links to the installed chart. |
| partners | `res.partner` | `res.partner` | Companies and their people (parents set once all exist), addresses with country and state codes, tax ids, customer and vendor from Odoo's ranks, notes as text. Odoo's own users and companies are skipped. |
| products | `product.product` | `product.product` | Each variant as a product named as Odoo shows it, with its internal reference as the code, category, unit, prices, weight and volume, sales and purchase taxes. Combos are skipped. |

Archived records come too, archived. Only the fields the connected Odoo version has are read.

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

## Not yet

Open invoices and bills with their payments, the opening balance, stock by location and lot, open orders,
employees and projects, and the reconciliation report proving the trial balance, receivables, payables and stock
equal Odoo's come next (RFC 0034 step 3 part 2); the incremental sync for a parallel run and the cut-over after that
(step 4). Until then, see [the pilot playbook](pilot.md) for loading the rest through the import screen.

## Tested against a real Odoo

`packages/cli/test/odoo.integration.test.ts` runs the importer against Odoo 18 with its demo data, recorded with
`KOSH_CERTIFY=live` and replayed in every test run (see [integrations.md](integrations.md), Certified against the
sandboxes): the dry run keeps nothing, every record is accounted for, a second run creates nothing.
