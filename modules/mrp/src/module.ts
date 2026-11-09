/**
 * The data layer of Production (RFC 0021): bills of materials with versions and effective dates, work centres with
 * their hours and cost, and production orders that say what is required, available and short before they start and
 * what they will cost. Orders move stock only through Stockroom: Confirm reserves the components in a consumption
 * transfer (stock → Production), Produce validates it and the output transfer (Production → stock).
 */

import { contactsShutro } from '@kosh/contacts';
import { messagingShutro } from '@kosh/messaging';
import { approvalGuard, permissionsShutro, requestApprovals } from '@kosh/permissions';
import { productShutro } from '@kosh/product';
import { emitting } from '@kosh/server';
import { type Decimal, type Id, orm } from '@kosh/server/orm';
import { defaultLocations, inProductUnit, stockShutro } from '@kosh/stock';
import {
  check,
  compute,
  defineModel,
  defineModule,
  type Env,
  extendModel,
  f,
  onchange,
  type Records,
  records,
} from './.kosh/bindings.js';
import {
  BOM_KINDS,
  bomsNeedApproval,
  CompanyMrp,
  ineligible,
  MrpBomCost,
  MrpBomEligibility,
  MrpBomSpec,
  MrpProductSpec,
  MrpShift,
  MrpSpecParameter,
} from './depth.js';

const READ = ['read'] as const;
const ALL = ['read', 'write', 'create', 'unlink'] as const;
const zero = orm.toDecimal(0);
const money = (d: Decimal) => d.toDecimalPlaces(2);

/** A date as `YYYY-MM-DD` (date-only values from PostgreSQL are local midnights: their local parts). */
const iso = (v: unknown): string => {
  if (!(v instanceof Date)) return String(v ?? '');
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
};

/** The bill of `product` valid on `date`: the latest that starts on or before it and has not ended. */
export async function validBom(
  env: Env,
  product: Id<'product.product'>,
  date: string,
): Promise<Id<'mrp.bom'> | null> {
  const bills = await (await env.model('mrp.bom').search({ where: { product } })).load([
    'validFrom',
    'validTo',
    'state',
    'company',
  ]);
  // Active bills; drafts too when the company needs no approval (RFC 0031 §3.2).
  const needs = new Map<number, boolean>();
  const usable = async (b: { state: string; company: { id: number } }) => {
    if (b.state === 'active') return true;
    if (b.state !== 'draft') return false;
    let need = needs.get(b.company.id);
    if (need === undefined) {
      need = await bomsNeedApproval(env, b.company.id);
      needs.set(b.company.id, need);
    }
    return !need;
  };
  const candidates: typeof bills extends Iterable<infer T> ? T[] : never = [];
  for (const b of bills) if (await usable(b as never)) candidates.push(b);
  const valid = candidates
    .filter(
      (b) =>
        (b.validFrom === null || iso(b.validFrom) <= date) &&
        (b.validTo === null || iso(b.validTo) >= date),
    )
    .sort((a, b) => iso(b.validFrom).localeCompare(iso(a.validFrom)) || b.id - a.id);
  return valid[0]?.id ?? null;
}

export const MrpWorkcenter = defineModel('mrp.workcenter', {
  label: 'Work centre',
  recName: 'name',
  order: ['name asc'],
  archivable: true,
  companyScoped: { required: true },
  access: { 'mrp.user': READ, 'mrp.manager': [...ALL, 'export', 'import'] },
  fields: {
    name: f.char({ required: true }),
    code: f.char(),
    /** Hours it works a day (its capacity). */
    hoursPerDay: f.decimal({ scale: 2, required: true, default: '8', label: 'Hours a day' }),
    /** Labour and overhead per hour of work. */
    costPerHour: f.decimal({ scale: 2, required: true, default: '0', label: 'Cost per hour' }),
    batchMin: f.decimal({ scale: 4, label: 'Minimum batch', help: 'The smallest batch it runs.' }),
    batchMax: f.decimal({
      scale: 4,
      label: 'Maximum batch',
      help: 'The largest batch it runs at once.',
    }),
    oeeTarget: f.decimal({
      scale: 2,
      default: '85',
      label: 'OEE target (%)',
      help: 'The overall equipment effectiveness aimed at: availability × performance × quality.',
    }),
    setupMinutes: f.decimal({
      scale: 2,
      default: '0',
      label: 'Setup (minutes)',
      help: 'Before each batch.',
    }),
    cleanupMinutes: f.decimal({
      scale: 2,
      default: '0',
      label: 'Cleanup (minutes)',
      help: 'After each batch.',
    }),
    alternatives: f.many2many('mrp.workcenter', {
      relation: 'mrp_workcenter_alternative',
      label: 'Alternative work centres',
      help: 'Where the same operation may run when this centre is full.',
    }),
    note: f.text(),
  },
  sqlConstraints: {
    positive: {
      check: orm.sql`hours_per_day > 0 AND cost_per_hour >= 0`,
      message: 'A work centre works some hours a day, at a cost that is not negative.',
    },
  },
});

