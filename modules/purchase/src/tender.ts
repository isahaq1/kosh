/**
 * RFQs to many vendors (RFC 0032 §3.4, after Paragon's procurement chain): a buyer asks several vendors to quote the
 * same lines by a deadline. Each vendor gets a **response** of their own and a **quote link** — single use until
 * submitted, valid a day past the deadline, only its digest kept — to a page where they type their prices, delivery
 * date and terms without an account; buyers may type a response for them. A submitted response moves the RFQ to
 * *Responses received*; the comparison (step 8) chooses the vendors. An approved purchase request becomes such an
 * RFQ in one step, its lines followed by the line tracker.
 */
import { randomBytes } from 'node:crypto';
import { layout, type Mailer, mailerFromEnv } from '@kosh/mail';
import { audit, digest, HttpProblem, type ModuleContext, randomToken } from '@kosh/server';
import { type Decimal, orm } from '@kosh/server/orm';
import { compute, defineModel, type Env, f, onchange, records } from './.kosh/bindings.js';

const ALL = ['read', 'write', 'create', 'unlink'] as const;
const zero: Decimal = orm.toDecimal(0);
type Row = Record<string, unknown>;

let config: { mailer: Mailer | undefined; apiUrl: string; log: (m: string, e: unknown) => void } = {
  mailer: mailerFromEnv(),
  apiUrl: (process.env['KOSH_API_URL'] ?? 'http://localhost:3000').replace(/\/$/, ''),
  log: () => undefined,
};
/** The mailer and public address the quote links use (tests: a memory mailer). */
export function configurePurchaseMails(next: Partial<typeof config>): void {
  config = { ...config, ...next };
}

/** A date-only value as `YYYY-MM-DD`. */
function isoDay(v: unknown): string {
  if (!(v instanceof Date)) return String(v ?? '').slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
}

const TENDER_STATES = {
  draft: 'Draft',
  sent: 'Sent',
  received: 'Responses received',
  comparing: 'In comparison',
  selected: 'Vendor selected',
  ordered: 'Orders made',
  cancel: 'Cancelled',
} as const;

export const PurchaseTender = defineModel('purchase.tender', {
  label: 'RFQ to vendors',
  recName: 'name',
  order: ['id desc'],
  companyScoped: { required: true },
  tracking: ['state', 'deadline', 'dateDelivery'],
  access: { 'purchase.user': ALL, 'purchase.manager': [...ALL, 'export', 'import'] },
  rules: { all: { groups: ['purchase.user'], perms: [...ALL], domain: {} } },
  fields: {
    name: f.char({ required: true, sequence: 'purchase.tender', label: 'Reference' }),
    buyer: f.many2one('res.users', {
      required: true,
      ondelete: 'restrict',
      default: (env: Env) => env.userId,
    }),
    date: f.date({ required: true, default: (env: Env) => env.today(), label: 'RFQ date' }),
    deadline: f.date({
      required: true,
      label: 'Response deadline',
      help: 'Vendors quote by this day; their links work a day longer.',
    }),
    dateDelivery: f.date({ label: 'Delivery date' }),
    sourcing: f.selection(
      { local: 'Local', import: 'Import' },
      {
        required: true,
        default: 'local',
        help: 'Bought in the country, or imported (a letter of credit may follow).',
      },
    ),
    topic: f.char({ label: 'RFQ topic' }),
    vendors: f.many2many('res.partner', { relation: 'purchase_tender_vendor', label: 'Vendors' }),
    currency: f.many2one('res.currency', { ondelete: 'restrict' }),
    paymentTerms: f.char({ label: 'Payment terms' }),
    technical: f.boolean({
      default: false,
      label: 'Technical comparison first',
      help: 'An engineer scores the vendors on the specifications before prices are compared.',
    }),
    note: f.text({ label: 'Notes and special instructions' }),
    request: f.many2one('purchase.request', { ondelete: 'set null', label: 'Purchase request' }),
    lines: f.one2many('purchase.tender.line', 'tender', { label: 'Products' }),
    responses: f.one2many('purchase.tender.response', 'tender', { label: 'Vendor responses' }),
    responseCount: f.integer({
      store: true,
      label: 'Responses',
      help: 'Vendors who submitted a quotation.',
      ...compute('purchase.tender', 'responseCount', ['responses.state'], (tenders) => {
        for (const t of tenders)
          t.responseCount = [...t.responses].filter((r) => r.state === 'submitted').length;
      }),
    }),
    state: f.state({
      states: TENDER_STATES,
      initial: 'draft',
      help: 'Drafted, sent to the vendors with their quote links, received once they answer, compared, a vendor selected, orders made.',
      transitions: {
        send: {
          from: ['draft'],
          to: 'sent',
          guard: records('purchase.tender', async (tenders) =>
            [...(await tenders.load({ lines: true, vendors: true }))]
              .filter((t) => t.lines.length === 0 || t.vendors.length === 0)
              .map((t) => t.id),
          ),
          message: 'Add the products and the vendors before sending the RFQ.',
          after: records('purchase.tender', async (tenders) => {
            const env = tenders.env as unknown as Env;
            await env.flush();
            for (const id of tenders.ids) await inviteVendors(env, id as number);
          }),
        },
        /** After the deadline, the buyer moves on with the answers in hand. */
        close: {
          from: ['sent'],
          to: 'received',
          guard: records('purchase.tender', async (tenders) =>
            [...(await tenders.load({}))]
              .filter((t) => (t.responseCount ?? 0) === 0)
              .map((t) => t.id),
          ),
          message: 'No vendor has answered yet.',
        },
        /** The comparative statement is being drawn up (step 8). */
        compare: { from: ['received'], to: 'comparing' },
        /** The statement is approved: the vendors are chosen. */
        select: { from: ['comparing', 'received'], to: 'selected' },
        /** The orders are made from the confirmed statement. */
        order: { from: ['selected', 'comparing', 'received'], to: 'ordered' },
        cancel: { from: ['draft', 'sent', 'received', 'comparing'], to: 'cancel' },
        redraft: { from: ['cancel'], to: 'draft' },
      },
      extensible: true,
    }),
  },
  onchange: {
    topic: onchange('purchase.tender', async (d, env): Promise<void> => {
      if ((d.get('currency') ?? null) !== null) return;
      const [company] = await env
        .model('res.company')
        .browse([env.companyId as never])
        .load({ currency: true });
      if (company?.currency) d.set('currency', company.currency.id as never);
    }),
  },
});

