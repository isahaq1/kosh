/**
 * The Shop's logic (RFC 0024 §2.7), run as the system in the site's company once the public routes know the site:
 * the catalogue (published products in the visitor's language), carts (a quotation per secret token, its lines priced
 * by the server from the product — never by the visitor), delivery methods with their fee for the cart, and checkout —
 * the customer found by email or made, cash on delivery confirmed (or left for someone to confirm above the site's
 * limit), or an online payment started whose confirmation confirms, invoices and pays the order.
 */
import { startPayment } from '@kosh/payment';
import { HttpProblem } from '@kosh/server';
import { type Decimal, type Id, orm } from '@kosh/server/orm';
import type { Env } from './.kosh/bindings.js';
import { feeOf, hashToken, newCartToken } from './module.js';

const zero = orm.toDecimal(0);
const LANGS: Readonly<Record<string, string>> = { en: 'en_US', bn: 'bn_BD' };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** At most this many of one product in a cart, and this many lines. */
const MAX_QUANTITY = orm.toDecimal(1000);
const MAX_LINES = 100;

export interface Site {
  readonly id: number;
  readonly key: string;
  readonly company: number;
}

const invalid = (field: string, detail: string): HttpProblem =>
  new HttpProblem(422, 'invalid-input', `Invalid ${field}`, detail);
const money = (d: Decimal | null | undefined): string => (d ?? zero).toDecimalPlaces(2).toFixed(2);

/** The environment reading in the visitor's language. */
export const inLang = (env: Env, lang: string): Env =>
  env.withLang(LANGS[lang] ?? 'en_US') as unknown as Env;

/** Published products on sale, searched, filtered, sorted and paged. */
export async function catalogue(
  env: Env,
  query: {
    readonly q?: string;
    readonly category?: number;
    readonly min?: Decimal;
    readonly max?: Decimal;
    readonly sort?: string;
    readonly page?: number;
    readonly size?: number;
  },
  site?: Site,
): Promise<{ products: Record<string, unknown>[]; total: number; page: number; pages: number }> {
  const size = Math.min(Math.max(query.size ?? 24, 1), 60);
  const page = Math.max(query.page ?? 1, 1);
  const where: Record<string, unknown> = { published: true, saleOk: true };
  if (query.q !== undefined && query.q.trim() !== '') {
    const q = query.q.trim().slice(0, 100);
    where['or'] = [{ name: { ilike: `%${q}%` } }, { code: { ilike: `%${q}%` } }];
  }
  if (query.category !== undefined) {
    // The category and those inside it.
    const inside = new Set([query.category]);
    let next = [query.category];
    while (next.length > 0 && inside.size < 500) {
      next = (
        await env.model('product.category').search({ where: { parent: { in: next } } as never })
      ).ids.filter((c) => !inside.has(c));
      for (const c of next) inside.add(c);
    }
    where['category'] = { in: [...inside] };
  }
  if (query.min !== undefined || query.max !== undefined)
    where['listPrice'] = {
      ...(query.min === undefined ? {} : { gte: query.min.toString() }),
      ...(query.max === undefined ? {} : { lte: query.max.toString() }),
    };
  const order =
    query.sort === 'price'
      ? ['listPrice asc', 'id asc']
      : query.sort === '-price'
        ? ['listPrice desc', 'id asc']
        : query.sort === 'name'
          ? ['name asc', 'id asc']
          : query.sort === 'new'
            ? ['id desc']
            : ['shopSequence asc', 'name asc', 'id asc'];
  const all = await env.model('product.product').search({ where: where as never });
  const found = await env.model('product.product').search({
    where: where as never,
    order: order as never,
    limit: size,
    offset: (page - 1) * size,
  });
  const products = await withAvailability(
    env,
    site,
    [...(await found.load({ category: true, uom: true }))].map(card),
  );
  return { products, total: all.length, page, pages: Math.max(Math.ceil(all.length / size), 1) };
}

// biome-ignore lint/suspicious/noExplicitAny: a loaded product of any load spec
function card(p: any): Record<string, unknown> {
  return {
    id: p.id,
    name: p.name,
    code: p.code,
    price: money(p.listPrice),
    category: p.category === null ? null : { id: p.category.id, name: p.category.name },
    unit: p.uom?.name ?? null,
    hasImage: p.image !== null,
  };
}

