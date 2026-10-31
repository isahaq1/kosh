/**
 * The data layer of Trade Finance (RFC 0021): import and export letters of credit under UCP 600 — the amount with its
 * tolerance, at sight or usance, the shipment and expiry dates —, amendments applied only once accepted,
 * presentations of documents with their discrepancies, accepted (with their maturity) and paid, and the limits each
 * bank gives, which issuing an LC never passes.
 */
import { contactsShutro } from '@kosh/contacts';
import { messagingShutro } from '@kosh/messaging';
import { installationSetting } from '@kosh/server';
import { type Decimal, orm } from '@kosh/server/orm';
import {
  check,
  compute,
  defineModel,
  defineModule,
  type Env,
  f,
  method,
  records,
} from './.kosh/bindings.js';

const ALL = ['read', 'write', 'create', 'unlink'] as const;
const zero = orm.toDecimal(0);

/** A date as `YYYY-MM-DD` (date-only values from PostgreSQL are local midnights: their local parts). */
export const iso = (v: unknown): string => {
  if (!(v instanceof Date)) return String(v ?? '').slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
};
export const addDays = (date: string, days: number): string => {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + days);
  return iso(d);
};
/** A monetary or decimal value as a Decimal. */
const amountOf = (v: unknown): Decimal =>
  v === null || v === undefined
    ? zero
    : typeof v === 'object' && 'amount' in (v as object)
      ? ((v as { amount: Decimal }).amount ?? zero)
      : orm.toDecimal(String(v));

/** How many days ahead the alerts look (App settings › Trade Finance). */
export async function alertDays(env: Env): Promise<number> {
  const value = Number(await installationSetting(env, 'trade_finance.alertDays', 15));
  return Number.isInteger(value) && value >= 0 ? value : 15;
}

export const INCOTERMS = {
  exw: 'EXW — Ex works',
  fca: 'FCA — Free carrier',
  fob: 'FOB — Free on board',
  cfr: 'CFR — Cost and freight',
  cif: 'CIF — Cost, insurance and freight',
  cpt: 'CPT — Carriage paid to',
  cip: 'CIP — Carriage and insurance paid to',
  dap: 'DAP — Delivered at place',
  ddp: 'DDP — Delivered duty paid',
} as const;

export const TradeLimit = defineModel('trade.lc.limit', {
  label: 'LC limit',
  order: ['bank asc', 'currency asc'],
  companyScoped: { required: true },
  access: {
    'trade_finance.user': ['read'],
    'trade_finance.manager': [...ALL, 'export'],
  },
  fields: {
    bank: f.many2one('res.partner', { required: true, ondelete: 'restrict' }),
    currency: f.many2one('res.currency', { required: true, ondelete: 'restrict' }),
    amount: f.monetary({ currency: 'currency', required: true, label: 'Limit' }),
    note: f.text(),
  },
  sqlConstraints: {
    onePerBank: {
      unique: ['company', 'bank', 'currency'],
      message: 'This bank already has a limit in this currency.',
    },
  },
});

