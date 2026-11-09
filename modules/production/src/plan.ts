/**
 * Production plans (RFC 0031 §3.3): what to make in a period, per product, bill, work centre and slot. **Generate
 * forecast** explodes every line through every level of its bills — the packaging bill of a second stage included —
 * into materials with what is required, on hand, on order and short; **Procure** orders the shortages through the
 * warehouse's reorder rules (a request for quotation by the vendor prices with Purchase, a production order for
 * made components); **capacity** refuses a slot beyond the work centre's batch limits or its hours, saying why; the
 * plan is approved through the approval engine and **scheduled** into production orders, one per line, each linked
 * back. A Gantt by work centre shows the slots.
 */
import { approvalGuard, requestApprovals } from '@kosh/permissions';
import { type Decimal, orm } from '@kosh/server/orm';
import { defaultLocations, inProductUnit } from '@kosh/stock';
import { compute, defineModel, type Env, f, onchange, records } from './.kosh/bindings.js';

const READ = ['read'] as const;
const ALL = ['read', 'write', 'create', 'unlink'] as const;
const zero: Decimal = orm.toDecimal(0);

/** A date-only value as `YYYY-MM-DD`. */
function isoDay(v: unknown): string {
  if (!(v instanceof Date)) return String(v ?? '').slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
}

const PLAN_STATES = {
  draft: 'Draft',
  forecast: 'Forecast',
  to_approve: 'Waiting approval',
  approved: 'Approved',
  scheduled: 'Scheduled',
  cancel: 'Cancelled',
} as const;

export const ProductionPlan = defineModel('production.plan', {
  label: 'Production plan',
  recName: 'name',
  order: ['dateFrom desc', 'id desc'],
  companyScoped: { required: true },
  tracking: ['state', 'dateFrom', 'dateTo', 'warehouse'],
  access: { 'production.user': READ, 'production.manager': [...ALL, 'export', 'import'] },
  fields: {
    name: f.char({ required: true, sequence: 'production.plan', label: 'Reference' }),
    title: f.char({ label: 'Plan' }),
    dateFrom: f.date({ required: true, label: 'From' }),
    dateTo: f.date({ required: true, label: 'To' }),
    warehouse: f.many2one('stock.warehouse', {
      ondelete: 'restrict',
      help: 'Where the products are made and the materials taken; empty: the company’s first warehouse.',
    }),
    workcenters: f.many2many('production.workcenter', {
      relation: 'production_plan_workcenter',
      label: 'Work centres',
      help: 'The centres the plan runs on; lines use one of them.',
    }),
    note: f.text(),
    lines: f.one2many('production.plan.line', 'plan', { label: 'What to make' }),
    materials: f.one2many('production.plan.material', 'plan', { label: 'Materials' }),
    orders: f.one2many('production.order', 'plan', { label: 'Production orders' }),
    shortageCount: f.integer({
      store: true,
      label: 'Materials short',
      help: 'Materials the forecast finds short of what is on hand and on order.',
      ...compute('production.plan', 'shortageCount', ['materials.shortage'], (plans) => {
        for (const p of plans)
          p.shortageCount = [...p.materials].filter((m) => (m.shortage ?? zero).gt(0)).length;
      }),
    }),
    state: f.state({
      states: PLAN_STATES,
      initial: 'draft',
      help: 'Drafted, forecast (its materials known), approved, scheduled into batches.',
      transitions: {
        /** The materials of every line through every level of its bills, with what is on hand and on order. */
        forecast: {
          from: ['draft', 'forecast'],
          to: 'forecast',
          guard: records('production.plan', async (plans) =>
            [...(await plans.load({ lines: true }))]
              .filter((p) => p.lines.length === 0)
              .map((p) => p.id),
          ),
          message: 'Add the products to make first.',
          after: records('production.plan', async (plans) => {
            const env = plans.env as unknown as Env;
            await env.flush();
            for (const id of plans.ids) await generateForecast(env, id as number);
          }),
        },
        /** The shortages ordered through the warehouse's reorder rules. */
        procure: {
          from: ['forecast'],
          to: 'forecast',
          guard: records('production.plan', async (plans) =>
            [...(await plans.load({ materials: true }))]
              .filter((p) => ![...p.materials].some((m) => (m.shortage ?? zero).gt(0)))
              .map((p) => p.id),
          ),
          message: 'Nothing is short.',
          after: records('production.plan', async (plans) => {
            const env = plans.env as unknown as Env;
            await env.flush();
            for (const id of plans.ids) await procureShortages(env, id as number);
          }),
        },
        submit: {
          from: ['forecast'],
          to: 'to_approve',
          guard: records('production.plan', async (plans) =>
            [...(await plans.load({ lines: true }))]
              .filter((p) => [...p.lines].some((l) => (l.capacityNote ?? '') !== ''))
              .map((p) => p.id),
          ),
          message: 'A line goes beyond its work centre’s capacity: see the lines’ capacity notes.',
          after: records('production.plan', async (plans) => {
            await requestApprovals(plans);
            for (const p of await plans.load({}))
              await plans.env.emit('production.plan.submitted', { id: p.id });
          }),
        },
        approve: {
          from: ['to_approve'],
          to: 'approved',
          guard: records('production.plan', (plans) => approvalGuard(plans)),
          message: 'Waiting for approvals.',
          after: records('production.plan', async (plans) => {
            for (const p of await plans.load({}))
              await plans.env.emit('production.plan.approved', { id: p.id });
          }),
        },
        reject: { from: ['to_approve'], to: 'forecast' },
        /** The lines' batches: schedules split by the work centres' maximum batch. */
        schedule: {
          from: ['approved'],
          to: 'scheduled',
          after: records('production.plan', async (plans) => {
            const env = plans.env as unknown as Env;
            await env.flush();
            for (const id of plans.ids) await generateSchedules(env, id as number);
            for (const p of await plans.load({}))
              await env.emit('production.plan.scheduled', { id: p.id });
          }),
        },
        cancel: { from: ['draft', 'forecast', 'to_approve', 'approved'], to: 'cancel' },
        redraft: { from: ['cancel', 'forecast'], to: 'draft' },
      },
      extensible: true,
    }),
  },
  sqlConstraints: {
    period: {
      check: orm.sql`date_to >= date_from`,
      message: 'A plan ends on or after it starts.',
    },
  },
});

