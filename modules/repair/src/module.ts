/**
 * The data layer of Repairs (RFC 0038, step 4): a **repair order** follows a customer's item from the counter
 * back to the customer — taken in with what the customer says is wrong, **diagnosed**, **quoted** with its parts
 * and labour, accepted or declined by the customer, **repaired**, and **handed back**.
 *
 * Under warranty nothing is charged and no quotation is needed. An item — by its serial number — is in repair
 * once at a time, and its earlier repairs are one click away. What other apps do with an order (parts from
 * stock, the invoice) hangs on its hooks: `started`, `finishing`, `cancelled`, `returned`.
 */
import { contactsShutro } from '@kosh/contacts';
import { messagingShutro } from '@kosh/messaging';
import { productShutro } from '@kosh/product';
import { emitting } from '@kosh/server';
import { type Decimal, orm } from '@kosh/server/orm';
import {
  check,
  compute,
  defineModel,
  defineModule,
  type Env,
  f,
  method,
  onchange,
  records,
} from './.kosh/bindings.js';

const ALL = ['read', 'write', 'create', 'unlink'] as const;
/** Fields the server maintains: written by its own code and by Administrators only. */
const SYSTEM = ['base.admin'] as const;
const zero: Decimal = orm.toDecimal(0);

/** States in which the item is with the workshop and the order is not finished. */
export const OPEN_STATES = ['received', 'diagnosed', 'quoted', 'approved', 'repairing'] as const;

export const RepairLine = defineModel('repair.line', {
  label: 'Repair line',
  order: ['id asc'],
  access: {
    'repair.user': [...ALL],
    'repair.manager': [...ALL, 'export'],
  },
  fields: {
    order: f.many2one('repair.order', { required: true, ondelete: 'cascade', index: true }),
    kind: f.selection(
      { part: 'Part', labour: 'Labour' },
      {
        required: true,
        default: 'part',
        label: 'What',
        help: 'A part put into the item, or the work done on it.',
      },
    ),
    product: f.many2one('product.product', { ondelete: 'restrict', label: 'Product' }),
    name: f.char({ required: true, label: 'Description' }),
    quantity: f.decimal({ scale: 2, required: true, default: '1', label: 'Quantity' }),
    priceUnit: f.decimal({ scale: 2, required: true, default: '0', label: 'Unit price' }),
    subtotal: f.decimal({
      scale: 2,
      store: true,
      label: 'Amount',
      help: 'The quantity at the unit price.',
      ...compute('repair.line', 'subtotal', ['quantity', 'priceUnit'], (lines) => {
        for (const l of lines)
          l.subtotal = (l.quantity ?? zero).times(l.priceUnit ?? zero).toDecimalPlaces(2);
      }),
    }),
  },
  onchange: {
    // The product gives its name and its sales price; both stay the technician's to change.
    product: onchange('repair.line', async (d) => {
      const p = await d.record('product');
      if (p === null || p === undefined) return;
      d.set('name', p.name);
      d.set('priceUnit', p.listPrice);
    }),
  },
  sqlConstraints: {
    positive: {
      check: orm.sql`quantity > 0 AND price_unit >= 0`,
      message: 'A line has a quantity above zero and a price that is not negative.',
    },
  },
  constraints: {
    partNamed: {
      ...check('repair.line', ['kind', 'product'], (lines) =>
        [...lines].filter((l) => l.kind === 'part' && l.product === null).map((l) => l.id),
      ),
      message: 'A part is a product: choose it.',
    },
  },
});

const sumOf = (
  lines: Iterable<{ kind: string; subtotal: Decimal | null }>,
  kind: 'part' | 'labour',
): Decimal =>
  [...lines].filter((l) => l.kind === kind).reduce((s, l) => s.plus(l.subtotal ?? zero), zero);

