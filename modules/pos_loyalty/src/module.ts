/**
 * The data layer of Loyalty at the Counter (RFC 0034 §2.6): a customer is named at the till by their loyalty
 * card's number as well as by a phone number or an email address, and the till says what the card holds; a paid
 * sale with a customer earns points once; goods that come back give back the share of the points they were.
 */
import { earnSale, loyaltyShutro, takeBackSale } from '@kosh/loyalty';
import { posShutro } from '@kosh/pos';
import { type Module, type ModuleBase, orm } from '@kosh/server/orm';
import { defineModule, type Env, extendModel, f, type Records } from './.kosh/bindings.js';

// Only the server writes these.
const SYSTEM = ['base.admin'] as const;

/** An amount in hundredths. */
const cents = (value: unknown): number =>
  value === null || value === undefined
    ? 0
    : Number(
        orm
          .toDecimal(value as never)
          .times(100)
          .toDecimalPlaces(0)
          .toString(),
      );
const iso = (value: unknown): string =>
  value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);

/** The customer a cashier named, as the Counter's hook returns it. */
interface Named {
  partner: number;
  name: string;
  note: string | null;
}

/** The customer's card in the company's running program, if both exist. */
async function cardOf(
  su: Env,
  company: number,
  where: Record<string, unknown>,
): Promise<{ partner: number; code: string; points: number; tier: string | null } | null> {
  const [program] = await su.model('loyalty.program').search({
    where: { company: company as never, state: 'running' } as never,
    limit: 1,
  });
  if (program === undefined) return null;
  const [card] = await su
    .model('loyalty.card')
    .search({ where: { program: program.id, ...where } as never, limit: 1 })
    .then((found) => found.load({ partner: true, tier: true }));
  if (card === undefined) return null;
  return {
    partner: card.partner.id as number,
    code: card.code,
    points: card.points ?? 0,
    tier: card.tier?.name ?? null,
  };
}

/** At the till: a loyalty card's number names its customer, and the till says what the card holds. */
export const ShopLoyalty = extendModel('pos.shop', {
  overrides: {
    findCustomer: async function (
      this: unknown,
      next: (typed: string) => Promise<Named | null>,
      typed: string,
    ): Promise<Named | null> {
      const shops = this as Records<'pos.shop'>;
      const su = shops.env as unknown as Env;
      const [shop] = await shops.load({ company: true });
      if (shop === undefined) return next(typed);
      const company = shop.company.id as number;
      const wanted = typed.trim();
      // A card's number is exact, however its letters were typed.
      const byCard = await cardOf(su, company, {
        code: { in: [...new Set([wanted, wanted.toUpperCase()])] },
      });
      let named: Named | null;
      let card = byCard;
      if (byCard === null) {
        named = await next(typed);
        if (named === null) return null;
        card = await cardOf(su, company, { partner: named.partner });
      } else {
        const [partner] = await su
          .model('res.partner')
          .browse([byCard.partner as never])
          .load(['name']);
        if (partner === undefined) return null;
        named = { partner: byCard.partner, name: partner.name, note: null };
      }
      if (card === null) return named;
      const bangla = su.lang.slice(0, 2) === 'bn';
      const points = bangla
        ? `${card.points.toLocaleString('bn-BD')} পয়েন্ট`
        : `${card.points.toLocaleString('en')} ${card.points === 1 ? 'point' : 'points'}`;
      return {
        ...named,
        note: [card.code, points, card.tier].filter((x) => x !== null).join(' · '),
      };
    },
  },
});

/** What a sale at the Counter earned, or — on a refund, below zero — gave back. */
export const SaleLoyalty = extendModel('pos.order', {
  fields: {
    loyaltyPoints: f.integer({
      label: 'Loyalty points',
      groups: { write: [...SYSTEM] },
      help: 'The points the sale earned for its customer; on a refund, below zero, the points it took back.',
    }),
  },
});

/**
 * Loyalty for a paid sale of the Counter, **once**: a sale with a customer earns by the company's running program
 * on what it came to before taxes; a refund takes back the share of the original's points that everything
 * returned from it so far is of it. Returns the points earned, or — below zero — taken back.
 */
export async function loyaltyOfSale(env: Env, sale: number): Promise<number> {
  return env.asSuperuser({ reason: 'loyalty at the counter' }, async (su) => {
    const orders = su.model('pos.order').browse([sale as never]);
    const [o] = await orders.load({
      company: true,
      partner: true,
      refundOf: { refunds: true },
      lines: { product: { category: true } },
    });
    if (o === undefined || o.state !== 'paid') return 0;
    if (o.refundOf === null) {
      if (o.partner === null) return 0;
      const points = await earnSale(su as never, {
        company: o.company.id as number,
        partner: o.partner.id as number,
        date: iso(o.date),
        lines: [...o.lines].map((l) => ({
          product: l.product.id as number,
          category: (l.product.category?.id as number | undefined) ?? null,
          amount: cents(l.subtotal),
        })),
        resModel: 'pos.order',
        resId: sale,
        label: o.name,
      });
      if (points > 0) {
        await orders.write({ loyaltyPoints: points } as never);
        await su.flush();
      }
      return points;
    }
    const original = o.refundOf;
    const refunds = [...original.refunds].filter((r) => r.state === 'paid');
    const taken = await takeBackSale(su as never, {
      sale: { resModel: 'pos.order', resId: original.id as number },
      about: { resModel: 'pos.order', resId: sale },
      earlier: refunds.map((r) => r.id as number).filter((id) => id !== sale),
      returned: refunds.reduce((sum, r) => sum - cents(r.amountUntaxed), 0),
      sold: cents(original.amountUntaxed),
      label: `${o.name}: goods returned from ${original.name}`,
    });
    if (taken > 0) {
      await orders.write({ loyaltyPoints: -taken } as never);
      await su.flush();
    }
    return -taken;
  });
}

// Named so the module's type stays short enough to emit (TS7056) with every model its dependencies carry.
const DEPENDS: readonly ModuleBase[] = [posShutro, loyaltyShutro];
const MODELS = [] as const;
const EXTENSIONS = [ShopLoyalty, SaleLoyalty] as const;

export const posLoyaltyShutro: Module<typeof MODELS, readonly ModuleBase[], typeof EXTENSIONS> =
  defineModule({
    name: 'pos_loyalty',
    version: '0.1.0',
    depends: DEPENDS,
    groups: [
      orm.defineGroup({
        code: 'pos_loyalty.user',
        label: 'Loyalty at the Counter',
        implies: ['loyalty.user'],
      }),
    ],
    models: MODELS,
    extensions: EXTENSIONS,
  });