export const MrpBom = defineModel('mrp.bom', {
  label: 'Bill of materials',
  recName: 'label',
  order: ['product asc', 'validFrom desc', 'id desc'],
  archivable: true,
  companyScoped: { required: true },
  tracking: ['quantity', 'validFrom', 'validTo', 'kind', 'state'],
  access: { 'mrp.user': READ, 'mrp.manager': [...ALL, 'export', 'import'] },
  fields: {
    product: f.many2one('product.product', { required: true, ondelete: 'restrict' }),
    /** How many of the product one bill makes, in the product's unit. */
    quantity: f.decimal({ scale: 4, required: true, default: '1', label: 'Makes' }),
    kind: f.selection(BOM_KINDS, {
      required: true,
      default: 'standard',
      help: 'Standard: components in quantities. Formula: components as shares of the batch (ratios adding up to 100 %), scaled to any quantity. Packaging: a pack of the product made.',
    }),
    packSize: f.decimal({
      scale: 4,
      label: 'Pack size',
      help: 'For a packaging bill: how much of the product one pack holds, in the product’s unit.',
    }),
    expectedLoss: f.decimal({
      scale: 2,
      default: '0',
      label: 'Expected loss (%)',
      help: 'What is lost making or packing a batch, as a share of it.',
    }),
    tolerance: f.decimal({
      scale: 2,
      default: '0',
      label: 'Tolerance (±%)',
      help: 'How far the quantity made may stray from the batch before it is questioned.',
    }),
    version: f.char({ required: true, default: 'v1' }),
    /** From when this version is used (empty: always). */
    validFrom: f.date({ label: 'Valid from' }),
    validTo: f.date({ label: 'Valid until' }),
    lines: f.one2many('mrp.bom.line', 'bom', { label: 'Components' }),
    operations: f.one2many('mrp.bom.operation', 'bom'),
    byproducts: f.one2many('mrp.bom.byproduct', 'bom', { label: 'By-products' }),
    specs: f.one2many('mrp.bom.spec', 'bom', { label: 'Specifications' }),
    costs: f.one2many('mrp.bom.cost', 'bom', { label: 'Costing history' }),
    unitCost: f.decimal({
      scale: 4,
      store: true,
      label: 'Unit cost',
      help: 'The components (gross of their losses) at their cost and the operations at their work centres’ rates, per unit made.',
      ...compute(
        'mrp.bom',
        'unitCost',
        [
          'quantity',
          'lines.grossQuantity',
          'lines.quantity',
          'lines.uom',
          'lines.product.standardPrice',
          'lines.product.uom',
          'operations.minutes',
          'operations.workcenter.costPerHour',
        ],
        (bills) => {
          for (const b of bills) {
            let total = zero;
            for (const l of b.lines) {
              const qty = inProductUnit(
                l.grossQuantity ?? l.quantity,
                (l.uom ?? null) as never,
                (l.product.uom ?? null) as never,
              );
              total = total.plus(qty.times(l.product.standardPrice ?? zero));
            }
            for (const op of b.operations)
              total = total.plus(op.minutes.div(60).times(op.workcenter.costPerHour));
            b.unitCost = b.quantity.gt(0) ? total.div(b.quantity).toDecimalPlaces(4) : zero;
          }
        },
      ),
    }),
    state: f.state({
      states: { draft: 'Draft', review: 'Under review', active: 'Active', inactive: 'Inactive' },
      initial: 'draft',
      help: 'Drafted, submitted for review, approved into active (the version used), set inactive when superseded; a revision copies it to the next version. A company that needs no approval uses drafts as well.',
      transitions: {
        submit: {
          from: ['draft'],
          to: 'review',
          guard: records('mrp.bom', async (bills) => {
            const out: number[] = [];
            for (const b of await bills.load({ lines: true, specs: true })) {
              const lines = [...b.lines];
              const ratios = lines.reduce((s, l) => s.plus(l.ratio ?? zero), zero);
              if (
                lines.length === 0 ||
                (b.kind === 'formula' && !ratios.eq(100)) ||
                [...b.specs].some((s) => s.within === false)
              )
                out.push(b.id);
            }
            return out;
          }),
          message:
            'A bill under review has components, formula ratios adding up to 100 % and every specification within range.',
          after: records('mrp.bom', async (bills) => {
            await requestApprovals(bills);
            for (const b of await bills.load({}))
              await bills.env.emit('mrp.bom.submitted', { id: b.id });
          }),
        },
        approve: {
          from: ['review'],
          to: 'active',
          guard: records('mrp.bom', (bills) => approvalGuard(bills)),
          message: 'Waiting for approvals.',
          after: records('mrp.bom', async (bills) => {
            const env = bills.env as unknown as Env;
            for (const b of await bills.load({})) {
              await env.asSuperuser({ reason: 'bill costing history' }, (su) =>
                su.model('mrp.bom.cost').create([
                  {
                    bom: b.id,
                    date: env.today(),
                    unitCost: b.unitCost ?? zero,
                    note: 'Activated',
                  },
                ] as never),
              );
              await env.emit('mrp.bom.activated', { id: b.id });
            }
          }),
        },
        reject: { from: ['review'], to: 'draft' },
        deactivate: { from: ['active'], to: 'inactive' },
        reactivate: { from: ['inactive'], to: 'active' },
        /** A copy as the next version, in draft, to change and submit; the cost of this version kept. */
        revise: {
          from: ['active'],
          to: 'active',
          after: records('mrp.bom', async (bills) => {
            const env = bills.env as unknown as Env;
            for (const id of bills.ids) await reviseBom(env, id as number);
          }),
        },
      },
      extensible: true,
    }),
    note: f.text(),
    label: f.char({
      store: true,
      label: 'Bill of materials',
      ...compute('mrp.bom', 'label', ['product.name', 'version'], (bills) => {
        for (const b of bills) b.label = `${b.product.name} ${b.version}`;
      }),
    }),
  },
  sqlConstraints: {
    positive: { check: orm.sql`quantity > 0`, message: 'A bill makes a positive quantity.' },
    packaging: {
      check: orm.sql`kind <> 'packaging' OR (pack_size IS NOT NULL AND pack_size > 0)`,
      message: 'A packaging bill has a pack size.',
    },
    shares: {
      check: orm.sql`expected_loss >= 0 AND expected_loss < 100 AND tolerance >= 0 AND tolerance <= 100`,
      message: 'Loss and tolerance are percentages.',
    },
    period: {
      check: orm.sql`valid_from IS NULL OR valid_to IS NULL OR valid_to >= valid_from`,
      message: 'A bill ends on or after it starts.',
    },
  },
});