export const TradeLc = defineModel('trade.lc', {
  label: 'Letter of credit',
  recName: 'name',
  order: ['expiryDate asc', 'id desc'],
  companyScoped: { required: true },
  tracking: ['state', 'amount', 'expiryDate', 'latestShipmentDate', 'bankReference'],
  access: {
    'trade_finance.user': ['read', 'write', 'create'],
    'trade_finance.manager': [...ALL, 'export', 'import'],
  },
  fields: {
    name: f.char({
      required: true,
      readonly: true,
      sequence: { code: 'trade.lc', dateField: 'applicationDate' },
      label: 'Reference',
    }),
    /** The LC number the bank gives when it issues it. */
    bankReference: f.char({ label: 'LC number' }),
    direction: f.selection(
      { import: 'Import (we apply)', export: 'Export (opened for us)' },
      { required: true, default: 'import' },
    ),
    bank: f.many2one('res.partner', {
      required: true,
      ondelete: 'restrict',
      label: 'Issuing bank',
    }),
    /** The vendor (import) or the customer (export). */
    partner: f.many2one('res.partner', {
      required: true,
      ondelete: 'restrict',
      label: 'Counterparty',
    }),
    currency: f.many2one('res.currency', { required: true, ondelete: 'restrict' }),
    amount: f.monetary({ currency: 'currency', required: true }),
    /** ± percent drawn beyond or short of the amount (UCP 600 art. 30). */
    tolerance: f.decimal({ scale: 2, required: true, default: '0', label: 'Tolerance (± %)' }),
    payment: f.selection(
      { sight: 'At sight', usance: 'Usance (days after acceptance)' },
      { required: true, default: 'sight' },
    ),
    usanceDays: f.integer({ label: 'Usance (days)' }),
    incoterm: f.selection(INCOTERMS, { label: 'Incoterm' }),
    applicationDate: f.date({
      required: true,
      default: (env: Env) => env.today(),
      label: 'Applied on',
    }),
    issueDate: f.date({ label: 'Issued on' }),
    latestShipmentDate: f.date({ required: true, label: 'Latest shipment' }),
    expiryDate: f.date({ required: true, label: 'Expires on' }),
    expiryPlace: f.char({ label: 'Expires at' }),
    partialShipment: f.boolean({ default: false, label: 'Partial shipments allowed' }),
    transshipment: f.boolean({ default: false, label: 'Transshipment allowed' }),
    documents: f.text({ label: 'Documents required' }),
    /** What the bank holds of ours against the LC (percent of the amount). */
    marginPercent: f.decimal({ scale: 2, default: '0', label: 'Margin (%)' }),
    origin: f.char({ label: 'Source document' }),
    amendments: f.one2many('trade.lc.amendment', 'lc'),
    presentations: f.one2many('trade.lc.presentation', 'lc'),
    /** At most the amount plus the tolerance. */
    maxDrawable: f.decimal({
      scale: 2,
      store: true,
      label: 'Can be drawn',
      ...compute('trade.lc', 'maxDrawable', ['amount', 'tolerance'], (lcs) => {
        for (const lc of lcs)
          lc.maxDrawable = amountOf(lc.amount)
            .times(orm.toDecimal(100).plus(lc.tolerance))
            .div(100)
            .toDecimalPlaces(2);
      }),
    }),
    drawn: f.decimal({
      scale: 2,
      store: true,
      label: 'Drawn',
      ...compute('trade.lc', 'drawn', ['presentations.amount', 'presentations.state'], (lcs) => {
        for (const lc of lcs)
          lc.drawn = [...lc.presentations]
            .filter((p) => p.state !== 'refused')
            .reduce((s, p) => s.plus(amountOf(p.amount)), zero);
      }),
    }),
    paid: f.decimal({
      scale: 2,
      store: true,
      label: 'Paid',
      ...compute('trade.lc', 'paid', ['presentations.amount', 'presentations.state'], (lcs) => {
        for (const lc of lcs)
          lc.paid = [...lc.presentations]
            .filter((p) => p.state === 'paid')
            .reduce((s, p) => s.plus(amountOf(p.amount)), zero);
      }),
    }),
    /** What the LC still commits the bank to (amount less paid), while issued. */
    outstanding: f.decimal({
      scale: 2,
      store: true,
      label: 'Outstanding',
      ...compute('trade.lc', 'outstanding', ['amount', 'paid', 'state'], (lcs) => {
        for (const lc of lcs) {
          const left = amountOf(lc.amount).minus(amountOf(lc.paid));
          lc.outstanding = lc.state === 'issued' && left.gt(0) ? left : zero;
        }
      }),
    }),
    note: f.text(),
    state: f.state({
      states: {
        draft: 'Draft',
        applied: 'Applied',
        issued: 'Issued',
        settled: 'Settled',
        cancel: 'Cancelled',
      },
      initial: 'draft',
      transitions: {
        apply: { from: ['draft'], to: 'applied' },
        issue: {
          from: ['applied'],
          to: 'issued',
          requires: 'trade_finance.issue',
          // Within the bank's limit, if it has one in the LC's currency.
          guard: records('trade.lc', async (lcs) => {
            const env = lcs.env as unknown as Env;
            const over: number[] = [];
            for (const lc of await lcs.load({})) {
              const [limit] = await (
                await env.model('trade.lc.limit').search({
                  where: { company: lc.company.id, bank: lc.bank.id, currency: lc.currency.id },
                  limit: 1,
                })
              ).load({});
              if (limit === undefined) continue;
              const others = await (
                await env.model('trade.lc').search({
                  where: {
                    company: lc.company.id,
                    bank: lc.bank.id,
                    currency: lc.currency.id,
                    state: 'issued',
                    id: { ne: lc.id },
                  },
                })
              ).load(['outstanding']);
              const used = [...others].reduce((s, o) => s.plus(amountOf(o.outstanding)), zero);
              if (used.plus(amountOf(lc.amount)).gt(amountOf(limit.amount))) over.push(lc.id);
            }
            return over;
          }),
          message: 'The bank’s limit would be passed: settle other LCs, or have the limit raised.',
          after: records('trade.lc', async (lcs): Promise<void> => {
            for (const lc of await lcs.load({}))
              if (lc.issueDate === null) await lc.write({ issueDate: lcs.env.today() } as never);
            await (lcs.env as unknown as Env).model('trade.lc').browse(lcs.ids).issued();
          }),
        },
        settle: {
          from: ['issued'],
          to: 'settled',
          after: records('trade.lc', async (lcs): Promise<void> => {
            await (lcs.env as unknown as Env).model('trade.lc').browse(lcs.ids).closed();
          }),
        },
        cancel: {
          from: ['draft', 'applied', 'issued'],
          to: 'cancel',
          after: records('trade.lc', async (lcs): Promise<void> => {
            await (lcs.env as unknown as Env).model('trade.lc').browse(lcs.ids).closed();
          }),
        },
        redraft: { from: ['cancel'], to: 'draft' },
      },
    }),
  },
  methods: {
    /** Runs once these LCs are recorded issued. Nothing here; `trade_finance_account` posts their margin. */
    issued: method('trade.lc', async (): Promise<void> => undefined),
    /** Runs once these LCs are settled or cancelled. Nothing here; `trade_finance_account` releases the margin. */
    closed: method('trade.lc', async (): Promise<void> => undefined),
  },
  sqlConstraints: {
    sensible: {
      check: orm.sql`tolerance >= 0 AND tolerance <= 100 AND margin_percent >= 0 AND margin_percent <= 100`,
      message: 'Tolerance and margin are percents between 0 and 100.',
    },
  },
  constraints: {
    dates: {
      ...check('trade.lc', ['latestShipmentDate', 'expiryDate', 'applicationDate'], async (lcs) =>
        [...lcs]
          .filter(
            (lc) =>
              iso(lc.latestShipmentDate) > iso(lc.expiryDate) ||
              iso(lc.expiryDate) < iso(lc.applicationDate),
          )
          .map((lc) => lc.id),
      ),
      message: 'Goods ship on or before the LC expires, and it expires after it is applied for.',
    },
    usance: {
      ...check('trade.lc', ['payment', 'usanceDays'], async (lcs) =>
        [...lcs]
          .filter((lc) => lc.payment === 'usance' && (lc.usanceDays === null || lc.usanceDays <= 0))
          .map((lc) => lc.id),
      ),
      message: 'A usance LC says after how many days it is paid.',
    },
    positive: {
      ...check('trade.lc', ['amount'], async (lcs) =>
        [...lcs].filter((lc) => amountOf(lc.amount).lte(0)).map((lc) => lc.id),
      ),
      message: 'An LC is for a positive amount.',
    },
  },
});

