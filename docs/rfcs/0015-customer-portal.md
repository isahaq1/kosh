# RFC 0015: Customer and vendor portal

- **Status:** Accepted 2026-10-27 with the proposed answers (a Vite + React `apps/portal`, Next.js kept for the
  public website; a contact sees their company's documents; invitations only, payment details shown; a typed name
  and a drawn signature)
- **Depends on:** 0001 (manifests), 0002 (API), 0003 (permissions, record rules), 0005 (documents: PDFs), 0006
  (chatter, email), 0007 (frontend), 0008 (apps), 0009 (invoices), 0014 (external users read like any user)

## 1. Summary

A portal where a company's **customers and vendors sign in** and see **their own** quotations, orders, invoices,
bills, projects and tasks. They download PDFs, accept a quotation with a signature, write on a document's thread, and
see what they owe. Internal users invite a contact with one click. Portal users never reach the back-office, the
generic API or any record that isn't theirs. Each document type is declared once in its app's manifest: which
records, which fields, which actions. The portal then gives it a list, a page, a PDF and a thread, with the record
rules that keep it private.

## 2. Problem

Today a customer asks by email or phone for a copy of an invoice, the status of an order, or whether a quotation is
still valid, and someone retypes the answer. Accepting a quotation means printing, signing and scanning. Kosh has no
user who is not an employee: every user is internal (`base.user`), and the generic API serves whatever a user's
groups allow.

## 3. How Odoo does it, and its weaknesses

Odoo's `portal` module gives contacts a login (a "share" user in `base.group_portal`) and pages per app (`/my/orders`,
`/my/invoices`, `/my/tasks`) rendered by QWeb templates on the website.

- **Security by record rules only.** Portal users reach the same JSON-RPC as employees. Every model with a portal
  rule is readable through any RPC call, every readable field included, so a field shown to employees only is one
  `read` away unless each model hides it. Portal-related advisories have followed from this over the years.
- **Pages per app, written by hand** in QWeb, Python controllers and routes. A new document type means a new
  controller, templates and a breadcrumb; changing a page means XML template inheritance.
- **Signature** on sales orders only: a drawn image and a name, stored as fields of the order.
- **No vendor side** beyond RFQs in some versions; invoices and bills each have their own page logic.
- **Invitations** go through a "Grant portal access" wizard per contact, with a share flag and a group switch that
  administrators often get wrong (a portal user made internal sees everything).

## 4. Options

- **A. A Kosh portal module with its own API, documents declared in manifests, a separate front end.** The portal
  API serves only declared fields of declared models. Record rules from the apps' portal bridges keep data per
  partner. Internal APIs refuse portal users outright. Strongest isolation, one declaration per document type.
- **B. Portal users on the generic API and back-office**, limited by record rules and field security only. Little
  new code, but it is Odoo's weakness: every field and route becomes something to guard against portal users, forever.
- **C. Portal pages written per app**, with controllers in each business app. Flexible, but repetitive, and it doesn't
  scale to custom and Studio models.

## 5. Recommendation: A

### 5.1 Who a portal user is

- A `res.users` record holding **only** `portal.user` (never `base.user`), linked to **one partner**: `portalPartner`,
  added to `res.users` by the portal module, which depends on Contacts. A portal user belongs to the company that
  invited them.
