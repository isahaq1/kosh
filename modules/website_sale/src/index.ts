/**
 * @packageDocumentation
 * `@kosh/website_sale` (RFC 0024 §2.7): the **Shop** on a Sites site. Products published with a description in English
 * and Bangla; delivery methods with fees (fixed, by weight, by zone — Dhaka or outside — free above an amount); a
 * public API for a storefront (the Next.js site, or any other): the catalogue, a cart held by a secret token, the
 * delivery methods with their fee, and checkout with cash on delivery or an online payment (RFC 0017 providers),
 * which confirms, invoices and pays the order once the provider confirms. No sign-in; rate limited per address as
 * every public route is; prices always the server's. The cart's token travels in the `x-cart-token` header.
 *
 * - `GET  /api/v1/public/shop/:site/products?q=&category=&min=&max=&sort=price|-price|name|new&page=&lang=`
 * - `GET  /api/v1/public/shop/:site/products/:id?lang=`         a product's page with related products
 * - `GET  /api/v1/public/shop/:site/categories?lang=`
 * - `POST /api/v1/public/shop/:site/cart`                       a new cart → `{ token }`
 * - `GET  /api/v1/public/shop/:site/cart`                       the cart (lines, fee, taxes, total)
 * - `PUT  /api/v1/public/shop/:site/cart/lines`                 `{ product, quantity }` (0 removes)
 * - `GET  /api/v1/public/shop/:site/carriers?city=`             the delivery methods with their fee for the cart
 * - `GET  /api/v1/public/shop/:site/payments`                   the online payment providers offered
 * - `POST /api/v1/public/shop/:site/checkout`                   `{ name, email, phone, street, city, carrier,
 *                                                                  payment: 'cod' | provider id, note?, returnUrl? }`
 * - `GET  /api/v1/public/shop/:site/order`                      the placed order of the token: its state, payment
 */
import { defineModule } from '@kosh/modules-sdk';
import { payment } from '@kosh/payment';
import { product } from '@kosh/product';
import { saleAccount } from '@kosh/sale_account';
import { sales } from '@kosh/sales';
import { HttpProblem, type ModuleContext } from '@kosh/server';
import { type Decimal, type Id, orm } from '@kosh/server/orm';
import { action, field, form, list, search, stat } from '@kosh/views';
import { website } from '@kosh/website';
import type { Env } from './.kosh/bindings.js';
import { shopDemo } from './demo.js';
import { DeliveryCarrier, websiteSaleShutro } from './module.js';
import {
  carriersFor,
  cartView,
  catalogue,
  categories,
  checkout,
  checkoutInput,
  inLang,
  newCart,
  orderOf,
  productPage,
  type Site,
  setLine,
} from './shop.js';

export {
  COURIERS,
  DeliveryCarrier,
  feeOf,
  hashToken,
  LineShop,
  OrderShop,
  ProductShop,
  SiteShop,
  TransactionOrder,
  websiteSaleShutro,
} from './module.js';
export { type CheckoutInput, checkout, setDelivery, setLine } from './shop.js';

type Row = Record<string, unknown>;
const notFound = (what: string): HttpProblem =>
  new HttpProblem(404, 'not-found', 'Not found', `There is no ${what}.`);

const decimal = (v: unknown, what: string): Decimal | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  try {
    return orm.toDecimal(String(v));
  } catch {
    throw new HttpProblem(400, 'invalid-input', `Invalid ${what}`, 'A number.');
  }
};
const positive = (v: unknown): number | undefined => {
  const n = Number(v);
  return v === undefined || v === '' || !Number.isSafeInteger(n) || n <= 0 ? undefined : n;
};

