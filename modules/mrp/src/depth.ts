/**
 * Bills of materials in depth (RFC 0031 §3.2): the generic **specifications** a formula must reach (parameters such
 * as protein or moisture, their values per product, the range a bill asks for and the value its lines reach), the
 * **costing history** of each version, the **component eligibility** (which product categories may be components
 * of each kind of bill in a company) and the **shifts** schedules run in (step 4). A company may require bills to
 * be **approved** before use (its setting); then only active bills make products.
 */
import { type Decimal, orm } from '@kosh/server/orm';
import { check, compute, defineModel, type Env, extendModel, f } from './.kosh/bindings.js';

const READ = ['read'] as const;
const ALL = ['read', 'write', 'create', 'unlink'] as const;
const zero: Decimal = orm.toDecimal(0);
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export const BOM_KINDS = {
  standard: 'Standard',
  formula: 'Formula (shares of a batch)',
  packaging: 'Packaging (a pack of the product)',
} as const;

/** A parameter products are measured by (protein, moisture, energy…), with its unit. */
export const MrpSpecParameter = defineModel('mrp.spec.parameter', {
  label: 'Specification parameter',
  recName: 'name',
  order: ['name asc'],
  archivable: true,
  access: { 'mrp.user': READ, 'mrp.manager': [...ALL, 'export', 'import'] },
  fields: {
    name: f.char({ required: true, translate: true }),
    unit: f.char({ size: 20, help: '%, kcal/kg, mg/kg…' }),
    note: f.text(),
  },
});

/** A product's value for a parameter (a raw material's protein, say). */
export const MrpProductSpec = defineModel('mrp.product.spec', {
  label: 'Product specification',
  order: ['product asc', 'parameter asc'],
  access: { 'mrp.user': READ, 'mrp.manager': [...ALL, 'export', 'import'] },
  fields: {
    product: f.many2one('product.product', { required: true, ondelete: 'cascade' }),
    parameter: f.many2one('mrp.spec.parameter', { required: true, ondelete: 'restrict' }),
    value: f.decimal({ scale: 4, required: true, default: '0' }),
  },
  sqlConstraints: {
    once: {
      unique: ['product', 'parameter'],
      message: 'A product has one value per parameter.',
    },
  },
});

/** The values a product's specifications reach for a bill's lines, weighted by each line's share of the batch. */
export async function reachedValues(env: Env, bomId: number): Promise<Map<number, Decimal>> {
  const [bom] = await env
    .model('mrp.bom')
    .browse([bomId as never])
    .load({ lines: { product: true } });
  const out = new Map<number, Decimal>();
  if (bom === undefined) return out;
  const lines = [...bom.lines];
  const total = lines.reduce((s, l) => s.plus(l.netQuantity ?? l.quantity), zero);
  if (total.lte(0)) return out;
  const specs = await (
    await env.model('mrp.product.spec').search({
      where: { product: { in: lines.map((l) => l.product.id) } } as never,
    })
  ).load({ product: true, parameter: true });
  for (const s of specs) {
    const line = lines.find((l) => l.product.id === s.product.id);
    if (line === undefined) continue;
    const weight = (line.netQuantity ?? line.quantity).div(total);
    const key = s.parameter.id as number;
    out.set(key, (out.get(key) ?? zero).plus(s.value.times(weight)));
  }
  return out;
}

/** The range a bill asks for on a parameter, and the value its lines reach. */
export const MrpBomSpec = defineModel('mrp.bom.spec', {
  label: 'Bill specification',
  order: ['bom asc', 'id asc'],
  access: { 'mrp.user': READ, 'mrp.manager': ALL },
  fields: {
    bom: f.many2one('mrp.bom', { required: true, ondelete: 'cascade' }),
    parameter: f.many2one('mrp.spec.parameter', { required: true, ondelete: 'restrict' }),
    minimum: f.decimal({ scale: 4, label: 'Minimum' }),
    maximum: f.decimal({ scale: 4, label: 'Maximum' }),
    value: f.decimal({
      scale: 4,
      store: true,
      label: 'Reached',
      help: 'What the bill’s lines reach, each product’s value weighted by its share of the batch.',
      ...compute(
        'mrp.bom.spec',
        'value',
        ['parameter', 'bom.lines.product', 'bom.lines.netQuantity', 'bom.lines.quantity'],
        async (specs) => {
          const env = (specs as unknown as { env: Env }).env;
          const cache = new Map<number, Map<number, Decimal>>();
          for (const s of specs) {
            const bomId = s.bom.id as number;
            let values = cache.get(bomId);
            if (values === undefined) {
              values = await reachedValues(env, bomId);
              cache.set(bomId, values);
            }
            s.value = values.get(s.parameter.id as number) ?? zero;
          }
        },
      ),
    }),
    within: f.boolean({
      store: true,
      label: 'Within range',
      help: 'The reached value is between the minimum and the maximum.',
      ...compute('mrp.bom.spec', 'within', ['value', 'minimum', 'maximum'], (specs) => {
        for (const s of specs) {
          const v = s.value ?? zero;
          s.within =
            (s.minimum === null || v.gte(s.minimum)) && (s.maximum === null || v.lte(s.maximum));
        }
      }),
    }),
  },
  sqlConstraints: {
    range: {
      check: orm.sql`minimum IS NULL OR maximum IS NULL OR maximum >= minimum`,
      message: 'The maximum is at or above the minimum.',
    },
  },
});