export const PurchaseTenderLine = defineModel('purchase.tender.line', {
  label: 'RFQ line',
  order: ['tender desc', 'sequence asc', 'id asc'],
  access: { 'purchase.user': ALL, 'purchase.manager': [...ALL, 'export', 'import'] },
  rules: { all: { groups: ['purchase.user'], perms: [...ALL], domain: {} } },
  fields: {
    tender: f.many2one('purchase.tender', { required: true, ondelete: 'cascade', label: 'RFQ' }),
    sequence: f.integer({ default: 10 }),
    product: f.many2one('product.product', { required: true, ondelete: 'restrict' }),
    name: f.char({ label: 'Description' }),
    uom: f.many2one('uom.uom', { ondelete: 'restrict', label: 'Unit' }),
    quantity: f.decimal({ scale: 3, required: true, default: '1' }),
    requestLine: f.many2one('purchase.request.line', {
      ondelete: 'set null',
      label: 'Request line',
    }),
  },
  sqlConstraints: {
    positive: { check: orm.sql`quantity > 0`, message: 'Quantities are positive.' },
  },
  onchange: {
    product: onchange('purchase.tender.line', async (d): Promise<void> => {
      const product = (await d.record('product')) as {
        name: string;
        uom: { id: number } | null;
      } | null;
      if (product === null) return;
      if (product.uom !== null) d.set('uom', product.uom.id as never);
      if ((d.get('name') ?? '') === '') d.set('name', product.name);
    }),
  },
});

