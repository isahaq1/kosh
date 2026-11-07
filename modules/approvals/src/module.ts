/**
 * The data layer of the Approvals app (RFC 0025). The engine's models (`approval.policy`, `approval.level`,
 * `approval.request`, `approval.vote`) are in `@kosh/permissions`; this module adds **generic requests** (step 4):
 * categories (Business trip, Payment, Equipment…) saying which fields a request has and what it leads to, and the
 * requests themselves, decided through the category's own policy — a policy on `approval.ask` whose condition is the
 * category, made when the category's first request is submitted (or from the category), its levels edited like any
 * policy's. On approval, the category's **outcome** runs: nothing here; apps add theirs (`approvals_purchase`: a
 * request for quotation from the lines).
 */
import { contactsShutro } from '@kosh/contacts';
import {
  approvalGuard,
  decidersOf,
  permissionsShutro,
  requestApprovals,
  requestsOf,
} from '@kosh/permissions';
import { orm } from '@kosh/server/orm';
import {
  check,
  compute,
  defineModel,
  defineModule,
  type Env,
  f,
  method,
  record,
  records,
} from './.kosh/bindings.js';

const ALL = ['read', 'write', 'create', 'unlink', 'export', 'import'] as const;
const me = { $env: 'uid' } as const;
const ZERO = orm.toDecimal(0);

/** Whether a request of the category shows a field, and whether it must be filled. */
const PRESENCE = { none: 'Not asked', optional: 'Optional', required: 'Required' } as const;
type Presence = keyof typeof PRESENCE;

/** The presence fields of a category, by the request field they govern. */
export const ASKED = {
  amount: 'askAmount',
  period: 'askPeriod',
  partner: 'askPartner',
  location: 'askLocation',
  quantity: 'askQuantity',
  lines: 'askLines',
  attachment: 'askAttachment',
} as const;

/** The requests' own methods, typed here (the models below refer to them while they are being defined). */
type AskMethods = {
  outcomes(): Promise<Map<string, string>>;
  runOutcome(): Promise<void>;
};
const asksOf = (env: Env, ids: readonly number[]) =>
  env.model('approval.ask').browse(ids as never) as unknown as AskMethods;

/** The outcomes the installed apps offer, by code (`approval.ask.outcomes()`, which they extend). */
export async function outcomesOffered(env: Env): Promise<Map<string, string>> {
  return asksOf(env, []).outcomes();
}