function registerShopRoutes(context: ModuleContext): void {
  const { app, shutro } = context;
  const pub = { config: { auth: false } };
  const base = '/api/v1/public/shop/:site';

  /** The site's shop, in a system scope of its company (as the superuser: visitors have no rights). */
  const inShop = async <T>(
    params: unknown,
    reason: string,
    fn: (env: Env, site: Site) => Promise<T>,
  ): Promise<T> => {
    const key = String((params as Row)['site'] ?? '');
    const site = await shutro.bootstrap({ reason: `shop: ${reason}` }, async (raw) => {
      const [s] = await (
        await (raw as unknown as Env)
          .withFlags({ checkCompany: false })
          .model('website.site')
          .search({ where: { key, shop: true }, limit: 1 } as never)
      ).load({});
      return s === undefined ? null : { id: s.id, key: s.key, company: s.company.id };
    });
    if (site === null) throw notFound(`shop ${key}`);
    return shutro.bootstrap({ reason: `shop: ${reason}`, company: site.company }, (raw) =>
      (raw as unknown as Env).asSuperuser({ reason: `shop ${site.key}: ${reason}` }, (su) =>
        fn(su, site),
      ),
    );
  };
  const tokenOf = (headers: Row): string => String(headers['x-cart-token'] ?? '');
  const langOf = (query: unknown): string => String((query as Row | null)?.['lang'] ?? 'en');
  const cartOr404 = async (env: Env, site: Site, token: string): Promise<Id<'sale.order'>> => {
    const id = await orderOf(env, site, token);
    if (id === null) throw notFound('cart for this token (it may be checked out)');
    return id;
  };

  app.get(`${base}/products`, pub, async (request) => {
    const q = (request.query ?? {}) as Row;
    return inShop(request.params, 'catalogue', (env) =>
      catalogue(inLang(env, langOf(q)), {
        ...(typeof q['q'] === 'string' ? { q: q['q'] } : {}),
        ...(positive(q['category']) === undefined ? {} : { category: positive(q['category']) }),
        ...(decimal(q['min'], 'minimum') === undefined
          ? {}
          : { min: decimal(q['min'], 'minimum') }),
        ...(decimal(q['max'], 'maximum') === undefined
          ? {}
          : { max: decimal(q['max'], 'maximum') }),
        ...(typeof q['sort'] === 'string' ? { sort: q['sort'] } : {}),
        ...(positive(q['page']) === undefined ? {} : { page: positive(q['page']) }),
      } as never),
    );
  });
  app.get(`${base}/products/:id`, pub, async (request) => {
    const id = positive((request.params as Row)['id']);
    if (id === undefined) throw notFound('such product');
    const page = await inShop(request.params, 'product', (env) =>
      productPage(inLang(env, langOf(request.query)), id),
    );
    if (page === null) throw notFound('such product on this shop');
    return page;
  });
  app.get(`${base}/categories`, pub, async (request) =>
    inShop(request.params, 'categories', async (env) => ({
      categories: await categories(inLang(env, langOf(request.query))),
    })),
  );
  app.post(`${base}/cart`, pub, async (request, reply) => {
    const made = await inShop(request.params, 'new cart', (env, site) => newCart(env, site));
    return reply.status(201).send({ token: made.token });
  });
  app.get(`${base}/cart`, pub, async (request) =>
    inShop(request.params, 'cart', async (env, site) =>
      cartView(env, await cartOr404(env, site, tokenOf(request.headers))),
    ),
  );
  app.put(`${base}/cart/lines`, pub, async (request) => {
    const body = (request.body ?? {}) as Row;
    const productId = positive(body['product']);
    if (productId === undefined)
      throw new HttpProblem(400, 'invalid-input', 'Invalid product', 'A product id.');
    const quantity = decimal(body['quantity'], 'quantity') ?? orm.toDecimal(1);
    return inShop(request.params, 'cart line', async (env, site) => {
      const id = await cartOr404(env, site, tokenOf(request.headers));
      await setLine(env, id, productId, quantity);
      return cartView(env, id);
    });
  });
  app.get(`${base}/carriers`, pub, async (request) => {
    const city = String((request.query as Row | null)?.['city'] ?? '').slice(0, 80);
    return inShop(request.params, 'delivery methods', async (env, site) => ({
      carriers: await carriersFor(
        inLang(env, langOf(request.query)),
        await cartOr404(env, site, tokenOf(request.headers)),
        city === '' ? null : city,
      ),
    }));
  });
  app.get(`${base}/payments`, pub, async (request) =>
    inShop(request.params, 'payment providers', async (env, site) => ({
      providers: [
        ...(await (
          await env.model('payment.provider').search({
            where: { company: site.company as never, state: { in: ['test', 'live'] } },
          })
        ).load({})),
      ].map((p) => ({ id: p.id, name: p.name, test: p.state === 'test' })),
    })),
  );
  app.post(`${base}/checkout`, { ...pub, bodyLimit: 16 * 1024 }, async (request, reply) => {
    const input = checkoutInput(request.body);
    const placed = await inShop(request.params, 'checkout', async (env, site) =>
      checkout(env, site, await cartOr404(env, site, tokenOf(request.headers)), input),
    );
    return reply.status(201).send(placed);
  });
  app.get(`${base}/order`, pub, async (request) =>
    inShop(request.params, 'order', async (env, site) => {
      const id = await orderOf(env, site, tokenOf(request.headers), true);
      if (id === null) throw notFound('order for this token');
      return cartView(env, id);
    }),
  );
}

