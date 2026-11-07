/**
 * Price lists (RFC 0028 §3.1): a list holds rules — for a product, a category (and the categories under it) or
 * everything; from a quantity; between dates — each giving a fixed price, a percent off a base, or a formula (a percent
 * off the base, plus a surcharge, rounded to a step, kept within a margin over the cost). The base is the list price,
 * the cost or another price list. The most specific rule wins: a product's over a category's (the nearest category
 * first) over everything, then the highest quantity reached, then the rule's sequence.
 *
 * {@link priceFor} prices one product on the server — Sales, the Shop and Counter all use it — and says why.
 */
import { orm } from '@kosh/server/orm';
import { defineModel, type Env, f } from './.kosh/bindings.js';

type Decimal = ReturnType<typeof orm.toDecimal>;
type Row = Record<string, unknown>;

const ALL = ['read', 'write', 'create', 'unlink', 'export', 'import'] as const;
const READ = ['read'] as const;

export const ProductPricelist = defineModel('product.pricelist', {
  label: 'Price list',
  archivable: true,
  order: ['sequence asc', 'name asc'],
  access: { 'product.user': READ, 'product.manager': ALL },
  fields: {
    name: f.char({ required: true, translate: true }),
    sequence: f.integer({ default: 10 }),
    currency: f.many2one('res.currency', {
      label: 'Currency',
      help: 'The currency of its prices; an order on this list is in it.',
    }),
    /** Empty: every company. */
    company: f.many2one('res.company', { ondelete: 'cascade', label: 'Company' }),
    rules: f.one2many('product.pricelist.rule', 'pricelist', { label: 'Rules' }),
    note: f.text({ label: 'Note' }),
  },
});

