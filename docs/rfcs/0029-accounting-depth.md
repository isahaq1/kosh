# RFC 0029 — Accounting in depth: bank statements and reconciliation rules, sending documents, follow-ups, fiscal positions

- Status: Accepted (2026-11-07)
- Builds on: RFC 0009 (Accounting), RFC 0006 (notifications and the outbox), RFC 0011 (automation: conditions, dry
  run), RFC 0015 (portal), RFC 0017 (payments), RFC 0028 (credit control)
- Source: [docs/odoo-gaps/accounting.md](../odoo-gaps/accounting.md) and the cross-cutting gap #5 (email composer) of
  [docs/odoo-gaps/README.md](../odoo-gaps/README.md)

## 1. Why

Accounting in Kosh is sound where it is strict — posted entries locked by the database, VDS / TDS, GST, Mushak —
but an accountant's everyday work is missing:

- **No bank statements.** Payments are matched by hand to open items; there is no statement to import, nothing to
  match it against, no suspense account. RFC 0009 left it out of version 1. It is the first thing an accountant does
  each morning.
- **No reconciliation rules.** Bank fees, recurring transfers and known customers are matched by hand every time.
- **Documents are not sent.** An invoice can be printed, and the portal announces it, but there is no "Send" with
  the PDF attached, no template per language, no record that it was sent or opened, no batch sending. Every other app
  needs the same composer (quotations, purchase orders, delivery notes).
- **No payment follow-ups.** The aged balance shows who is late; nobody is reminded.
- **No fiscal positions or account determination.** Taxes and accounts cannot follow the customer (an exporter, a
  VAT-exempt body, another state); products and categories have no income or expense accounts of their own.

## 2. Where we go further than Odoo

| | Odoo 19 | Kosh after this RFC |
| --- | --- | --- |
| Statements | Import CSV / OFX / CAMT (Enterprise), bank sync (Enterprise) | Import CSV / OFX / CAMT and **bank feeds behind an adapter** (as payment providers), every statement line **explained**: why each proposal matches |
| Reconciliation models | Rules: match, write-off, suggest | The same, with a **dry run and hit rate** like automation rules, every automatic match **audited and reversible** |
| Sending | Send & print, templates, mark as sent | **One composer for every document** (invoices, quotations, orders), templates per language, PDF attached, **delivery and opens tracked** through the notify pipeline, batch send, auto-send on posting per customer |
| Follow-ups | Levels by email (Enterprise) | Levels by **email, SMS and WhatsApp**, with the **portal pay link**, run as jobs, paused per customer, every reminder on the customer's chatter |
| Fiscal positions | Tax and account mapping, auto-detected | The same, chosen from country, state, tax status and supply scope, **previewed on the invoice before posting** |

## 3. Design

### 3.1 Bank statements (`accounting`)

- `account.bank.statement` (journal, date, opening and closing balance, state `open | done`) and
  `account.bank.statement.line` (date, label, reference, partner, amount, currency, the matched entry, state
  `open | matched`).
