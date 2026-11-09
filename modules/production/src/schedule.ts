/**
 * Production schedules (RFC 0031 §3.4): one batch of a product at a work centre in a slot, from an approved plan
 * line (split by the centre's maximum batch) or by hand. **Check stock** runs the pre-flight — each component's
 * required, available, deficit or surplus —; **Confirm** makes the production orders: the *make* order, and for a
 * packaging bill the *pack* order that consumes the make order's output by its lot once it is produced. The
 * schedule follows its orders: in progress when one starts, done when all are done, its produced quantity summed.
 */
import { type Decimal, orm } from '@kosh/server/orm';
import { compute, defineModel, type Env, f, records } from './.kosh/bindings.js';

const READ = ['read'] as const;
const ALL = ['read', 'write', 'create', 'unlink'] as const;
const zero: Decimal = orm.toDecimal(0);

function isoDay(v: unknown): string {
  if (!(v instanceof Date)) return String(v ?? '').slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
}

export const ProductionSchedule = defineModel('production.schedule', {
  label: 'Production schedule',
  recName: 'name',
  order: ['start asc', 'id asc'],
  companyScoped: { required: true },
  tracking: ['state', 'quantity', 'workcenter', 'start', 'end'],
  access: { 'production.user': READ, 'production.manager': [...ALL, 'export', 'import'] },
  fields: {
    name: f.char({ required: true, sequence: 'production.schedule', label: 'Batch number' }),
    plan: f.many2one('production.plan', { ondelete: 'set null', label: 'Production plan' }),
    planLine: f.many2one('production.plan.line', { ondelete: 'set null', label: 'Plan line' }),
    product: f.many2one('product.product', { required: true, ondelete: 'restrict' }),
    bom: f.many2one('production.bom', { ondelete: 'restrict', label: 'Bill of materials' }),
    packagingBom: f.many2one('production.bom', {
      ondelete: 'restrict',
      label: 'Packaging bill',
      help: 'When set, a second order packs what is made, by its lot.',
    }),
    quantity: f.decimal({ scale: 4, required: true, default: '1', label: 'Target' }),
    produced: f.decimal({
      scale: 4,
      store: true,
      help: 'What the batch’s make orders produced, once done.',
      ...compute(
        'production.schedule',
        'produced',
        ['orders.producedQty', 'orders.state', 'orders.stage'],
        (rows) => {
          for (const s of rows)
            s.produced = [...s.orders]
              .filter((o) => o.state === 'done' && o.stage === 'make')
              .reduce((sum, o) => sum.plus(o.producedQty ?? zero), zero);
        },
      ),
    }),
    remaining: f.decimal({
      scale: 4,
      store: true,
      help: 'The target less what was produced.',
      ...compute('production.schedule', 'remaining', ['quantity', 'produced'], (rows) => {
        for (const s of rows) {
          const left = s.quantity.minus(s.produced ?? zero);
          s.remaining = left.gt(0) ? left : zero;
        }
      }),
    }),
    workcenter: f.many2one('production.workcenter', { required: true, ondelete: 'restrict' }),
    shift: f.many2one('production.shift', { ondelete: 'set null' }),
    start: f.datetime({ required: true }),
    end: f.datetime({ required: true }),
    warehouse: f.many2one('stock.warehouse', { ondelete: 'restrict' }),
    components: f.one2many('production.schedule.component', 'schedule', { label: 'Pre-flight' }),
    orders: f.one2many('production.order', 'schedule', { label: 'Production orders' }),
    deficitCount: f.integer({
      store: true,
      label: 'Components short',
      help: 'Components the pre-flight finds short.',
      ...compute('production.schedule', 'deficitCount', ['components.deficit'], (rows) => {
        for (const s of rows)
          s.deficitCount = [...s.components].filter((c) => (c.deficit ?? zero).gt(0)).length;
      }),
    }),
    note: f.text(),
    state: f.state({
      states: {
        draft: 'Draft',
        checked: 'Stock checked',
        confirmed: 'Confirmed',
        progress: 'In progress',
        done: 'Done',
        cancel: 'Cancelled',
      },
      initial: 'draft',
      help: 'Drafted, its stock checked (the pre-flight), confirmed into orders, in progress once one starts, done when all are.',
      transitions: {
        /** The pre-flight: each component's required, available, deficit or surplus, now. */
        check: {
          from: ['draft', 'checked'],
          to: 'checked',
          after: records('production.schedule', async (rows) => {
            const env = rows.env as unknown as Env;
            await env.flush();
            for (const id of rows.ids) await preflight(env, id as number);
          }),
        },
        /** The make order (and the pack order of a packaging bill), confirmed when their bills may be used. */
        confirm: {
          from: ['checked'],
          to: 'confirmed',
          after: records('production.schedule', async (rows) => {
            const env = rows.env as unknown as Env;
            await env.flush();
            for (const id of rows.ids) await makeOrders(env, id as number);
            for (const s of await rows.load({}))
              await env.emit('production.schedule.confirmed', { id: s.id });
          }),
        },
        begin: { from: ['confirmed'], to: 'progress' },
        finish: {
          from: ['confirmed', 'progress'],
          to: 'done',
          after: records('production.schedule', async (rows) => {
            for (const s of await rows.load({}))
              await rows.env.emit('production.schedule.done', { id: s.id });
          }),
        },
        cancel: { from: ['draft', 'checked', 'confirmed'], to: 'cancel' },
        redraft: { from: ['cancel', 'checked'], to: 'draft' },
      },
      extensible: true,
    }),
  },
  sqlConstraints: {
    positive: { check: orm.sql`quantity > 0`, message: 'A batch makes a positive quantity.' },
    slot: { check: orm.sql`"end" > start`, message: 'A slot ends after it starts.' },
  },
});