export const RepairOrder = defineModel('repair.order', {
  label: 'Repair order',
  recName: 'name',
  order: ['id desc'],
  companyScoped: { required: true },
  tracking: ['state', 'technician', 'warranty', 'dueDate'],
  access: {
    'repair.user': ['read', 'write', 'create'],
    'repair.manager': [...ALL, 'export', 'import'],
  },
  fields: {
    name: f.char({ required: true, sequence: 'repair.order', label: 'Reference' }),
    partner: f.many2one('res.partner', {
      required: true,
      ondelete: 'restrict',
      index: true,
      label: 'Customer',
    }),
    product: f.many2one('product.product', {
      ondelete: 'restrict',
      index: true,
      label: 'Product',
      help: 'When the item is one of your products.',
    }),
    itemName: f.char({
      required: true,
      label: 'Item',
      help: 'What was handed in: “Walton fridge WFC-3D8”, “HP LaserJet 1020”.',
    }),
    serial: f.char({
      index: true,
      label: 'Serial number',
      help: 'The item’s own number: an item is in repair once at a time, and its earlier repairs are found by it.',
    }),
    accessories: f.char({
      label: 'Came with',
      help: 'What was handed in with it: the charger, the remote, the box.',
    }),
    receivedOn: f.date({
      required: true,
      default: (env: Env) => env.today(),
      label: 'Received on',
    }),
    dueDate: f.date({ label: 'Promised for' }),
    technician: f.many2one('res.users', { ondelete: 'set null', label: 'Technician' }),
    problem: f.text({
      required: true,
      label: 'What the customer says',
      help: 'The fault as the customer describes it.',
    }),
    diagnosis: f.text({
      label: 'Diagnosis',
      help: 'What the technician found, and what it takes to put right.',
    }),
    warranty: f.boolean({
      default: false,
      label: 'Under warranty',
      help: 'Nothing is charged to the customer, and the repair starts without a quotation.',
    }),
    declineReason: f.char({
      label: 'Declined because',
      help: 'Why the customer did not want the repair.',
    }),
    lines: f.one2many('repair.line', 'order', { label: 'Parts and labour' }),
    partsTotal: f.decimal({
      scale: 2,
      store: true,
      label: 'Parts',
      help: 'The parts’ amounts.',
      ...compute('repair.order', 'partsTotal', ['lines.subtotal', 'lines.kind'], (orders) => {
        for (const o of orders) o.partsTotal = sumOf(o.lines, 'part');
      }),
    }),
    labourTotal: f.decimal({
      scale: 2,
      store: true,
      label: 'Labour',
      help: 'The labour’s amounts.',
      ...compute('repair.order', 'labourTotal', ['lines.subtotal', 'lines.kind'], (orders) => {
        for (const o of orders) o.labourTotal = sumOf(o.lines, 'labour');
      }),
    }),
    amountTotal: f.decimal({
      scale: 2,
      store: true,
      label: 'Total',
      help: 'Parts and labour, before taxes.',
      ...compute('repair.order', 'amountTotal', ['lines.subtotal'], (orders) => {
        for (const o of orders)
          o.amountTotal = [...o.lines].reduce((s, l) => s.plus(l.subtotal ?? zero), zero);
      }),
    }),
    amountDue: f.decimal({
      scale: 2,
      store: true,
      label: 'To charge',
      help: 'What the customer is charged, before taxes: the total, or nothing under warranty.',
      ...compute('repair.order', 'amountDue', ['lines.subtotal', 'warranty'], (orders) => {
        for (const o of orders)
          o.amountDue =
            o.warranty === true
              ? zero
              : [...o.lines].reduce((s, l) => s.plus(l.subtotal ?? zero), zero);
      }),
    }),
    startedAt: f.datetime({ label: 'Repair started', groups: { write: [...SYSTEM] } }),
    repairedAt: f.datetime({ label: 'Repaired', groups: { write: [...SYSTEM] } }),
    returnedOn: f.date({ label: 'Handed back on', groups: { write: [...SYSTEM] } }),
    state: f.state({
      states: {
        received: 'Received',
        diagnosed: 'Diagnosed',
        quoted: 'Quoted',
        approved: 'Accepted',
        repairing: 'In repair',
        repaired: 'Repaired',
        declined: 'Declined',
        returned: 'Handed back',
        cancel: 'Cancelled',
      },
      initial: 'received',
      help: 'Received, diagnosed, quoted to the customer and accepted — or declined —, repaired, handed back. Under warranty the repair starts from the diagnosis.',
      transitions: {
        diagnose: {
          from: ['received'],
          to: 'diagnosed',
          guard: records('repair.order', async (orders) =>
            [...(await orders.load(['diagnosis']))]
              .filter((o) => (o.diagnosis ?? '').trim() === '')
              .map((o) => o.id),
          ),
          message: 'Write the diagnosis first: what was found, and what it takes.',
        },
        quote: emitting('repair.order.quoted', {
          from: ['diagnosed'],
          to: 'quoted',
          guard: records('repair.order', async (orders) =>
            [...(await orders.load({ lines: true }))]
              .filter((o) => o.warranty === true || [...o.lines].length === 0)
              .map((o) => o.id),
          ),
          message:
            'A quotation lists the parts and the labour; under warranty there is nothing to quote — start the repair.',
        }),
        approve: { from: ['quoted'], to: 'approved' },
        decline: {
          from: ['quoted'],
          to: 'declined',
          guard: records('repair.order', async (orders) =>
            [...(await orders.load(['declineReason']))]
              .filter((o) => (o.declineReason ?? '').trim() === '')
              .map((o) => o.id),
          ),
          message: 'Say why the customer declined (Declined because).',
        },
        begin: emitting('repair.order.started', {
          from: ['approved', 'diagnosed'],
          to: 'repairing',
          // Straight from the diagnosis only under warranty: a charged repair is accepted first.
          guard: records('repair.order', async (orders) =>
            [...(await orders.load(['state', 'warranty']))]
              .filter((o) => o.state === 'diagnosed' && o.warranty !== true)
              .map((o) => o.id),
          ),
          message: 'The customer accepts the quotation first: quote it, then mark it accepted.',
          after: records('repair.order', async (orders): Promise<void> => {
            const env = orders.env as unknown as Env;
            await env.asSuperuser({ reason: 'repair started' }, (su) =>
              su
                .model('repair.order')
                .browse(orders.ids)
                .write({ startedAt: new Date() } as never),
            );
            await env.model('repair.order').browse(orders.ids).started();
          }),
        }),
        finish: emitting('repair.order.repaired', {
          from: ['repairing'],
          to: 'repaired',
          // What other apps need done first (repair_stock: the parts consumed); refusing refuses the finish.
          before: records('repair.order', async (orders): Promise<void> => {
            await (orders.env as unknown as Env)
              .model('repair.order')
              .browse(orders.ids)
              .finishing();
          }),
          after: records('repair.order', async (orders): Promise<void> => {
            const env = orders.env as unknown as Env;
            await env.asSuperuser({ reason: 'repair finished' }, (su) =>
              su
                .model('repair.order')
                .browse(orders.ids)
                .write({ repairedAt: new Date() } as never),
            );
          }),
        }),
        // Handed back: repaired, or as it came when the customer declined.
        deliver: emitting('repair.order.returned', {
          from: ['repaired', 'declined'],
          to: 'returned',
          after: records('repair.order', async (orders): Promise<void> => {
            const env = orders.env as unknown as Env;
            await env.asSuperuser({ reason: 'item handed back' }, (su) =>
              su
                .model('repair.order')
                .browse(orders.ids)
                .write({ returnedOn: su.today() } as never),
            );
            await env.model('repair.order').browse(orders.ids).returned();
          }),
        }),
        cancel: {
          from: ['received', 'diagnosed', 'quoted', 'approved', 'repairing'],
          to: 'cancel',
          after: records('repair.order', async (orders): Promise<void> => {
            await (orders.env as unknown as Env)
              .model('repair.order')
              .browse(orders.ids)
              .cancelled();
          }),
        },
      },
    }),
  },
  methods: {
    /** Runs once these orders' repair has started. Nothing here; `repair_stock` reserves their parts. */
    started: method('repair.order', async (): Promise<void> => undefined),
    /** Runs before these orders are repaired. Nothing here; `repair_stock` consumes their parts or refuses. */
    finishing: method('repair.order', async (): Promise<void> => undefined),
    /** Runs once these orders are cancelled. Nothing here; `repair_stock` releases their parts. */
    cancelled: method('repair.order', async (): Promise<void> => undefined),
    /** Runs once these items are handed back. Nothing here; `repair_account` drafts the invoice. */
    returned: method('repair.order', async (): Promise<void> => undefined),
  },
  constraints: {
    // One item, one open order: the same serial number is not taken in twice.
    oneAtATime: {
      ...check('repair.order', ['serial', 'state', 'product'], async (orders) =>
        orders.env.asSuperuser({ reason: 'an item in repair once' }, async (su) => {
          const failing: number[] = [];
          for (const o of await su
            .model('repair.order')
            .browse(orders.ids as never)
            .load({ company: true })) {
            const serial = (o.serial ?? '').trim();
            if (serial === '' || !(OPEN_STATES as readonly string[]).includes(o.state)) continue;
            const twin = await su.model('repair.order').search({
              where: {
                company: o.company.id,
                serial,
                state: { in: [...OPEN_STATES] },
                id: { ne: o.id },
              } as never,
              limit: 1,
            });
            if (twin.length > 0) failing.push(o.id as number);
          }
          return failing;
        }),
      ),
      message: 'An item with this serial number is in repair already.',
    },
    // What was agreed is what is repaired and charged.
    linesAgreed: {
      ...check('repair.order', ['warranty'], async (orders) =>
        [...(await orders.load(['state']))]
          .filter((o) => ['repaired', 'returned', 'declined', 'cancel'].includes(o.state))
          .map((o) => o.id),
      ),
      message: 'Whether it is under warranty is decided before the repair ends.',
    },
  },
});

export const repairShutro = defineModule({
  name: 'repair',
  version: '0.1.0',
  depends: [contactsShutro, productShutro, messagingShutro],
  groups: [
    orm.defineGroup({
      code: 'repair.user',
      label: 'Repairs: technician',
      implies: ['contacts.user', 'product.user'],
    }),
    orm.defineGroup({ code: 'repair.manager', label: 'Repairs manager', implies: ['repair.user'] }),
  ],
  sequences: [
    orm.defineSequence({ code: 'repair.order', prefix: 'RO/{year}/', padding: 5, reset: 'yearly' }),
  ],
  models: [RepairOrder, RepairLine],
});