export const websiteSale: ReturnType<typeof defineModule> = defineModule({
  shutro: websiteSaleShutro,
  kosh: '^0.1.0',
  hooks: { demo: shopDemo },
  depends: [website, sales, saleAccount, payment, product],
  accessLevels: {
    manager: { label: 'Shop manager', groups: ['website_sale.manager'] },
  },
  routes: (context: ModuleContext) => registerShopRoutes(context),
  actions: {
    'shop.action_orders': action('sale.order' as never, {
      label: 'Shop orders',
      views: ['list', 'form'],
      domain: { website: { isNull: false }, placedAt: { isNull: false } },
    }),
    'shop.action_carriers': action(DeliveryCarrier, {
      label: 'Delivery methods',
      views: ['list', 'form'],
    }),
    'shop.action_products': action('product.product' as never, {
      label: 'Shop products',
      views: ['list', 'form'],
      domain: { published: true },
    }),
  },
  menus: [
    {
      id: 'sites.shop_orders',
      parent: 'sites.root',
      label: 'Shop orders',
      action: 'shop.action_orders',
      sequence: 0.5,
    },
    {
      id: 'sites.shop_products',
      parent: 'sites.root',
      label: 'Shop products',
      action: 'shop.action_products',
      sequence: 0.6,
    },
    {
      id: 'sites.carriers',
      parent: 'sites.root',
      label: 'Delivery methods',
      action: 'shop.action_carriers',
      sequence: 5,
    },
  ],
  views: {
    'delivery.carrier.list': list(DeliveryCarrier, {
      columns: [
        'name',
        'kind',
        'price',
        'priceInside',
        'priceOutside',
        'freeOver',
        'cod',
        'courier',
      ],
    }),
    'delivery.carrier.form': form(DeliveryCarrier, (k) => ({
      sheet: [
        k.group('main', ['name', 'kind', 'courier', 'cod', 'sequence'], {
          description:
            'A fixed fee; by weight, the first kg and each one after it; by zone, a fee inside the listed cities and one outside.',
        }),
        k.group('fees', [
          'price',
          'pricePerKg',
          'zoneCities',
          'priceInside',
          'priceOutside',
          'freeOver',
        ]),
        k.group('about', ['description', 'product'], { columns: 1 }),
      ],
      chatter: true,
    })),
  },
  viewExtensions: [
    {
      view: 'product.product.form',
      operations: [
        {
          insertAfter: 'prices',
          nodes: [
            {
              kind: 'group',
              id: 'shop',
              label: 'Shop',
              children: [
                field({ field: 'published', id: 'shop_published' }),
                field({ field: 'shopSequence', id: 'shop_sequence' }),
                field({ field: 'weight', id: 'shop_weight' }),
                field({ field: 'related', id: 'shop_related', widget: 'tags' }),
                field({ field: 'websiteDescription', id: 'shop_description' }),
              ],
            },
          ],
        },
      ],
    },
    {
      view: 'website.site.form',
      operations: [
        {
          append: 'main',
          nodes: [
            field({ field: 'shop', id: 'site_shop' }),
            field({ field: 'codLimit', id: 'site_cod_limit' }),
            field({ field: 'salesperson', id: 'site_salesperson' }),
          ],
        },
      ],
    },
    {
      view: 'sale.order.form',
      operations: [
        {
          append: 'related',
          nodes: [
            stat({
              id: 'order_online_payments',
              label: 'Online payments',
              model: 'payment.transaction',
              where: { saleOrder: { $record: 'id' } },
              action: 'payment.action_transactions',
            }),
          ],
        },
      ],
    },
    {
      view: 'sale.order.form',
      operations: [
        {
          insertAfter: 'partner',
          nodes: [
            field({ field: 'website', id: 'order_site' }),
            field({ field: 'carrier', id: 'order_carrier' }),
            field({ field: 'shopPayment', id: 'order_shop_payment' }),
            field({ field: 'placedAt', id: 'order_placed_at' }),
            field({ field: 'shopNote', id: 'order_shop_note' }),
          ],
        },
      ],
    },
  ],
  search: {
    'delivery.carrier': search(DeliveryCarrier, {
      fields: ['name'],
      groupBy: ['kind', 'courier'],
    }),
  },
});