export const ProductionScheduleComponent = defineModel('production.schedule.component', {
  label: 'Pre-flight line',
  order: ['schedule asc', 'id asc'],
  access: { 'production.user': READ, 'production.manager': READ },
  fields: {
    schedule: f.many2one('production.schedule', { required: true, ondelete: 'cascade' }),
    product: f.many2one('product.product', { required: true, ondelete: 'restrict' }),
    required: f.decimal({ scale: 4, required: true, default: '0' }),
    available: f.decimal({
      scale: 4,
      required: true,
      default: '0',
      help: 'On hand and not reserved, in the warehouse.',
    }),
    deficit: f.decimal({
      scale: 4,
      store: true,
      help: 'Required beyond what is available.',
      ...compute('production.schedule.component', 'deficit', ['required', 'available'], (rows) => {
        for (const c of rows) {
          const d = c.required.minus(c.available);
          c.deficit = d.gt(0) ? d : zero;
        }
      }),
    }),
    surplus: f.decimal({
      scale: 4,
      store: true,
      help: 'Available beyond what is required.',
      ...compute('production.schedule.component', 'surplus', ['required', 'available'], (rows) => {
        for (const c of rows) {
          const s = c.available.minus(c.required);
          c.surplus = s.gt(0) ? s : zero;
        }
      }),
    }),
  },
});

