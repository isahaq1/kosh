/**
 * Counter's routes (RFC 0021): what the register needs in few calls — the shop's catalogue, the cashier's open
 * session, a sale posted whole (lines and payments, accepted once by its client id, paid at once), a session
 * closed with its count.
 *
 * - `GET  /api/v1/counter/shops`                  the shops the cashier may sell in, with their payment methods
 * - `GET  /api/v1/counter/catalogue?shop=`         products for the register: price, taxes, barcode, picture
 * - `GET  /api/v1/counter/session?shop=`           the cashier's open session at the shop, or null
 * - `POST /api/v1/counter/sessions`                `{ shop, openingCash }`: a session opened
 * - `POST /api/v1/counter/orders`                  a sale: `{ session, clientId, partner?, lines, payments, note? }`
 * - `POST /api/v1/counter/sessions/:id/close`      `{ closingCash, differenceReason? }`: the count, then closed
 */
import { HttpProblem, type ModuleContext } from '@kosh/server';
import { type Id, orm } from '@kosh/server/orm';
import type { Env } from './.kosh/bindings.js';

const idOf = (value: unknown, what: string): number => {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0)
    throw new HttpProblem(400, 'invalid-id', 'Invalid id', `${what} is a positive integer.`);
  return id;
};
const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

export interface SaleInput {
  readonly session: number;
  readonly clientId?: string;
  readonly partner?: number | null;
  readonly note?: string;
  readonly lines: readonly {
    readonly product: number;
    readonly quantity: string;
    readonly priceUnit?: string;
    readonly discount?: string;
  }[];
  readonly payments: readonly {
    readonly method: number;
    readonly amount: string;
    readonly reference?: string;
  }[];
}

