# Data health

`shutro-erp check data` checks what must always hold in each company's data, and names what does not with the
records behind it (RFC 0036 §2.3). It reads only: nothing is changed by looking.

```sh
shutro-erp check data                  # every company
shutro-erp check data --company 1      # one company
shutro-erp check data --json           # for a monitor; exit code 1 when anything was found
```

```
Padma Traders
✔ accounting: Every posted entry balances
✔ accounting: What is left to pay on each document is what its receivable or payable lines hold
✔ accounting: Posted documents are numbered without gaps or duplicates
✖ stock: The stock on hand is what the validated transfers moved — 1 finding(s)
    Rice 50 kg: 6.0000 on hand, but its transfers moved 1.0000 (product.product 1)
✔ stock_account: The stock accounts hold what the stock is worth
✖ stock_account: Each product’s valuation adds up to its quantity on hand — 1 finding(s)
    Rice 50 kg: 1.0000 valued, 6.0000 on hand (product.product 1)
shutro-erp check data: 2 check(s) found something. Nothing was changed.
```

## The checks

Each installed app declares its own; only those of the installed apps run.

| App | Check | Holds when |
| --- | --- | --- |
| Accounting | Every posted entry balances | each posted entry's debits equal its credits |
| Accounting | What is left to pay on each document is what its lines hold | a posted invoice, bill or credit note's amount left equals the open amount of its receivable or payable lines |
| Accounting | Posted documents are numbered without gaps or duplicates | within each numbering (`INV/2026/…`), no number is missing between the first and the last, and none is used twice |
| Stockroom | The stock on hand is what the validated transfers moved | for each product, what came into the company's internal locations less what left them is what the stock lines hold |
| Stock valuation | The stock accounts hold what the stock is worth | the valuation layers add up to the balance of the stock accounts |
| Stock valuation | Each product's valuation adds up to its quantity on hand | the layers' quantities equal the stock on hand (stock from before valuation was installed shows here) |

A check that cannot run (a query that breaks) is reported as such, never as "nothing found".

Posted entries are also protected where the data lives: the database refuses a change to a posted entry's number or
lines, so most of what the Accounting checks guard against cannot be done behind the books at all.

## Your own checks

A module declares what must hold in its data with `dataChecks` in its manifest. A check reads the current
company's data as the system and returns what it found wrong:

```ts
import type { DataCheckSpec } from 'shutro-erp/modules-sdk';
import type { Env } from 'shutro-erp/orm';

const loansHaveDates: DataCheckSpec = {
  key: 'loans_due',
  label: 'Every confirmed loan has a due date',
  run: async (raw: never) => {
    const env = raw as Env;
    const rows = await env.sql<{ id: number; reference: string }>`
      SELECT id, reference FROM library_loan
      WHERE company_id = ${env.companyId as number} AND state = 'confirmed' AND due IS NULL`;
    return rows.map((r) => ({
      what: r.reference,
      detail: 'confirmed without a due date',
      records: { model: 'library.loan', ids: [r.id] },
    }));
  },
};

export const library = defineModule({ …, dataChecks: [loansHaveDates] });
```

## Not yet

Duplicates of contacts and products with merging, broken links, a weekly run with a notification, the result on
`shutro-erp doctor` and a Settings page come next (RFC 0036 step 6).