export const PurchaseTenderResponse = defineModel('purchase.tender.response', {
  label: 'Vendor response',
  recName: 'name',
  order: ['id desc'],
  companyScoped: { required: true },
  tracking: ['state', 'amountTotal', 'dateDelivery'],
  access: { 'purchase.user': ALL, 'purchase.manager': [...ALL, 'export', 'import'] },
  rules: { all: { groups: ['purchase.user'], perms: [...ALL], domain: {} } },
  fields: {
    name: f.char({ required: true, sequence: 'purchase.tender.response', label: 'Reference' }),
    tender: f.many2one('purchase.tender', { required: true, ondelete: 'cascade', label: 'RFQ' }),
    vendor: f.many2one('res.partner', { required: true, ondelete: 'restrict' }),
    responseDate: f.datetime({ label: 'Responded on' }),
    dateDelivery: f.date({ label: 'Delivery date' }),
    paymentTerms: f.char({ label: 'Payment terms' }),
    advancePercent: f.decimal({ scale: 2, default: '0', label: 'Advance (%)' }),
    technicalRank: f.integer({
      default: 0,
      label: 'Technical rank',
      help: 'Given by the technical comparison when the RFQ asks for one; 0 until then.',
    }),
    remark: f.text(),
    lines: f.one2many('purchase.tender.response.line', 'response', { label: 'Quoted lines' }),
    amountTotal: f.decimal({
      scale: 2,
      store: true,
      label: 'Total',
      help: 'The quoted lines together, before tax.',
      ...compute('purchase.tender.response', 'amountTotal', ['lines.subtotal'], (responses) => {
        for (const r of responses)
          r.amountTotal = [...r.lines].reduce((s, l) => s.plus(l.subtotal ?? zero), zero);
      }),
    }),
    /** The quote link's digest; the link itself is shown once to whoever makes it. */
    tokenHash: f.char({ index: 'unique', label: 'Quote link' }),
    tokenExpiresAt: f.datetime({ label: 'Quote link valid until' }),
    state: f.state({
      states: {
        invited: 'Invited',
        quoted: 'Quoted, not sent',
        submitted: 'Submitted',
        not_responded: 'Not responded',
        rejected: 'Rejected',
      },
      initial: 'invited',
      help: 'Invited with a quote link; quoted while the vendor fills it in; submitted once sent; not responded after the deadline; rejected by the buyer.',
      transitions: {
        submit: {
          from: ['invited', 'quoted'],
          to: 'submitted',
          guard: records('purchase.tender.response', async (responses) =>
            [...(await responses.load({ lines: true }))]
              .filter((r) => r.lines.length === 0 || [...r.lines].some((l) => l.priceUnit.lte(0)))
              .map((r) => r.id),
          ),
          message: 'Every line needs a price.',
          after: records('purchase.tender.response', async (responses) => {
            const env = responses.env as unknown as Env;
            await responses.write({ responseDate: new Date() } as never);
            for (const r of await responses.load({ tender: true })) {
              if (r.tender.state === 'sent')
                await env.model('purchase.tender').browse([r.tender.id]).close();
              await env.emit('purchase.tender.response_submitted', { id: r.id });
            }
          }),
        },
        /** The vendor saved prices through their link, without submitting yet. */
        quote: { from: ['invited', 'quoted'], to: 'quoted' },
        unanswered: { from: ['invited', 'quoted'], to: 'not_responded' },
        reject: { from: ['submitted'], to: 'rejected' },
        reopen: { from: ['not_responded', 'rejected'], to: 'invited' },
      },
      extensible: true,
    }),
  },
});

export const PurchaseTenderResponseLine = defineModel('purchase.tender.response.line', {
  label: 'Quoted line',
  order: ['response desc', 'id asc'],
  access: { 'purchase.user': ALL, 'purchase.manager': [...ALL, 'export', 'import'] },
  rules: { all: { groups: ['purchase.user'], perms: [...ALL], domain: {} } },
  fields: {
    response: f.many2one('purchase.tender.response', { required: true, ondelete: 'cascade' }),
    tenderLine: f.many2one('purchase.tender.line', {
      required: true,
      ondelete: 'restrict',
      label: 'RFQ line',
    }),
    product: f.many2one('product.product', { required: true, ondelete: 'restrict' }),
    quantity: f.decimal({ scale: 3, required: true, default: '1' }),
    priceUnit: f.decimal({ scale: 2, required: true, default: '0', label: 'Quoted price' }),
    subtotal: f.decimal({
      scale: 2,
      store: true,
      help: 'The quantity at the quoted price.',
      ...compute(
        'purchase.tender.response.line',
        'subtotal',
        ['quantity', 'priceUnit'],
        (lines) => {
          for (const l of lines) l.subtotal = l.quantity.times(l.priceUnit).toDecimalPlaces(2);
        },
      ),
    }),
    note: f.char(),
  },
});