export const ProductPricelistRule = defineModel('product.pricelist.rule', {
  label: 'Price rule',
  order: ['pricelist asc', 'sequence asc', 'id asc'],
  access: { 'product.user': READ, 'product.manager': ALL },
  fields: {
    pricelist: f.many2one('product.pricelist', { required: true, ondelete: 'cascade' }),
    sequence: f.integer({ default: 10 }),
    appliesTo: f.selection(
      { all: 'Every product', category: 'A category', product: 'A product' },
      {
        required: true,
        default: 'all',
        label: 'Applies to',
        help: 'Which products the rule prices: one product, a category and those under it, or every product.',
      },
    ),
    product: f.many2one('product.product', { ondelete: 'cascade', label: 'Product' }),
    category: f.many2one('product.category', {
      ondelete: 'cascade',
      label: 'Category',
      help: 'The category and every category under it.',
    }),
    minQuantity: f.decimal({
      scale: 3,
      default: '0',
      label: 'From quantity',
      help: 'The rule applies from this quantity on the line.',
    }),
    dateFrom: f.date({ label: 'From' }),
    dateTo: f.date({ label: 'Until' }),
    compute: f.selection(
      { fixed: 'A fixed price', discount: 'A percent off', formula: 'A formula' },
      {
        required: true,
        default: 'fixed',
        label: 'Price',
        help: 'A fixed price; a percent off the base; or a formula: the percent off, plus an amount, rounded, kept within a margin over the cost.',
      },
    ),
    fixedPrice: f.decimal({ scale: 2, label: 'Price' }),
    base: f.selection(
      { list: 'The list price', cost: 'The cost', pricelist: 'Another price list' },
      {
        required: true,
        default: 'list',
        label: 'Based on',
        help: 'What the percent is taken off: the product’s list price, its cost, or its price on another list.',
      },
    ),
    basePricelist: f.many2one('product.pricelist', { ondelete: 'restrict', label: 'Other list' }),
    discount: f.decimal({
      scale: 2,
      default: '0',
      label: 'Percent off',
      help: 'Off the base; negative for a markup.',
    }),
    surcharge: f.decimal({ scale: 2, default: '0', label: 'Plus' }),
    rounding: f.decimal({
      scale: 2,
      default: '0',
      label: 'Round to',
      help: 'The price is rounded to a multiple of this (1: whole taka; 0: not rounded).',
    }),
    minMargin: f.decimal({ scale: 2, label: 'At least over cost' }),
    maxMargin: f.decimal({ scale: 2, label: 'At most over cost' }),
  },
  constraints: {
    complete: {
      depends: [
        'appliesTo',
        'product',
        'category',
        'compute',
        'fixedPrice',
        'base',
        'basePricelist',
      ],
      check: async (records: never) => {
        const rules = records as Iterable<{
          id: number;
          appliesTo: string;
          product: { id: number } | null;
          category: { id: number } | null;
          compute: string;
          fixedPrice: Decimal | null;
          base: string;
          basePricelist: { id: number } | null;
        }>;
        const failing: number[] = [];
        for (const r of rules)
          if (
            (r.appliesTo === 'product' && r.product === null) ||
            (r.appliesTo === 'category' && r.category === null) ||
            (r.compute === 'fixed' && r.fixedPrice === null) ||
            (r.compute !== 'fixed' && r.base === 'pricelist' && r.basePricelist === null)
          )
            failing.push(r.id);
        return failing;
      },
      message:
        'A rule names its product or category, a fixed price its price, and a price based on another list that list.',
    },
    noCycle: {
      depends: ['basePricelist', 'pricelist'],
      check: async (records: never) => {
        const { env } = records as { env: Env };
        const rules = records as Iterable<{
          id: number;
          pricelist: { id: number };
          basePricelist: { id: number } | null;
        }>;
        const failing: number[] = [];
        for (const r of rules) {
          if (r.basePricelist === null) continue;
          // Following the base lists from this rule's must never come back to its own list.
          const seen = new Set<number>([r.pricelist.id]);
          let next: number[] = [r.basePricelist.id];
          for (let depth = 0; next.length > 0 && depth < 20; depth += 1) {
            if (next.some((n) => seen.has(n))) {
              failing.push(r.id);
              break;
            }
            for (const n of next) seen.add(n);
            const rows = await env.asSuperuser({ reason: 'price list cycle' }, async (su) =>
              (
                await (
                  await su.model('product.pricelist.rule').search({
                    where: { pricelist: { in: next }, basePricelist: { isNull: false } } as never,
                  })
                ).load({ basePricelist: true })
              ).map((x) => (x.basePricelist as { id: number } | null)?.id ?? 0),
            );
            next = [...new Set(rows.filter((id) => id > 0))];
          }
        }
        return failing;
      },
      message: 'A price list cannot be based on itself, even through other lists.',
    },
  },
});

/** A product's price on a list: the price, the rule used (or null), and why, in words. */
export interface PriceFound {
  readonly price: Decimal;
  readonly rule: number | null;
  readonly explanation: string;
}

const dec = (v: unknown): Decimal => orm.toDecimal(v === null || v === undefined ? '0' : String(v));

/** Rounds to a multiple of `step` (half up); a step of 0 leaves it. */
function roundTo(value: Decimal, step: Decimal): Decimal {
  if (step.lte(0)) return value;
  return value.div(step).toDecimalPlaces(0, 4).times(step);
}

/**
 * The price of `product` on `pricelist` for `quantity` on `date` (ISO), read as the caller, and why. Without a list, or
 * when no rule applies, the product's list price. @param depth guards lists based on lists (cycles are refused when
 * saved; this stops anyway)
 */