- **Import:** CSV (a saved column mapping per journal, reusing `@kosh/import`'s mapper), OFX and CAMT.053.
  Duplicates (same journal, date, amount, reference) are refused. **Feeds:** a `BankFeed` adapter interface (fetch
  new lines since a cursor) with a test feed; real banks are adapters added later, like payment providers.
- **Matching workspace** (Accounting › Reconcile bank): one line at a time, keyboard-first. The server proposes open
  receivable / payable items and draft payments — by exact amount, by the invoice number found in the label, by the
  partner and their oldest open items — each with **why** ("amount and INV/2026/00042 in the label"). Matching
  creates the payment entry from the bank journal and reconciles it. Unmatched lines can go to a counterpart account
  (fees, interest) with taxes. A line can be left on the bank journal's **suspense account** and matched later.
- The statement is `done` when every line is matched and the closing balance agrees.

### 3.2 Reconciliation rules (`accounting`)

- `account.reconcile.rule`: journals, conditions (label contains / matches, amount range, partner, direction), and
  an outcome: **match** (find the open item by reference or partner and match it), **write off** (to an account with
  taxes, a label) or **suggest** (propose, do not apply).
- Rules run on import and on demand, in sequence; the first that applies wins. Every automatic match is an audited
  event and can be undone from the line.
- **Dry run** over the last 90 days of lines shows what each rule would have done, and each rule shows its **hit
  rate**.

### 3.3 Sending documents (`@kosh/mail`, used by every app)

- `mail.template` (model, name, subject and body with `{{record.field}}` placeholders, translations per language,
  the document template to attach — RFC 0005 —, active).
- A **Send** action on any document whose model declares `sendable` in its manifest (`{ template, partner }`): a
  composer dialog (recipients from the partner and its contacts, CC, the template's text in the recipient's language,
  the PDF attached, editable), sent through the outbox. The record gets `sentAt` / `sentCount` (an extension made by
  `@kosh/mail`), the message goes on its chatter, and delivery and opens come back through `@kosh/notify`'s tracking.
- **Batch:** Send from a list's selection uses each record's template and language; **auto-send on posting** per
  customer (`res.partner.sendInvoicesBy: none | email | email_and_whatsapp`).
- Accounting ships templates for invoices, credit notes and bills' remittance advice; Sales for quotations and
  orders; Purchase for requests for quotation and orders.

### 3.4 Payment follow-ups (`accounting`, with `@kosh/notify`)

- `account.followup.level` (days overdue, channels — email, SMS, WhatsApp —, template, whether to stop selling:
  block new orders through RFC 0028's credit control).
- A daily job finds each customer's overdue invoices, picks the highest level reached and not yet sent for them,
  sends one reminder per customer with the list and the **portal pay link** (RFC 0017), and posts it on the
  customer's chatter. **Pause** per customer (a promise to pay until a date).
- Accounting › Follow-ups: who is late, at which level, what was sent, with Send now and Pause.

### 3.5 Fiscal positions and account determination (`accounting`, `product`)

- `account.fiscal.position` (name, auto-apply conditions: countries, states, VAT status, supply scope; tax mappings
  tax → tax or none; account mappings account → account).
- Chosen on invoices and bills (and orders, through the bridges) from the partner, or set by hand; shown on the
  document, with a **preview** of each line's tax and account after mapping before posting.
- `product.category.incomeAccount` / `expenseAccount` and the same on products (the product's, else the category's,
  else the journal's default); `res.partner.receivableAccount` / `payableAccount` (else the company's).

## 4. Steps

1. Bank statements: models, CSV / OFX / CAMT import, the test feed, the matching workspace with explained
   proposals, suspense.
2. Reconciliation rules: match, write-off, suggest; run on import; dry run and hit rate; undo.
3. The composer: `mail.template`, `sendable` documents, Send with the PDF, tracking, batch, auto-send on posting;
   templates for Accounting, Sales and Purchase.
4. Follow-ups: levels, the daily job, email / SMS / WhatsApp with the pay link, pause, the Follow-ups screen.
5. Fiscal positions and account determination: mappings, auto-apply, the preview; product, category and partner
   accounts.

Each step: real-PostgreSQL tests (permission tests: only accountants match, import and run rules; portal users never
see others' reminders), English and Bangla, the module standard, E2E for the workspace and the composer, docs.

## 5. Not in this RFC

Analytic plans with distribution, recurring / deferred / accrual entries, early-payment discounts, scoped lock dates
with exceptions, cheque printing, currency revaluation, UBL / Peppol — a later accounting RFC.

## 6. Notes

- **Step 1 (2026-11-07).** `account.bank.statement` (with `close` emitting `account.bank.statement.closed`) and its
  lines (`open | matched`, a unique import key), `parseCsv` / `parseOfx` / `parseCamt`, `importStatement`,
  `proposalsFor` (scored: the amount, the document's number or reference in the label, the partner), `matchLine`
  (through `registerPayment`), `writeOffLine` (an entry in the statement's journal), the `BankFeed` adapter with
  `testBankFeed` and the journal's feed and cursor (kept as the system), the routes and the Reconcile bank page.
  Deviation: a line not matched yet stays open on the statement instead of being posted to a suspense account — the
  bank's balance in the books is then the matched lines; to revisit with reconciliation rules. Not yet: taxes on
  write-offs, partial matches of one document by several lines.
- **Step 2 (2026-11-07).** `account.reconcile.rule` (journals, direction, label contains, amount range, partner;
  match / write off / suggest; `hits`), the line's `rule`, `applyRules` from `importStatement` and
  `POST …/reconcile-rules/run`, `dryRunRule` (hit rate over the last days, examples on open lines), `undoLine`
  (unreconcile, reverse and match the payment with its reversal; reverse a write-off), each automatic match and undo
  audited; Run rules, Recently matched and Undo on the Reconcile bank page. Deviations: *label matches* is a plain
  case-insensitive "contains" (no regular expressions from users); *match* finds the open document of the same amount
  among the explained proposals, not by a reference pattern; write-offs without taxes, as in step 1.
- **Step 3 part 1 (2026-11-07).** `mailTemplates` and `sendable` in manifests; `mail.template` (subject and body
  translated per language, the document attached) installed by `mail`'s defaults; `mail.outgoing` queued with the
  record and sent once by the `mail.send` outbox subscriber (`Mailer` gained copies and attachments); the compose and
  send routes; the Send dialog beside Print; `fillText` in `@kosh/reporting` fills placeholders as plain text; the
  contact's language (`res.partner.lang`: English or Bangla); templates for invoices and credit notes, quotations and
  orders, and purchase orders. Deviations: the sent count and date come from `mail.outgoing` (shown in the dialog)
  instead of `sentAt` / `sentCount` fields added to every sendable model; recipients are the partner's address (and
  any typed), not yet its contacts. Next (part 2): Send from a list's selection, auto-send on posting per customer,
  delivery and open tracking through `@kosh/notify`.
- **Step 3 part 2 (2026-11-08).** Send from a list's selection (`POST /api/v1/mail/send-many/:model`, the
  `selectionAction` kind of the UI registry; skipped documents with their reason); auto-send through `autoSend: {
  topic, flag }` on a sendable document, run by an outbox subscriber as the user who emitted the event, with
  `res.partner.sendInvoicesByEmail` for invoices and credit notes. Deviations: one choice per customer (email or
  not) instead of `none | email | email_and_whatsapp` — WhatsApp documents wait for a provider that sends files; the
  delivery state is the outgoing email's (queued, sent, failed with the reason), opens are not tracked (a tracking
  pixel is left out on purpose). Step 3 complete. Seen once under the full parallel E2E run and not
  reproduced alone or on reruns: the accounting spec's trial balance without its `1010 Bank` row — open, like the
  Trade Finance overview flake.

