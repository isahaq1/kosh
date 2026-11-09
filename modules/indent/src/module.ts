/**
 * The data layer of Requests (RFC 0032 §3.1): a section asks its store for goods by an **indent**. Product groups
 * name who approves their products; an indent is decided through the approval engine (the requester's department
 * head, then the approvers of its products' groups), each level able to lower the approved quantities. The store
 * issues what was approved by an internal transfer from the warehouse to an internal-use location — reserved,
 * lots first-expiry-first-out, valued by `stock_account` — partly or at once; what each line still owes follows from
 * the validated transfers. The requester acknowledges what arrived, which closes the indent.
 *
 * Requesters see their own indents and those they decide; store keepers the indents of every warehouse of their
 * companies; Requests managers everything and the configuration.
 */
import { hrShutro } from '@kosh/hr';
import { approvalGuard, permissionsShutro, requestApprovals } from '@kosh/permissions';
import { productShutro } from '@kosh/product';
import { type Decimal, orm } from '@kosh/server/orm';
import { defaultLocations, onHandIn, stockShutro, transitLocation } from '@kosh/stock';
import {
  check,
  compute,
  defineModel,
  defineModule,
  type Env,
  extendModel,
  f,
  method,
  onchange,
  records,
} from './.kosh/bindings.js';

const READ = ['read'] as const;
const ALL = ['read', 'write', 'create', 'unlink'] as const;
const me = { $env: 'uid' } as const;
const zero: Decimal = orm.toDecimal(0);

export const IndentProductGroup = defineModel('indent.product.group', {
  label: 'Product group',
  recName: 'name',
  order: ['name asc'],
  archivable: true,
  access: {
    'indent.user': READ,
    'indent.store': READ,
    'indent.manager': [...ALL, 'export', 'import'],
  },
  fields: {
    name: f.char({ required: true, translate: true }),
    categories: f.many2many('product.category', {
      relation: 'indent_group_category',
      label: 'Product categories',
      help: 'Products of these categories, and of the categories inside them, belong to the group.',
    }),
    approvalUsers: f.many2many('res.users', {
      relation: 'indent_group_approver',
      label: 'Approvers',
      help: 'Who approves indents for the group’s products (the approval level where the record names the approvers).',
    }),
    note: f.text({ label: 'Guidance', translate: true }),
  },
});

/** The group of a product: the first group naming its category or a category above it. */
async function groupOf(env: Env, product: number | null): Promise<number | null> {
  if (product === null) return null;
  const [p] = await env
    .model('product.product')
    .browse([product as never])
    .load({ category: true });
  let category = (p?.category?.id as number | undefined) ?? null;
  for (let depth = 0; category !== null && depth < 10; depth += 1) {
    const found = await env
      .model('indent.product.group')
      .search({ where: { categories: { any: { id: category } } } as never, limit: 1 });
    if (found.ids[0] !== undefined) return found.ids[0] as number;
    const [c] = await env
      .model('product.category')
      .browse([category as never])
      .load({ parent: true });
    category = (c?.parent?.id as number | undefined) ?? null;
  }
  return null;
}

/** What validated transfers of the given notes moved, by their moves. */
function done(
  moves: Iterable<{
    quantity: Decimal;
    quantityDone: Decimal | null;
    picking: { state: string; noteKind: string | null };
  }>,
  note: (kind: string | null) => boolean,
): Decimal {
  return [...moves]
    .filter((m) => m.picking.state === 'done' && note(m.picking.noteKind))
    .reduce((s, m) => s.plus(m.quantityDone ?? m.quantity), zero);
}

/** The employee of a user, with their department, if they have one. */
async function employeeOf(
  env: Env,
  user: number,
): Promise<{ id: number; department: number | null } | null> {
  const found = await env.model('hr.employee').search({ where: { user: user as never }, limit: 1 });
  const [e] = await found.load({ department: true });
  return e === undefined
    ? null
    : { id: e.id as number, department: (e.department?.id as number | undefined) ?? null };
}

const STATES = {
  draft: 'Draft',
  to_approve: 'Waiting for approval',
  approved: 'Approved',
  acknowledged: 'Acknowledged',
  rejected: 'Rejected',
  cancel: 'Cancelled',
} as const;