export async function priceFor(
  env: Env,
  pricelist: number | null,
  product: number,
  quantity: Decimal | string | number,
  date: string,
  depth = 0,
): Promise<PriceFound> {
  // Read with the caller's rights (product users read price lists): no system scope, so it runs in reads too.
  const su = env;
  {
    const [p] = (
      await su
        .model('product.product')
        .browse([product as never])
        .load({ category: true })
    ).map((x) => ({
      listPrice: dec(x.listPrice),
      cost: dec(x.standardPrice),
      category: (x.category as { id: number } | null)?.id ?? null,
    }));
    if (p === undefined)
      throw new orm.ValidationError('product.pricelist', [], 'No such product.', '');
    if (pricelist === null || depth > 5)
      return { price: p.listPrice, rule: null, explanation: 'List price.' };
    const [list] = await (
      await su
        .withFlags({ activeTest: false })
        .model('product.pricelist')
        .search({
          where: { id: pricelist } as never,
          limit: 1,
        })
    ).load([]);
    if (list === undefined) return { price: p.listPrice, rule: null, explanation: 'List price.' };
    const listName = String((list as unknown as Row)['name'] ?? '');
    // The product's category and those above it, nearest first.
    const categories: number[] = [];
    for (let c = p.category, guard = 0; c !== null && guard < 20; guard += 1) {
      categories.push(c);
      const [row] = await (
        await su.model('product.category').search({ where: { id: c } as never, limit: 1 })
      ).load({ parent: true });
      c = (row?.parent as { id: number } | null)?.id ?? null;
    }
    const qty = dec(quantity);
    const rules = (
      await (
        await su.model('product.pricelist.rule').search({ where: { pricelist } as never })
      ).load({ product: true, category: true, basePricelist: true })
    )
      .map((r) => r as unknown as Row & { id: number })
      .filter((r) => {
        const from = r['dateFrom'] === null ? null : String(r['dateFrom']).slice(0, 10);
        const to = r['dateTo'] === null ? null : String(r['dateTo']).slice(0, 10);
        if (from !== null && date < from) return false;
        if (to !== null && date > to) return false;
        if (qty.lt(dec(r['minQuantity']))) return false;
        const kind = r['appliesTo'];
        if (kind === 'product') return (r['product'] as { id: number } | null)?.id === product;
        if (kind === 'category')
          return categories.includes((r['category'] as { id: number } | null)?.id ?? -1);
        return true;
      });
    const rank = (r: Row): number =>
      r['appliesTo'] === 'product'
        ? 0
        : r['appliesTo'] === 'category'
          ? 1 + categories.indexOf((r['category'] as { id: number }).id)
          : 100;
    rules.sort(
      (a, b) =>
        rank(a) - rank(b) ||
        dec(b['minQuantity']).cmp(dec(a['minQuantity'])) ||
        Number(a['sequence']) - Number(b['sequence']) ||
        a.id - b.id,
    );
    const rule = rules[0];
    if (rule === undefined)
      return {
        price: p.listPrice,
        rule: null,
        explanation: `List price (no rule of ${listName}).`,
      };
    const fromQty = dec(rule['minQuantity']).gt(0)
      ? ` from ${dec(rule['minQuantity']).toString()}`
      : '';
    if (rule['compute'] === 'fixed')
      return {
        price: dec(rule['fixedPrice']),
        rule: rule.id,
        explanation: `${listName}: a fixed price${fromQty}.`,
      };
    const baseKind = String(rule['base']);
    const based =
      baseKind === 'cost'
        ? { price: p.cost, label: 'the cost' }
        : baseKind === 'pricelist'
          ? {
              price: (
                await priceFor(
                  su,
                  (rule['basePricelist'] as { id: number } | null)?.id ?? null,
                  product,
                  qty,
                  date,
                  depth + 1,
                )
              ).price,
              label: 'another list',
            }
          : { price: p.listPrice, label: 'the list price' };
    const off = dec(rule['discount']);
    let price = based.price.times(orm.toDecimal(100).minus(off)).div(100);
    if (rule['compute'] === 'formula') {
      price = roundTo(price.plus(dec(rule['surcharge'])), dec(rule['rounding']));
      if (rule['minMargin'] !== null && price.lt(p.cost.plus(dec(rule['minMargin']))))
        price = p.cost.plus(dec(rule['minMargin']));
      if (rule['maxMargin'] !== null && price.gt(p.cost.plus(dec(rule['maxMargin']))))
        price = p.cost.plus(dec(rule['maxMargin']));
    }
    return {
      price: price.toDecimalPlaces(2, 4),
      rule: rule.id,
      explanation: `${listName}: ${off.toString()} % off ${based.label}${fromQty}.`,
    };
  }
}