export function registerCounterRoutes({ app }: ModuleContext): void {
  app.get('/api/v1/counter/shops', async (request) =>
    request.env(async (raw) => {
      const env = raw as unknown as Env;
      const shops = await (await env.model('pos.shop').search({})).load({ methods: true });
      return {
        shops: shops.map((s) => ({
          id: s.id,
          name: s.name,
          pricesIncludeTax: s.pricesIncludeTax,
          receiptFooter: s.receiptFooter,
          methods: [...s.methods].map((m) => ({ id: m.id, name: m.name, kind: m.kind })),
        })),
      };
    }),
  );

  app.get('/api/v1/counter/catalogue', async (request) =>
    request.env(async (raw) => {
      const env = raw as unknown as Env;
      const products = await (
        await env
          .model('product.product')
          .search({ where: { saleOk: true }, order: ['name asc'], limit: 2000 })
      ).load({ taxes: true, category: true, uom: true, image: true });
      return {
        products: products.map((p) => ({
          id: p.id,
          name: p.name,
          code: p.code,
          barcode: p.barcode,
          price: p.listPrice.toString(),
          category: p.category?.name ?? null,
          uom: p.uom?.name ?? null,
          image: p.image?.id ?? null,
          taxes: [...p.taxes].map((t) => ({
            id: t.id,
            name: t.name,
            amountType: t.amountType,
            rate: t.rate.toString(),
            fixedAmount: t.fixedAmount.toString(),
          })),
        })),
      };
    }),
  );

  app.get('/api/v1/counter/session', async (request) =>
    request.env(async (raw) => {
      const env = raw as unknown as Env;
      const shop = idOf((request.query as { shop?: unknown }).shop, 'shop');
      const [session] = await env.model('pos.session').search({
        where: { shop: shop as Id<'pos.shop'>, cashier: env.userId as never, state: 'open' },
        limit: 1,
      });
      return { session: session === undefined ? null : sessionOut(session) };
    }),
  );

  app.post('/api/v1/counter/sessions', async (request, reply) => {
    const body = (request.body ?? {}) as { shop?: unknown; openingCash?: unknown };
    const shop = idOf(body.shop, 'shop');
    const openingCash = text(body.openingCash) || '0';
    const made = await request.env(
      async (raw) => {
        const env = raw as unknown as Env;
        const created = await env
          .model('pos.session')
          .create([
            { shop: shop as Id<'pos.shop'>, openingCash: orm.toDecimal(openingCash) } as never,
          ]);
        await env.flush();
        const [s] = await env.model('pos.session').browse(created.ids);
        return s === undefined ? null : sessionOut(s);
      },
      { write: true },
    );
    return reply.status(201).send({ session: made });
  });

  app.post('/api/v1/counter/orders', async (request, reply) => {
    const input = request.body as SaleInput | null;
    if (
      input === null ||
      typeof input !== 'object' ||
      !Array.isArray(input.lines) ||
      !Array.isArray(input.payments)
    )
      throw new HttpProblem(
        400,
        'invalid-body',
        'Invalid sale',
        'Send the session, the lines and the payments.',
      );
    if (input.lines.length === 0)
      throw new HttpProblem(422, 'empty-sale', 'Nothing to sell', 'Add at least one line.');
    const session = idOf(input.session, 'session');
    const clientId = text(input.clientId);
    const outcome = await request.env(
      async (raw) => {
        const env = raw as unknown as Env;
        // The same sale sent twice (a device back online): the first one, unchanged.
        if (clientId !== '') {
          const [known] = await env.model('pos.order').search({
            where: { session: session as Id<'pos.session'>, clientId },
            limit: 1,
          });
          if (known !== undefined) return { order: await orderOut(env, known.id), repeated: true };
        }
        const [current] = await env
          .model('pos.session')
          .browse([session as Id<'pos.session'>])
          .load({ shop: true });
        if (current === undefined)
          throw new HttpProblem(404, 'missing-record', 'Not found', 'No such session.');
        const products = await env
          .model('product.product')
          .browse(input.lines.map((l) => idOf(l.product, 'product') as Id<'product.product'>))
          .load({ taxes: true });
        const byId = new Map(products.map((p) => [p.id as number, p]));
        const created = await env.model('pos.order').create([
          {
            session: session as Id<'pos.session'>,
            pricesIncludeTax: current.shop.pricesIncludeTax === true,
            ...(clientId === '' ? {} : { clientId }),
            ...(input.partner === undefined || input.partner === null
              ? {}
              : { partner: idOf(input.partner, 'partner') }),
            ...(text(input.note) === '' ? {} : { note: text(input.note) }),
            lines: {
              create: input.lines.map((l) => {
                const product = byId.get(idOf(l.product, 'product'));
                if (product === undefined)
                  throw new HttpProblem(
                    422,
                    'unknown-product',
                    'Unknown product',
                    `No product ${String(l.product)}.`,
                  );
                return {
                  product: product.id,
                  name: product.name,
                  quantity: orm.toDecimal(text(l.quantity) || '1'),
                  priceUnit: orm.toDecimal(text(l.priceUnit) || product.listPrice.toString()),
                  discount: orm.toDecimal(text(l.discount) || '0'),
                  taxes: { set: [...product.taxes].map((t) => t.id) },
                };
              }),
            },
            payments: {
              create: input.payments.map((p) => ({
                method: idOf(p.method, 'method'),
                amount: orm.toDecimal(text(p.amount) || '0'),
                ...(text(p.reference) === '' ? {} : { reference: text(p.reference) }),
              })),
            },
          } as never,
        ]);
        await env.flush();
        await env.model('pos.order').browse(created.ids).pay();
        await env.flush();
        return { order: await orderOut(env, created.ids[0] as Id<'pos.order'>), repeated: false };
      },
      { write: true },
    );
    return reply.status(outcome.repeated ? 200 : 201).send(outcome);
  });

  app.post('/api/v1/counter/sessions/:id/close', async (request) => {
    const id = idOf((request.params as { id?: unknown }).id, 'id');
    const body = (request.body ?? {}) as { closingCash?: unknown; differenceReason?: unknown };
    const closingCash = text(body.closingCash);
    if (closingCash === '')
      throw new HttpProblem(
        422,
        'count-missing',
        'Count the cash',
        'Send the cash counted in the drawer.',
      );
    return request.env(
      async (raw) => {
        const env = raw as unknown as Env;
        const set = env.model('pos.session').browse([id as Id<'pos.session'>]);
        await set.write({
          closingCash: orm.toDecimal(closingCash),
          ...(text(body.differenceReason) === ''
            ? {}
            : { differenceReason: text(body.differenceReason) }),
        } as never);
        await env.flush();
        await set.close();
        await env.flush();
        const [s] = await env.model('pos.session').browse([id as Id<'pos.session'>]);
        return { session: s === undefined ? null : sessionOut(s) };
      },
      { write: true },
    );
  });
}

const textOrNull = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v);

function sessionOut(raw: unknown): Record<string, unknown> {
  const s = raw as Record<string, unknown>;
  return {
    id: s['id'],
    name: String(s['name'] ?? ''),
    state: String(s['state'] ?? ''),
    openingCash: String(s['openingCash'] ?? '0'),
    expectedCash: textOrNull(s['expectedCash']),
    closingCash: textOrNull(s['closingCash']),
    closingDifference: textOrNull(s['closingDifference']),
    orderCount: typeof s['orderCount'] === 'number' ? s['orderCount'] : 0,
    total: String(s['total'] ?? '0'),
  };
}

async function orderOut(env: Env, id: Id<'pos.order'>): Promise<Record<string, unknown>> {
  const [o] = await env.model('pos.order').browse([id]).load({ lines: true, payments: true });
  if (o === undefined) throw new HttpProblem(404, 'missing-record', 'Not found', 'No such sale.');
  return {
    id: o.id,
    name: o.name,
    state: o.state,
    total: o.total?.toString() ?? '0',
    amountTax: o.amountTax?.toString() ?? '0',
    amountPaid: o.amountPaid?.toString() ?? '0',
    change: o.change?.toString() ?? '0',
    lines: [...o.lines].map((l) => ({
      product: l.product.id,
      name: l.name,
      quantity: l.quantity.toString(),
      priceUnit: l.priceUnit.toString(),
      subtotal: l.subtotal?.toString() ?? '0',
    })),
    payments: [...o.payments].map((p) => ({ method: p.method.id, amount: p.amount.toString() })),
  };
}