/** A kind of request, its fields and its outcome. */
export const ApprovalCategory = defineModel('approval.category', {
  label: 'Request category',
  recName: 'name',
  order: ['sequence asc', 'name asc'],
  archivable: true,
  access: { 'base.user': ['read'], 'approvals.manager': ALL },
  fields: {
    name: f.char({ required: true, translate: true }),
    code: f.char({ size: 32 }),
    /** Empty: every company's. */
    company: f.many2one('res.company', { ondelete: 'cascade' }),
    sequence: f.integer({ required: true, default: 10 }),
    description: f.text({ translate: true, help: 'Shown to whoever asks: what to give and why.' }),
    askAmount: f.selection(PRESENCE, {
      required: true,
      default: 'optional',
      label: 'Amount',
      help: 'Whether a request of this category asks for an amount: not asked, optional or required.',
    }),
    askPeriod: f.selection(PRESENCE, {
      required: true,
      default: 'none',
      label: 'Period',
      help: 'Whether a request of this category asks for a period, from and until: not asked, optional or required.',
    }),
    askPartner: f.selection(PRESENCE, {
      required: true,
      default: 'none',
      label: 'Contact',
      help: 'Whether a request of this category asks for a contact: not asked, optional or required.',
    }),
    askLocation: f.selection(PRESENCE, {
      required: true,
      default: 'none',
      label: 'Location',
      help: 'Whether a request of this category asks for a location: not asked, optional or required.',
    }),
    askQuantity: f.selection(PRESENCE, {
      required: true,
      default: 'none',
      label: 'Quantity',
      help: 'Whether a request of this category asks for a quantity: not asked, optional or required.',
    }),
    askLines: f.selection(PRESENCE, {
      required: true,
      default: 'none',
      label: 'Lines',
      help: 'Whether a request of this category asks for lines with quantities and prices: not asked, optional or required.',
    }),
    askAttachment: f.selection(PRESENCE, {
      required: true,
      default: 'none',
      label: 'Attachment',
      help: 'Required: the request is submitted only with a file attached.',
    }),
    /** What an approved request leads to: one of the outcomes the installed apps offer (empty: nothing). */
    outcome: f.char({
      size: 32,
      label: 'On approval',
      help: 'Empty: nothing more. `purchase`: a request for quotation from the lines (with Purchase).',
    }),
    /** Its policy on requests (made when the first request is submitted; its levels are edited there). */
    policy: f.many2one('approval.policy', { ondelete: 'set null', label: 'Approval policy' }),
    requestCount: f.integer({
      label: 'Requests',
      ...compute('approval.category', 'requestCount', ['asks'], (categories) => {
        for (const c of categories) c.requestCount = c.asks.length;
      }),
    }),
    asks: f.one2many('approval.ask', 'category'),
  },
  sqlConstraints: {
    oneCode: { unique: ['company', 'code'], message: 'Another category has this code.' },
  },
  constraints: {
    // An outcome is one an installed app offers.
    knownOutcome: {
      ...check('approval.category', ['outcome'], async (categories): Promise<number[]> => {
        const offered = await outcomesOffered(categories.env as unknown as Env);
        return categories
          .filter((c) => c.outcome !== null && c.outcome !== '' && !offered.has(c.outcome))
          .map((c) => c.id as number);
      }),
      message: 'No installed app offers this outcome.',
    },
  },
});

const STATES = {
  draft: 'Draft',
  submitted: 'Waiting for approval',
  approved: 'Approved',
  refused: 'Refused',
  cancelled: 'Cancelled',
} as const;