export const ProductionPlanLine = defineModel('production.plan.line', {
  label: 'Plan line',
  recName: 'label',
  order: ['start asc', 'id asc'],
  access: { 'production.user': READ, 'production.manager': ALL },
  fields: {
    plan: f.many2one('production.plan', { required: true, ondelete: 'cascade' }),
    product: f.many2one('product.product', { required: true, ondelete: 'restrict' }),
    bom: f.many2one('production.bom', { ondelete: 'restrict', label: 'Bill of materials' }),
    packagingBom: f.many2one('production.bom', {
      ondelete: 'restrict',
      label: 'Packaging bill',
      help: 'The packaging bill of a second stage (step 4): its materials are forecast too.',
    }),
    quantity: f.decimal({ scale: 4, required: true, default: '1' }),
    workcenter: f.many2one('production.workcenter', { required: true, ondelete: 'restrict' }),
    start: f.datetime({ required: true }),
    end: f.datetime({ required: true }),
    minutes: f.decimal({
      scale: 2,
      store: true,
      label: 'Minutes needed',
      help: 'The bill’s operations for the quantity.',
      ...compute(
        'production.plan.line',
        'minutes',
        ['quantity', 'bom.quantity', 'bom.operations.minutes'],
        (lines) => {
          for (const l of lines) {
            if (l.bom === null || l.bom.quantity.lte(0)) {
              l.minutes = zero;
              continue;
            }
            const factor = l.quantity.div(l.bom.quantity);
            l.minutes = [...l.bom.operations]
              .reduce((s, op) => s.plus(op.minutes.times(factor)), zero)
              .toDecimalPlaces(2);
          }
        },
      ),
    }),
    capacityNote: f.char({
      size: 300,
      store: true,
      label: 'Capacity',
      help: 'Why the slot does not fit its work centre — the batch limits, the minutes against its hours over the slot (setup and cleanup included) —; empty when it fits.',
      ...compute(
        'production.plan.line',
        'capacityNote',
        [
          'quantity',
          'start',
          'end',
          'bom.quantity',
          'bom.operations.minutes',
          'product.name',
          'workcenter.name',
          'workcenter.batchMin',
          'workcenter.batchMax',
          'workcenter.hoursPerDay',
          'workcenter.setupMinutes',
          'workcenter.cleanupMinutes',
        ],
        (lines) => {
          for (const l of lines) {
            const w = l.workcenter;
            const why: string[] = [];
            if (w.batchMin !== null && l.quantity.lt(w.batchMin))
              why.push(`below the minimum batch of ${w.batchMin.toString()}`);
            if (w.batchMax !== null && l.quantity.gt(w.batchMax))
              why.push(`above the maximum batch of ${w.batchMax.toString()}`);
            const start = new Date(l.start as Date);
            const end = new Date(l.end as Date);
            const days = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / 86_400_000));
            const available = w.hoursPerDay.times(60).times(days);
            const minutes =
              l.bom === null || l.bom.quantity.lte(0)
                ? zero
                : [...l.bom.operations].reduce(
                    (s, op) => s.plus(op.minutes.times(l.quantity.div(l.bom?.quantity ?? zero))),
                    zero,
                  );
            const needed = minutes.plus(w.setupMinutes ?? zero).plus(w.cleanupMinutes ?? zero);
            if (needed.gt(available))
              why.push(
                `${needed.toDecimalPlaces(0).toString()} minutes needed, ${available.toDecimalPlaces(0).toString()} available at ${w.name} in ${days} day(s)`,
              );
            l.capacityNote = why.length === 0 ? '' : `${l.product.name}: ${why.join('; ')}.`;
          }
        },
      ),
    }),
    schedules: f.one2many('production.schedule', 'planLine', { label: 'Batches' }),
    scheduleCount: f.integer({
      store: true,
      label: 'Batches',
      help: 'The schedules made from the line, one per batch of its work centre.',
      ...compute('production.plan.line', 'scheduleCount', ['schedules.quantity'], (lines) => {
        for (const l of lines) l.scheduleCount = l.schedules.length;
      }),
    }),
    label: f.char({
      store: true,
      label: 'Line',
      ...compute('production.plan.line', 'label', ['product.name', 'quantity'], (lines) => {
        for (const l of lines) l.label = `${l.product.name} × ${l.quantity.toString()}`;
      }),
    }),
  },
  sqlConstraints: {
    positive: { check: orm.sql`quantity > 0`, message: 'A line makes a positive quantity.' },
    slot: { check: orm.sql`"end" > start`, message: 'A slot ends after it starts.' },
  },
  onchange: {
    product: onchange('production.plan.line', async (d, env): Promise<void> => {
      const product = (await d.record('product')) as { id: number } | null;
      if (product === null) return;
      const { validBom } = await import('./module.js');
      const bom = await validBom(env as never, product.id as never, isoDay(env.today()));
      if (bom !== null) d.set('bom', bom as never);
    }),
  },
});