export const IndentRequest = defineModel('indent.request', {
  label: 'Indent',
  recName: 'name',
  order: ['id desc'],
  companyScoped: { required: true },
  tracking: ['state', 'kind', 'warehouse', 'destination', 'priority', 'dateRequired'],
  access: {
    'indent.user': ALL,
    'indent.store': ALL,
    'indent.manager': [...ALL, 'export', 'import'],
  },
  rules: {
    // One's own indents; changed while a draft (or sent back as rejected).
    seeOwn: { groups: ['indent.user'], perms: ['read'], domain: { requester: me } },
    draftOwn: {
      groups: ['indent.user'],
      perms: ['write', 'create', 'unlink'],
      domain: { requester: me, state: { in: ['draft', 'rejected'] } },
    },
    // The requester acknowledges an approved indent.
    acknowledgeOwn: {
      groups: ['indent.user'],
      perms: ['write'],
      domain: { requester: me, state: 'approved' },
    },
    // Who decides: the department's head and the approvers of the products' groups see the indent.
    deciders: {
      groups: ['indent.user'],
      perms: ['read'],
      domain: {
        or: [
          { 'department.head.user': me },
          { lines: { any: { 'group.approvalUsers': { any: { id: me } } } } },
        ],
      },
    },
    // Store keepers: every indent of their companies (the company rule applies).
    store: { groups: ['indent.store'], perms: ['read', 'write'], domain: {} },
    all: { groups: ['indent.manager'], perms: [...ALL], domain: {} },
  },
  fields: {
    name: f.char({ required: true, sequence: 'indent.request', label: 'Reference' }),
    requester: f.many2one('res.users', {
      required: true,
      ondelete: 'restrict',
      default: (env: Env) => env.userId,
      label: 'Requested by',
    }),
    kind: f.selection(
      { issue: 'Issue for use', transfer: 'Transfer to a warehouse' },
      {
        required: true,
        default: 'issue',
        label: 'Request',
        help: 'Goods issued for a section’s use, or stock sent from the store to another warehouse through transit.',
      },
    ),
    employee: f.many2one('hr.employee', { ondelete: 'set null' }),
    department: f.many2one('hr.department', {
      ondelete: 'set null',
      help: 'The requester’s department: its head approves the indent first.',
    }),
    warehouse: f.many2one('stock.warehouse', {
      required: true,
      ondelete: 'restrict',
      label: 'Store',
      help: 'The warehouse asked for the goods.',
    }),
    destination: f.many2one('stock.location', {
      required: true,
      ondelete: 'restrict',
      label: 'Goes to',
      help: 'An internal-use location of the section (issued goods leave stock there), or the stock location of the warehouse receiving a transfer.',
    }),
    dateRequired: f.date({
      required: true,
      label: 'Needed by',
      default: (env: Env) => env.today(),
    }),
    priority: f.selection(
      { normal: 'Normal', high: 'High', urgent: 'Urgent', critical: 'Critical' },
      { required: true, default: 'normal', help: 'How soon the goods are needed, shown as stars.' },
    ),
    purpose: f.text(),
    lines: f.one2many('indent.request.line', 'request', { label: 'Products' }),
    pickings: f.one2many('stock.picking', 'indent', { label: 'Transfers' }),
    issueCount: f.integer({
      label: 'Transfers',
      ...compute('indent.request', 'issueCount', ['pickings'], (requests) => {
        for (const r of requests) r.issueCount = r.pickings.length;
      }),
    }),
    issueStatus: f.selection(
      { none: 'Nothing issued', partial: 'Partly issued', full: 'Issued in full' },
      {
        store: true,
        label: 'Issued',
        help: 'What arrived of the approved quantities, by validated transfers (for a transfer: received; a shortage recorded counts as settled).',
        ...compute(
          'indent.request',
          'issueStatus',
          ['lines.qtyApproved', 'lines.qtyIssued', 'lines.qtyShort'],
          (requests) => {
            for (const r of requests) {
              const lines = [...r.lines].filter((l) => (l.qtyApproved ?? zero).gt(0));
              const issued = lines.filter((l) => (l.qtyIssued ?? zero).gt(0));
              r.issueStatus =
                issued.length === 0
                  ? 'none'
                  : lines.every((l) =>
                        (l.qtyIssued ?? zero).plus(l.qtyShort ?? zero).gte(l.qtyApproved ?? zero),
                      )
                    ? 'full'
                    : 'partial';
            }
          },
        ),
      },
    ),
    rejectReason: f.char({ size: 300, label: 'Rejected because' }),
    shortageReason: f.char({
      size: 300,
      label: 'Shortage because',
      help: 'Why goods shipped were not received (lost, damaged on the road): written off from transit.',
    }),
    acknowledgedOn: f.date({ label: 'Acknowledged on' }),
    state: f.state({
      states: STATES,
      initial: 'draft',
      help: 'Drafted by the requester, approved by the department head and the products’ group approvers, issued by the store, then acknowledged by the requester.',
      transitions: {
        submit: {
          from: ['draft', 'rejected'],
          to: 'to_approve',
          guard: records('indent.request', async (requests) =>
            [...(await requests.load({ lines: true }))]
              .filter((r) => r.lines.length === 0)
              .map((r) => r.id),
          ),
          message: 'Add the products before submitting the indent.',
          // Approved quantities start as requested; approvers may lower them.
          before: records('indent.request', async (requests) => {
            for (const r of await requests.load({ lines: true }))
              for (const l of r.lines)
                await l.write({ qtyApproved: l.quantity, rejectReason: null } as never);
            await requests.write({ rejectReason: null } as never);
          }),
          after: records('indent.request', async (requests) => {
            await requestApprovals(requests);
            for (const r of await requests.load({}))
              await requests.env.emit('indent.request.submitted', { id: r.id });
          }),
        },
        approve: {
          from: ['to_approve'],
          to: 'approved',
          guard: records('indent.request', (requests) => approvalGuard(requests)),
          message: 'Waiting for approvals.',
          after: records('indent.request', async (requests) => {
            for (const r of await requests.load({}))
              await requests.env.emit('indent.request.approved', { id: r.id });
          }),
        },
        reject: { from: ['to_approve'], to: 'rejected' },
        redraft: { from: ['rejected', 'cancel'], to: 'draft' },
        cancel: {
          from: ['draft', 'to_approve', 'rejected'],
          to: 'cancel',
        },
        /**
         * Issues what is still owed: one transfer from the store to where the goods are used (RFC 0032 §3.1), or for a
         * transfer the Stock Transfer Note into the store's transit location (§3.1, step 2).
         */
        issue: {
          from: ['approved'],
          to: 'approved',
          requires: 'indent.issue',
          guard: records('indent.request', async (requests) =>
            [...(await requests.load({ lines: true }))]
              .filter((r) => [...r.lines].every((l) => (l.qtyRemaining ?? zero).lte(0)))
              .map((r) => r.id),
          ),
          message: 'Nothing is left to issue.',
          after: records('indent.request', async (requests) => {
            const env = requests.env as unknown as Env;
            await env.flush();
            for (const id of requests.ids) await issueRemaining(env, id as number);
          }),
        },
        /** What was shipped and not received is written off from transit, with the reason (RFC 0032 §3.1). */
        shortage: {
          from: ['approved'],
          to: 'approved',
          requires: 'indent.issue',
          guard: records('indent.request', async (requests) =>
            [...(await requests.load({ pickings: true }))]
              .filter(
                (r) =>
                  (r.shortageReason ?? '').trim() === '' ||
                  ![...r.pickings].some((p) => p.noteKind === 'srn' && p.state === 'confirmed'),
              )
              .map((r) => r.id),
          ),
          message: 'Say why, on a transfer with goods still in transit.',
          after: records('indent.request', async (requests) => {
            const env = requests.env as unknown as Env;
            await env.flush();
            for (const id of requests.ids) await writeOffShortage(env, id as number);
          }),
        },
        /** The requester confirms what arrived; what was not issued is no longer owed. */
        acknowledge: {
          from: ['approved'],
          to: 'acknowledged',
          guard: records('indent.request', async (requests) =>
            [...(await requests.load({}))]
              .filter((r) => r.issueStatus === 'none' || r.requester.id !== requests.env.userId)
              .map((r) => r.id),
          ),
          message: 'The requester acknowledges what the store issued.',
          after: records('indent.request', async (requests) => {
            const env = requests.env as unknown as Env;
            await requests.write({ acknowledgedOn: env.today() } as never);
            for (const r of await requests.load({}))
              await env.emit('indent.request.acknowledged', { id: r.id });
          }),
        },
      },
      extensible: true, // indent_purchase asks Purchase for the shortfall
    }),
  },
  constraints: {
    // An internal-use location: issued goods leave stock there.
    usedAt: {
      ...check('indent.request', ['destination', 'kind'], async (requests) =>
        [...(await requests.load({ destination: true }))]
          .filter((r) => r.kind === 'issue' && r.destination.usage !== 'consumption')
          .map((r) => r.id),
      ),
      message: 'Goods are issued to an internal-use location.',
    },
    // A transfer goes to the stock of another warehouse.
    transferTo: {
      ...check('indent.request', ['destination', 'kind', 'warehouse'], async (requests) =>
        [...(await requests.load({ destination: true }))]
          .filter(
            (r) =>
              r.kind === 'transfer' &&
              (r.destination.usage !== 'internal' ||
                r.destination.transit === true ||
                r.destination.warehouse === null ||
                r.destination.warehouse.id === r.warehouse.id),
          )
          .map((r) => r.id),
      ),
      message: 'A transfer goes to a stock location of another warehouse.',
    },
  },
  methods: {
    /**
     * The approvers each indent names for a level where "the record decides" (RFC 0027 §2.1): those of its lines'
     * product groups.
     */
    approvalUsers: method('indent.request', async function (this: unknown, _key: string): Promise<
      Map<number, number[]>
    > {
      const requests = this as { env: Env; ids: readonly number[] };
      const out = new Map<number, number[]>();
      for (const r of await requests.env
        .model('indent.request')
        .browse([...requests.ids] as never)
        .load({ lines: { group: { approvalUsers: true } } })) {
        const people = new Set<number>();
        for (const l of r.lines)
          for (const u of l.group?.approvalUsers ?? []) people.add(u.id as number);
        out.set(r.id as number, [...people]);
      }
      return out;
    }),
  },
  onchange: {
    // The requester's employee and department, the company's first store and the internal-use location: when the
    // requester changes, and when the purpose is typed on a new indent.
    requester: onchange(
      'indent.request',
      async (d, env): Promise<void> => fillRequest(d as never, env, true),
    ),
    purpose: onchange(
      'indent.request',
      async (d, env): Promise<void> => fillRequest(d as never, env, false),
    ),
    // Where the goods go follows the kind: internal use for an issue, chosen for a transfer.
    kind: onchange('indent.request', async (d, env): Promise<void> => {
      const draft = d as unknown as { get(k: string): unknown; set(k: string, v: unknown): void };
      draft.set('destination', draft.get('kind') === 'transfer' ? null : await internalUse(env));
    }),
  },
});

