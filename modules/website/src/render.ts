/**
 * What a page is to the outside (RFC 0021, Sites): its blocks in order with the forms they show, as the public API
 * returns it, and as HTML for the editors' preview — every text escaped, links only to the site or http(s).
 */
import type { Id } from '@kosh/server/orm';
import type { Env } from './.kosh/bindings.js';
import { HONEYPOT, safeUrl } from './module.js';

export interface PublicForm {
  readonly key: string;
  readonly name: string;
  readonly fields: readonly {
    readonly name: string;
    readonly label: string;
    readonly kind: string;
    readonly required: boolean;
  }[];
  /** The hidden input to leave empty (a bot fills it in). */
  readonly honeypot: string;
  readonly successMessage: string;
}

export interface PublicBlock {
  readonly kind: string;
  readonly title: string | null;
  readonly body: string | null;
  readonly imageUrl: string | null;
  readonly buttonLabel: string | null;
  readonly buttonUrl: string | null;
  readonly form: PublicForm | null;
}

export interface PublicPage {
  readonly path: string;
  readonly lang: string;
  readonly title: string;
  readonly description: string | null;
  readonly publishedAt: string | null;
  readonly blocks: readonly PublicBlock[];
  /** The same page in its other languages (published ones, for the public API). */
  readonly translations: readonly { readonly lang: string; readonly path: string }[];
}

/** A page with its blocks, forms and translations; `published` keeps translations to published pages. */
export async function pageOf(
  env: Env,
  id: Id<'website.page'>,
  published: boolean,
): Promise<PublicPage | null> {
  const [page] = await env.model('website.page').browse([id]).load({ translationOf: true });
  if (page === undefined) return null;
  const blocks = [
    ...(await (
      await env.model('website.block').search({ where: { page: page.id } })
    ).load({
      form: true,
    })),
  ];
  const formIds = [...new Set(blocks.flatMap((b) => (b.form === null ? [] : [b.form.id])))];
  const fields =
    formIds.length === 0
      ? []
      : [...(await env.model('website.form.field').search({ where: { form: { in: formIds } } }))];
  const formOf = (b: (typeof blocks)[number]): PublicForm | null =>
    b.form === null
      ? null
      : {
          key: b.form.key,
          name: b.form.name,
          fields: fields
            .filter((x) => x.form.id === b.form?.id)
            .map((x) => ({ name: x.name, label: x.label, kind: x.kind, required: x.required })),
          honeypot: HONEYPOT,
          successMessage: b.form.successMessage,
        };
  const original = page.translationOf?.id ?? page.id;
  const family = await env.model('website.page').search({
    where: {
      or: [{ id: original }, { translationOf: original }],
      ...(published ? { state: 'published' } : {}),
    },
  });
  return {
    path: page.path,
    lang: page.lang,
    title: page.title,
    description: page.description,
    publishedAt: page.publishedAt?.toISOString() ?? null,
    blocks: blocks.map((b) => ({
      kind: b.kind,
      title: b.title,
      body: b.body,
      imageUrl: b.imageUrl !== null && safeUrl(b.imageUrl) ? b.imageUrl : null,
      buttonLabel: b.buttonLabel,
      buttonUrl: b.buttonUrl !== null && safeUrl(b.buttonUrl) ? b.buttonUrl : null,
      form: formOf(b),
    })),
    translations: [...family]
      .filter((p) => p.id !== page.id)
      .map((p) => ({ lang: p.lang, path: p.path })),
  };
}

const escapeHtml = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
const paragraphs = (text: string | null): string =>
  (text ?? '')
    .split(/\n{2,}/)
    .filter((p) => p.trim() !== '')
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
const button = (b: PublicBlock): string =>
  b.buttonLabel !== null && b.buttonUrl !== null
    ? `<a class="button" href="${escapeHtml(b.buttonUrl)}">${escapeHtml(b.buttonLabel)}</a>`
    : '';

function blockHtml(b: PublicBlock): string {
  const title = b.title === null ? '' : escapeHtml(b.title);
  switch (b.kind) {
    case 'hero':
      return `<section class="hero">${title === '' ? '' : `<h1>${title}</h1>`}${paragraphs(b.body)}${button(b)}</section>`;
    case 'image':
      return b.imageUrl === null
        ? ''
        : `<figure><img src="${escapeHtml(b.imageUrl)}" alt="${title}">${title === '' ? '' : `<figcaption>${title}</figcaption>`}</figure>`;
    case 'cta':
      return `<section class="cta">${title === '' ? '' : `<h2>${title}</h2>`}${paragraphs(b.body)}${button(b)}</section>`;
    case 'form': {
      const form = b.form;
      if (form === null) return '';
      const inputs = form.fields
        .map((x) => {
          const tag =
            x.kind === 'textarea'
              ? `<textarea name="${escapeHtml(x.name)}" disabled></textarea>`
              : `<input name="${escapeHtml(x.name)}" type="${x.kind === 'phone' ? 'tel' : escapeHtml(x.kind)}" disabled>`;
          return `<label>${escapeHtml(x.label)}${x.required ? ' *' : ''}${tag}</label>`;
        })
        .join('');
      return `<section class="form">${title === '' ? '' : `<h2>${title}</h2>`}${paragraphs(b.body)}<form>${inputs}<button type="button" disabled>${escapeHtml(b.buttonLabel ?? 'Send')}</button></form></section>`;
    }
    default:
      return `<section>${title === '' ? '' : `<h2>${title}</h2>`}${paragraphs(b.body)}${button(b)}</section>`;
  }
}

const STYLE = `body{font:16px/1.6 system-ui,sans-serif;margin:0;color:#1f2933;background:#fff}
main{max-width:760px;margin:0 auto;padding:24px 16px}section,figure{margin:0 0 32px}
.hero{padding:32px 0}.hero h1{font-size:2.2em;line-height:1.2;margin:0 0 12px}
.cta{padding:24px;border-radius:12px;background:#f1f5f9}img{max-width:100%;border-radius:8px}
.button{display:inline-block;padding:8px 16px;border-radius:8px;background:#2563eb;color:#fff;text-decoration:none}
form{display:grid;gap:12px}label{display:grid;gap:4px;font-weight:600}input,textarea{font:inherit;padding:6px 8px}
@media (prefers-color-scheme: dark){body{background:#111827;color:#e5e7eb}.cta{background:#1f2937}}`;

/** The page as a stand-alone document (no scripts): the editors' preview. */
export function pageHtml(page: PublicPage): string {
  return `<!doctype html><html lang="${escapeHtml(page.lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(page.title)}</title><style>${STYLE}</style></head><body><main>${page.blocks.map(blockHtml).join('')}</main></body></html>`;
}