export const ProductionPlanMaterial = defineModel('production.plan.material', {
  label: 'Plan material',
  order: ['plan asc', 'id asc'],
  access: { 'production.user': READ, 'production.manager': READ },
  fields: {
    plan: f.many2one('production.plan', { required: true, ondelete: 'cascade' }),
    product: f.many2one('product.product', { required: true, ondelete: 'restrict' }),
    required: f.decimal({ scale: 4, required: true, default: '0' }),
    onHand: f.decimal({ scale: 4, required: true, default: '0', label: 'On hand' }),
    onOrder: f.decimal({ scale: 4, required: true, default: '0', label: 'On order' }),
    shortage: f.decimal({
      scale: 4,
      store: true,
      help: 'Required beyond what is on hand and on order.',
      ...compute(
        'production.plan.material',
        'shortage',
        ['required', 'onHand', 'onOrder'],
        (rows) => {
          for (const m of rows) {
            const left = m.required.minus(m.onHand).minus(m.onOrder);
            m.shortage = left.gt(0) ? left : zero;
          }
        },
      ),
    }),
    procured: f.decimal({ scale: 4, required: true, default: '0', help: 'Ordered by Procure.' }),
    document: f.char({
      label: 'Ordered by',
      help: 'The request for quotation or production order Procure made.',
    }),
    note: f.char({ size: 300 }),
  },
});

/** The components of a bill for `quantity` of its product, gross of losses, in the components' units. */
async function componentsOf(
  env: Env,
  bomId: number,
  quantity: Decimal,
): Promise<{ product: number; quantity: Decimal }[]> {
  const [bom] = await env
    .model('production.bom')
    .browse([bomId as never])
    .load({ lines: { product: { uom: true }, uom: true } });
  if (bom === undefined || bom.quantity.lte(0)) return [];
  const factor = quantity.div(bom.quantity);
  return [...bom.lines].map((l) => ({
    product: l.product.id as number,
    quantity: inProductUnit(
      (l.grossQuantity ?? l.quantity).times(factor),
      (l.uom ?? null) as never,
      (l.product.uom ?? null) as never,
    ),
  }));
}