async function fillRequest(
  d: { get(key: string): unknown; set(key: string, value: unknown): void },
  env: Env,
  requesterChanged: boolean,
): Promise<void> {
  if (requesterChanged || (d.get('department') ?? null) === null) {
    const user = (d.get('requester') as number | null) ?? env.userId;
    const employee = await employeeOf(env, user as number);
    d.set('employee', employee?.id ?? null);
    d.set('department', employee?.department ?? null);
  }
  if ((d.get('warehouse') ?? null) === null) {
    const places = await defaultLocations(env as never, 'internal');
    if (places.warehouse !== null) d.set('warehouse', places.warehouse);
  }
  if ((d.get('destination') ?? null) === null && d.get('kind') !== 'transfer') {
    const used = await internalUse(env);
    if (used !== null) d.set('destination', used);
  }
}

/** The shared internal-use location (`Internal use`), if any. */
async function internalUse(env: Env): Promise<number | null> {
  const found = await env
    .model('stock.location')
    .search({ where: { usage: 'consumption' }, order: ['id asc'], limit: 1 });
  return (found.ids[0] as number | undefined) ?? null;
}

/**
 * Makes and confirms one transfer for what an approved indent still owes, from the store's stock to where the goods
 * are used (reserved on confirmation). Runs as the store keeper; the moves link the indent lines.
 */