/** The next version's name: v1 → v2, 2026-A → 2026-A-2. */
function nextVersion(version: string): string {
  const m = /^(.*?)(\d+)$/.exec(version);
  return m === null ? `${version}-2` : `${m[1]}${Number(m[2]) + 1}`;
}

/** A copy of a bill as its next version, in draft: lines, operations, by-products and specifications. */
export async function reviseBom(env: Env, id: number): Promise<number | null> {
  const [b] = await env
    .model('mrp.bom')
    .browse([id as never])
    .load({ lines: true, operations: true, byproducts: true, specs: true, company: true });
  if (b === undefined) return null;
  const made = await env.model('mrp.bom').create([
    {
      product: b.product.id,
      company: b.company.id,
      quantity: b.quantity,
      kind: b.kind,
      packSize: b.packSize,
      expectedLoss: b.expectedLoss,
      tolerance: b.tolerance,
      version: nextVersion(b.version),
      note: b.note,
      lines: {
        create: [...b.lines].map((l) => ({
          product: l.product.id,
          quantity: l.quantity,
          uom: l.uom?.id ?? null,
          ratio: l.ratio,
          loss: l.loss,
        })),
      },
      operations: {
        create: [...b.operations].map((o) => ({
          name: o.name,
          workcenter: o.workcenter.id,
          minutes: o.minutes,
        })),
      },
      byproducts: {
        create: [...b.byproducts].map((x) => ({
          product: x.product.id,
          quantity: x.quantity,
          uom: x.uom?.id ?? null,
          costShare: x.costShare,
        })),
      },
      specs: {
        create: [...b.specs].map((x) => ({
          parameter: x.parameter.id,
          minimum: x.minimum,
          maximum: x.maximum,
        })),
      },
    },
  ] as never);
  await env.emit('mrp.bom.revised', { id: b.id });
  return (made.ids[0] as number | undefined) ?? null;
}

export const MrpBomLine = defineModel('mrp.bom.line', {
  label: 'Component',
  order: ['id asc'],
  access: { 'mrp.user': READ, 'mrp.manager': ALL },
  fields: {
    bom: f.many2one('mrp.bom', { required: true, ondelete: 'cascade' }),
    product: f.many2one('product.product', { required: true, ondelete: 'restrict' }),
    quantity: f.decimal({ scale: 4, required: true, default: '1' }),
    uom: f.many2one('uom.uom', { label: 'Unit' }),
    ratio: f.decimal({
      scale: 2,
      label: 'Ratio (%)',
      help: 'For a formula: the component’s share of the batch; the ratios add up to 100 %.',
    }),
    loss: f.decimal({
      scale: 2,
      default: '0',
      label: 'Loss (%)',
      help: 'What is lost of this component in making (spillage, moisture): the gross quantity covers it.',
    }),
    netQuantity: f.decimal({
      scale: 4,
      store: true,
      label: 'Net quantity',
      help: 'What goes into the product: the quantity, or the ratio of the batch for a formula.',
      ...compute(
        'mrp.bom.line',
        'netQuantity',
        ['quantity', 'ratio', 'bom.kind', 'bom.quantity'],
        (lines) => {
          for (const l of lines)
            l.netQuantity =
              l.bom.kind === 'formula' && l.ratio !== null
                ? l.bom.quantity.times(l.ratio).div(100).toDecimalPlaces(4)
                : l.quantity;
        },
      ),
    }),
    grossQuantity: f.decimal({
      scale: 4,
      store: true,
      label: 'Gross quantity',
      help: 'The net quantity plus the loss: what the order consumes.',
      ...compute('mrp.bom.line', 'grossQuantity', ['netQuantity', 'loss'], (lines) => {
        for (const l of lines)
          l.grossQuantity = (l.netQuantity ?? l.quantity)
            .times(orm.toDecimal(100).plus(l.loss ?? zero))
            .div(100)
            .toDecimalPlaces(4);
      }),
    }),
  },
  onchange: {
    product: onchange('mrp.bom.line', async (d) => {
      const p = await d.record('product');
      if (p?.uom) d.set('uom', p.uom.id);
    }),
  },
  sqlConstraints: {
    positive: {
      check: orm.sql`quantity > 0`,
      message: 'A component is needed in a positive quantity.',
    },
    shares: {
      check: orm.sql`(ratio IS NULL OR (ratio >= 0 AND ratio <= 100)) AND loss >= 0 AND loss < 100`,
      message: 'Ratios and losses are percentages.',
    },
  },
  constraints: {
    // The company's eligibility rules for the bill's kind (RFC 0031 §3.2): refused lines say why.
    eligible: {
      ...check('mrp.bom.line', ['product', 'bom'], async (lines) => {
        const env = lines.env as unknown as Env;
        const failing: number[] = [];
        for (const l of await lines.load({ bom: { company: true }, product: true })) {
          const why = await ineligible(
            env,
            l.bom.company.id as number,
            l.bom.kind,
            l.product.id as number,
          );
          if (why !== null) {
            failing.push(l.id);
            throw new orm.ValidationError(
              'mrp.bom.line',
              ['product'],
              why,
              'Choose an allowed component, or change the eligibility rules (Production › Configuration).',
            );
          }
        }
        return failing;
      }),
      message: 'This product is not an allowed component of the bill’s kind.',
    },
    notItself: {
      ...check('mrp.bom.line', ['product', 'bom'], async (lines) =>
        (await lines.load({ bom: true }))
          .filter((l) => l.bom.product.id === l.product.id)
          .map((l) => l.id),
      ),
      message: 'A product is not a component of itself.',
    },
  },
});