/**
 * Explodes a bill through every level: a component with a usable bill of its own is made, its components counted
 * instead (ten levels at most); the rest are materials.
 */
async function explodeAll(
  env: Env,
  bomId: number,
  quantity: Decimal,
  date: string,
  into: Map<number, Decimal>,
  depth = 0,
): Promise<void> {
  const { validBom } = await import('./module.js');
  for (const c of await componentsOf(env, bomId, quantity)) {
    const sub = depth < 10 ? await validBom(env as never, c.product as never, date) : null;
    if (sub !== null) await explodeAll(env, sub as number, c.quantity, date, into, depth + 1);
    else into.set(c.product, (into.get(c.product) ?? zero).plus(c.quantity));
  }
}

/** The plan's materials: every line's bill (and packaging bill) exploded, with on hand and on order. */
export async function generateForecast(env: Env, id: number): Promise<void> {
  await env.asSuperuser({ reason: 'production plan forecast' }, async (su) => {
    const [p] = await su
      .model('production.plan')
      .browse([id as never])
      .load({
        lines: { bom: true, packagingBom: true },
        materials: true,
        warehouse: true,
        company: true,
      });
    if (p === undefined) return;
    if (p.materials.length > 0) await p.materials.unlink();
    const date = isoDay(p.dateFrom);
    const into = new Map<number, Decimal>();
    for (const l of p.lines) {
      if (l.bom !== null) await explodeAll(su as never, l.bom.id as number, l.quantity, date, into);
      if (l.packagingBom !== null) {
        // Packs of the product: the packaging bill's materials for the packs the line fills.
        const packSize = l.packagingBom.packSize ?? zero;
        const packs = packSize.gt(0) ? l.quantity.div(packSize) : l.quantity;
        for (const c of await componentsOf(su as never, l.packagingBom.id as number, packs))
          if (c.product !== (l.product.id as number))
            into.set(c.product, (into.get(c.product) ?? zero).plus(c.quantity));
      }
    }
    const places = await defaultLocations(
      su as never,
      'internal',
      p.warehouse?.id ?? null,
      p.company.id,
    );
    const receiving = (
      await defaultLocations(su as never, 'receipt', p.warehouse?.id ?? null, p.company.id)
    ).destination;
    for (const [product, required] of into) {
      let onHand = zero;
      let onOrder = zero;
      if (places.source !== null) {
        const quants = await (
          await su.model('stock.quant').search({
            where: { product: product as never, location: { childOf: places.source } },
          })
        ).load(['quantity']);
        onHand = [...quants].reduce((s, q) => s.plus(q.quantity), zero);
        // Coming in: confirmed receipts into the warehouse, what is not done yet.
        const incoming = await (
          await su.model('stock.move').search({
            where: {
              product: product as never,
              'picking.state': 'confirmed',
              'picking.kind': 'receipt',
            } as never,
          })
        ).load({ picking: { destination: true } });
        onOrder = [...incoming]
          .filter(
            (m) => receiving === null || (m.picking?.destination?.id ?? receiving) === receiving,
          )
          .reduce((s, m) => s.plus((m.productQty ?? m.quantity).minus(m.doneQty ?? zero)), zero);
      }
      await su.model('production.plan.material').create([
        {
          plan: p.id,
          product: product as never,
          required: required.toDecimalPlaces(4),
          onHand: onHand.toDecimalPlaces(4),
          onOrder: onOrder.gt(0) ? onOrder.toDecimalPlaces(4) : zero,
        },
      ] as never);
    }
    await su.flush();
  });
}

/** Materials are the system's (read-only for everyone): what Procure did is noted as superuser. */
async function noteMaterial(env: Env, id: number, values: Record<string, unknown>): Promise<void> {
  await env.asSuperuser({ reason: 'production plan procurement' }, async (su) => {
    await su
      .model('production.plan.material')
      .browse([id as never])
      .write(values as never);
    await su.flush();
  });
}

/** The vendor of the product's preferred vendor price, else its first; `null` without Purchase or without prices. */
async function preferredVendor(env: Env, product: number): Promise<number | null> {
  let prices: { vendor: { id: number } | null; preferred: boolean }[];
  try {
    prices = [
      ...((await (
        await (
          env.model as (name: string) => {
            search(q: unknown): Promise<{ load(q: unknown): Promise<unknown> }>;
          }
        )('product.vendor.price').search({ where: { product } })
      ).load({ vendor: true })) as Iterable<{ vendor: { id: number } | null; preferred: boolean }>),
    ];
  } catch {
    return null; // Purchase (the `product.vendor.price` model) is not installed.
  }
  const chosen = prices.find((v) => v.preferred) ?? prices[0];
  return chosen?.vendor?.id ?? null;
}