async function issueRemaining(env: Env, id: number): Promise<number | null> {
  const [r] = await env
    .model('indent.request')
    .browse([id as never])
    .load({
      lines: { product: true, uom: true },
      warehouse: true,
      destination: true,
      company: true,
    });
  if (r === undefined) return null;
  const owed = r.lines.filter((l) => (l.qtyRemaining ?? zero).gt(0));
  if (owed.length === 0) return null;
  const places = await defaultLocations(env as never, 'internal', r.warehouse.id, r.company.id);
  if (places.source === null)
    throw new orm.ValidationError(
      'indent.request',
      ['warehouse'],
      `${r.warehouse.name} has no stock location.`,
      'Add its stock location in Stockroom › Configuration › Locations.',
    );
  // A transfer ships into the store's transit location first (the Stock Transfer Note); the receipt follows.
  const transfer = r.kind === 'transfer';
  const made = await env.model('stock.picking').create([
    {
      kind: 'internal',
      company: r.company.id,
      warehouse: r.warehouse.id,
      source: places.source,
      destination: transfer
        ? await transitLocation(env as never, r.warehouse.id)
        : r.destination.id,
      origin: r.name,
      indent: r.id,
      noteKind: transfer ? 'stn' : null,
      moves: {
        create: owed.map((l) => ({
          product: l.product.id,
          name: l.product.name,
          quantity: l.qtyRemaining,
          uom: l.uom?.id ?? null,
          indentLine: l.id,
        })),
      },
    },
  ] as never);
  await made.confirm();
  await env.emit('indent.request.issued', { id: r.id });
  return (made.ids[0] as number | undefined) ?? null;
}