/** A request of a category: what is asked, by whom, with its fields, lines and outcome. */
export const ApprovalAsk = defineModel('approval.ask', {
  label: 'Request',
  recName: 'title',
  order: ['id desc'],
  companyScoped: { required: true },
  tracking: ['state', 'amount', 'dateFrom', 'dateTo'],
  access: { 'base.user': ['read', 'write', 'create'], 'approvals.manager': ALL },
  rules: {
    // One's own requests (deciders see them through the inbox, as the system); changed while a draft or refused.
    own: { groups: ['base.user'], perms: ['read'], domain: { requester: me } },
    // Who may decide it reads it (named when it is submitted).
    deciding: { groups: ['base.user'], perms: ['read'], domain: { deciders: { any: { id: me } } } },
    ownDraft: {
      groups: ['base.user'],
      perms: ['write', 'create'],
      domain: { requester: me, state: { in: ['draft', 'refused'] } },
    },
    managers: {
      groups: ['approvals.manager'],
      perms: ['read', 'write', 'create', 'unlink'],
      domain: {},
    },
  },
  fields: {
    name: f.char({ readonly: true, sequence: 'approval.ask', label: 'Number' }),
    category: f.many2one('approval.category', { required: true, ondelete: 'restrict' }),
    title: f.char({ required: true, label: 'What for' }),
    requester: f.many2one('res.users', {
      required: true,
      default: (env: Env) => env.userId,
      ondelete: 'restrict',
      label: 'Asked by',
    }),
    description: f.text(),
    amount: f.decimal({ scale: 2 }),
    dateFrom: f.date({ label: 'From' }),
    dateTo: f.date({ label: 'Until' }),
    partner: f.many2one('res.partner', { ondelete: 'set null', label: 'Contact' }),
    location: f.char(),
    quantity: f.decimal({ scale: 3 }),
    lines: f.one2many('approval.ask.line', 'ask'),
    linesTotal: f.decimal({
      scale: 2,
      store: true,
      label: 'Lines total',
      help: 'The sum of the lines’ subtotals.',
      ...compute('approval.ask', 'linesTotal', ['lines.subtotal'], (asks) => {
        for (const a of asks)
          a.linesTotal = [...a.lines].reduce((s, l) => s.plus(l.subtotal ?? 0), ZERO);
      }),
    }),
    /** The document the outcome made (`purchase.order` 12…), shown on the request. */
    resultModel: f.char({ label: 'Made' }),
    resultId: f.integer(),
    resultName: f.char({ label: 'Made document' }),
    approvedAt: f.datetime({ label: 'Approved on' }),
    /** What the category asks for (the form shows and marks the fields by them). */
    askAmount: f.selection(PRESENCE, {
      store: true,
      help: 'Whether this request asks for an amount, as its category says.',
      ...compute('approval.ask', 'askAmount', ['category.askAmount'], (asks) => {
        for (const a of asks) a.askAmount = a.category?.askAmount ?? 'none';
      }),
    }),
    askPeriod: f.selection(PRESENCE, {
      store: true,
      help: 'Whether this request asks for a period, as its category says.',
      ...compute('approval.ask', 'askPeriod', ['category.askPeriod'], (asks) => {
        for (const a of asks) a.askPeriod = a.category?.askPeriod ?? 'none';
      }),
    }),
    askPartner: f.selection(PRESENCE, {
      store: true,
      help: 'Whether this request asks for a contact, as its category says.',
      ...compute('approval.ask', 'askPartner', ['category.askPartner'], (asks) => {
        for (const a of asks) a.askPartner = a.category?.askPartner ?? 'none';
      }),
    }),
    askLocation: f.selection(PRESENCE, {
      store: true,
      help: 'Whether this request asks for a location, as its category says.',
      ...compute('approval.ask', 'askLocation', ['category.askLocation'], (asks) => {
        for (const a of asks) a.askLocation = a.category?.askLocation ?? 'none';
      }),
    }),
    askQuantity: f.selection(PRESENCE, {
      store: true,
      help: 'Whether this request asks for a quantity, as its category says.',
      ...compute('approval.ask', 'askQuantity', ['category.askQuantity'], (asks) => {
        for (const a of asks) a.askQuantity = a.category?.askQuantity ?? 'none';
      }),
    }),
    askLines: f.selection(PRESENCE, {
      store: true,
      help: 'Whether this request asks for lines, as its category says.',
      ...compute('approval.ask', 'askLines', ['category.askLines'], (asks) => {
        for (const a of asks) a.askLines = a.category?.askLines ?? 'none';
      }),
    }),
    askAttachment: f.selection(PRESENCE, {
      store: true,
      help: 'Whether this request asks for an attached file, as its category says.',
      ...compute('approval.ask', 'askAttachment', ['category.askAttachment'], (asks) => {
        for (const a of asks) a.askAttachment = a.category?.askAttachment ?? 'none';
      }),
    }),
    /** Who may decide it: its levels' approvers and their delegates, when it was submitted. */
    deciders: f.many2many('res.users', {
      relation: 'approval_ask_decider_rel',
      label: 'Decided by',
    }),
    state: f.state({
      states: STATES,
      initial: 'draft',
      help: 'Submitted to the category’s approvers; approved, its outcome runs.',
      transitions: {
        submit: {
          from: ['draft', 'refused'],
          to: 'submitted',
          guard: records('approval.ask', async (asks) =>
            missingFields(asks.env as unknown as Env, asks.ids as readonly number[]),
          ),
          message: 'Fill in what the category asks for (and attach a file when it is required).',
          before: records('approval.ask', async (asks) => {
            // The category's policy exists before the engine looks for it.
            const env = asks.env as unknown as Env;
            const categories = new Set<number>();
            for (const a of await asks.load(['category'])) categories.add(a.category.id as number);
            await env.asSuperuser({ reason: 'request category policy' }, async (su) => {
              for (const c of categories) await ensureCategoryPolicy(su, c);
            });
          }),
          after: records('approval.ask', async (asks): Promise<void> => {
            await requestApprovals(asks);
            const env = asks.env as unknown as Env;
            const today = new Date().toISOString().slice(0, 10);
            await env.asSuperuser({ reason: 'request deciders' }, async (su) => {
              for (const id of asks.ids as readonly number[]) {
                const people = new Set<number>();
                for (const r of await requestsOf(su, 'approval.ask', id))
                  if (r.state === 'pending')
                    for (const u of await decidersOf(su, r, today)) people.add(u);
                await su
                  .model('approval.ask')
                  .browse([id as never])
                  .write({ deciders: { set: [...people] } } as never);
              }
            });
          }),
        },
        approve: {
          from: ['submitted'],
          to: 'approved',
          guard: records('approval.ask', (asks) => approvalGuard(asks)),
          message: 'Waiting for approvals.',
          // Run as the system by the engine: the outcome of each request's category.
          after: records('approval.ask', async (asks): Promise<void> => {
            const env = asks.env as unknown as Env;
            await env
              .model('approval.ask')
              .browse(asks.ids)
              .write({ approvedAt: new Date() } as never);
            await asksOf(env, asks.ids as readonly number[]).runOutcome();
            for (const id of asks.ids) await env.emit('approval.ask.approved', { id });
          }),
        },
        refuse: { from: ['submitted'], to: 'refused' },
        redraft: { from: ['submitted', 'refused', 'cancelled'], to: 'draft' },
        cancel: { from: ['draft', 'submitted', 'refused'], to: 'cancelled' },
      },
    }),
  },
  sqlConstraints: {
    amountPositive: {
      check: orm.sql`amount IS NULL OR amount >= 0`,
      message: 'An amount is not negative.',
    },
    period: {
      check: orm.sql`date_from IS NULL OR date_to IS NULL OR date_to >= date_from`,
      message: 'A period ends on or after it starts.',
    },
  },
  methods: {
    /** The outcomes the installed apps offer, by code. None here; apps add theirs. */
    outcomes: method(
      'approval.ask',
      async (): Promise<Map<string, string>> => new Map<string, string>(),
    ),
    /**
     * Runs the outcome of each approved request's category (as the system). Nothing here; an app that offers an
     * outcome makes its document for the requests of that outcome and writes `resultModel` / `resultId`.
     */
    runOutcome: method('approval.ask', async (): Promise<void> => undefined),
  },
});