/**
 * Orders the shortages through the warehouse's reorder rules: the rule of the product and warehouse (made when
 * there is none: a buy rule) is asked for the shortage; what it makes — a request for quotation with Purchase, a
 * production order for a made component — is noted on the material, or why nothing was.
 */
export async function procureShortages(env: Env, id: number): Promise<void> {
  const { orderRules } = await import('@kosh/stock');
  const [p] = await env
    .model('production.plan')
    .browse([id as never])
    .load({ materials: { product: true }, warehouse: true, company: true });
  if (p === undefined) return;
  const warehouse =
    p.warehouse?.id ??
    (await defaultLocations(env as never, 'internal', null, p.company.id)).warehouse;
  if (warehouse === null) return;
  for (const m of p.materials) {
    if ((m.shortage ?? zero).lte(0)) continue;
    let rule = (
      await env.model('stock.reorder').search({
        where: { product: m.product.id, warehouse, company: p.company.id } as never,
        limit: 1,
      })
    ).ids[0];
    if (rule === undefined) {
      // No rule yet: a make rule for a product with a usable bill, else a buy rule from the product's preferred
      // vendor price (Purchase); without either, the material says so and nothing is ordered.
      const { validBom } = await import('./module.js');
      const made = await validBom(env as never, m.product.id as never, isoDay(env.today()));
      const vendor = made === null ? await preferredVendor(env, m.product.id as number) : null;
      if (made === null && vendor === null) {
        await noteMaterial(env, m.id as number, {
          note: 'No reorder rule for the product and no vendor price to buy from: add one in Stockroom › Replenishment or on the product.',
        });
        continue;
      }
      rule = (
        await env.model('stock.reorder').create([
          {
            product: m.product.id,
            warehouse,
            company: p.company.id,
            method: made === null ? 'buy' : 'make',
            vendor,
            minimum: '0',
            maximum: '0',
          },
        ] as never)
      ).ids[0];
    }
    if (rule === undefined) continue;
    const result = await orderRules(
      env as never,
      [rule as number],
      new Map([[rule as number, m.shortage ?? zero]]),
    );
    const ordered = result.ordered[0];
    const skipped = result.skipped[0];
    await noteMaterial(env, m.id as number, {
      procured: ordered === undefined ? zero : orm.toDecimal(ordered.quantity),
      document: ordered?.document ?? null,
      note: ordered === undefined ? (skipped?.reason ?? 'Not ordered.') : null,
    });
  }
  await env.flush();
}

/**
 * The plan's batches: each line split evenly into as many schedules as its work centre's maximum batch needs, the
 * slot divided among them, each linked to its line; lines that already have batches are left alone.
 */
export async function generateSchedules(env: Env, id: number): Promise<void> {
  const [p] = await env
    .model('production.plan')
    .browse([id as never])
    .load({ lines: { workcenter: true, schedules: true }, warehouse: true, company: true });
  if (p === undefined) return;
  for (const l of p.lines) {
    if (l.schedules.length > 0) continue;
    const max = l.workcenter.batchMax ?? null;
    const n = max?.gt(0) ? Math.max(1, Math.ceil(Number(l.quantity.div(max).toString()))) : 1;
    const start = new Date(l.start as Date).getTime();
    const end = new Date(l.end as Date).getTime();
    const slice = Math.max(1, Math.floor((end - start) / n));
    const each = l.quantity.div(n).toDecimalPlaces(4);
    let left = l.quantity;
    for (let i = 0; i < n; i++) {
      const quantity = i === n - 1 ? left : each;
      left = left.minus(quantity);
      await env.model('production.schedule').create([
        {
          plan: p.id,
          planLine: l.id,
          product: l.product.id,
          bom: l.bom?.id ?? null,
          packagingBom: l.packagingBom?.id ?? null,
          quantity,
          workcenter: l.workcenter.id,
          start: new Date(start + i * slice),
          end: new Date(i === n - 1 ? end : start + (i + 1) * slice),
          warehouse: p.warehouse?.id ?? null,
          company: p.company.id,
        },
      ] as never);
    }
  }
  await env.flush();
}