- What they see: documents whose partner is **their partner, or the company their partner works for** (the
  contact's `parent`), as the proposed default. A person at Acme sees Acme's invoices; a self-employed customer sees
  their own.
- **Two worlds, enforced on the server**: every back-office and generic route (`/api/v1/models/*`, menus, views,
  search, reports, chat, the realtime gateway, Studio, imports…) requires an internal user (`base.user`) and answers
  403 to anyone else. This is one check in the request environment, so a new module's routes are safe by default.
  Portal users reach `/api/portal/v1/*` only. Internal users never get portal sessions mixed in: a user is either
  internal or portal, and switching needs an administrator, audited.

### 5.2 Invitations and sign-in

- **Grant portal access** on a contact (internal users with `portal.manager`): creates the portal user (login = the
  contact's email), links it, and emails a one-time link (single use, 7 days, stored as a digest) to choose a password.
  **Revoke** archives the user and ends their sessions.
- Sign-in, sessions, CSRF and rate limits are Kosh's own (RFC 0002 auth), on the portal's origin. 2FA (TOTP) is
  optional for portal users; passkeys come later on the same models. Password reset by email. No public sign-up in
  version 1.
- Every invitation, activation, sign-in, revocation and signature is in the audit log.

### 5.3 Documents declared in manifests

An app (or a bridge such as `sale_portal`) declares what its customers see:

```ts
portal: {
  documents: [
    {
      key: 'quotations',                // /portal/quotations
      model: 'sale.order',
      label: 'Quotations and orders',
      partner: 'partner',               // whose document it is
      domain: { state: { in: ['sent', 'sale', 'done'] } }, // drafts stay internal
      list: ['name', 'dateOrder', 'state', 'amountTotal'],
      fields: ['name', 'dateOrder', 'validityDate', 'state', 'amountUntaxed', 'amountTax', 'amountTotal', 'note'],
      lines: { field: 'lines', fields: ['product', 'name', 'quantity', 'priceUnit', 'subtotal'] },
      pdf: 'sales.quotation',           // a document template (RFC 0005)
      actions: [
        { key: 'accept', label: 'Accept and sign', transition: 'confirm', when: { state: 'sent' }, signature: true },
        { key: 'decline', label: 'Decline', when: { state: 'sent' }, message: true },
      ],
      thread: true,                     // comments of the chatter, both ways
    },
  ],
},
```

The bridge also adds, through Shutro's `extendModel`, read access for `portal.user` and the record rule ("the
partner is the user's partner or its company"), so the data stays private even if a route were wrong. The portal
module checks at load time that every declared document has its rule.

- **Fields**: only the declared fields are read and returned (relations as their display names). Field security
  still applies. Undeclared fields don't exist for the portal.
- **Actions** run a declared transition **as the portal user**: the bridge grants exactly that transition through
  an action permission (RFC 0003), guarded by `when`. A signature (typed name, a drawn image, time, IP, the
  document's hash) is stored as an attachment and a chatter entry, and audited.
- **PDFs** are rendered by the reporting engine as the portal user, from the declared template.
- **Thread**: portal users see a document's *comments* (`kind: comment`), never internal notes, activities or
  system entries. Their messages are comments; the document's followers are notified as for any comment.
- **Custom and Studio models** declare documents the same way (Studio gets a "Show in portal" step later).

### 5.4 Version 1 documents

| Bridge | Documents | Actions |
|---|---|---|
| `sale_portal` | quotations and sales orders | accept with signature, decline with a reason |
| `account_portal` | customer invoices and credit notes; vendor bills (to vendors) | — (payment details shown; online payment comes with the integrations RFC) |
| `purchase_portal` | purchase orders and RFQs (to vendors) | acknowledge an order |
| `project_portal` | the customer's projects and their tasks | comment |

The portal home shows what needs attention: quotations to sign, invoices due and overdue (amounts per currency,
never summed across currencies), open tasks.

### 5.5 The portal API

```
POST /api/portal/v1/activate              { token, password }
GET  /api/portal/v1/home                  counts and the items needing attention
GET  /api/portal/v1/documents             the declared document types the user has
GET  /api/portal/v1/documents/:key        list (search, filters on declared fields, paging)
GET  /api/portal/v1/documents/:key/:id    the record: declared fields and lines
GET  /api/portal/v1/documents/:key/:id/pdf
POST /api/portal/v1/documents/:key/:id/actions/:action   { signature?, message? }  (Idempotency-Key)
GET  /api/portal/v1/documents/:key/:id/thread
POST /api/portal/v1/documents/:key/:id/thread            { body, attachments? }
```

The same OpenAPI generation and typed client as the back-office API. A generated permission test proves, for every
declared document: a portal user of another partner gets 404, an internal route answers 403 to a portal user, and
an undeclared field never appears.

### 5.6 The front end

`apps/portal`: its own Vite + React app on `@kosh/ui` (the same design system, i18n, light and dark, RTL), with no
back-office code in its bundle. It's mobile first (customers open links from email on phones) and a PWA. Pages: sign
in, activate, home, a list and a page per document type, the PDF, sign, the thread, profile (password, 2FA,
language). Pages are generated from the document declarations, and a module can replace a page with its own React
component, as in the back-office.

### 5.7 Notifications to portal users

By email only in version 1 (no in-app inbox in the portal yet): a new document shared with them (a sent quotation,
a posted invoice), a reply on a thread. They use the existing email channel and templates (RFC 0006), in the
user's language, with a link to the document's portal page.

### 5.8 Tests

- Integration (PostgreSQL): invitation and activation (expired, reused tokens), the internal-only guard on every
  back-office route group, the generated per-document matrix (other partner 404, undeclared fields absent, actions
  only when `when` holds), signature records, threads without notes, PDFs as the user.
- E2E (Playwright, `apps/portal`): a customer is invited, activates, signs a quotation (the order is confirmed in the
  back-office), downloads an invoice, writes on a thread. English and Bangla, mobile width.
- Budget: the portal home under 150 ms API time for a partner with 10,000 documents.

## 6. Delivery plan (each step reviewed)

1. Portal identity: the `portal` module (groups, `portalPartner`, invitations, activation, revocation), the
   internal-only guard on every back-office route, the audit events; tests.
2. Documents: the manifest's `portal` spec, its load-time checks, the portal API (list, page, PDF, thread,
   actions with signatures); `sale_portal` and `account_portal`; the generated permission tests.
3. `apps/portal`: sign-in, activation, home, documents, sign, thread, profile; E2E; emails with portal links.
4. `purchase_portal` and `project_portal`; `docs/portal.md`.

## 7. Open questions (answers wanted with the approval)

- **The front end's stack**: CLAUDE.md says "Public portal/website later in Next.js". This portal is signed-in
  only (no SEO), so the proposal is a **Vite + React app** (`apps/portal`) on the same design system, keeping
  Next.js for the public website when that comes. Or Next.js now?
- **Who sees what**: a contact sees their company's documents (proposed), or only documents addressed to them?
- **Sign-up**: invitation only (proposed), or also a public sign-up that creates a contact?
- **Payments**: version 1 shows the payment details and reference (proposed); paying online by card, bKash or
  Nagad comes with the integrations RFC. Or should a payment provider come in this RFC?
- **Signature**: typed name plus a drawn signature, with time, IP and the document's hash (proposed), or the typed
  name only?

## Alignment with CLAUDE.md

"Secure by default": portal users reach a separate, declared-only API, internal routes refuse them in one place,
and record rules keep data per partner underneath. "Metadata-driven": a document type is declared once and gets
its list, page, PDF, thread and permission tests. "Customizable without forking": pages are replaceable components;
bridges add documents to the portal without touching the apps. "Kosh never reimplements ORM features": access, rules
and transitions are Shutro's; the portal adds declarations and routes. "Works in English and Bangla, light and dark,
desktop and mobile": the portal is built on `@kosh/ui`.