/**
 * For each validated Stock Transfer Note, the Stock Receive Note of what it shipped: from the store's transit
 * location to the receiving warehouse, confirmed so the goods in transit are reserved for it. Runs in the
 * validation's audited superuser scope.
 */
async function receiveNotes(env: Env, pickings: readonly number[]): Promise<void> {
  for (const p of await env
    .model('stock.picking')
    .browse([...pickings] as never)
    .load({
      moves: { product: true, uom: true, indentLine: true },
      indent: { destination: true },
    })) {
    if (p.noteKind !== 'stn' || p.indent === null) continue;
    const shipped = p.moves.filter((m) => (m.doneQty ?? zero).gt(0));
    if (shipped.length === 0) continue;
    const made = await env.model('stock.picking').create([
      {
        kind: 'internal',
        company: p.company.id,
        warehouse: p.indent.destination.warehouse?.id ?? null,
        source: p.destination.id,
        destination: p.indent.destination.id,
        origin: `${p.indent.name} · ${p.name}`,
        indent: p.indent.id,
        noteKind: 'srn',
        moves: {
          create: shipped.map((m) => ({
            product: m.product.id,
            name: m.name,
            quantity: m.doneQty,
            uom: m.uom?.id ?? null,
            indentLine: m.indentLine?.id ?? null,
          })),
        },
      },
    ] as never);
    await made.confirm();
    await env.emit('indent.request.shipped', { id: p.indent.id });
  }
}

/**
 * Writes off what an indent's open receive notes still carry: each is cancelled (its reservations released) and an
 * inventory adjustment takes the goods out of transit, valued as a loss by `stock_account`.
 */