/** A published product's page: its card, description, weight and related products (published ones). */
/**
 * The cards with what is available, when stock is followed (`website_sale_stock`): in stock, few left (with how
 * many) or out of stock, by the site's "few left" threshold; null when it is not.
 */
async function withAvailability(
  env: Env,
  site: Site | undefined,
  cards: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  if (cards.length === 0) return cards;
  const available = await env
    .model('product.product')
    .browse(cards.map((c) => c['id']) as never)
    .shopAvailable();
  const [s] =
    site === undefined
      ? []
      : await env
          .model('website.site')
          .browse([site.id as never])
          .load({});
  const few = orm.toDecimal(s?.fewLeft ?? 5);
  return cards.map((c) => {
    const raw = available.get(c['id'] as number) ?? null;
    if (raw === null) return { ...c, availability: null };
    const left = orm.toDecimal(raw);
    return left.lte(0)
      ? { ...c, availability: 'out_of_stock' }
      : left.lte(few)
        ? { ...c, availability: 'few_left', left: left.toString() }
        : { ...c, availability: 'in_stock' };
  });
}

export async function productPage(
  env: Env,
  id: number,
  site?: Site,
): Promise<Record<string, unknown> | null> {
  const [p] = await (
    await env.model('product.product').search({
      where: { id: orm.asId(id, 'product.product'), published: true, saleOk: true },
      limit: 1,
    })
  ).load({ category: true, uom: true, related: true });
  if (p === undefined) return null;
  const related = await (
    await env.model('product.product').search({
      where: {
        id: { in: [...p.related.ids] },
        published: true,
        saleOk: true,
      } as never,
    })
  ).load({ category: true, uom: true });
  const [self] = await withAvailability(env, site, [card(p)]);
  return {
    ...self,
    description: p.websiteDescription,
    seo: {
      title: p.seoTitle ?? p.name,
      description: p.seoDescription ?? (p.websiteDescription ?? '').slice(0, 160),
    },
    weight: p.weight === null ? null : p.weight.toString(),
    related: await withAvailability(env, site, [...related].map(card)),
  };
}