/** What else one bill makes (sawdust, offcuts), and the share of the order's cost it carries. */
export const MrpBomByproduct = defineModel('mrp.bom.byproduct', {
  label: 'By-product',
  order: ['id asc'],
  access: { 'mrp.user': READ, 'mrp.manager': ALL },
  fields: {
    bom: f.many2one('mrp.bom', { required: true, ondelete: 'cascade' }),
    product: f.many2one('product.product', { required: true, ondelete: 'restrict' }),
    quantity: f.decimal({ scale: 4, required: true, default: '1' }),
    uom: f.many2one('uom.uom', { label: 'Unit' }),
    /** Percent of the order's cost (the main product carries the rest). */
    costShare: f.decimal({
      scale: 2,
      required: true,
      default: '0',
      label: 'Share of the cost (%)',
    }),
  },
  sqlConstraints: {
    positive: {
      check: orm.sql`quantity > 0 AND cost_share >= 0 AND cost_share < 100`,
      message: 'A by-product is made in a positive quantity, with a share of the cost under 100 %.',
    },
  },
  constraints: {
    sharesUnderAll: {
      ...check('mrp.bom.byproduct', ['costShare', 'bom', 'product'], async (lines) => {
        const failing: number[] = [];
        for (const l of await lines.load({ bom: { byproducts: true } })) {
          const total = [...l.bom.byproducts].reduce((s, b) => s.plus(b.costShare), zero);
          if (total.gte(100) || l.product.id === l.bom.product.id) failing.push(l.id);
        }
        return failing;
      }),
      message:
        'By-products are other products than the one made, and their shares of the cost stay under 100 %.',
    },
  },
});

export const MrpBomOperation = defineModel('mrp.bom.operation', {
  label: 'Operation',
  order: ['id asc'],
  access: { 'mrp.user': READ, 'mrp.manager': ALL },
  fields: {
    bom: f.many2one('mrp.bom', { required: true, ondelete: 'cascade' }),
    name: f.char({ required: true }),
    workcenter: f.many2one('mrp.workcenter', { required: true, ondelete: 'restrict' }),
    /** Minutes for what one bill makes. */
    minutes: f.decimal({ scale: 2, required: true, default: '0' }),
  },
});

export const MrpProductionComponent = defineModel('mrp.production.component', {
  label: 'Component need',
  order: ['id asc'],
  access: { 'mrp.user': READ, 'mrp.manager': READ },
  fields: {
    production: f.many2one('mrp.production', { required: true, ondelete: 'cascade' }),
    product: f.many2one('product.product', { required: true, ondelete: 'restrict' }),
    /** In the product's unit. */
    required: f.decimal({ scale: 4, required: true, default: '0' }),
    /** Available in the warehouse when the order was last checked. */
    available: f.decimal({ scale: 4, required: true, default: '0' }),
    short: f.decimal({
      scale: 4,
      store: true,
      label: 'Short',
      help: 'How much more is needed than the warehouse had available when the order was last checked.',
      ...compute('mrp.production.component', 'short', ['required', 'available'], (lines) => {
        for (const l of lines) {
          const missing = l.required.minus(l.available);
          l.short = missing.gt(0) ? missing : zero;
        }
      }),
    }),
    cost: f.decimal({
      scale: 2,
      store: true,
      label: 'Cost',
      help: 'The quantity needed at the component’s cost.',
      ...compute(
        'mrp.production.component',
        'cost',
        ['required', 'product.standardPrice'],
        (lines) => {
          for (const l of lines) l.cost = money(l.required.times(l.product.standardPrice));
        },
      ),
    }),
  },
});

/**
 * Lists the orders' component needs from their bills (in the product's unit, for the quantity ordered) with what is
 * available in their warehouse now; as the system (component lines are not edited by hand).
 */
async function explode(ids: readonly Id<'mrp.production'>[], env: Env): Promise<void> {
  await env.asSuperuser({ reason: 'production components' }, async (su) => {
    const orders = await su
      .model('mrp.production')
      .browse(ids)
      .load({ bom: { lines: { product: { uom: true }, uom: true } }, components: true });
    for (const o of orders) {
      if (o.components.length > 0) await o.components.unlink();
      if (o.bom === null) continue;
      const factor = o.quantity.div(o.bom.quantity);
      const needs = new Map<number, Decimal>();
      for (const l of o.bom.lines) {
        const inUnit = inProductUnit(
          (l.grossQuantity ?? l.quantity).times(factor),
          l.uom ?? null,
          l.product.uom ?? null,
        );
        needs.set(l.product.id, (needs.get(l.product.id) ?? zero).plus(inUnit));
      }
      const places = await defaultLocations(
        su as never,
        'internal',
        o.warehouse?.id ?? null,
        o.company.id,
      );
      for (const [product, required] of needs) {
        let available = zero;
        if (places.source !== null) {
          const quants = await (
            await su.model('stock.quant').search({
              where: {
                product: orm.asId(product, 'product.product'),
                location: { childOf: places.source },
              },
            })
          ).load(['quantity', 'reserved']);
          available = [...quants].reduce(
            (s, q) => s.plus(q.quantity).minus(q.reserved ?? zero),
            zero,
          );
        }
        await su.model('mrp.production.component').create([
          {
            production: o.id,
            product: orm.asId(product, 'product.product'),
            required: required.toDecimalPlaces(4),
            available: available.gt(0) ? available : zero,
          },
        ]);
      }
    }
  });
}