/** A line of a request: what, how many, at what price. Apps add theirs (a product, with Purchase). */
export const ApprovalAskLine = defineModel('approval.ask.line', {
  label: 'Request line',
  order: ['ask asc', 'sequence asc', 'id asc'],
  access: { 'base.user': ['read', 'write', 'create', 'unlink'], 'approvals.manager': ALL },
  fields: {
    ask: f.many2one('approval.ask', { required: true, ondelete: 'cascade' }),
    sequence: f.integer({ required: true, default: 10 }),
    name: f.char({ required: true, label: 'Description' }),
    quantity: f.decimal({ scale: 3, required: true, default: '1' }),
    priceUnit: f.decimal({ scale: 2, required: true, default: '0', label: 'Unit price' }),
    subtotal: f.decimal({
      scale: 2,
      store: true,
      help: 'The quantity times the unit price.',
      ...compute('approval.ask.line', 'subtotal', ['quantity', 'priceUnit'], (lines) => {
        for (const l of lines) l.subtotal = l.quantity.times(l.priceUnit).toDecimalPlaces(2);
      }),
    }),
  },
  sqlConstraints: {
    positive: {
      check: orm.sql`quantity > 0 AND price_unit >= 0`,
      message: 'A line asks for a positive quantity at a price not below zero.',
    },
  },
});

