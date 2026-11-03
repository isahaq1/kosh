/**
 * Bringing visitors back and to the shop (RFC 0024 §2.7): carts left with an email get one reminder with a code that
 * restores them (the cart's own token is never sent); the site's sitemap lists its published pages and products for
 * search engines; product pictures are served without a sign-in, only of products on the shop.
 */
import { layout, type Mailer } from '@kosh/mail';
import { HttpProblem } from '@kosh/server';
import { orm } from '@kosh/server/orm';
import type { Env } from './.kosh/bindings.js';
import { hashToken, newCartToken } from './module.js';
import type { Site } from './shop.js';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const escapeXml = (s: string): string =>
  s.replace(
    /[<>&'"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c] ?? c,
  );

/** The shop's mailer (from the environment, or the tests'): set by the module. */
let shopMailer: Mailer | undefined;
export function setShopMailer(mailer: Mailer | undefined): void {
  shopMailer = mailer;
}

/** The email a visitor leaves on their cart, for one reminder if they leave it. */
export async function setContact(env: Env, id: number, email: string): Promise<void> {
  const clean = email.trim().slice(0, 200);
  if (!EMAIL.test(clean))
    throw new HttpProblem(422, 'invalid-input', 'Invalid email', 'An email address.');
  await env
    .model('sale.order')
    .browse([id as never])
    .write({ contactEmail: clean });
  await env.flush();
}

/**
 * Reminds the carts of the company's shops left longer than their site says, with an email and goods, once each: a
 * new recovery code (only its hash is kept) in a link to the site's `/cart/recover`. Sent after the commit; returns
 * how many were reminded.
 */
export async function remindAbandoned(env: Env, now: Date = new Date()): Promise<number> {
  const sites = await (
    await env
      .model('website.site')
      .search({ where: { shop: true, abandonedHours: { gt: 0 } } } as never)
  ).load({});
  let reminded = 0;
  for (const site of sites) {
    if (site.domain === null || site.domain === '') continue;
    const before = new Date(now.getTime() - site.abandonedHours * 3_600_000);
    const carts = await (
      await env.model('sale.order').search({
        where: {
          website: site.id,
          state: 'draft',
          placedAt: { isNull: true },
          contactEmail: { isNull: false },
          remindedAt: { isNull: true },
          updatedAt: { lt: before },
        } as never,
        limit: 200,
      })
    ).load({ lines: true, currency: true });
    for (const cart of carts) {
      const goods = [...cart.lines].filter((l) => !l.isDelivery && !l.isDiscount);
      if (goods.length === 0 || cart.contactEmail === null) continue;
      const code = newCartToken();
      await env
        .model('sale.order')
        .browse([cart.id])
        .write({ recoveryToken: hashToken(code), remindedAt: now });
      const bangla = site.lang === 'bn';
      const url = `https://${site.domain}/cart/recover?code=${encodeURIComponent(code)}`;
      const mail = layout({
        title: bangla ? 'আপনার কার্ট অপেক্ষা করছে' : 'Your cart is waiting',
        paragraphs: [
          bangla
            ? `${site.name}-এ আপনার কার্টে রাখা পণ্যগুলো:`
            : `What you left in your cart at ${site.name}:`,
          ...goods.map((l) => `${l.quantity.toString()} × ${l.name}`),
        ],
        action: { label: bangla ? 'কার্টে ফিরে যান' : 'Back to your cart', url },
        lang: bangla ? 'bn' : 'en',
      });
      const to = cart.contactEmail;
      const subject = bangla ? 'আপনার কার্ট অপেক্ষা করছে' : `Your cart at ${site.name} is waiting`;
      const mailer = shopMailer;
      if (mailer !== undefined)
        env.afterCommit(async () => {
          await mailer
            .send({ to, subject, html: mail.html, text: mail.text })
            .catch(() => undefined);
        });
      reminded += 1;
    }
  }
  await env.flush();
  return reminded;
}

/** A reminder's code restores its cart: a new token for it (the old one stops working); null when unknown. */
export async function recoverCart(env: Env, site: Site, code: string): Promise<string | null> {
  if (code === '' || code.length > 100) return null;
  const [id] = (
    await env.model('sale.order').search({
      where: {
        website: site.id,
        recoveryToken: hashToken(code),
        state: 'draft',
        placedAt: { isNull: true },
      } as never,
      limit: 1,
    })
  ).ids;
  if (id === undefined) return null;
  const token = newCartToken();
  await env
    .model('sale.order')
    .browse([id])
    .write({ cartToken: hashToken(token), recoveryToken: null });
  await env.flush();
  return token;
}

/**
 * The site's sitemap: its published pages (the default language at their path, the other at `/<lang><path>`) and the
 * products on its shop (at `/shop/p/<id>`), each with when it last changed. Null without the site's domain.
 */
export async function sitemap(env: Env, site: Site): Promise<string | null> {
  const [s] = await env
    .model('website.site')
    .browse([site.id as never])
    .load({});
  if (s === undefined || s.domain === null || s.domain === '') return null;
  const base = `https://${s.domain.replace(/^https?:\/\//, '').replace(/\/$/, '')}`;
  const day = (v: unknown) =>
    v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? '').slice(0, 10);
  const pages = await (
    await env
      .model('website.page')
      .search({ where: { site: site.id as never, state: 'published' }, order: ['path asc'] })
  ).load({});
  const products = await (
    await env.model('product.product').search({
      where: { published: true, saleOk: true },
      order: ['shopSequence asc', 'id asc'],
      limit: 5000,
    })
  ).load({});
  const urls = [
    ...[...pages].map((p) => ({
      loc: `${base}${p.lang === s.lang ? '' : `/${p.lang}`}${p.path === '/' && p.lang !== s.lang ? '' : p.path}`,
      lastmod: day(p.updatedAt),
    })),
    ...[...products].map((p) => ({ loc: `${base}/shop/p/${p.id}`, lastmod: day(p.updatedAt) })),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
    .map((u) => `  <url><loc>${escapeXml(u.loc)}</loc><lastmod>${u.lastmod}</lastmod></url>`)
    .join('\n')}\n</urlset>\n`;
}

/** The picture of a product on the shop (`width`: its thumbnail of that width, when one was made). */
export async function productImage(
  env: Env,
  product: number,
  width?: number,
): Promise<{ key: string; mime: string; size: number; name: string } | null> {
  const [p] = await (
    await env.model('product.product').search({
      where: { id: orm.asId(product, 'product.product'), published: true, saleOk: true },
      limit: 1,
    })
  ).load({});
  if (p === undefined || p.image === null) return null;
  type Row = { id: number; key: string; mime: string; size: number; name: string };
  const attachments = env.model('storage.attachment' as never) as unknown as {
    search(q: unknown): Promise<{ ids: number[]; load(f: unknown): Promise<Row[]> }>;
    browse(ids: number[]): { load(f: unknown): Promise<Row[]> };
  };
  let id = p.image.id as number;
  if (width !== undefined) {
    const variant = await attachments.search({ where: { variantOf: id, width }, limit: 1 });
    id = variant.ids[0] ?? id;
  }
  const [a] = [...(await attachments.browse([id]).load(['key', 'mime', 'size', 'name']))];
  if (a === undefined || !a.mime.startsWith('image/')) return null;
  return { key: a.key, mime: a.mime, size: a.size, name: a.name };
}