/** When a work centre's day starts (local time). */
export const DAY_STARTS_AT = 8;

/**
 * Forward schedule of `minutes` of work at a centre working `hoursPerDay` from `DAY_STARTS_AT`, from `from`: what does
 * not fit in a day continues the next day. Returns the start and the end.
 */
export function schedule(
  from: Date,
  minutes: number,
  hoursPerDay: number,
): { start: Date; stop: Date } {
  const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), DAY_STARTS_AT);
  const dayEnd = (d: Date) => new Date(dayStart(d).getTime() + hoursPerDay * 3_600_000);
  let at = new Date(Math.max(from.getTime(), dayStart(from).getTime()));
  if (at >= dayEnd(at)) at = dayStart(new Date(at.getTime() + 86_400_000));
  const start = at;
  let left = minutes * 60_000;
  for (;;) {
    const room = dayEnd(at).getTime() - at.getTime();
    if (left <= room) return { start, stop: new Date(at.getTime() + left) };
    left -= room;
    at = dayStart(new Date(dayStart(at).getTime() + 86_400_000));
  }
}

/**
 * A step of a production order at a work centre: planned from the bill's operation (its minutes for the quantity
 * ordered), scheduled after what the centre already has, then started and finished with the minutes it took.
 */
export const MrpWorkorder = defineModel('mrp.workorder', {
  label: 'Work order',
  tracking: ['state', 'plannedStart', 'workcenter'],
  recName: 'name',
  order: ['plannedStart asc', 'id asc'],
  companyScoped: { required: true },
  access: {
    'mrp.user': ['read', 'write'],
    'mrp.manager': [...ALL, 'export'],
  },
  fields: {
    production: f.many2one('mrp.production', { required: true, ondelete: 'cascade' }),
    name: f.char({ required: true, label: 'Operation' }),
    workcenter: f.many2one('mrp.workcenter', { required: true, ondelete: 'restrict' }),
    plannedMinutes: f.decimal({ scale: 2, required: true, default: '0', label: 'Planned minutes' }),
    plannedStart: f.datetime({ label: 'Planned start' }),
    plannedStop: f.datetime({ label: 'Planned end' }),
    startedAt: f.datetime({ label: 'Started' }),
    finishedAt: f.datetime({ label: 'Finished' }),
    /** The minutes it took (from start to finish). */
    actualMinutes: f.decimal({ scale: 2, label: 'Minutes taken' }),
    state: f.state({
      states: { ready: 'Ready', progress: 'In progress', done: 'Done', cancel: 'Cancelled' },
      initial: 'ready',
      help: 'Started and finished at the work centre; the minutes between them are recorded.',
      transitions: {
        start: {
          from: ['ready'],
          to: 'progress',
          after: records('mrp.workorder', async (orders): Promise<void> => {
            await orders.write({ startedAt: new Date() } as never);
          }),
        },
        finish: {
          from: ['progress'],
          to: 'done',
          after: records('mrp.workorder', async (orders): Promise<void> => {
            const now = new Date();
            for (const w of await orders.load({})) {
              const began = w.startedAt instanceof Date ? w.startedAt : now;
              await w.write({
                finishedAt: now,
                // Whole milliseconds, then minutes (Shutro takes no fractional JS numbers).
                actualMinutes: orm
                  .toDecimal(now.getTime() - began.getTime())
                  .div(60_000)
                  .toDecimalPlaces(2),
              } as never);
            }
          }),
        },
        /** Done with its order (Produce), however far it got. */
        close: { from: ['ready', 'progress'], to: 'done' },
        cancel: { from: ['ready', 'progress'], to: 'cancel' },
      },
    }),
  },
});

/**
 * Makes the orders' work orders from their bills' operations and schedules them forward, step after step, each at
 * its work centre after what the centre already has planned (from the order's date).
 */
async function planWork(ids: readonly Id<'mrp.production'>[], env: Env): Promise<void> {
  await env.asSuperuser({ reason: 'production schedule' }, async (su) => {
    const orders = await su
      .model('mrp.production')
      .browse(ids)
      .load({ bom: { operations: { workcenter: true } } });
    for (const o of orders) {
      if (o.bom === null) continue;
      const factor = o.quantity.div(o.bom.quantity);
      // The order's day, local (a date is read as text or as a local midnight).
      const day = new Date(`${iso(o.date as unknown)}T00:00:00`);
      let after = new Date(day.getFullYear(), day.getMonth(), day.getDate(), DAY_STARTS_AT);
      for (const op of o.bom.operations) {
        const minutes = op.minutes.times(factor).toDecimalPlaces(2);
        // The centre is free after the last step it has that is not done or cancelled.
        const busy = await (
          await su.model('mrp.workorder').search({
            where: { workcenter: op.workcenter.id, state: { in: ['ready', 'progress'] } },
            order: ['plannedStop desc'],
            limit: 1,
          })
        ).load(['plannedStop']);
        const free = [...busy][0]?.plannedStop;
        const from = free instanceof Date && free > after ? free : after;
        const { start, stop } = schedule(from, Number(minutes), Number(op.workcenter.hoursPerDay));
        await su.model('mrp.workorder').create([
          {
            production: o.id,
            company: o.company.id,
            name: op.name,
            workcenter: op.workcenter.id,
            plannedMinutes: minutes,
            plannedStart: start,
            plannedStop: stop,
          },
        ] as never);
        after = stop;
      }
    }
  });
}

