# The pilot playbook

How Shutro ERP goes live at its first real company, and how we know whether it worked (RFC 0034 §2.2). No claim of
being better than Odoo is made until a pilot has run this playbook to the end.

The pilot has two leads:

- **The company's lead**: someone who works in the business every day and will use Shutro ERP daily for at least
  a month. They decide what "done" means for each task.
- **The implementer**: sets up the installation, loads the data, runs the checks, and keeps the log of problems.

## 1. Before anything is installed (week 0)

Agree on these in writing; they are what the weekly review measures against.

- **Scope**: the apps the company will use in the pilot. Fewer is better: for a trading company, Contacts,
  Products, Sales, Purchase, Stockroom and Accounting; add others only when the company already does that work
  in a system today.
- **The system being replaced** (Odoo, spreadsheets, another ERP) and who owns its data.
- **The cut-off date**: the day opening balances and open documents are taken from.
- **The parallel-run window**: how long both systems run side by side (at least two weeks, covering a month end if
  possible).
- **Success measures**, each with today's figure measured before the pilot starts:

  | Measure | How it is counted |
  | --- | --- |
  | Orders and invoices processed in Shutro ERP | the documents' counts per week, from the lists |
  | Time per task | a stopwatch on five common tasks (a quotation, a receipt, a bill, a payment, a stock count), today vs. in Shutro ERP |
  | Errors | documents corrected or cancelled per week, and problems logged (§5) |
  | Agreement with the old system | the reconciliation checks of §4, all equal at each week's end |
  | Users' word | at each weekly review, each user's one sentence: what was better, what was worse |

- **Exit rule**: what makes the company stop the pilot and stay on the old system (for example, two weeks running
  with figures that do not reconcile). Writing it down makes it a decision, not a mood.

## 2. The installation (week 1)

On the server that will run it (see [server.md](server.md), Operations):

```sh
npx shutro-erp init erp --country BD --apps contacts,product,sales,purchase,stock,accounting
cd erp
shutro-erp doctor
```

- Fix every failure `doctor` names, then every warning, until it is all ticks. In particular: HTTPS and secure
  cookies, mail (`SMTP_URL`), storage (`S3_ENDPOINT`), Valkey, and two-factor sign-in for every administrator.
- Back up and verify, then schedule both nightly and copy `backups/` off the server:

  ```sh
  shutro-erp backup && shutro-erp backup verify
  ```

  `doctor`'s `backups` check stays green only while verified backups are less than a week old.
- Set up point-in-time recovery (WAL archiving) if losing a day's work is not acceptable — it rarely is once the
  pilot handles real money.
- Create the users with their roles (Settings › People), and check each with "What can they do?" before they sign
  in: nobody gets a role "for now".
- Set the company's details, its fiscal year, its bank accounts and each app's settings (Settings › App settings).

## 3. The data (week 1)

Load in this order; each step depends on the one before. Every list has **Import** (CSV or XLSX, see
[import.md](import.md)): download the app's template, fill it, check it — every error is shown on its row —, then
import. An import can be undone for seven days.

1. **Masters**: units and product groups, products (with their tax), contacts (customers and vendors), warehouses
   and locations, employees if Workforce is in scope.
2. **The chart of accounts**: the country's chart comes with the localization; map the old system's accounts to it
   in a spreadsheet first, and add only the accounts the company truly uses.
3. **Opening balances at the cut-off date**: one journal entry for the trial balance; open customer invoices and
   vendor bills as documents (so they can be paid and followed up); stock on hand through a count per warehouse
   (Stockroom › Counts), valued at the old system's cost.
4. **Open documents**: confirmed sales and purchase orders not yet delivered or received.

Use **external ids** (the old system's references) on every row: re-importing then updates instead of duplicating,
and every record can be traced back to where it came from.

From Odoo, `shutro-erp odoo import` loads units, product categories, taxes, the chart, contacts and products
directly, each with its Odoo id, and with `--cutoff` the opening balances and the open invoices and bills, proved
by its reconciliation ([odoo.md](odoo.md)); a dry run first. Stock still goes through the import screen until the
importer's next part.

## 4. The parallel run (weeks 2–4)

Every document is entered in both systems, by the same person, the same day. At the end of each week, compare:

| Check | In Shutro ERP | Must equal |
| --- | --- | --- |
| Trial balance | Accounting › Reports › Trial balance at the week's end | the old system's, account by account |
| Receivables and payables | Accounting › Reports › Aged balances | the old system's, per partner |
| Stock | Stockroom’s stock report per warehouse, quantities and value | the old system's |
| Documents | the counts of orders, invoices, bills and payments for the week | the old system's |
| Tax | the VAT return (Mushak 9.1 in Bangladesh) for the period | what the company would file |

Every difference is a problem in the log (§5) until it is explained: an entry error in one system, a mapping
error from §3, or a defect in Shutro ERP.

## 5. The problem log and the weekly review

Keep one log (a shared sheet, or a Focus list in Shutro ERP itself). Each problem gets:

- what happened, who saw it, when, and the screen;
- the **reference** shown with any server error (`#` and eight characters): quote it — it finds the request in the
  server's logs;
- its kind: *defect* (Shutro ERP is wrong), *gap* (something the company needs that is missing), *training* (it
  works, it was not known), *data* (from the load);
- who owns it, and when it was closed.

Every week, one hour, both leads and the users:

1. The success measures of §1, this week against last week and against the old system.
2. The reconciliation checks of §4: equal, or each difference explained.
3. The log: what was closed, what is open, what blocks work. Defects first.
4. `shutro-erp doctor`: all ticks, including a verified backup this week.
5. Each user's sentence.
6. Decide: continue, change something (write what), or stop under the exit rule.

## 6. Cut-over

When the parallel run has had **two consecutive weeks** with every check of §4 equal, no open defect that blocks
work, and a month end closed in both systems:

1. Agree a day; freeze the old system the evening before (read-only, kept for reference).
2. Back up and verify (`shutro-erp backup && shutro-erp backup verify`).
3. Enter the last day's documents, check §4 one final time.
4. From the next morning, Shutro ERP is the only system. The old one stays read-only for at least a year.

## 7. After the pilot

Write a one-page report: the measures before and after, the log's figures by kind, what was fixed, what is still a
gap, and the company's lead's verdict. That report — not this playbook — is the evidence for any claim of being
better than the system it replaced.
