# The customer and vendor portal

`@kosh/portal` (RFC 0015) lets a company's customers and vendors sign in and see **their own** documents: quotations
and orders, invoices and bills, purchase orders, projects and tasks. They download PDFs, accept a quotation with a
signature, decline it with a reason, and write on a document's thread. The portal is a separate app
(`apps/portal`) that talks only to the portal API; portal users never reach the back-office.

## Apps

| Module | What customers or vendors see | Actions |
|---|---|---|
| `sale_portal` | sent quotations and sales orders, with their lines and the quotation PDF | accept with a signature (the order is confirmed), decline with a reason |
| `account_portal` | posted invoices and credit notes, with what is still due (unpaid ones on the home page); vendor bills | — |
| `purchase_portal` | requests for quotation sent to the vendor, and purchase orders | — |
| `project_portal` | the customer's projects and their open tasks | — |
| `payment` | — | **Pay now** on open invoices, with the company's payment providers ([integrations.md](integrations.md#online-payments)) |

Each needs its app and `portal`. Documents have a thread when the app declares one. New quotations, invoices and
requests are announced by email.

## Giving a contact access

On a contact's form, **Portal access** (for users with the "Portal access" level):

1. **Grant portal access**: the contact's email becomes their login. The invitation goes by email when the server
   can send mail (`SMTP_URL`); its link is shown either way, to share another way. The link works once, for 7 days.
2. The contact opens the link, chooses a password (12+ characters) and is signed in.
3. **Send the invitation again** replaces the link (a forgotten password, an expired link). **Revoke access** ends
   the access and every session at once; granting again brings the same user back with a new invitation.

A contact sees the documents of their own contact and of **their company** (the contact's parent), including those
addressed to colleagues at the same company. Portal links point to `SHUTRO_ERP_PORTAL_URL` (e.g.
`https://portal.example.com`).

## Security

- Portal users hold only `portal.user`. The server refuses them every back-office and generic API route (403),
  except signing in and out and `/api/portal/`. This is one check in the server, so new modules are covered without
  doing anything.
- Which records: always a search as the portal user, so the record rule each bridge adds (`portalRule`) decides.
  Another customer's document is 404. What of them: only the fields the app declares.
- Actions run once the portal has checked the record is the user's and the action applies. The transition runs as
  the system, as an employee would act on the customer's word. The signature (typed name, drawn image, time, IP,
  and a hash of the fields and lines the user saw), the thread entry and the audit event name the portal user.
- Threads show comments only: internal notes, activities and the change log stay internal.
- Every invitation, activation, revocation and action is in the audit log (`portal.*`).

## Showing a document type in the portal

A bridge module declares the document in its manifest and adds the record rule to the model:

```ts
// module.ts: the data layer
export const OrderPortal = extendModel('sale.order', {
  access: { 'portal.user': ['read'] },
  rules: { portal: portalRule('partner') }, // or a path: portalRule('project.partner')
});

// index.ts: the manifest
export const salePortal = defineModule({
  shutro: salePortalShutro,
  kosh: '^0.1.0',
  depends: [sales, portal],
  changeEvents: ['sale.order'], // for announcements
  accessLevels: { manager: { label: 'Portal access (sales documents)', groups: ['portal.manager'] } },
  portal: {
    documents: [
      {
        key: 'quotations',
        model: 'sale.order',
        label: 'Quotations and orders',
        partner: 'partner',
        domain: { state: { in: ['sent', 'sale', 'done'] } },
        list: ['name', 'dateOrder', 'state', 'amountTotal'],
        fields: ['name', 'state', 'dateOrder', 'amountTotal', 'note'],
        lines: { field: 'lines', fields: ['product', 'name', 'quantity', 'priceUnit', 'subtotal'] },
        pdf: 'sales.quotation',
        actions: [
          { key: 'accept', label: 'Accept and sign', transition: 'confirm', when: { state: 'sent' }, signature: true },
          { key: 'decline', label: 'Decline', transition: 'cancel', when: { state: 'sent' }, message: true },
        ],
        thread: true,
        attention: { state: 'sent' }, // on the portal's home
        announce: { state: 'sent' }, // emailed once when a record enters this domain
        // payment: { when: { … } }, // payable online in this domain (account_portal's invoices; needs `payment`)
      },
    ],
  },
});
```

The server checks every declaration when it starts: the model, the fields and line fields, the transitions, the PDF
template, and that the model gives `portal.user` read access **with a record rule**. A declaration that could show
documents without the rule stops the server.

## The portal API

```
POST /api/portal/v1/activate                               { token, password } → { login }
GET  /api/portal/v1/me
GET  /api/portal/v1/home                                   what needs the user
GET  /api/portal/v1/documents                              the document types and counts
GET  /api/portal/v1/documents/:key?q=&offset=&limit=
GET  /api/portal/v1/documents/:key/:id
GET  /api/portal/v1/documents/:key/:id/pdf
POST /api/portal/v1/documents/:key/:id/actions/:action     { signature?: { name, image }, message? }
GET  /api/portal/v1/documents/:key/:id/thread
POST /api/portal/v1/documents/:key/:id/thread              { body }
GET  /api/portal/v1/payments/providers                     with `payment`: the providers offered
POST /api/portal/v1/payments                               { document, id, provider } → { reference, redirectUrl }
GET  /api/portal/v1/payments/:reference                    the payment's state
```

Staff manage access with `GET/POST /api/v1/portal/access`, `POST /api/v1/portal/access/:user/invitation` and
`DELETE /api/v1/portal/access/:user`.

## Running the portal app

`apps/portal` is a Vite + React app on the Shutro ERP design system, in English and Bangla, with light and dark themes,
built for phones first. `pnpm --filter @kosh/portal-web dev` serves it on port 5174, proxying `/api` to `SHUTRO_ERP_API`
(default `http://localhost:3000`). In production, serve its build on the portal's domain with `/api` going to the
Shutro ERP server, and set `SHUTRO_ERP_PORTAL_URL` to that domain.

## Not yet

- Real payment providers (SSLCommerz, bKash, Razorpay, Stripe): the test provider works end to end today.
- `shutro-erp init` does not offer the portal yet, and generated projects do not include the portal app.
- Installing the portal as an app on the home screen (PWA).