/** The places of an order: its warehouse's stock, and the Production location. */
async function placesOf(
  env: Env,
  warehouse: Id<'stock.warehouse'> | null,
  company: Id<'res.company'>,
) {
  const stock = (await defaultLocations(env as never, 'internal', warehouse, company)).source;
  const production = (
    await env.model('stock.location').search({ where: { usage: 'production' }, limit: 1 })
  ).ids[0];
  if (stock === null || production === undefined)
    throw new orm.ValidationError(
      'mrp.production',
      ['warehouse'],
      'There is no stock location or Production location to work from.',
      'Check the warehouse in Stockroom › Configuration.',
    );
  return { stock, production };
}

export const MrpProduction = defineModel('mrp.production', {
  label: 'Production order',
  recName: 'name',
  order: ['date desc', 'id desc'],
  companyScoped: { required: true },
  tracking: ['state', 'quantity', 'bom'],
  access: {
    'mrp.user': ['read', 'write', 'create'],
    'mrp.manager': [...ALL, 'export', 'import'],
  },
  fields: {
    name: f.char({
      required: true,
      readonly: true,
      sequence: { code: 'mrp.production', dateField: 'date' },
      label: 'Reference',
    }),
    product: f.many2one('product.product', { required: true, ondelete: 'restrict' }),
    quantity: f.decimal({ scale: 4, required: true, default: '1' }),
    bom: f.many2one('mrp.bom', { ondelete: 'restrict', label: 'Bill of materials' }),
    date: f.date({ required: true, default: (env: Env) => env.today(), label: 'Planned for' }),
    warehouse: f.many2one('stock.warehouse', { ondelete: 'restrict' }),
    components: f.one2many('mrp.production.component', 'production'),
    /** Scrap recorded on the order, with its reasons (Stockroom's scrap). */
    scraps: f.one2many('stock.scrap', 'production'),
    workorders: f.one2many('mrp.workorder', 'production', { label: 'Work orders' }),
    consumption: f.many2one('stock.picking', {
      ondelete: 'set null',
      label: 'Components transfer',
    }),
    output: f.many2one('stock.picking', { ondelete: 'set null', label: 'Output transfer' }),
    /** The components at their cost. */
    materialCost: f.decimal({
      scale: 2,
      store: true,
      label: 'Materials',
      help: 'The components needed at their cost.',
      ...compute('mrp.production', 'materialCost', ['components.cost'], (orders) => {
        for (const o of orders)
          o.materialCost = [...o.components].reduce((s, c) => s.plus(c.cost ?? zero), zero);
      }),
    }),
    /** The operations at their work centres' cost per hour. */
    operationCost: f.decimal({
      scale: 2,
      store: true,
      label: 'Operations',
      help: 'The operations’ minutes for the quantity ordered at their work centres’ cost per hour.',
      ...compute(
        'mrp.production',
        'operationCost',
        [
          'quantity',
          'bom.quantity',
          'bom.operations.minutes',
          'bom.operations.workcenter.costPerHour',
        ],
        (orders) => {
          for (const o of orders) {
            if (o.bom === null) {
              o.operationCost = zero;
              continue;
            }
            const factor = o.quantity.div(o.bom.quantity);
            o.operationCost = money(
              [...o.bom.operations].reduce(
                (s, op) =>
                  s.plus(op.minutes.times(factor).div(60).times(op.workcenter.costPerHour)),
                zero,
              ),
            );
          }
        },
      ),
    }),
    totalCost: f.decimal({
      scale: 2,
      store: true,
      label: 'Total cost',
      help: 'The materials and the operations together.',
      ...compute('mrp.production', 'totalCost', ['materialCost', 'operationCost'], (orders) => {
        for (const o of orders)
          o.totalCost = (o.materialCost ?? zero).plus(o.operationCost ?? zero);
      }),
    }),
    unitCost: f.decimal({
      scale: 4,
      store: true,
      label: 'Unit cost',
      help: 'The total cost divided by the quantity made.',
      ...compute('mrp.production', 'unitCost', ['totalCost', 'quantity'], (orders) => {
        for (const o of orders)
          o.unitCost = o.quantity.gt(0)
            ? (o.totalCost ?? zero).div(o.quantity).toDecimalPlaces(4)
            : zero;
      }),
    }),
    /** The one chip: Draft, Waiting (components short), Ready, Done, Cancelled. */
    status: f.selection(
      { draft: 'Draft', waiting: 'Waiting', ready: 'Ready', done: 'Done', cancelled: 'Cancelled' },
      {
        store: true,
        label: 'Status',
        help: 'A confirmed order is ready once all its components are reserved, otherwise it is waiting.',
        ...compute('mrp.production', 'status', ['state', 'consumption.availability'], (orders) => {
          for (const o of orders)
            o.status =
              o.state === 'confirmed'
                ? o.consumption?.availability === 'full'
                  ? 'ready'
                  : 'waiting'
                : o.state === 'cancel'
                  ? 'cancelled'
                  : o.state;
        }),
      },
    ),
    note: f.text(),
    state: f.state({
      states: { draft: 'Draft', confirmed: 'Confirmed', done: 'Done', cancel: 'Cancelled' },
      initial: 'draft',
      help: 'Confirmed, the components are reserved and the work orders scheduled; done, the product is made.',
      transitions: {
        /** Lists the components with what is available and short, and the cost, before anything starts. */
        check: {
          from: ['draft', 'confirmed'],
          to: 'draft',
          guard: records('mrp.production', async (orders) =>
            (await orders.load({})).filter((o) => o.state !== 'draft'),
          ),
          message: 'A confirmed order is checked with Check availability.',
          after: records('mrp.production', async (orders): Promise<void> => {
            await explode(orders.ids, orders.env);
          }),
        },
        confirm: emitting('mrp.production.confirmed', {
          from: ['draft'],
          to: 'confirmed',
          guard: records('mrp.production', async (orders) => {
            const env = orders.env as unknown as Env;
            const out: number[] = [];
            for (const o of await orders.load({ bom: true, company: true })) {
              if (o.bom === null || o.bom.state === 'inactive' || o.bom.state === 'review') {
                out.push(o.id);
                continue;
              }
              if (o.bom.state === 'draft' && (await bomsNeedApproval(env, o.company.id as number)))
                out.push(o.id);
            }
            return out;
          }),
          message:
            'Choose a bill of materials that may be used: an active one (or a draft, when bills need no approval).',
          // The components, their transfer to Production (reserved), and the work orders, scheduled.
          after: records('mrp.production', async (orders): Promise<void> => {
            await explode(orders.ids, orders.env);
            await planWork(orders.ids, orders.env as unknown as Env);
            const env = orders.env as unknown as Env;
            for (const o of await env
              .model('mrp.production')
              .browse(orders.ids)
              .load({ components: true })) {
              // Nothing to consume (labour only): no components transfer.
              if (o.components.length === 0) continue;
              const { stock, production } = await placesOf(
                env,
                o.warehouse?.id ?? null,
                o.company.id,
              );
              const made = await env.model('stock.picking').create([
                {
                  kind: 'production',
                  company: o.company.id,
                  warehouse: o.warehouse?.id ?? null,
                  source: stock,
                  destination: production,
                  origin: o.name,
                  scheduledDate: o.date,
                  moves: {
                    create: [...o.components].map((c) => ({
                      product: c.product.id,
                      quantity: c.required,
                    })),
                  },
                },
              ]);
              await made.confirm();
              await env
                .model('mrp.production')
                .browse([o.id])
                .write({ consumption: made.ids[0] ?? null });
            }
          }),
        }),
        /** "Check availability": reserve the components that came in since. */
        reserve: {
          from: ['confirmed'],
          to: 'confirmed',
          after: records('mrp.production', async (orders): Promise<void> => {
            const env = orders.env as unknown as Env;
            for (const o of await env.model('mrp.production').browse(orders.ids).load({}))
              if (o.consumption !== null)
                await env.model('stock.picking').browse([o.consumption.id]).reserve();
          }),
        },
        produce: emitting('mrp.production.done', {
          from: ['confirmed'],
          to: 'done',
          guard: records('mrp.production', async (orders) =>
            (await orders.load({ consumption: true })).filter(
              (o) => o.consumption !== null && o.consumption.availability !== 'full',
            ),
          ),
          message: 'Components are short: check availability, or wait for them to come in.',
          before: records('mrp.production', async (orders): Promise<void> => {
            const env = orders.env as unknown as Env;
            // What is left of the work is done with the order.
            const open = await env.model('mrp.workorder').search({
              where: { production: { in: [...orders.ids] }, state: { in: ['ready', 'progress'] } },
            });
            if (open.length > 0) await open.close();
            for (const o of await env.model('mrp.production').browse(orders.ids).load({})) {
              if (o.consumption !== null)
                await env.model('stock.picking').browse([o.consumption.id]).validate();
              const { stock, production } = await placesOf(
                env,
                o.warehouse?.id ?? null,
                o.company.id,
              );
              const [bill] =
                o.bom === null
                  ? []
                  : await env.model('mrp.bom').browse([o.bom.id]).load({ byproducts: true });
              const factor = bill === undefined ? zero : o.quantity.div(bill.quantity);
              const made = await env.model('stock.picking').create([
                {
                  kind: 'production',
                  company: o.company.id,
                  warehouse: o.warehouse?.id ?? null,
                  source: production,
                  destination: stock,
                  origin: o.name,
                  moves: {
                    create: [
                      { product: o.product.id, quantity: o.quantity },
                      ...[...(bill?.byproducts ?? [])].map((b) => ({
                        product: b.product.id,
                        quantity: b.quantity.times(factor).toDecimalPlaces(4),
                        uom: b.uom?.id ?? null,
                      })),
                    ],
                  },
                },
              ]);
              // Linked before it is validated: what values it (mrp_account) finds its order.
              await env
                .model('mrp.production')
                .browse([o.id])
                .write({ output: made.ids[0] ?? null });
              await made.confirm();
              await made.validate();
            }
          }),
        }),
        cancel: {
          from: ['draft', 'confirmed'],
          to: 'cancel',
          after: records('mrp.production', async (orders): Promise<void> => {
            const env = orders.env as unknown as Env;
            const open = await env.model('mrp.workorder').search({
              where: { production: { in: [...orders.ids] }, state: { in: ['ready', 'progress'] } },
            });
            for (const w of await open.load({})) await w.cancel();
            for (const o of await env
              .model('mrp.production')
              .browse(orders.ids)
              .load({ consumption: true }))
              if (
                o.consumption !== null &&
                o.consumption.state !== 'done' &&
                o.consumption.state !== 'cancel'
              )
                await env.model('stock.picking').browse([o.consumption.id]).cancel();
          }),
        },
        redraft: { from: ['cancel'], to: 'draft' },
      },
    }),
  },
  onchange: {
    // The bill valid on the order's date, and the company's first warehouse.
    product: onchange('mrp.production', async (d, env) => {
      const product = d.get('product') as Id<'product.product'> | null | undefined;
      if (product === null || product === undefined) return;
      d.set('bom', await validBom(env, product, String(d.get('date') ?? env.today())));
      if ((d.get('warehouse') ?? null) === null)
        d.set('warehouse', (await defaultLocations(env as never, 'internal')).warehouse);
    }),
    date: onchange('mrp.production', async (d, env) => {
      const product = d.get('product') as Id<'product.product'> | null | undefined;
      if (product === null || product === undefined) return;
      d.set('bom', await validBom(env, product, String(d.get('date') ?? env.today())));
    }),
  },
  sqlConstraints: {
    positive: { check: orm.sql`quantity > 0`, message: 'An order makes a positive quantity.' },
  },
  constraints: {
    billOfTheProduct: {
      ...check('mrp.production', ['bom', 'product'], async (orders) =>
        (await orders.load({ bom: true }))
          .filter((o) => o.bom !== null && o.bom.product.id !== o.product.id)
          .map((o) => o.id),
      ),
      message: 'The bill of materials is for another product.',
    },
  },
});