/** A fresh quote link for a response: the token is stored as its digest; the URL is returned once. */
async function issueQuoteLink(env: Env, responseId: number): Promise<string> {
  const [r] = await env
    .model('purchase.tender.response')
    .browse([responseId as never])
    .load({ tender: true });
  if (r === undefined) throw new HttpProblem(404, 'not-found', 'Not found', 'No such response.');
  const token = randomToken(24);
  const expires = new Date(`${isoDay(r.tender.deadline)}T00:00:00`);
  expires.setDate(expires.getDate() + 2);
  await env
    .model('purchase.tender.response')
    .browse([responseId as never])
    .write({ tokenHash: digest(token), tokenExpiresAt: expires } as never);
  return `${config.apiUrl}/api/v1/public/purchase/quotes/${token}`;
}

/**
 * On sending: one response per vendor with the RFQ's lines, each with its quote link, emailed to the vendor when a
 * mailer is configured and the vendor has an email (a failed send is logged; the buyer may make a new link).
 */
async function inviteVendors(env: Env, tenderId: number): Promise<void> {
  const [t] = await env
    .model('purchase.tender')
    .browse([tenderId as never])
    .load({ vendors: true, lines: { product: true }, company: true, buyer: true });
  if (t === undefined) return;
  for (const vendor of t.vendors) {
    const made = await env.model('purchase.tender.response').create([
      {
        tender: t.id,
        vendor: vendor.id,
        company: t.company.id,
        paymentTerms: t.paymentTerms,
        dateDelivery: t.dateDelivery,
        lines: {
          create: [...t.lines].map((l) => ({
            tenderLine: l.id,
            product: l.product.id,
            quantity: l.quantity,
          })),
        },
      },
    ] as never);
    const id = made.ids[0] as number;
    const url = await issueQuoteLink(env, id);
    const email = vendor.email ?? null;
    if (config.mailer === undefined || email === null || email === '') continue;
    try {
      const body = layout({
        title: `Request for quotation ${t.name}`,
        paragraphs: [
          `${t.company.name} asks ${vendor.name} to quote ${t.lines.length} product(s) by ${isoDay(t.deadline)}.`,
          ...(t.note ? [t.note] : []),
          'The link is yours alone and works until the deadline; you may save and come back before you submit.',
        ],
        action: { label: 'Send your quotation', url },
      });
      await config.mailer.send({
        to: email,
        subject: `Request for quotation ${t.name}${t.topic ? ` — ${t.topic}` : ''}`,
        html: body.html,
        text: body.text,
      });
    } catch (error) {
      config.log(`The quote link of ${t.name} could not be emailed to ${vendor.name}.`, error);
    }
  }
  await env.emit('purchase.tender.sent', { id: t.id });
}

const esc = (s: string): string =>
  s.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string,
  );

interface QuoteView {
  readonly id: number;
  readonly name: string;
  readonly state: string;
  readonly vendor: string;
  readonly tender: {
    readonly name: string;
    readonly topic: string | null;
    readonly deadline: string;
    readonly note: string | null;
    readonly currency: string;
    readonly company: string;
  };
  readonly dateDelivery: string | null;
  readonly paymentTerms: string | null;
  readonly remark: string | null;
  readonly lines: readonly {
    readonly id: number;
    readonly product: string;
    readonly quantity: string;
    readonly uom: string;
    readonly priceUnit: string;
  }[];
}

