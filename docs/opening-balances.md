# Starting from your own figures

`shutro-erp opening` starts a company in Shutro ERP from the figures it has today — from another system, a
spreadsheet or an accountant's ledger — and proves that what was loaded equals what was entered (RFC 0036 §2.1).

## Run it

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

The same flow on screen (Settings › Start from your figures), Undo the opening until the first posting, and the
signed opening certificate come next (RFC 0036 step 2).