/** The product categories that hold published products, with their parents. */
export async function categories(
  env: Env,
): Promise<{ id: number; name: string; parent: number | null }[]> {
  const products = await (
    await env.model('product.product').search({ where: { published: true, saleOk: true } })
  ).load({ category: true });
  const ids = new Set<number>();
  for (const p of products) if (p.category !== null) ids.add(p.category.id);
  const out = new Map<number, { id: number; name: string; parent: number | null }>();
  let next = [...ids];
  while (next.length > 0) {
    const found = await env
      .model('product.category')
      .browse(next as never)
      .load({ parent: true });
    next = [];
    for (const c of found) {
      out.set(c.id, { id: c.id, name: c.name, parent: c.parent?.id ?? null });
      if (c.parent !== null && !out.has(c.parent.id)) next.push(c.parent.id);
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Who carts belong to before checkout: the site's visitor contact, made the first time. */
async function visitorOf(env: Env, site: Site): Promise<number> {
  const [s] = await env
    .model('website.site')
    .browse([site.id as never])
    .load({ visitor: true });
  if (s?.visitor !== null && s?.visitor !== undefined) return s.visitor.id;
  const made = await env
    .model('res.partner')
    .create([{ name: `${s?.name ?? site.key} — shop visitor`, company: site.company as never }]);
  const id = made.ids[0] as number;
  await env
    .model('website.site')
    .browse([site.id as never])
    .write({ visitor: id as never });
  return id;
}

/** Who the site's orders are assigned to: its salesperson, else whoever made the site. */
async function salespersonOf(env: Env, site: Site): Promise<number | null> {
  const [s] = await env
    .model('website.site')
    .browse([site.id as never])
    .load({ salesperson: true });
  return s?.salesperson?.id ?? (s as { createdBy?: number | null } | undefined)?.createdBy ?? null;
}

/** A new cart: a quotation of the site's company for its visitor, with a new secret token. */
export async function newCart(env: Env, site: Site): Promise<{ token: string; id: number }> {
  const token = newCartToken();
  const [company] = await env
    .model('res.company')
    .browse([site.company as never])
    .load({ currency: true });
  const visitor = await visitorOf(env, site);
  const made = await env.model('sale.order').create([
    {
      partner: visitor as never,
      // The customer's price list, when they have one (RFC 0028 §3.1).
      pricelist: (await pricelistOf(env, visitor)) as never,
      currency: company?.currency.id as never,
      company: site.company as never,
      website: site.id as never,
      cartToken: hashToken(token),
      user: (await salespersonOf(env, site)) as never,
    },
  ]);
  await env.flush();
  return { token, id: made.ids[0] as number };
}

/** The order of `token` on the site: a cart (not checked out) unless `placed`. */
export async function orderOf(
  env: Env,
  site: Site,
  token: string,
  placed = false,
): Promise<Id<'sale.order'> | null> {
  if (token === '' || token.length > 100) return null;
  const [id] = (
    await env.model('sale.order').search({
      where: {
        website: site.id as never,
        cartToken: hashToken(token),
        ...(placed
          ? { placedAt: { isNull: false } }
          : { placedAt: { isNull: true }, state: 'draft' }),
      } as never,
      limit: 1,
    })
  ).ids;
  return id ?? null;
}

/** What the visitor sees of a cart or an order. */
export async function cartView(env: Env, id: Id<'sale.order'>): Promise<Record<string, unknown>> {
  const [o] = await env
    .model('sale.order')
    .browse([id])
    .load({ lines: { product: true }, currency: true, carrier: true, coupon: true });
  if (o === undefined) throw new HttpProblem(404, 'not-found', 'Not found', 'There is no cart.');
  const goods = [...o.lines].filter((l) => !l.isDelivery && !l.isDiscount);
  const fee = [...o.lines]
    .filter((l) => l.isDelivery)
    .reduce((s, l) => s.plus((l.priceUnit ?? zero).times(l.quantity)), zero);
  const payments = await (
    await env.model('payment.transaction').search({
      where: { saleOrder: id },
      order: ['id desc'],
      limit: 1,
    })
  ).load({});
  return {
    name: o.name,
    state: o.state,
    placed: o.placedAt !== null,
    currency: o.currency.name,
    lines: goods.map((l) => ({
      product: l.product.id,
      name: l.name,
      quantity: l.quantity.toString(),
      price: money(l.priceUnit ?? zero),
      subtotal: money((l.priceUnit ?? zero).times(l.quantity)),
    })),
    carrier: o.carrier === null ? null : { id: o.carrier.id, name: o.carrier.name },
    delivery: money(fee),
    untaxed: money(o.amountUntaxed?.amount),
    tax: money(o.amountTax?.amount),
    total: money(o.amountTotal?.amount),
    coupon: o.coupon === null ? null : o.coupon.code,
    discount: money(
      [...o.lines].reduce(
        (s, l) =>
          l.isDiscount
            ? s.minus((l.priceUnit ?? zero).times(l.quantity))
            : s.plus((l.priceUnit ?? zero).times(l.quantity).times(l.discount).div(100)),
        zero,
      ),
    ),
    payment: o.shopPayment,
    paymentState: [...payments][0]?.state ?? null,
  };
}

/** A customer's price list (RFC 0028 §3.1), or null. */
async function pricelistOf(env: Env, partner: unknown): Promise<number | null> {
  if (typeof partner !== 'number') return null;
  const [p] = await env
    .model('res.partner')
    .browse([partner as never])
    .load({ pricelist: true });
  return (p?.pricelist?.id as number | undefined) ?? null;
}

const goodsOf = async (env: Env, id: Id<'sale.order'>) => {
  const [o] = await env
    .model('sale.order')
    .browse([id])
    .load({ lines: { product: true }, carrier: true, partner: true });
  const goods = [...(o?.lines ?? [])].filter((l) => !l.isDelivery && !l.isDiscount);
  return {
    order: o,
    amount: goods.reduce((s, l) => s.plus((l.priceUnit ?? zero).times(l.quantity)), zero),
    weight: goods.reduce((s, l) => s.plus((l.product.weight ?? zero).times(l.quantity)), zero),
  };
};

/** Sets how many of `product` the cart holds (0 removes it), at the product's price; the fee follows. */
export async function setLine(
  env: Env,
  id: Id<'sale.order'>,
  product: number,
  quantity: Decimal,
): Promise<void> {
  if (quantity.lt(0) || quantity.gt(MAX_QUANTITY))
    throw invalid('quantity', `From 0 to ${MAX_QUANTITY.toString()}.`);
  const [p] = await (
    await env.model('product.product').search({
      where: { id: orm.asId(product, 'product.product'), published: true, saleOk: true },
      limit: 1,
    })
  ).load({ taxes: true, uom: true });
  if (p === undefined) throw invalid('product', 'This product is not on the shop.');
  // Beyond what is available, unless the site sells beyond stock.
  const [cart] = await env.model('sale.order').browse([id]).load({ website: true });
  if (cart?.website !== null && cart?.website !== undefined && !cart.website.allowBackorders) {
    const raw = (await env.model('product.product').browse([p.id]).shopAvailable()).get(p.id);
    if (raw !== null && raw !== undefined && quantity.gt(orm.toDecimal(raw)))
      throw invalid(
        'quantity',
        orm.toDecimal(raw).lte(0)
          ? `${p.name} is out of stock.`
          : `Only ${orm.toDecimal(raw).toString()} of ${p.name} left.`,
      );
  }
  const lines = await (
    await env
      .model('sale.order.line')
      .search({ where: { order: id, isDelivery: false, isDiscount: false } })
  ).load({ product: true });
  const line = [...lines].find((l) => l.product.id === p.id);
  if (line !== undefined) {
    if (quantity.isZero()) await env.model('sale.order.line').browse([line.id]).unlink();
    else await env.model('sale.order.line').browse([line.id]).write({ quantity });
  } else if (!quantity.isZero()) {
    if (lines.length >= MAX_LINES) throw invalid('cart', `At most ${MAX_LINES} products.`);
    await env.model('sale.order.line').create([
      {
        order: id,
        product: p.id,
        name: p.name,
        quantity,
        uom: p.uom?.id ?? null,
        // Priced by the cart's price list (the customer's), else at the list price (RFC 0028 §3.1).
        taxes: { set: [...p.taxes.ids] },
      },
    ] as never);
  }
  await env.flush();
  await reprice(env, id);
}

/** The cart's fee and coupon again, after a change. */
async function reprice(env: Env, id: Id<'sale.order'>, city?: string | null): Promise<void> {
  const [o] = await env.model('sale.order').browse([id]).load({ carrier: true, partner: true });
  if (o?.carrier !== null && o?.carrier !== undefined)
    await setDelivery(env, id, o.carrier.id, city === undefined ? o.partner.city : city);
  else await refreshCoupon(env, id);
}

type CouponRow = {
  readonly id: number;
  readonly code: string;
  readonly kind: string;
  readonly value: Decimal;
  readonly minimum: Decimal;
  readonly validFrom: unknown;
  readonly validTo: unknown;
  readonly maxUses: number | null;
  readonly uses: number;
  readonly oncePerCustomer: boolean;
  readonly active?: boolean;
};

const day = (v: unknown): string | null =>
  v === null || v === undefined
    ? null
    : v instanceof Date
      ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
      : String(v).slice(0, 10);

/** Why `coupon` does not apply to goods worth `amount` today (null: it applies). */
function couponProblem(env: Env, coupon: CouponRow, amount: Decimal): string | null {
  const today = env.today();
  const from = day(coupon.validFrom);
  const to = day(coupon.validTo);
  if (from !== null && today < from) return `The coupon ${coupon.code} starts on ${from}.`;
  if (to !== null && today > to) return `The coupon ${coupon.code} ended on ${to}.`;
  if (coupon.maxUses !== null && coupon.uses >= coupon.maxUses)
    return `The coupon ${coupon.code} has been used up.`;
  if (amount.lt(coupon.minimum))
    return `The coupon ${coupon.code} is for orders of ${money(coupon.minimum)} or more.`;
  return null;
}

/**
 * Applies the cart's coupon: a percentage off each goods line, or an amount off as a line of its own (never more than
 * the goods), or the delivery fee (`setDelivery`); a coupon that no longer applies (the cart fell below its minimum)
 * is taken off.
 */
async function refreshCoupon(env: Env, id: Id<'sale.order'>): Promise<void> {
  const [o] = await env.model('sale.order').browse([id]).load({ coupon: true, lines: true });
  if (o === undefined) return;
  const goods = [...o.lines].filter((l) => !l.isDelivery && !l.isDiscount);
  const amount = goods.reduce((s, l) => s.plus((l.priceUnit ?? zero).times(l.quantity)), zero);
  let coupon = o.coupon as CouponRow | null;
  if (coupon !== null && couponProblem(env, coupon, amount) !== null) {
    await env.model('sale.order').browse([id]).write({ coupon: null });
    coupon = null;
  }
  const percent = coupon?.kind === 'percent' ? coupon.value : zero;
  for (const l of goods)
    if (!l.discount.eq(percent))
      await env.model('sale.order.line').browse([l.id]).write({ discount: percent });
  const old = await env.model('sale.order.line').search({ where: { order: id, isDiscount: true } });
  if (old.length > 0) await old.unlink();
  if (coupon?.kind === 'amount' && coupon.value.gt(0) && amount.gt(0)) {
    const off = coupon.value.lt(amount) ? coupon.value : amount;
    await env.model('sale.order.line').create([
      {
        order: id,
        product: await discountProduct(env, coupon.id),
        name: `Coupon ${coupon.code}`,
        quantity: '1',
        priceUnit: off.negated(),
        isDiscount: true,
      },
    ] as never);
  }
  await env.flush();
}

/** The service product an amount off is charged as, made the first time. */
async function discountProduct(env: Env, coupon: number): Promise<number> {
  const [c] = await env
    .model('shop.coupon')
    .browse([coupon as never])
    .load({ product: true });
  if (c?.product !== null && c?.product !== undefined) return c.product.id;
  const made = await env
    .model('product.product')
    .create([
      { name: `Coupon ${c?.code ?? ''}`, kind: 'service', saleOk: false, purchaseOk: false },
    ]);
  const product = made.ids[0] as number;
  await env
    .model('shop.coupon')
    .browse([coupon as never])
    .write({ product: product as never });
  return product;
}

/** Puts a coupon on the cart (an empty code takes it off). @throws 422 with why it does not apply */
export async function setCoupon(
  env: Env,
  site: Site,
  id: Id<'sale.order'>,
  code: string,
): Promise<void> {
  const clean = code.trim().toUpperCase();
  if (clean === '') {
    await env.model('sale.order').browse([id]).write({ coupon: null });
    await reprice(env, id);
    return;
  }
  const [coupon] = await (
    await env.model('shop.coupon').search({
      where: { code: clean.slice(0, 40), company: site.company as never },
      limit: 1,
    })
  ).load({});
  if (coupon === undefined) throw invalid('coupon', `There is no coupon ${clean}.`);
  const { amount } = await goodsOf(env, id);
  const problem = couponProblem(env, coupon as CouponRow, amount);
  if (problem !== null) throw invalid('coupon', problem);
  await env.model('sale.order').browse([id]).write({ coupon: coupon.id });
  await reprice(env, id);
}

/** At checkout: the coupon still applies, and once per customer means once for this email. */
async function checkCouponAtCheckout(
  env: Env,
  site: Site,
  id: Id<'sale.order'>,
  email: string,
): Promise<number | null> {
  const [o] = await env.model('sale.order').browse([id]).load({ coupon: true });
  const coupon = o?.coupon as CouponRow | null | undefined;
  if (coupon === null || coupon === undefined) return null;
  const { amount } = await goodsOf(env, id);
  const problem = couponProblem(env, coupon, amount);
  if (problem !== null) throw invalid('coupon', problem);
  if (coupon.oncePerCustomer) {
    const before = await env.model('sale.order').search({
      where: {
        coupon: coupon.id,
        website: site.id,
        placedAt: { isNull: false },
        state: { ne: 'cancel' },
        'partner.email': email,
      } as never,
      limit: 1,
    });
    if (before.length > 0)
      throw invalid(
        'coupon',
        `The coupon ${coupon.code} is once per customer: it was used already.`,
      );
  }
  return coupon.id;
}

/** The company's delivery methods with their fee for the cart, delivered to `city`. */
export async function carriersFor(
  env: Env,
  id: Id<'sale.order'>,
  city: string | null,
): Promise<{ id: number; name: string; fee: string; cod: boolean; description: string | null }[]> {
  const { amount, weight, order } = await goodsOf(env, id);
  const found = await (
    await env.model('delivery.carrier').search({
      where: { company: order?.company.id as never },
    })
  ).load({});
  return [...found].map((c) => ({
    id: c.id,
    name: c.name,
    fee: money(feeOf(c, amount, weight, city)),
    cod: c.cod,
    description: c.description,
  }));
}

/** The fee's service product of a method, made the first time. */
async function feeProduct(env: Env, carrier: number): Promise<number> {
  const [c] = await env
    .model('delivery.carrier')
    .browse([carrier as never])
    .load({ product: true });
  if (c?.product !== null && c?.product !== undefined) return c.product.id;
  const made = await env
    .model('product.product')
    .create([
      { name: `Delivery: ${c?.name ?? ''}`, kind: 'service', saleOk: false, purchaseOk: false },
    ]);
  const product = made.ids[0] as number;
  await env
    .model('delivery.carrier')
    .browse([carrier as never])
    .write({ product: product as never });
  return product;
}

/** Chooses the delivery method: its fee, for the cart and `city`, replaces the cart's fee line. */
export async function setDelivery(
  env: Env,
  id: Id<'sale.order'>,
  carrier: number,
  city: string | null,
): Promise<void> {
  const { amount, weight, order } = await goodsOf(env, id);
  const [c] = await (
    await env.model('delivery.carrier').search({
      where: { id: carrier as never, company: order?.company.id as never },
      limit: 1,
    })
  ).load({});
  if (c === undefined) throw invalid('delivery method', 'Choose one of the methods offered.');
  const [withCoupon] = await env.model('sale.order').browse([id]).load({ coupon: true });
  const free =
    withCoupon?.coupon?.kind === 'free_delivery' &&
    couponProblem(env, withCoupon.coupon as CouponRow, amount) === null;
  const fee = free ? zero : feeOf(c, amount, weight, city);
  const old = await env.model('sale.order.line').search({ where: { order: id, isDelivery: true } });
  if (old.length > 0) await old.unlink();
  await env.model('sale.order.line').create([
    {
      order: id,
      product: await feeProduct(env, c.id),
      name: c.name,
      quantity: '1',
      priceUnit: fee,
      isDelivery: true,
    },
  ] as never);
  await env.model('sale.order').browse([id]).write({ carrier: c.id });
  await env.flush();
  await refreshCoupon(env, id);
}

export interface CheckoutInput {
  readonly name: string;
  readonly email: string;
  readonly phone: string;
  readonly street: string;
  readonly city: string;
  readonly carrier: number;
  /** `cod`, or a payment provider's id. */
  readonly payment: string;
  readonly note?: string;
  /** Where the customer comes back to after paying online (http(s)). */
  readonly returnUrl?: string;
}

const text = (v: unknown, field: string, max: number, required = true): string => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (required && s === '') throw invalid(field, 'is required.');
  if (s.length > max) throw invalid(field, `is at most ${max} characters.`);
  return s;
};

/** Reads and checks a checkout's input. */
export function checkoutInput(body: unknown): CheckoutInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const email = text(b['email'], 'email', 200);
  if (!EMAIL.test(email)) throw invalid('email', 'is an email address.');
  const returnUrl = text(b['returnUrl'], 'return address', 500, false);
  if (returnUrl !== '' && !/^https?:\/\/[^\s]+$/i.test(returnUrl))
    throw invalid('return address', 'is an http(s) address.');
  const carrier = Number(b['carrier']);
  if (!Number.isSafeInteger(carrier) || carrier <= 0)
    throw invalid('delivery method', 'Choose one of the methods offered.');
  return {
    name: text(b['name'], 'name', 120),
    email,
    phone: text(b['phone'], 'phone', 30),
    street: text(b['street'], 'address', 200),
    city: text(b['city'], 'city', 80),
    carrier,
    payment: text(b['payment'], 'payment', 20),
    note: text(b['note'], 'note', 1000, false),
    ...(returnUrl === '' ? {} : { returnUrl }),
  };
}

/**
 * Places the cart: the customer (found by email in the company, else made), the delivery to their city, the note.
 * Cash on delivery confirms it when the method takes cash and the total is within the site's limit (above it, it
 * stays a quotation for the team to confirm); paying online starts a payment and returns where to send the visitor.
 */
export async function checkout(
  env: Env,
  site: Site,
  id: Id<'sale.order'>,
  input: CheckoutInput,
): Promise<{
  order: string;
  state: string;
  total: string;
  redirectUrl?: string;
  reference?: string;
}> {
  const lines = await env
    .model('sale.order.line')
    .search({ where: { order: id, isDelivery: false } });
  if (lines.length === 0) throw invalid('cart', 'The cart is empty.');
  const [existing] = (
    await env.model('res.partner').search({
      where: { email: input.email, company: site.company as never },
      limit: 1,
    })
  ).ids;
  const values = {
    name: input.name,
    email: input.email,
    phone: input.phone,
    street: input.street,
    city: input.city,
  };
  let partner: number;
  if (existing !== undefined) {
    partner = existing;
    // A known customer's address is not changed by a visitor: the order keeps it in its note.
  } else
    partner = (
      await env.model('res.partner').create([{ ...values, company: site.company as never }])
    ).ids[0] as number;
  await env
    .model('sale.order')
    .browse([id])
    .write({ partner: partner as never });
  await setDelivery(env, id, input.carrier, input.city);
  const [c] = await env
    .model('delivery.carrier')
    .browse([input.carrier as never])
    .load({});
  const deliverTo = `Deliver to: ${input.name}, ${input.phone}, ${input.street}, ${input.city}`;
  const note = [deliverTo, input.note ?? ''].filter((s) => s !== '').join('\n');
  const [s] = await env
    .model('website.site')
    .browse([site.id as never])
    .load({});
  const order = env.model('sale.order').browse([id]);
  const coupon = await checkCouponAtCheckout(env, site, id, input.email);
  if (coupon !== null) {
    const [c] = await env
      .model('shop.coupon')
      .browse([coupon as never])
      .load({});
    await env
      .model('shop.coupon')
      .browse([coupon as never])
      .write({ uses: (c?.uses ?? 0) + 1 });
  }
  if (input.payment === 'cod') {
    if (c?.cod !== true)
      throw invalid('payment', 'This delivery method does not take cash on delivery.');
    await order.write({ shopPayment: 'cod', shopNote: note, placedAt: new Date() });
    await env.flush();
    const [o] = await order.load({});
    if (
      s?.codLimit === null ||
      s?.codLimit === undefined ||
      (o?.amountTotal?.amount ?? zero).lte(s.codLimit)
    )
      await order.confirm();
    const [placed] = await order.load({});
    return {
      order: placed?.name ?? '',
      state: placed?.state ?? 'draft',
      total: money(placed?.amountTotal?.amount),
    };
  }
  const provider = Number(input.payment);
  if (!Number.isSafeInteger(provider) || provider <= 0)
    throw invalid('payment', 'Cash on delivery, or one of the providers offered.');
  await order.write({ shopPayment: 'online', shopNote: note, placedAt: new Date() });
  await env.flush();
  const [o] = await order.load({ partner: true, currency: true });
  if (o === undefined) throw new HttpProblem(404, 'not-found', 'Not found', 'There is no cart.');
  const started = await startPayment(env as never, {
    provider,
    move: null,
    partner: o.partner,
    currency: o.currency,
    amount: o.amountTotal?.amount ?? zero,
    company: site.company,
    description: `Order ${o.name}`,
    ...(input.returnUrl === undefined ? {} : { returnUrl: input.returnUrl }),
    values: { saleOrder: o.id },
  });
  return {
    order: o.name,
    state: o.state,
    total: money(o.amountTotal?.amount),
    redirectUrl: started.redirectUrl,
    reference: started.reference,
  };
}