/** Scrap recorded on a production order (a broken component, a faulty unit made), with its reason. */
export const ScrapProduction = extendModel('stock.scrap', {
  fields: {
    production: f.many2one('mrp.production', { ondelete: 'set null', label: 'Production order' }),
  },
});

/**
 * Reorder rules that make (RFC 0024 §2.6): production orders not produced yet are on order; ordering makes one
 * production order per rule with the bill valid on its date, confirmed (its components reserved, its work planned).
 */
export const ReorderMake = extendModel('stock.reorder', {
  overrides: {
    pending: async function (
      this: unknown,
      next: () => Promise<Map<number, { quantity: string; document: string }[]>>,
    ): Promise<Map<number, { quantity: string; document: string }[]>> {
      const out = await next();
      const rules = this as Records<'stock.reorder'>;
      const env = rules.env as unknown as Env;
      for (const r of await rules.load({})) {
        const main = (await defaultLocations(env as never, 'internal', null, r.company.id))
          .warehouse;
        const orders = await (
          await env.model('mrp.production').search({
            where: {
              product: r.product.id,
              company: r.company.id,
              state: { in: ['draft', 'confirmed'] },
            },
          })
        ).load({});
        const found = out.get(r.id) ?? [];
        for (const o of orders)
          if ((o.warehouse?.id ?? main) === r.warehouse.id)
            found.push({ quantity: o.quantity.toString(), document: o.name });
        out.set(r.id, found);
      }
      return out;
    },
    procure: async function (
      this: unknown,
      next: (quantities: ReadonlyMap<number, string>) => Promise<Map<number, string>>,
      quantities: ReadonlyMap<number, string>,
    ): Promise<Map<number, string>> {
      const out = await next(quantities);
      const rules = this as Records<'stock.reorder'>;
      const env = rules.env as unknown as Env;
      for (const r of await rules.load({ product: true })) {
        const qty = quantities.get(r.id);
        if (r.method !== 'make' || qty === undefined) continue;
        const date = new Date(`${env.today()}T00:00:00Z`);
        date.setUTCDate(date.getUTCDate() + r.leadDays);
        const when = date.toISOString().slice(0, 10);
        const bom = await validBom(env, r.product.id, when);
        if (bom === null)
          throw new orm.ValidationError(
            'stock.reorder',
            ['method'],
            `${r.product.name} has no bill of materials valid on ${when}.`,
            'Add one in Production › Bills of materials, or replenish it another way.',
          );
        const made = await env.model('mrp.production').create([
          {
            product: r.product.id,
            quantity: qty,
            bom,
            date: when,
            warehouse: r.warehouse.id,
            company: r.company.id,
            note: 'Replenishment',
          },
        ]);
        await made.confirm();
        const [order] = await made.load({});
        out.set(r.id, order?.name ?? '');
      }
      return out;
    },
  },
});

export const mrpShutro = defineModule({
  name: 'mrp',
  version: '0.3.0',
  depends: [productShutro, stockShutro, contactsShutro, messagingShutro, permissionsShutro],
  groups: [
    orm.defineGroup({ code: 'mrp.user', label: 'Production user', implies: ['stock.user'] }),
    orm.defineGroup({ code: 'mrp.manager', label: 'Production manager', implies: ['mrp.user'] }),
  ],
  sequences: [
    orm.defineSequence({
      code: 'mrp.production',
      prefix: 'MO/{year}/',
      padding: 5,
      reset: 'yearly',
    }),
  ],
  models: [
    MrpWorkcenter,
    MrpBom,
    MrpBomLine,
    MrpBomByproduct,
    MrpBomOperation,
    MrpProduction,
    MrpProductionComponent,
    MrpWorkorder,
    MrpSpecParameter,
    MrpProductSpec,
    MrpBomSpec,
    MrpBomCost,
    MrpBomEligibility,
    MrpShift,
  ],
  extensions: [ScrapProduction, ReorderMake, CompanyMrp],
});
