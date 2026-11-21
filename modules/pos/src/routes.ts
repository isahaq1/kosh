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
import { type Mailer, mailerFromEnv } from '@kosh/mail';
import { type Messenger, messengerFromEnv } from '@kosh/notify';
import { priceFor } from '@kosh/product';
import { documentFields, renderDocument } from '@kosh/reporting';
import { HttpProblem, type ModuleContext, publicApiModels } from '@kosh/server';
import { type Id, orm } from '@kosh/server/orm';
import type { Env } from './.kosh/bindings.js';
import type { SaleExtras } from './module.js';

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
  /** What the cashier asked another app to take off, by the keys its fields have (`saleExtras`). */
  readonly extras?: Readonly<Record<string, unknown>>;
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

/** A quote is worked out like a sale and then undone: this carries it out of the transaction that is rolled back. */
class Quoted extends Error {
  readonly value: unknown;
  constructor(value: unknown) {
    super('quoted');
    this.value = value;
  }
}

export interface CounterOptions {
  /** Who sends receipts by email; default: SMTP from the environment (`SMTP_URL`), none without it. */
  readonly mailer?: Mailer | undefined;
  /** Who sends receipts by text; default: the messenger from the environment, none without it. */
  readonly messenger?: Messenger | undefined;
}

/**
 * A customer's own price list (RFC 0028 §3.1) — Sales' field, so read only when Sales is installed —, as the
 * caller; none otherwise. The sale and the till's catalogue both ask here, so the till shows what is charged.
 */
async function ownList(env: Env, customer: number | null): Promise<number | null> {
  if (customer === null) return null;
  try {
    const partners = env.model('res.partner' as never) as unknown as {
      browse(ids: number[]): {
        load(keys: string[]): Promise<{ read(keys: string[]): Record<string, unknown>[] }>;
      };
    };
    const [row] = (await partners.browse([customer]).load(['pricelist'])).read(['pricelist']);
    return typeof row?.['pricelist'] === 'number' ? (row['pricelist'] as number) : null;
  } catch {
    return null; // Sales is not installed: no customer lists
  }
}