/** The pre-flight: the bill's components for the target, with what is available in the warehouse, as the system. */
export async function preflight(env: Env, id: number): Promise<void> {
  const { componentNeeds } = await import('./module.js');
  await env.asSuperuser({ reason: 'production schedule pre-flight' }, async (su) => {
    const [s] = await su
      .model('production.schedule')
      .browse([id as never])
      .load({
        components: true,
        bom: true,
        packagingBom: true,
        warehouse: true,
        company: true,
        product: true,
      });
    if (s === undefined) return;
    if (s.components.length > 0) await s.components.unlink();
    const needs = new Map<number, { required: Decimal; available: Decimal }>();
    const add = async (bom: number | null, quantity: Decimal) => {
      if (bom === null) return;
      for (const n of await componentNeeds(
        su as never,
        bom as never,
        quantity,
        s.warehouse?.id ?? null,
        s.company.id,
      )) {
        const got = needs.get(n.product);
        needs.set(n.product, {
          required: (got?.required ?? zero).plus(n.required),
          available: got?.available ?? n.available,
        });
      }
    };
    await add(s.bom?.id ?? null, s.quantity);
    if (s.packagingBom !== null) {
      const packSize = s.packagingBom.packSize ?? zero;
      const packs = packSize.gt(0) ? s.quantity.div(packSize) : s.quantity;
      // The packaging bill's other materials (the empty bags); what it packs is what this batch makes.
      for (const n of await componentNeeds(
        su as never,
        s.packagingBom.id as never,
        packs,
        s.warehouse?.id ?? null,
        s.company.id,
      ))
        if (n.product !== (s.product.id as number)) {
          const got = needs.get(n.product);
          needs.set(n.product, {
            required: (got?.required ?? zero).plus(n.required),
            available: got?.available ?? n.available,
          });
        }
    }
    for (const [product, n] of needs)
      await su.model('production.schedule.component').create([
        {
          schedule: s.id,
          product: product as never,
          required: n.required.toDecimalPlaces(4),
          available: n.available.toDecimalPlaces(4),
        },
      ] as never);
    await su.flush();
  });
}

/**
 * The batch's orders: the make order at the schedule's start, confirmed when its bill may be used; for a packaging
 * bill the pack order too, drafted with the make order as its source — confirmed, and its bulk taken from the make
 * order's lot, once that order has produced.
 */
export async function makeOrders(env: Env, id: number): Promise<void> {
  const [s] = await env
    .model('production.schedule')
    .browse([id as never])
    .load({
      orders: true,
      product: true,
      bom: true,
      packagingBom: { product: true },
      warehouse: true,
      company: true,
      plan: true,
      shift: true,
    });
  if (s === undefined || s.orders.length > 0) return;
  const made = await env.model('production.order').create([
    {
      product: s.product.id,
      quantity: s.quantity,
      bom: s.bom?.id ?? null,
      date: isoDay(s.start),
      warehouse: s.warehouse?.id ?? null,
      company: s.company.id,
      plan: s.plan?.id ?? null,
      schedule: s.id,
      stage: 'make',
      batch: s.name,
      shift: s.shift?.id ?? null,
    },
  ] as never);
  await env.flush();
  if (s.bom !== null) await made.confirm();
  if (s.packagingBom !== null) {
    const packSize = s.packagingBom.packSize ?? zero;
    const packs = (packSize.gt(0) ? s.quantity.div(packSize) : s.quantity).toDecimalPlaces(4);
    await env.model('production.order').create([
      {
        product: s.packagingBom.product.id,
        quantity: packs,
        bom: s.packagingBom.id,
        date: isoDay(s.start),
        warehouse: s.warehouse?.id ?? null,
        company: s.company.id,
        plan: s.plan?.id ?? null,
        schedule: s.id,
        stage: 'pack',
        batch: s.name,
        shift: s.shift?.id ?? null,
        sourceOrder: made.ids[0],
      },
    ] as never);
  }
  await env.flush();
}

/** After an order of a schedule starts or finishes: the schedule in progress, or done when all its orders are. */
export async function followOrders(env: Env, scheduleId: number): Promise<void> {
  await env.asSuperuser({ reason: 'production schedule follows its orders' }, async (su) => {
    const rows = await su
      .model('production.schedule')
      .browse([scheduleId as never])
      .load({ orders: true });
    const [s] = rows;
    if (s === undefined) return;
    const orders = [...s.orders].filter((o) => o.state !== 'cancel');
    if (orders.length > 0 && orders.every((o) => o.state === 'done')) {
      if (s.state === 'confirmed' || s.state === 'progress') await rows.finish();
    } else if (
      s.state === 'confirmed' &&
      orders.some((o) => o.state === 'progress' || o.state === 'done')
    )
      await rows.begin();
    await su.flush();
  });
}