async function writeOffShortage(env: Env, id: number): Promise<void> {
  const [r] = await env
    .model('indent.request')
    .browse([id as never])
    .load({ pickings: { moves: { product: true, uom: true, indentLine: true } }, company: true });
  if (r === undefined) return;
  const open = r.pickings.filter((p) => p.noteKind === 'srn' && p.state === 'confirmed');
  if (open.length === 0) return;
  const adjustment = (
    await env
      .model('stock.location')
      .search({ where: { usage: 'adjustment' }, order: ['id asc'], limit: 1 })
  ).ids[0];
  if (adjustment === undefined) return;
  for (const p of open) {
    await env.model('stock.picking').browse([p.id]).cancel();
    const loss = await env.model('stock.picking').create([
      {
        kind: 'adjustment',
        company: r.company.id,
        warehouse: p.warehouse?.id ?? null,
        source: p.source.id,
        destination: adjustment,
        origin: `${r.name} · ${p.name} · ${r.shortageReason ?? ''}`,
        indent: r.id,
        noteKind: 'short',
        note: r.shortageReason,
        moves: {
          create: p.moves.map((m) => ({
            product: m.product.id,
            name: m.name,
            quantity: m.quantity,
            uom: m.uom?.id ?? null,
            indentLine: m.indentLine?.id ?? null,
          })),
        },
      },
    ] as never);
    await loss.confirm();
    await loss.validate();
  }
}