export function registerCounterRoutes(context: ModuleContext, options: CounterOptions = {}): void {
  const { app } = context;
  const mailer = 'mailer' in options ? options.mailer : mailerFromEnv();
  const messenger = 'messenger' in options ? options.messenger : messengerFromEnv();
  const models = publicApiModels(context.registry);
  const fields = documentFields(models);

  /** The receipt template of a sale: its shop's (`pos.shop.receiptTemplate()`), as the cashier may read it. */
  const receiptTemplateOf = async (env: Env, id: number) => {
    const [order] = await env
      .model('pos.order')
      .browse([id as never])
      .load({ session: ['shop'] });
    const shop = order?.session?.shop?.id as number | undefined;
    const keys =
      shop === undefined
        ? new Map<number, string>()
        : await (
            env.model('pos.shop').browse([shop as never]) as unknown as {
              receiptTemplate(): Promise<Map<number, string>>;
            }
          ).receiptTemplate();
    const key = (shop === undefined ? undefined : keys.get(shop)) ?? 'pos.receipt';
    const find = async (k: string) =>
      (
        await (await env.model('report.template').search({ where: { key: k }, limit: 1 })).load([])
      ).read(['id', 'name', 'layout', 'scope'])[0];
    const template = (await find(key)) ?? (await find('pos.receipt'));
    if (template === undefined)
      throw new HttpProblem(
        409,
        'no-template',
        'No receipt template',
        'Run the apps\u2019 defaults.',
      );
    return template;
  };

  // `GET /api/v1/counter/orders/:id/receipt-template`: the template its receipt prints with (the shop decides).
  app.get('/api/v1/counter/orders/:id/receipt-template', async (request) => {
    const id = idOf((request.params as { id?: unknown }).id, 'id');
    return request.env(async (raw) => {
      const template = await receiptTemplateOf(raw as unknown as Env, id);
      return { id: template['id'], name: template['name'] };
    });
  });

  // `POST /api/v1/counter/orders/:id/receipt` `{ email?, phone? }`: the receipt sent — the document by email,
  // a summary by text; what was sent is said back.
  app.post('/api/v1/counter/orders/:id/receipt', async (request) => {
    const id = idOf((request.params as { id?: unknown }).id, 'id');
    const body = (request.body ?? {}) as { email?: unknown; phone?: unknown };
    const email = text(body.email);
    const phone = text(body.phone);
    if (email === '' && phone === '')
      throw new HttpProblem(
        422,
        'no-address',
        'Nowhere to send',
        'Give an email address or a phone number.',
      );
    const model = models.get('pos.order');
    if (model === undefined)
      throw new HttpProblem(404, 'unknown-model', 'Unknown model', 'pos.order');
    return request.env(async (raw) => {
      const env = raw as unknown as Env;
      const order = await orderOut(env, id as Id<'pos.order'>);
      const sent: string[] = [];
      if (email !== '') {
        if (mailer === undefined)
          throw new HttpProblem(
            409,
            'no-mailer',
            'No email set up',
            'Set SMTP_URL to send receipts by email.',
          );
        const template = await receiptTemplateOf(env, id);
        const rendered = await renderDocument(
          env as never,
          model,
          template as never,
          fields,
          { ids: [id] },
          'html',
        );
        await mailer.send({
          to: email,
          subject: `Receipt ${String(order['name'])}`,
          text: receiptText(order),
          html: rendered.content.toString('utf8'),
        });
        sent.push('email');
      }
      if (phone !== '') {
        if (messenger === undefined)
          throw new HttpProblem(
            409,
            'no-messenger',
            'No text messaging set up',
            'Set up Twilio to send receipts by text.',
          );
        await messenger.send({ channel: 'sms', to: phone, text: receiptText(order) });
        sent.push('sms');
      }
      return { sent };
    });
  });

  app.get('/api/v1/counter/shops', async (request) =>
    request.env(async (raw) => {
      const env = raw as unknown as Env;
      const shops = await (await env.model('pos.shop').search({})).load({
        methods: true,
        pricelist: true,
      });
      return {
        shops: shops.map((s) => ({
          id: s.id,
          name: s.name,
          pricesIncludeTax: s.pricesIncludeTax,
          receiptFooter: s.receiptFooter,
          pricelist: (s.pricelist?.id as number | undefined) ?? null,
          methods: [...s.methods].map((m) => ({ id: m.id, name: m.name, kind: m.kind })),
        })),
      };
    }),
  );

  // `GET /api/v1/counter/catalogue?shop=&partner=`: the products on sale, at the shop's prices (its price list)
  // — or, for a named customer with a list of their own, at theirs: what the sale will charge.
  app.get('/api/v1/counter/catalogue', async (request) =>
    request.env(async (raw) => {
      const env = raw as unknown as Env;
      const shopId = Number((request.query as { shop?: unknown } | null)?.shop);
      const [shop] =
        Number.isSafeInteger(shopId) && shopId > 0
          ? await env
              .model('pos.shop')
              .browse([shopId as Id<'pos.shop'>])
              .load({ pricelist: true })
          : [];
      const partner = Number((request.query as { partner?: unknown } | null)?.partner);
      const own = Number.isSafeInteger(partner) && partner > 0 ? await ownList(env, partner) : null;
      const list = own ?? (shop?.pricelist?.id as number | undefined) ?? null;
      const today = env.today();
      const products = await (
        await env
          .model('product.product')
          .search({ where: { saleOk: true }, order: ['name asc'], limit: 2000 })
      ).load({
        taxes: true,
        category: true,
        uom: true,
        image: true,
        template: true,
        attributeValues: true,
      });
      const prices = new Map<number, ReturnType<typeof orm.toDecimal>>();
      if (list !== null)
        for (const p of products)
          prices.set(
            p.id as number,
            (await priceFor(env as never, list, p.id as number, '1', today)).price,
          );
      return {
        products: products.map((p) => ({
          id: p.id,
          name: p.name,
          code: p.code,
          barcode: p.barcode,
          price: (list === null
            ? p.listPrice
            : (prices.get(p.id as number) ?? p.listPrice)
          ).toString(),
          category: p.category?.name ?? null,
          uom: p.uom?.name ?? null,
          image: p.image?.id ?? null,
          // A variant: its family and the values that tell it apart (RFC 0030 §3.4), so the register groups them.
          template: p.template === null ? null : { id: p.template.id, name: p.template.name },
          values: [...p.attributeValues].map((v) => v.name),
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

  // `GET /api/v1/counter/customers?shop=&q=`: the one customer a phone number, an email address — or what another
  // app knows, a loyalty card — points at, for the sale being rung up; 404 when none, or more than one.
  app.get('/api/v1/counter/customers', async (request) => {
    const query = request.query as { shop?: unknown; q?: unknown };
    const shop = idOf(query.shop, 'shop');
    const typed = text(query.q);
    if (typed.length < 4 || typed.length > 80)
      throw new HttpProblem(
        400,
        'invalid-input',
        'What to look for',
        'A phone number, an email address or a card number.',
      );
    return request.env(
      async (raw) => {
        const env = raw as unknown as Env;
        // The cashier's own right to the shop decides; the contact is then read as the system.
        const seen = await env
          .model('pos.shop')
          .search({ where: { id: shop as Id<'pos.shop'> }, limit: 1 });
        if (seen.length === 0)
          throw new HttpProblem(404, 'missing-record', 'Not found', 'No such shop.');
        const found = await env.asSuperuser({ reason: 'a customer named at the till' }, (su) =>
          su
            .model('pos.shop')
            .browse([shop as Id<'pos.shop'>])
            .findCustomer(typed),
        );
        if (found === null)
          throw new HttpProblem(
            404,
            'no-customer',
            'No customer',
            'Nobody, or more than one contact, has this.',
          );
        // With prices of their own, the till asks for the catalogue again: it shows what the sale will charge.
        return { customer: { ...found, ownPrices: (await ownList(env, found.partner)) !== null } };
      },
      { write: true },
    );
  });

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

  // `POST /api/v1/counter/quote` `{ session, partner?, lines, extras? }`: what the sale would come to — every
  // line priced, what other apps take off it (promotions, points, a gift card) and the inputs they offer —,
  // worked out exactly as the sale is, and undone. `POST /api/v1/counter/orders` is the sale itself.
  for (const quote of [true, false])
    app.post(quote ? '/api/v1/counter/quote' : '/api/v1/counter/orders', async (request, reply) => {
      const input = request.body as SaleInput | null;
      if (
        input === null ||
        typeof input !== 'object' ||
        !Array.isArray(input.lines) ||
        (!quote && !Array.isArray(input.payments))
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
      const clientId = quote ? '' : text(input.clientId);
      const asked: Record<string, string> = {};
      for (const [key, value] of Object.entries(input.extras ?? {}).slice(0, 20))
        if ((typeof value === 'string' || typeof value === 'number') && String(value).trim() !== '')
          asked[key.slice(0, 40)] = String(value).trim().slice(0, 80);
      const work = () =>
        request.env(
          async (raw) => {
            const env = raw as unknown as Env;
            // The same sale sent twice (a device back online): the first one, unchanged.
            if (clientId !== '') {
              const [known] = await env.model('pos.order').search({
                where: { session: session as Id<'pos.session'>, clientId },
                limit: 1,
              });
              if (known !== undefined)
                return { order: await orderOut(env, known.id), repeated: true };
            }
            const [current] = await env
              .model('pos.session')
              .browse([session as Id<'pos.session'>])
              .load({ shop: { pricelist: true } });
            if (current === undefined)
              throw new HttpProblem(404, 'missing-record', 'Not found', 'No such session.');
            // The customer's own price list, else the shop's (RFC 0028 §3.1).
            const customer =
              input.partner === undefined || input.partner === null
                ? null
                : idOf(input.partner, 'partner');
            const own = await ownList(env, customer);
            const list = own ?? (current.shop.pricelist?.id as number | undefined) ?? null;
            const today = env.today();
            const listed = new Map<string, ReturnType<typeof orm.toDecimal>>();
            for (const l of input.lines)
              if (text(l.priceUnit) === '' && list !== null) {
                const quantity = text(l.quantity) || '1';
                listed.set(
                  `${String(l.product)}:${quantity}`,
                  (await priceFor(env as never, list, idOf(l.product, 'product'), quantity, today))
                    .price,
                );
              }
            const products = await env
              .model('product.product')
              .browse(input.lines.map((l) => idOf(l.product, 'product') as Id<'product.product'>))
              .load({ taxes: true, category: true });
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
                      priceUnit:
                        text(l.priceUnit) !== ''
                          ? orm.toDecimal(text(l.priceUnit))
                          : (listed.get(`${String(l.product)}:${text(l.quantity) || '1'}`) ??
                            product.listPrice),
                      discount: orm.toDecimal(text(l.discount) || '0'),
                      taxes: { set: [...product.taxes].map((t) => t.id) },
                    };
                  }),
                },
              } as never,
            ]);
            await env.flush();
            const orders = env.model('pos.order').browse(created.ids);
            const orderId = created.ids[0] as Id<'pos.order'>;
            // What other apps take off it: worked out by them, as the system, on what the sale comes to.
            const cents = (value: unknown): number =>
              Number(
                orm
                  .toDecimal((value ?? 0) as never)
                  .times(100)
                  .toDecimalPlaces(0)
                  .toString(),
              );
            const [priced] = await orders.load({
              lines: true,
              session: { shop: true },
              company: true,
            });
            if (priced === undefined)
              throw new HttpProblem(500, 'sale', 'Sale', 'The sale was not made.');
            const goods = [...priced.lines];
            // Read now: the record follows the sale, and the sale is about to have lines taken off it.
            const gross = cents(priced.total);
            // Only when the till asked: a sale rung up offline, at the prices the till showed, is kept as it
            // was paid.
            const none: SaleExtras = { fields: [], lines: [], problems: [], token: null };
            const extras =
              !quote && input.extras === undefined
                ? none
                : await env.asSuperuser({ reason: 'what is taken off a counter sale' }, (su) =>
                    su
                      .model('pos.shop')
                      .browse([priced.session.shop.id])
                      .saleExtras(
                        {
                          company: priced.company.id as number,
                          partner: customer,
                          date: String(today).slice(0, 10),
                          total: gross,
                          lines: goods.map((l) => ({
                            product: l.product.id as number,
                            category:
                              (byId.get(l.product.id as number)?.category?.id as
                                | number
                                | undefined) ?? null,
                            quantity: Number(l.quantity),
                            amount: cents(l.subtotal) + cents(l.taxAmount),
                          })),
                        },
                        asked,
                        !quote,
                      ),
                  );
            const [problem] = extras.problems;
            if (!quote && problem !== undefined)
              throw new HttpProblem(422, `extras-${problem.field}`, 'Another look', problem.say);
            const off = extras.lines.reduce((sum, l) => sum + l.amount, 0);
            if (off > gross || extras.lines.some((l) => !(l.amount > 0)))
              throw new HttpProblem(
                422,
                'extras-too-much',
                'Another look',
                'More would be taken off the sale than it comes to.',
              );
            if (extras.lines.length > 0) {
              await orders.write({
                lines: {
                  create: extras.lines.map((l) => ({
                    product: l.product,
                    name: l.name.slice(0, 200),
                    quantity: orm.toDecimal('1'),
                    priceUnit: orm.toDecimal((-l.amount / 100).toFixed(2)),
                    discount: orm.toDecimal('0'),
                    extra: l.kind.slice(0, 20),
                  })),
                },
              } as never);
              await env.flush();
            }
            if (quote) {
              const [quoted] = await env
                .model('pos.order')
                .browse(created.ids)
                .load({ lines: true });
              throw new Quoted({
                lines: [...(quoted?.lines ?? [])]
                  .filter((l) => l.extra === null)
                  .map((l) => ({
                    product: l.product.id,
                    name: l.name,
                    quantity: l.quantity.toString(),
                    priceUnit: l.priceUnit.toString(),
                    amount: ((cents(l.subtotal) + cents(l.taxAmount)) / 100).toFixed(2),
                  })),
                subtotal: (gross / 100).toFixed(2),
                extras: {
                  fields: extras.fields,
                  lines: extras.lines.map((l) => ({
                    kind: l.kind,
                    name: l.name,
                    amount: (l.amount / 100).toFixed(2),
                  })),
                  problems: extras.problems,
                },
                total: ((gross - off) / 100).toFixed(2),
              });
            }
            await orders.write({
              payments: {
                create: input.payments.map((p) => ({
                  method: idOf(p.method, 'method'),
                  amount: orm.toDecimal(text(p.amount) || '0'),
                  ...(text(p.reference) === '' ? {} : { reference: text(p.reference) }),
                })),
              },
            } as never);
            await env.flush();
            await orders.pay();
            await env.flush();
            if (extras.lines.length > 0)
              await env.asSuperuser({ reason: 'what was taken off a counter sale is kept' }, (su) =>
                su.model('pos.order').browse([orderId]).extrasKept(extras.token),
              );
            return {
              order: await orderOut(env, created.ids[0] as Id<'pos.order'>),
              repeated: false,
            };
          },
          { write: true },
        );
      if (!quote) {
        const outcome = await work();
        return reply.status(outcome.repeated ? 200 : 201).send(outcome);
      }
      try {
        await work();
      } catch (error) {
        if (error instanceof Quoted) return reply.send(error.value);
        throw error;
      }
      throw new HttpProblem(500, 'quote', 'Quote', 'The quote was not worked out.');
    });

  // `POST /api/v1/counter/orders/:id/refund` `{ session, reason, lines?: [{ product, quantity }], method? }`:
  // the sale (or part of it) taken back — a negative sale in the open session, paid back by the method given
  // (the shop's cash by default), linked to the original. Cashiers refund the sales of their own open session;
  // `pos.refund_any` (managers) refunds any sale.
  app.post('/api/v1/counter/orders/:id/refund', async (request, reply) => {
    const id = idOf((request.params as { id?: unknown }).id, 'id');
    const body = (request.body ?? {}) as {
      session?: unknown;
      reason?: unknown;
      method?: unknown;
      lines?: { product?: unknown; quantity?: unknown }[];
    };
    const session = idOf(body.session, 'session');
    const reason = text(body.reason);
    if (reason === '')
      throw new HttpProblem(422, 'reason-missing', 'Say why', 'A refund needs its reason.');
    const made = await request.env(
      async (raw) => {
        const env = raw as unknown as Env;
        const [original] = await env
          .model('pos.order')
          .browse([id as Id<'pos.order'>])
          .load({ lines: { taxes: true }, payments: { method: true }, session: true });
        if (original === undefined || original.state !== 'paid')
          throw new HttpProblem(404, 'missing-record', 'Not found', 'No paid sale with this id.');
        const [current] = await env
          .model('pos.session')
          .browse([session as Id<'pos.session'>])
          .load({ shop: { methods: true } });
        if (current === undefined || current.state !== 'open')
          throw new HttpProblem(
            409,
            'session-closed',
            'Session closed',
            'Refund in an open session.',
          );
        const mine = original.session.id === current.id;
        let may = mine;
        if (!may) {
          try {
            may = env.access.has('pos.refund_any');
          } catch {
            may = false;
          }
        }
        if (!may)
          throw new HttpProblem(
            403,
            'refund-forbidden',
            'Not yours to refund',
            'Cashiers refund the sales of their own open session; a manager refunds any sale.',
          );
        if ((body.lines ?? []).length > 0 && [...original.lines].some((l) => l.extra !== null))
          throw new HttpProblem(
            409,
            'refund-whole',
            'Refund it whole',
            'A promotion, points or a gift card took something off this sale: it is refunded whole, so that what was taken off goes back with it.',
          );
        const wanted = new Map<number, string>();
        for (const l of body.lines ?? [])
          wanted.set(idOf(l.product, 'product'), text(l.quantity) || '0');
        const lines = [...original.lines]
          .map((l) => {
            const qty =
              wanted.size === 0 ? l.quantity : orm.toDecimal(wanted.get(l.product.id) ?? '0');
            return { line: l, qty };
          })
          .filter(({ qty }) => qty.gt(0));
        if (lines.length === 0)
          throw new HttpProblem(
            422,
            'nothing-to-refund',
            'Nothing to refund',
            'Give the quantities taken back.',
          );
        for (const { line, qty } of lines)
          if (qty.gt(line.quantity))
            throw new HttpProblem(
              422,
              'too-much',
              'More than sold',
              `${line.name}: ${qty.toString()} of ${line.quantity.toString()} sold.`,
            );
        const methodId =
          body.method === undefined
            ? (
                [...current.shop.methods].find((mm) => mm.kind === 'cash') ??
                [...current.shop.methods][0]
              )?.id
            : idOf(body.method, 'method');
        if (methodId === undefined)
          throw new HttpProblem(
            409,
            'no-method',
            'No payment method',
            'The shop has no payment method.',
          );
        const created = await env.model('pos.order').create([
          {
            session: session as Id<'pos.session'>,
            pricesIncludeTax: original.pricesIncludeTax,
            partner: original.partner?.id ?? null,
            refundOf: original.id,
            refundReason: reason,
            note: `Refund of ${original.name}: ${reason}`,
            lines: {
              create: lines.map(({ line, qty }) => ({
                product: line.product.id,
                name: line.name,
                quantity: qty.neg(),
                priceUnit: line.priceUnit,
                discount: line.discount,
                extra: line.extra,
                taxes: { set: [...line.taxes].map((t) => t.id) },
              })),
            },
          } as never,
        ]);
        await env.flush();
        const [draft] = await env.model('pos.order').browse(created.ids);
        const total = draft?.total ?? orm.toDecimal(0);
        await env
          .model('pos.order.payment')
          .create([{ order: created.ids[0], method: methodId, amount: total } as never]);
        await env.flush();
        await env.model('pos.order').browse(created.ids).pay();
        await env.flush();
        return orderOut(env, created.ids[0] as Id<'pos.order'>);
      },
      { write: true },
    );
    return reply.status(201).send({ order: made });
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

/** The receipt in a few lines of text (a text message, an email's plain part). */
function receiptText(order: Record<string, unknown>): string {
  const lines = (order['lines'] as { name: string; quantity: string; subtotal: string }[]).map(
    (l) => `${l.name} × ${l.quantity}: ${l.subtotal}`,
  );
  return [
    `Receipt ${String(order['name'])}`,
    ...lines,
    `Total ${String(order['total'])} (taxes ${String(order['amountTax'])})`,
    `Paid ${String(order['amountPaid'])}, change ${String(order['change'])}`,
  ].join(NEWLINE);
}
const NEWLINE = String.fromCharCode(10);

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
