/**
 * Vendor prices (RFC 0030 §3.1): what a vendor charges for a product (or every product of a category), from what
 * quantity, between which dates, in which currency, with their own code and name for it and how many days they take.
 * `vendorPriceFor` picks one and says why in words: the preferred vendor when one fits, else the cheapest that
 * fits — and, with a date it is needed by, the cheapest that arrives in time. Purchase lines, reorder rules and
 * Replenishment use it.
 */
import type { orm } from '@kosh/server/orm';
import { defineModel, type Env, f } from './.kosh/bindings.js';

const ALL = ['read', 'write', 'create', 'unlink', 'export', 'import'] as const;

export const ProductVendorPrice = defineModel('product.vendor.price', {
  label: 'Vendor price',
  archivable: true,
  companyScoped: { required: false },
  order: ['sequence asc', 'minQuantity asc', 'id asc'],
  access: {
    'purchase.user': ['read', 'write', 'create', 'export', 'import'],
    'purchase.manager': ALL,
  },
  fields: {
    vendor: f.many2one('res.partner', { required: true, ondelete: 'cascade', label: 'Vendor' }),
    product: f.many2one('product.product', { ondelete: 'cascade', label: 'Product' }),
    category: f.many2one('product.category', {
      ondelete: 'cascade',
      label: 'Category',
      help: 'For every product of the category that has no price of its own from this vendor.',
    }),
    vendorCode: f.char({ label: 'Vendor’s code' }),
    vendorName: f.char({ label: 'Vendor’s name for it' }),
    currency: f.many2one('res.currency', {
      label: 'Currency',
      help: 'Used on orders in this currency; empty: any.',
    }),
    minQuantity: f.decimal({
      scale: 3,
      required: true,
      default: '0',
      label: 'From quantity',
      help: 'The price applies from this quantity on (price breaks: one row per break).',
    }),
    price: f.decimal({ scale: 2, required: true, label: 'Price' }),
    dateFrom: f.date({ label: 'Valid from' }),
    dateTo: f.date({ label: 'Valid until' }),
    leadDays: f.integer({
      required: true,
      default: 0,
      label: 'Lead days',
      help: 'Days from ordering to arrival.',
    }),
    preferred: f.boolean({
      default: false,
      label: 'Preferred',
      help: 'Chosen before cheaper vendors when its price fits (and it arrives in time).',
    }),
    sequence: f.integer({ default: 10 }),
  },
  constraints: {
    productOrCategory: {
      depends: ['product', 'category'],
      check: async (records: never) =>
        [
          ...(records as Iterable<{
            id: number;
            product: { id: number } | null;
            category: { id: number } | null;
          }>),
        ]
          .filter((r) => (r.product === null) === (r.category === null))
          .map((r) => r.id),
      message: 'A vendor price is for a product or for a category, one of the two.',
    },
    dates: {
      depends: ['dateFrom', 'dateTo'],
      check: async (records: never) =>
        [...(records as Iterable<{ id: number; dateFrom: string | null; dateTo: string | null }>)]
          .filter((r) => r.dateFrom !== null && r.dateTo !== null && r.dateTo < r.dateFrom)
          .map((r) => r.id),
      message: 'A vendor price ends on or after the day it starts.',
    },
  },
});

type Decimal = ReturnType<typeof orm.toDecimal>;

/** The vendor price chosen, and why. */
export interface VendorChoice {
  readonly id: number;
  readonly vendor: number;
  readonly vendorName: string;
  readonly price: Decimal;
  readonly leadDays: number;
  readonly vendorCode: string | null;
  readonly explanation: string;
}

const dayOf = (v: unknown) =>
  v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? '').slice(0, 10);
const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/**
 * The price a vendor (or the best vendor) charges for `quantity` of a product on `date`, as the caller: the
 * product's own rows before its category's; the preferred row before the others when it fits; with `needBy`, rows
 * that arrive later only when none arrives in time; the cheapest, then the quickest. Null when no row fits.
 */
export async function vendorPriceFor(
  env: Env,
  input: {
    readonly product: number;
    readonly quantity: Decimal;
    readonly date: string;
    readonly vendor?: number | null;
    readonly currency?: number | null;
    readonly needBy?: string | null;
  },
): Promise<VendorChoice | null> {
  const [product] = await env
    .model('product.product')
    .browse([input.product as never])
    .load({ category: true });
  if (product === undefined) return null;
  const category = (product.category?.id as number | undefined) ?? null;
  const found = await env.model('product.vendor.price').search({
    where: {
      or: [{ product: input.product }, ...(category === null ? [] : [{ product: null, category }])],
      minQuantity: { lte: input.quantity.toString() },
      ...(input.vendor == null ? {} : { vendor: input.vendor }),
    } as never,
  });
  const rows = [...(await found.load({ vendor: true, currency: true, product: true }))].filter(
    (r) => {
      const from = r.dateFrom === null ? null : dayOf(r.dateFrom);
      const to = r.dateTo === null ? null : dayOf(r.dateTo);
      if (from !== null && from > input.date) return false;
      if (to !== null && to < input.date) return false;
      if (r.currency !== null && input.currency != null && r.currency.id !== input.currency)
        return false;
      return true;
    },
  );
  if (rows.length === 0) return null;
  // The product's own rows win over its category's; per vendor, the highest quantity break that fits.
  const own = rows.filter((r) => r.product !== null);
  const pool = own.length > 0 ? own : rows;
  const best = new Map<number, (typeof pool)[number]>();
  for (const r of pool) {
    const v = r.vendor.id as number;
    const seen = best.get(v);
    if (seen === undefined || r.minQuantity.gt(seen.minQuantity)) best.set(v, r);
  }
  const candidates = [...best.values()];
  const inTime = (r: (typeof candidates)[number]) =>
    input.needBy == null || addDays(input.date, r.leadDays) <= input.needBy;
  const timely = candidates.filter(inTime);
  const usable = timely.length > 0 ? timely : candidates;
  const cheapest = [...usable].sort(
    (a, b) => a.price.comparedTo(b.price) || a.leadDays - b.leadDays,
  )[0];
  const preferred = usable.find((r) => r.preferred);
  const chosen = preferred ?? cheapest;
  if (chosen === undefined) return null;
  const vendorName = String(chosen.vendor.name ?? '');
  const breakText = chosen.minQuantity.gt(0) ? ` from ${chosen.minQuantity.toString()}` : '';
  const scope = chosen.product === null ? ' (its category’s price)' : '';
  const reasons: string[] = [];
  if (input.vendor != null) reasons.push(`${vendorName}’s price${breakText}${scope}`);
  else if (preferred !== undefined) reasons.push(`${vendorName} is preferred${breakText}${scope}`);
  else if (usable.length > 1)
    reasons.push(`${vendorName} is the cheapest of ${usable.length}${breakText}${scope}`);
  else reasons.push(`${vendorName}’s price${breakText}${scope}`);
  if (input.needBy != null)
    reasons.push(
      timely.length > 0
        ? `arrives in ${chosen.leadDays} days, in time`
        : `nobody arrives by ${input.needBy}; ${chosen.leadDays} days`,
    );
  else if (chosen.leadDays > 0) reasons.push(`${chosen.leadDays} days to arrive`);
  return {
    id: chosen.id as number,
    vendor: chosen.vendor.id as number,
    vendorName,
    price: chosen.price,
    leadDays: chosen.leadDays,
    vendorCode: chosen.vendorCode ?? null,
    explanation: `${reasons.join('; ')}.`,
  };
}