export const TradeAmendment = defineModel('trade.lc.amendment', {
  label: 'LC amendment',
  order: ['id asc'],
  access: {
    'trade_finance.user': ['read', 'write', 'create'],
    'trade_finance.manager': [...ALL, 'export'],
  },
  fields: {
    lc: f.many2one('trade.lc', { required: true, ondelete: 'cascade', label: 'LC' }),
    date: f.date({ required: true, default: (env: Env) => env.today() }),
    newAmount: f.decimal({ scale: 2, label: 'New amount' }),
    newExpiryDate: f.date({ label: 'New expiry' }),
    newShipmentDate: f.date({ label: 'New latest shipment' }),
    note: f.text({ label: 'What changes' }),
    state: f.state({
      states: { draft: 'Requested', accepted: 'Accepted', refused: 'Refused' },
      initial: 'draft',
      transitions: {
        // Binding once accepted (UCP 600 art. 10): only then does the LC change.
        accept: {
          from: ['draft'],
          to: 'accepted',
          requires: 'trade_finance.issue',
          before: records('trade.lc.amendment', async (amendments): Promise<void> => {
            for (const a of await amendments.load({ lc: true })) {
              const changes: Record<string, unknown> = {};
              if (a.newAmount !== null) changes['amount'] = a.newAmount.toString();
              if (a.newExpiryDate !== null) changes['expiryDate'] = iso(a.newExpiryDate);
              if (a.newShipmentDate !== null)
                changes['latestShipmentDate'] = iso(a.newShipmentDate);
              if (Object.keys(changes).length > 0)
                await amendments.env
                  .model('trade.lc')
                  .browse([a.lc.id])
                  .write(changes as never);
            }
          }),
        },
        refuse: { from: ['draft'], to: 'refused' },
      },
    }),
  },
  constraints: {
    // Amendments are to issued LCs.
    issuedOnly: {
      ...check('trade.lc.amendment', ['lc'], async (amendments) =>
        (await amendments.load({ lc: true }))
          .filter((a) => a.lc.state !== 'issued')
          .map((a) => a.id),
      ),
      message: 'Only an issued LC is amended.',
    },
  },
});

