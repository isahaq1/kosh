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
| (every installation) | No draft points at an archived record | no record in its first state (a draft quotation, a draft bill) refers to a contact, product or other record that was archived |
| Accounting | Every posted entry balances | each posted entry's debits equal its credits |
| Accounting | What is left to pay on each document is what its lines hold | a posted invoice, bill or credit note's amount left equals the open amount of its receivable or payable lines |
| Accounting | Posted documents are numbered without gaps or duplicates | within each numbering (`INV/2026/…`), no number is missing between the first and the last, and none is used twice |
| Stockroom | The stock on hand is what the validated transfers moved | for each product, what came into the company's internal locations less what left them is what the stock lines hold |
| Stock valuation | The stock accounts hold what the stock is worth | the valuation layers add up to the balance of the stock accounts |
| Stock valuation | Each product's valuation adds up to its quantity on hand | the layers' quantities equal the stock on hand (stock from before valuation was installed shows here) |

A check that cannot run (a query that breaks) is reported as such, never as "nothing found".

## Every week, by itself

Each run is recorded. A running server checks every company once a week; when a check that held starts to find
something, the Administrators get a notification. `shutro-erp doctor` says where the data stands:

```
✔ data            every check holds in 1 company(ies)
▲ data            1 check(s) found something in 1 company(ies): No draft points at an archived record
                  → Run shutro-erp check data to see each finding with its records, or open Settings › Data health.
```

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

## Duplicates and merging

Records that look like one another are found by the keys their app declares, compared once normalized (case and
spaces; the digits only for a phone number):

| Records | Looked for by |
| --- | --- |
| Contacts | tax ID, email, phone, name |
| Products | name (codes and barcodes are unique already) |

An Administrator reviews the groups and merges the ones that are one record (the API today; the Settings page comes
next):

| Route | What it does |
| --- | --- |
| `GET /api/v1/settings/data-health` | the last recorded result for the current company |
| `POST /api/v1/settings/data-health/run` | the checks above, run now and recorded |
| `GET /api/v1/settings/duplicates` | the groups: what they share, and the records |
| `POST /api/v1/settings/duplicates/merge` | `{ model, keep, merge: [ids] }` |
| `GET /api/v1/settings/merges` | the latest merges, and whether each can still be undone |
| `POST /api/v1/settings/merges/:id/undo` | puts every link back and restores the duplicate |

A merge:

- **moves every link** to the record kept: each relation of an installed model to it (a child contact, an order's
  customer, a draft invoice's partner) and each record that refers to it by model and id (the chatter, followers,
  activities, attachments) — found from the models themselves, so an app installed tomorrow is covered;
- **archives** the duplicate, never deletes it;
- goes through the ORM as the system: every move is audited and every constraint still applies. A link that may
  not be changed — the partner of a **posted** entry — refuses the merge with the reason, and nothing is kept:
  archive that duplicate instead;
- is **undone for 7 days**: every link moved goes back (unless a person moved it elsewhere since) and the duplicate
  is restored.

Many-to-many relations to the merged record are not moved yet.

Your own module declares its duplicates the same way:

```ts
export const library = defineModule({
  …,
  duplicates: [{ model: 'library.book', keys: [{ label: 'ISBN', fields: ['isbn'] }] }],
});
```

## Not yet

The Settings page — the checks, the duplicates side by side, merge and undo — comes next (RFC 0036 step 6).