function quotePage(q: QuoteView, nonce: string): string {
  const closed = q.state === 'submitted' || q.state === 'rejected' || q.state === 'not_responded';
  const rows = q.lines
    .map(
      (l) =>
        `<tr><td>${esc(l.product)}</td><td class="n">${esc(l.quantity)} ${esc(l.uom)}</td><td><input type="number" min="0" step="0.01" data-line="${l.id}" value="${esc(l.priceUnit)}" ${closed ? 'disabled' : ''} aria-label="Price of ${esc(l.product)}"></td></tr>`,
    )
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(q.tender.name)} — quotation</title><style>body{font:16px system-ui,sans-serif;max-width:44rem;margin:2rem auto;padding:0 1rem;color:#111;background:#fff}
@media (prefers-color-scheme:dark){body{color:#eee;background:#111}input,textarea{background:#222;color:#eee}}
table{width:100%;border-collapse:collapse}td,th{border-bottom:1px solid #8884;padding:.4rem;text-align:start}.n{text-align:end;white-space:nowrap}
input,textarea{font:inherit;width:100%;box-sizing:border-box;padding:.3rem}label{display:block;margin-top:.8rem;font-weight:600}
button{font:inherit;padding:.6rem 1rem;border-radius:.5rem;border:1px solid #888;cursor:pointer;margin:.8rem .5rem 0 0}.go{background:#16a34a;color:#fff;border-color:#16a34a}</style></head>
<body><h1>Request for quotation ${esc(q.tender.name)}</h1>
<p>${esc(q.tender.company)} asks ${esc(q.vendor)} to quote${q.tender.topic ? ` — ${esc(q.tender.topic)}` : ''}. Deadline: ${esc(q.tender.deadline)}. Prices in ${esc(q.tender.currency)}.</p>
${q.tender.note ? `<p>${esc(q.tender.note)}</p>` : ''}
${closed ? `<p role="status"><strong>${q.state === 'submitted' ? 'Your quotation was received — thank you.' : 'This request is closed.'}</strong></p>` : ''}
<table><thead><tr><th>Product</th><th class="n">Quantity</th><th>Unit price</th></tr></thead><tbody>${rows}</tbody></table>
<label for="d">Delivery date</label><input id="d" type="date" value="${esc(q.dateDelivery ?? '')}" ${closed ? 'disabled' : ''}>
<label for="p">Payment terms</label><input id="p" maxlength="200" value="${esc(q.paymentTerms ?? '')}" ${closed ? 'disabled' : ''}>
<label for="r">Remarks</label><textarea id="r" maxlength="2000" ${closed ? 'disabled' : ''}>${esc(q.remark ?? '')}</textarea>
${closed ? '' : '<div><button data-s="0">Save for later</button><button class="go" data-s="1">Submit the quotation</button></div>'}
<p id="out" role="status"></p>
<script nonce="${nonce}">for(const b of document.querySelectorAll('button[data-s]')){b.addEventListener('click',async()=>{const out=document.getElementById('out');out.textContent='Sending…';
const lines=[...document.querySelectorAll('input[data-line]')].map(i=>({id:Number(i.dataset.line),priceUnit:i.value}));
const r=await fetch(location.pathname,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({lines,dateDelivery:document.getElementById('d').value,paymentTerms:document.getElementById('p').value,remark:document.getElementById('r').value,submit:b.dataset.s==='1'})});
let j={};try{j=await r.json()}catch{}out.textContent=r.ok?(j.state==='submitted'?'Submitted — thank you.':'Saved.'):(j.detail||'It could not be saved.');if(r.ok&&j.state==='submitted')for(const x of document.querySelectorAll('button,input,textarea'))x.disabled=true;})}</script></body></html>`;
}

/** The quote link's response, by the token's digest, while the link is valid. */
async function responseOfToken(su: Env, token: string): Promise<QuoteView | null> {
  const found = await su
    .withFlags({ checkCompany: false })
    .model('purchase.tender.response')
    .search({ where: { tokenHash: digest(token) } as never, limit: 1 });
  const [r] = await found.load({
    vendor: true,
    tender: { currency: true, company: true },
    lines: { tenderLine: { product: true, uom: true } },
  });
  if (r === undefined) return null;
  if (r.tokenExpiresAt !== null && new Date(r.tokenExpiresAt as Date).getTime() < Date.now())
    return null;
  return {
    id: r.id as number,
    name: r.name,
    state: r.state,
    vendor: r.vendor.name,
    tender: {
      name: r.tender.name,
      topic: r.tender.topic ?? null,
      deadline: isoDay(r.tender.deadline),
      note: r.tender.note ?? null,
      currency: r.tender.currency?.name ?? '',
      company: r.tender.company.name,
    },
    dateDelivery: r.dateDelivery === null ? null : isoDay(r.dateDelivery),
    paymentTerms: r.paymentTerms ?? null,
    remark: r.remark ?? null,
    lines: [...r.lines].map((l) => ({
      id: l.id as number,
      product: l.tenderLine.product.name,
      quantity: l.quantity.toString(),
      uom: l.tenderLine.uom?.name ?? '',
      priceUnit: l.priceUnit.toString(),
    })),
  };
}

export function registerTenderRoutes(context: ModuleContext): void {
  const { app, shutro } = context;
  configurePurchaseMails({ log: (message, error) => app.log.warn({ err: error }, message) });
  const tokenOf = (params: unknown) => String((params as Row)['token'] ?? '');
  const asSystem = <T>(reason: string, run: (su: Env) => Promise<T>): Promise<T> =>
    shutro.bootstrap({ reason }, (raw) =>
      (raw as Env).asSuperuser({ reason }, (su) => run(su as unknown as Env)),
    );

  // A new quote link for a response (the old one stops working), for buyers who email or paste it themselves.
  app.post('/api/v1/purchase/responses/:id/link', async (request) => {
    const id = Number((request.params as Row)['id']);
    return request.env(
      async (raw) => {
        const env = raw as unknown as Env;
        env.access.check('purchase.tender.response', 'write');
        await env.access.checkRecords('purchase.tender.response', [id as never], 'write');
        return { url: await issueQuoteLink(env, id) };
      },
      { write: true },
    );
  });

  // The vendor's page: the lines to price, the delivery date and terms; its script (allowed by a nonce) posts.
  app.get(
    '/api/v1/public/purchase/quotes/:token',
    { config: { auth: false } },
    async (request, reply) => {
      const q = await asSystem('quote link', (su) => responseOfToken(su, tokenOf(request.params)));
      if (q === null)
        throw new HttpProblem(
          404,
          'not-found',
          'Not found',
          'This link has expired or does not exist.',
        );
      const nonce = randomBytes(16).toString('base64');
      return reply
        .type('text/html; charset=utf-8')
        .header(
          'content-security-policy',
          `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'`,
        )
        .header('cache-control', 'no-store')
        .send(quotePage(q, nonce));
    },
  );

  // The vendor saves, or submits once; audited with the address.
  app.post(
    '/api/v1/public/purchase/quotes/:token',
    { config: { auth: false }, bodyLimit: 64 * 1024 },
    async (request) => {
      const token = tokenOf(request.params);
      const body = (request.body ?? {}) as Row;
      const submit = body['submit'] === true;
      const given = Array.isArray(body['lines']) ? (body['lines'] as Row[]) : [];
      const text = (key: string, max: number) =>
        typeof body[key] === 'string' ? (body[key] as string).slice(0, max) : null;
      return asSystem('quote link', async (su) => {
        const q = await responseOfToken(su, token);
        if (q === null)
          throw new HttpProblem(
            404,
            'not-found',
            'Not found',
            'This link has expired or does not exist.',
          );
        if (q.state === 'submitted' || q.state === 'rejected' || q.state === 'not_responded')
          throw new HttpProblem(409, 'closed', 'Closed', 'This quotation was submitted already.');
        const scoped = su.withFlags({ checkCompany: false });
        for (const l of given) {
          const id = Number(l['id']);
          const price = String(l['priceUnit'] ?? '');
          if (!q.lines.some((x) => x.id === id) || !/^\d+(\.\d{1,2})?$/.test(price)) continue;
          await scoped
            .model('purchase.tender.response.line')
            .browse([id as never])
            .write({ priceUnit: price } as never);
        }
        // Only what the page sent changes: a submit after a save keeps the saved terms.
        const values: Record<string, unknown> = {};
        const delivery = text('dateDelivery', 10);
        if (delivery !== null)
          values['dateDelivery'] = /^\d{4}-\d{2}-\d{2}$/.test(delivery) ? delivery : null;
        const terms = text('paymentTerms', 200);
        if (terms !== null) values['paymentTerms'] = terms;
        const remark = text('remark', 2000);
        if (remark !== null) values['remark'] = remark;
        if (Object.keys(values).length > 0)
          await scoped
            .model('purchase.tender.response')
            .browse([q.id as never])
            .write(values as never);
        await scoped
          .model('purchase.tender.response')
          .browse([q.id as never])
          .quote();
        await su.flush();
        let state = 'quoted';
        if (submit) {
          await scoped
            .model('purchase.tender.response')
            .browse([q.id as never])
            .submit();
          state = 'submitted';
        }
        await audit(su as never, {
          kind: submit ? 'purchase.quote_submitted' : 'purchase.quote_saved',
          summary: `${q.vendor} ${submit ? 'submitted' : 'saved'} their quotation ${q.name} through their link.`,
          targetModel: 'purchase.tender.response',
          targetId: q.id,
          ip: request.ip,
        });
        await su.flush();
        return { ok: true, state };
      });
    },
  );
}
