# Starting from your own figures

**Accounting › Configuration › Start from your figures** (and `shutro-erp opening`) starts a company in Shutro ERP
from the figures it has today — from another system, a spreadsheet or an accountant's ledger — and proves that what
was loaded equals what was entered (RFC 0036 §2.1). It is an Administrator's: the server refuses anyone else.

## On screen

1. **Download the workbook**: your accounts are already listed.
2. Choose the filled workbook and **Check**: everything is done and rolled back. Every error is a row of a table
   with its sheet and row; when there is none, each check of the proof shows *Equal* or *Differs*, and what differs
   with the workbook's figure beside the books'.
3. **Load** is offered once a check passes, and asks before it posts.
4. The loaded opening stays on the page with who loaded it, what it made, its proof and the workbook's SHA-256 —
   and **Undo the opening**.

Every load is also a record (`account.opening`) accounting managers can read.

## From the command line

1. Set the company up first: its chart of accounts, its contacts and products (the import screen on each list,
   [import.md](import.md)), its warehouses and locations.
2. Get the workbook, with the company's accounts already listed:

   ```sh
   shutro-erp opening template            # writes opening-balances.xlsx
   ```

3. Fill it (below), then check it. Everything is done and rolled back; every error is listed with its sheet and
   row, then the proof:

   ```sh
   shutro-erp opening check opening-balances.xlsx
   ```

4. Load it. It is kept only when every check is equal:

   ```sh
   shutro-erp opening load opening-balances.xlsx
   ```

`--company <id>` chooses the company (default: the first).

## The workbook

| Sheet | Columns | What to enter |
| --- | --- | --- |
| Trial balance | Account code, Account name, Debit, Credit | Each account's balance at the end of the cut-off day, as your trial balance shows it (income and expense for the year so far). Debits must equal credits. Leave accounts without a balance empty. |
| Receivables | Kind, Number, Customer, Date, Due date, Amount left | Each unpaid customer document: `Invoice` or `Credit note` with what is left to pay; `Other` for an amount that is not a document (an advance received: a negative amount). |
| Payables | Kind, Number, Vendor, Date, Due date, Amount left | Each unpaid vendor document: `Bill` or `Refund`; `Other` for an advance paid (negative). |
| Stock | Product code, Product, Location, Lot / serial number, Expiry date, Quantity, Unit cost | What is on hand: the product by its code (or its name), the location as Stockroom shows it (`WH/Stock/Shelf 1`), the lot or serial number of a tracked product, the quantity in the product's unit, and what a unit cost. |
| Control totals | What, Value | The cut-off date, and what your old system says: total receivable, total payable, stock value. |

Dates are written `YYYY-MM-DD` (or as spreadsheet dates). Customers and vendors are matched by their name, which
must be unique.

## What it makes

- **One posted opening entry**, dated the cut-off: every account but receivables and payables at its balance.
- **A posted document for each open one** — an invoice, credit note, bill or refund for what is left, with its
  number as the reference and its dates — so it is paid, followed up and reconciled like any other. `Other` rows are
  lines of the opening entry with their partner.
- **One validated inventory adjustment per location**, lots on their lines (made when missing, with their expiry).
  With stock valuation, each line comes in at the cost given and is dated the cut-off in the books; the opening
  entry takes what it posted into account, so the stock account ends at your trial balance's figure.
- All of it meets on an **Opening balances** account (code `OPENING`), which nets to zero.

## The proof

Read from the posted books in the same transaction, so a check-only run proves it too:

| Check | Equal when |
| --- | --- |
| trial balance | each account's balance at the cut-off is the sheet's |
| total receivable, total payable | the receivable and payable accounts hold the control totals |
| opening balances account | it nets to zero (the open documents add up to the receivable and payable accounts) |
| stock on hand | each product's quantity in each location and lot is the sheet's |
| stock value | the stock is worth the control total (or the sheet's quantities times costs) |

*Stock in the books* is said, not refused: when the stock accounts of your trial balance hold another amount than
the stock is worth (an old system that did not value stock in its books), the difference is named for your
accountant to post.

A second load at the same cut-off finds the opening and changes nothing; the checks run again.

## Undo

Until the **first posting after the opening**, an Administrator can undo it with a reason (the screen's *Undo the
opening*, or `POST /api/v1/accounting/opening/undo`). Nothing is deleted — posted entries never are:

- every entry and document of the opening is **reversed at the cut-off** and reconciled with its reversal, so
  nothing stays open;
- each stock adjustment is taken back out as its **return**, lots included, at the value it came in at.

Every account, every partner's balance, the stock and its value are back where they were; the opening is kept as
*Undone* with who, when and why, and a corrected workbook can be loaded. Once anything is posted after the opening,
or its stock has moved, the undo says so and is no longer offered: correct it with entries instead.

## The API

Administrators only; the workbook travels base64-encoded as `content`.

| Route | What it does |
| --- | --- |
| `GET /api/v1/accounting/opening` | the openings loaded and undone, whether the loaded one can still be undone |
| `GET /api/v1/accounting/opening/template` | the workbook |
| `POST /api/v1/accounting/opening/check` | the report of a check-only run |
| `POST /api/v1/accounting/opening/load` | the same, kept when every check is equal |
| `POST /api/v1/accounting/opening/undo` | `{ reason }`: undoes the loaded opening, or 409 with why not |

## Example

```
Opening balances at 2026-06-30: checked, nothing was kept.

An opening entry of 7 lines, 4 open documents, 2 stock adjustments.

✔ trial balance: 7 accounts at 2026-06-30, every one equal
✔ total receivable: 31500.00, equal to the control total
✔ total payable: 18000.00, equal to the control total
✔ opening balances account: nets to zero
✔ stock on hand: 3 products, locations and lots, every quantity equal
✔ stock value: 273005.00, equal to the control total
✔ stock in the books: the stock accounts hold 273005.00, the stock's value
```

and, for a workbook with a wrong row:

```
Opening balances: refused, nothing was kept.

✖ Receivables, row 6: No contact named Nobody Ltd.
✖ Stock, row 5: No internal location WH/Nowhere.
```

## Not yet

The signed opening certificate (a PDF of the figures, the checks, who approved and the workbook's hash, stored in
Documents) comes next (RFC 0036 step 2, part 2).