/** The requests (of `ids`) missing a field their category requires. */
export async function missingFields(env: Env, ids: readonly number[]): Promise<number[]> {
  const bad: number[] = [];
  for (const a of await env
    .model('approval.ask')
    .browse(ids as never)
    .load({ category: true, lines: ['id'] })) {
    const c = a.category;
    const required = (key: keyof typeof ASKED) => (c[ASKED[key]] as Presence) === 'required';
    const empty =
      (required('amount') && a.amount === null) ||
      (required('period') && (a.dateFrom === null || a.dateTo === null)) ||
      (required('partner') && a.partner === null) ||
      (required('location') && (a.location ?? '').trim() === '') ||
      (required('quantity') && a.quantity === null) ||
      (required('lines') && a.lines.length === 0);
    if (empty) {
      bad.push(a.id as number);
      continue;
    }
    if (required('attachment')) {
      const files = await env.asSuperuser({ reason: 'request attachments' }, (su) =>
        su.model('storage.attachment' as never).search({
          where: { resModel: 'approval.ask', resId: a.id } as never,
          limit: 1,
        }),
      );
      if (files.ids.length === 0) bad.push(a.id as number);
    }
  }
  return bad;
}

/**
 * The category's policy on requests (as the system): made when missing — its condition the category, one level
 * decided by the requester's manager (an Approvals manager without one) —, kept as it is when it exists.
 */
export async function ensureCategoryPolicy(su: Env, category: number): Promise<number> {
  const [c] = await su
    .model('approval.category')
    .browse([category as never])
    .load(['name', 'policy', 'company']);
  if (c === undefined) throw new Error(`approval.category ${category} is missing`);
  if (c.policy !== null) return c.policy.id as number;
  const policy = await su.model('approval.policy').create([
    {
      name: `Requests: ${String(c.name)}`,
      targetModel: 'approval.ask',
      condition: { category },
      company: c.company?.id ?? null,
      onApproved: 'approve',
      onRejected: 'refuse',
      onSentBack: 'redraft',
      onWithdrawn: 'redraft',
    } as never,
  ]);
  const id = policy.ids[0] as number;
  await su.model('approval.level').create([
    {
      policy: id,
      sequence: 10,
      name: 'Manager',
      approverKind: 'manager',
      approverRole: 'approvals.manager',
    } as never,
  ]);
  await su
    .model('approval.category')
    .browse([category as never])
    .write({ policy: id } as never);
  return id;
}

export const approvalsShutro = defineModule({
  name: 'approvals',
  version: '0.2.0',
  depends: [permissionsShutro, contactsShutro],
  sequences: [orm.defineSequence({ code: 'approval.ask', prefix: 'REQ-', padding: 5 })],
  models: [ApprovalCategory, ApprovalAsk, ApprovalAskLine],
  // The categories every installation starts with (theirs to change afterwards).
  data: [
    record(
      'approval.category',
      'category_trip',
      {
        name: 'Business trip',
        code: 'TRIP',
        sequence: 10,
        description: 'Where, when and the estimated cost.',
        askAmount: 'required',
        askPeriod: 'required',
        askLocation: 'required',
      },
      { noupdate: true },
    ),
    record(
      'approval.category',
      'category_payment',
      {
        name: 'Payment',
        code: 'PAY',
        sequence: 20,
        description: 'To whom, how much and why; attach the invoice or quotation.',
        askAmount: 'required',
        askPartner: 'required',
        askAttachment: 'required',
      },
      { noupdate: true },
    ),
    record(
      'approval.category',
      'category_purchase',
      {
        name: 'Purchase request',
        code: 'PR',
        sequence: 30,
        description: 'What to buy: the lines, and the vendor when known.',
        askAmount: 'none',
        askPartner: 'optional',
        askLines: 'required',
      },
      { noupdate: true },
    ),
    record(
      'approval.category',
      'category_general',
      {
        name: 'General',
        code: 'GEN',
        sequence: 90,
        description: 'Anything else that needs a decision.',
      },
      { noupdate: true },
    ),
  ],
});