export const IndentRequestLine = defineModel('indent.request.line', {
  label: 'Indent line',
  order: ['request desc', 'sequence asc', 'id asc'],
  access: {
    'indent.user': ALL,
    'indent.store': ALL,
    'indent.manager': [...ALL, 'export', 'import'],
  },
  rules: {
    seeOwn: { groups: ['indent.user'], perms: ['read'], domain: { 'request.requester': me } },
    draftOwn: {
      groups: ['indent.user'],
      perms: ['write', 'create', 'unlink'],
      domain: { 'request.requester': me, 'request.state': { in: ['draft', 'rejected'] } },
    },
    // The deciders see the lines and lower approved quantities while the indent waits for them.
    deciders: {
      groups: ['indent.user'],
      perms: ['read'],
      domain: {
        or: [
          { 'request.department.head.user': me },
          { 'request.lines': { any: { 'group.approvalUsers': { any: { id: me } } } } },
        ],
      },
    },
    lowering: {
      groups: ['indent.user'],
      perms: ['write'],
      domain: {
        'request.state': 'to_approve',
        or: [
          { 'request.department.head.user': me },
          { 'group.approvalUsers': { any: { id: me } } },
        ],
      },
    },
    store: { groups: ['indent.store'], perms: ['read', 'write'], domain: {} },
    all: { groups: ['indent.manager'], perms: [...ALL], domain: {} },
  },
  fields: {
    request: f.many2one('indent.request', { required: true, ondelete: 'cascade', label: 'Indent' }),
    sequence: f.integer({ default: 10 }),
    product: f.many2one('product.product', { required: true, ondelete: 'restrict' }),
    group: f.many2one('indent.product.group', {
      ondelete: 'set null',
      label: 'Product group',
      help: 'The group naming the product’s category (or one above it); its approvers decide the indent.',
      store: true,
      ...compute('indent.request.line', 'group', ['product', 'product.category'], async (lines) => {
        const env = (lines as unknown as { env: Env }).env;
        for (const l of lines) l.group = (await groupOf(env, l.product.id as number)) as never;
      }),
    }),
    uom: f.many2one('uom.uom', { ondelete: 'restrict', label: 'Unit' }),
    quantity: f.decimal({ scale: 3, required: true, default: '1', label: 'Requested' }),
    qtyApproved: f.decimal({
      scale: 3,
      label: 'Approved',
      help: 'As requested when submitted; an approver may lower it, never raise it.',
    }),
    moves: f.one2many('stock.move', 'indentLine'),
    qtyIssued: f.decimal({
      scale: 3,
      store: true,
      label: 'Issued',
      help: 'Issued by validated transfers from the store; for a transfer, received at the other warehouse.',
      ...compute(
        'indent.request.line',
        'qtyIssued',
        ['moves.quantity', 'moves.quantityDone', 'moves.picking.state', 'moves.picking.noteKind'],
        (lines) => {
          for (const l of lines) l.qtyIssued = done(l.moves, (k) => k === null || k === 'srn');
        },
      ),
    }),
    qtyShipped: f.decimal({
      scale: 3,
      store: true,
      label: 'Shipped',
      help: 'For a transfer: sent by validated Stock Transfer Notes.',
      ...compute(
        'indent.request.line',
        'qtyShipped',
        ['moves.quantity', 'moves.quantityDone', 'moves.picking.state', 'moves.picking.noteKind'],
        (lines) => {
          for (const l of lines) l.qtyShipped = done(l.moves, (k) => k === 'stn');
        },
      ),
    }),
    qtyShort: f.decimal({
      scale: 3,
      store: true,
      label: 'Short',
      help: 'Shipped and never received: written off from transit with the reason.',
      ...compute(
        'indent.request.line',
        'qtyShort',
        ['moves.quantity', 'moves.quantityDone', 'moves.picking.state', 'moves.picking.noteKind'],
        (lines) => {
          for (const l of lines) l.qtyShort = done(l.moves, (k) => k === 'short');
        },
      ),
    }),
    inTransit: f.decimal({
      scale: 3,
      label: 'In transit',
      help: 'Shipped, not received yet and not written off.',
      ...compute(
        'indent.request.line',
        'inTransit',
        ['qtyShipped', 'qtyIssued', 'qtyShort', 'request.kind'],
        (lines) => {
          for (const l of lines) {
            const left = (l.qtyShipped ?? zero)
              .minus(l.qtyIssued ?? zero)
              .minus(l.qtyShort ?? zero);
            l.inTransit = l.request.kind === 'transfer' && left.gt(0) ? left : zero;
          }
        },
      ),
    }),
    qtyRemaining: f.decimal({
      scale: 3,
      store: true,
      label: 'Still owed',
      help: 'Approved and not issued yet (in transfers waiting, or not issued at all).',
      ...compute(
        'indent.request.line',
        'qtyRemaining',
        [
          'qtyApproved',
          'moves.quantity',
          'moves.quantityDone',
          'moves.picking.state',
          'moves.picking.noteKind',
          'request.state',
        ],
        (lines) => {
          for (const l of lines) {
            if (l.request.state !== 'approved') {
              l.qtyRemaining = zero;
              continue;
            }
            // What open transfers already carry is not owed again (for a transfer: what was shipped or will be).
            const planned = [...l.moves]
              .filter(
                (m) =>
                  m.picking.state !== 'cancel' &&
                  (m.picking.noteKind === null || m.picking.noteKind === 'stn'),
              )
              .reduce(
                (s, m) =>
                  s.plus(m.picking.state === 'done' ? (m.quantityDone ?? m.quantity) : m.quantity),
                zero,
              );
            const left = (l.qtyApproved ?? zero).minus(planned);
            l.qtyRemaining = left.gt(0) ? left : zero;
          }
        },
      ),
    }),
    onHand: f.decimal({
      scale: 3,
      label: 'On hand in the store',
      help: 'What the store’s warehouse holds of the product now.',
      ...compute(
        'indent.request.line',
        'onHand',
        ['product', 'request.warehouse', 'request.company'],
        async (lines) => {
          const env = (lines as unknown as { env: Env }).env;
          for (const l of lines) {
            const places = await defaultLocations(
              env as never,
              'internal',
              l.request.warehouse.id,
              l.request.company.id,
            );
            l.onHand =
              places.source === null
                ? zero
                : await onHandIn(env as never, l.product.id, places.source);
          }
        },
      ),
    }),
    note: f.char({ size: 300 }),
    rejectReason: f.char({ size: 300, label: 'Lowered because' }),
  },
  sqlConstraints: {
    positive: {
      check: orm.sql`quantity > 0 AND (qty_approved IS NULL OR qty_approved >= 0)`,
      message: 'Requested quantities are positive.',
    },
  },
  constraints: {
    notAbove: {
      ...check('indent.request.line', ['quantity', 'qtyApproved'], async (lines) =>
        [...lines].filter((l) => l.qtyApproved?.gt(l.quantity)).map((l) => l.id),
      ),
      message: 'An approved quantity is never above the requested one.',
    },
  },
  onchange: {
    product: onchange('indent.request.line', async (d) => {
      const product = (await d.record('product')) as {
        id: number;
        uom: { id: number } | null;
      } | null;
      if (product === null) return;
      if (product.uom !== null) d.set('uom', product.uom.id as never);
    }),
  },
});

// Requesters read the stores and locations they ask from, and the issues of their own indents.
export const WarehouseIndent = extendModel('stock.warehouse', { access: { 'indent.user': READ } });
export const LocationIndent = extendModel('stock.location', { access: { 'indent.user': READ } });
// What the store holds, beside each line.
export const QuantIndent = extendModel('stock.quant', { access: { 'indent.user': READ } });