/** The unit cost of a bill when it was activated or revised: the costing history. */
export const MrpBomCost = defineModel('mrp.bom.cost', {
  label: 'Bill cost',
  order: ['bom asc', 'date desc', 'id desc'],
  access: { 'mrp.user': READ, 'mrp.manager': READ },
  fields: {
    bom: f.many2one('mrp.bom', { required: true, ondelete: 'cascade' }),
    date: f.date({ required: true }),
    unitCost: f.decimal({ scale: 4, required: true, label: 'Unit cost' }),
    note: f.char({ size: 200 }),
  },
});

/** Which product categories may be components of a kind of bill in a company. */
export const MrpBomEligibility = defineModel('mrp.bom.eligibility', {
  label: 'Component eligibility',
  recName: 'label',
  order: ['kind asc', 'id asc'],
  archivable: true,
  companyScoped: { required: true },
  access: { 'mrp.user': READ, 'mrp.manager': [...ALL, 'export', 'import'] },
  fields: {
    kind: f.selection(BOM_KINDS, {
      required: true,
      default: 'standard',
      label: 'Kind of bill',
      help: 'The kind of bill these categories may be components of.',
    }),
    categories: f.many2many('product.category', {
      relation: 'mrp_bom_eligibility_category',
      label: 'Allowed component categories',
      help: 'Products of these categories (and the categories inside them) may be components; others are refused.',
    }),
    note: f.text(),
    label: f.char({
      store: true,
      label: 'Eligibility',
      ...compute('mrp.bom.eligibility', 'label', ['kind'], (rules) => {
        for (const r of rules)
          r.label = `${BOM_KINDS[r.kind as keyof typeof BOM_KINDS]} components`;
      }),
    }),
  },
});

/**
 * Why a product may not be a component of a bill in its company, or null: the eligibility rules of the bill's
 * kind name categories, and the product's category (or one above it) is not among them.
 */
export async function ineligible(
  env: Env,
  company: number,
  kind: string,
  productId: number,
): Promise<string | null> {
  const rules = await (
    await env
      .model('mrp.bom.eligibility')
      .search({ where: { company: company as never, kind: kind as never } })
  ).load({ categories: true });
  const allowed = new Set<number>();
  for (const r of rules) for (const c of r.categories) allowed.add(c.id as number);
  if (rules.length === 0 || allowed.size === 0) return null;
  const [product] = await env
    .model('product.product')
    .browse([productId as never])
    .load({ category: true });
  let category = (product?.category?.id as number | undefined) ?? null;
  for (let depth = 0; category !== null && depth < 10; depth += 1) {
    if (allowed.has(category)) return null;
    const [c] = await env
      .model('product.category')
      .browse([category as never])
      .load({ parent: true });
    category = (c?.parent?.id as number | undefined) ?? null;
  }
  const names = [
    ...(await env
      .model('product.category')
      .browse([...allowed] as never)
      .load({})),
  ]
    .map((c) => c.name)
    .join(', ');
  return `${product?.name ?? productId} is not an allowed component of a ${BOM_KINDS[kind as keyof typeof BOM_KINDS].toLowerCase()} bill (allowed: ${names}).`;
}

/** A shift of the day (schedules run in them, RFC 0031 step 4). */
export const MrpShift = defineModel('mrp.shift', {
  label: 'Shift',
  recName: 'name',
  order: ['start asc', 'name asc'],
  archivable: true,
  companyScoped: { required: true },
  access: { 'mrp.user': READ, 'mrp.manager': [...ALL, 'export', 'import'] },
  fields: {
    name: f.char({ required: true, translate: true }),
    start: f.char({ size: 5, required: true, default: '06:00', help: 'HH:MM, 24-hour.' }),
    end: f.char({
      size: 5,
      required: true,
      default: '14:00',
      help: 'HH:MM; before the start for a shift over midnight.',
    }),
    hours: f.decimal({
      scale: 2,
      store: true,
      label: 'Hours',
      help: 'The shift’s length (over midnight when it ends before it starts).',
      ...compute('mrp.shift', 'hours', ['start', 'end'], (shifts) => {
        for (const s of shifts) {
          const [sh, sm] = s.start.split(':').map(Number) as [number, number];
          const [eh, em] = s.end.split(':').map(Number) as [number, number];
          let minutes = eh * 60 + em - (sh * 60 + sm);
          if (minutes <= 0) minutes += 24 * 60;
          s.hours = orm.toDecimal(minutes).div(60).toDecimalPlaces(2);
        }
      }),
    }),
  },
  constraints: {
    times: {
      ...check('mrp.shift', ['start', 'end'], async (shifts) =>
        [...shifts].filter((s) => !TIME.test(s.start) || !TIME.test(s.end)).map((s) => s.id),
      ),
      message: 'Times are HH:MM, 24-hour (06:00, 22:30).',
    },
  },
});

/** Whether bills must be approved before they make products (Settings › App settings › Production). */
export const CompanyMrp = extendModel('res.company', {
  fields: {
    bomApproval: f.boolean({
      default: false,
      label: 'Bills of materials need approval',
      help: 'On: only active bills — submitted, reviewed and approved — make products; off: a draft bill is used as soon as it is written.',
    }),
  },
});

export async function bomsNeedApproval(env: Env, company: number): Promise<boolean> {
  const [c] = await env
    .model('res.company')
    .browse([company as never])
    .load(['bomApproval']);
  return c?.bomApproval === true;
}