export const TradePresentation = defineModel('trade.lc.presentation', {
  label: 'Presentation',
  order: ['date asc', 'id asc'],
  access: {
    'trade_finance.user': ['read', 'write', 'create'],
    'trade_finance.manager': [...ALL, 'export'],
  },
  fields: {
    lc: f.many2one('trade.lc', { required: true, ondelete: 'cascade', label: 'LC' }),
    currency: f.many2one('res.currency', {
      store: true,
      readonly: true,
      ...compute('trade.lc.presentation', 'currency', ['lc.currency'], (presentations) => {
        for (const p of presentations) p.currency = p.lc.currency.id;
      }),
    }),
    date: f.date({ required: true, default: (env: Env) => env.today(), label: 'Presented on' }),
    amount: f.monetary({ currency: 'currency', required: true, label: 'Drawn' }),
    documents: f.text({ label: 'Documents presented' }),
    /** What the bank found that does not comply. */
    discrepancies: f.text(),
    /** The applicant accepts the documents despite the discrepancies. */
    waived: f.boolean({ default: false, label: 'Discrepancies waived' }),
    acceptedOn: f.date({ label: 'Accepted on' }),
    maturityDate: f.date({ label: 'Due on' }),
    paidOn: f.date({ label: 'Paid on' }),
    state: f.state({
      states: { presented: 'Presented', accepted: 'Accepted', paid: 'Paid', refused: 'Refused' },
      initial: 'presented',
      transitions: {
        accept: {
          from: ['presented'],
          to: 'accepted',
          guard: records('trade.lc.presentation', async (presentations) =>
            (await presentations.load({})).filter(
              (p) => (p.discrepancies ?? '').trim() !== '' && !p.waived,
            ),
          ),
          message: 'The documents are discrepant: waive the discrepancies, or refuse them.',
          // The maturity: at sight the acceptance date; usance, so many days after it.
          after: records('trade.lc.presentation', async (presentations): Promise<void> => {
            const today = iso(presentations.env.today());
            for (const p of await presentations.load({ lc: true }))
              await p.write({
                acceptedOn: today,
                maturityDate:
                  p.lc.payment === 'usance' ? addDays(today, p.lc.usanceDays ?? 0) : today,
              } as never);
          }),
        },
        pay: {
          from: ['accepted'],
          to: 'paid',
          after: records('trade.lc.presentation', async (presentations): Promise<void> => {
            const env = presentations.env as unknown as Env;
            await presentations.write({ paidOn: env.today() } as never);
            await env.model('trade.lc.presentation').browse(presentations.ids).paid();
            // An LC paid in full is settled.
            for (const p of await presentations.load({ lc: true })) {
              const [lc] = await env.model('trade.lc').browse([p.lc.id]).load({});
              if (lc?.state === 'issued' && amountOf(lc.paid).gte(amountOf(lc.amount)))
                await env.model('trade.lc').browse([lc.id]).settle();
            }
          }),
        },
        refuse: { from: ['presented'], to: 'refused' },
      },
    }),
  },
  methods: {
    /** Runs once these presentations are paid. Nothing here; `trade_finance_account` posts the payment. */
    paid: method('trade.lc.presentation', async (): Promise<void> => undefined),
  },
  constraints: {
    // Drawn only on an issued LC, never beyond the amount plus the tolerance, nor after it expired.
    withinTheLc: {
      ...check('trade.lc.presentation', ['amount', 'lc', 'date'], async (presentations) => {
        const failing: number[] = [];
        for (const p of await presentations.load({ lc: { presentations: true } })) {
          const lc = p.lc;
          const drawn = [...lc.presentations]
            .filter((x) => x.state !== 'refused')
            .reduce((s, x) => s.plus(amountOf(x.amount)), zero);
          if (
            lc.state !== 'issued' ||
            amountOf(p.amount).lte(0) ||
            drawn.gt(amountOf(lc.maxDrawable)) ||
            iso(p.date) > iso(lc.expiryDate)
          )
            failing.push(p.id);
        }
        return failing;
      }),
      message:
        'Documents are presented under an issued LC, before it expires, for no more than it allows (its amount and tolerance).',
    },
  },
});

export const tradeFinanceShutro = defineModule({
  name: 'trade_finance',
  version: '0.1.0',
  depends: [contactsShutro, messagingShutro],
  groups: [
    // Users see the banks and counterparties of their LCs.
    orm.defineGroup({
      code: 'trade_finance.user',
      label: 'Trade Finance user',
      implies: ['contacts.user'],
    }),
    orm.defineGroup({
      code: 'trade_finance.manager',
      label: 'Trade Finance manager',
      implies: ['trade_finance.user'],
    }),
  ],
  permissions: [
    orm.definePermission({
      code: 'trade_finance.issue',
      label: 'Record LCs issued and amendments accepted',
      groups: ['trade_finance.manager'],
    }),
  ],
  sequences: [
    orm.defineSequence({ code: 'trade.lc', prefix: 'LC/{year}/', padding: 5, reset: 'yearly' }),
  ],
  models: [TradeLimit, TradeLc, TradeAmendment, TradePresentation],
});