export const PickingIndent = extendModel('stock.picking', {
  access: { 'indent.user': READ },
  rules: {
    indentIssues: {
      groups: ['indent.user'],
      perms: ['read'],
      domain: { 'indent.requester': me },
    },
    // Stockroom's own users stay unrestricted (a rule naming indent.user would otherwise bind store keepers).
    stockroom: { groups: ['stock.user'], perms: [...ALL], domain: {} },
  },
  fields: {
    indent: f.many2one('indent.request', { ondelete: 'set null', label: 'Indent' }),
    noteKind: f.selection(
      { stn: 'Stock Transfer Note', srn: 'Stock Receive Note', short: 'Shortage in transit' },
      {
        label: 'Note',
        help: 'For a transfer indent: the shipment into transit, its receipt at the other warehouse, or what was lost on the road.',
      },
    ),
  },
  overrides: {
    // The rest of a partial issue stays with its indent.
    backorderValues: async function (
      this: unknown,
      next: () => Promise<Map<number, Record<string, unknown>>>,
    ): Promise<Map<number, Record<string, unknown>>> {
      const out = await next();
      for (const p of await (
        this as {
          load(
            spec: object,
          ): Promise<
            Iterable<{ id: number; indent: { id: number } | null; noteKind: string | null }>
          >;
        }
      ).load({}))
        out.set(p.id, { ...out.get(p.id), indent: p.indent?.id ?? null, noteKind: p.noteKind });
      return out;
    },
    // A shipped Stock Transfer Note brings its Stock Receive Note.
    validated: async function (this: unknown, next: () => Promise<void>): Promise<void> {
      await next();
      const pickings = this as { env: Env; ids: readonly number[] };
      await receiveNotes(pickings.env, pickings.ids);
    },
  },
});

export const MoveIndent = extendModel('stock.move', {
  access: { 'indent.user': READ },
  rules: {
    indentIssues: {
      groups: ['indent.user'],
      perms: ['read'],
      domain: { 'indentLine.request.requester': me },
    },
    // Stockroom's own users stay unrestricted (a rule naming indent.user would otherwise bind store keepers).
    stockroom: { groups: ['stock.user'], perms: [...ALL], domain: {} },
  },
  fields: {
    indentLine: f.many2one('indent.request.line', { ondelete: 'set null', label: 'Indent line' }),
  },
  overrides: {
    backorderValues: async function (
      this: unknown,
      next: () => Promise<Map<number, Record<string, unknown>>>,
    ): Promise<Map<number, Record<string, unknown>>> {
      const out = await next();
      for (const m of await (
        this as {
          load(spec: object): Promise<Iterable<{ id: number; indentLine: { id: number } | null }>>;
        }
      ).load({}))
        out.set(m.id, { ...out.get(m.id), indentLine: m.indentLine?.id ?? null });
      return out;
    },
  },
});

export const indentShutro = defineModule({
  name: 'indent',
  version: '0.1.0',
  depends: [hrShutro, productShutro, stockShutro, permissionsShutro],
  groups: [
    orm.defineGroup({
      code: 'indent.user',
      label: 'Requests: own indents',
      implies: ['hr.user', 'product.user'],
    }),
    orm.defineGroup({
      code: 'indent.store',
      label: 'Requests: store keeper',
      implies: ['indent.user', 'stock.user'],
    }),
    orm.defineGroup({
      code: 'indent.manager',
      label: 'Requests manager',
      implies: ['indent.store'],
    }),
  ],
  permissions: [
    orm.definePermission({
      code: 'indent.issue',
      label: 'Issue goods for indents',
      groups: ['indent.store'],
    }),
  ],
  sequences: [
    orm.defineSequence({
      code: 'indent.request',
      prefix: 'IND/{year}/',
      padding: 5,
      reset: 'yearly',
    }),
  ],
  models: [IndentProductGroup, IndentRequest, IndentRequestLine],
  extensions: [WarehouseIndent, LocationIndent, QuantIndent, PickingIndent, MoveIndent],
});
