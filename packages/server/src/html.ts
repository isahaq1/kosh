/**
 * Rich text on the server (RFC 0034 §2.4): whatever is saved into an `html` field through the API is **rebuilt from
 * an allow-list** — the tags and attributes a note needs (paragraphs, headings, lists, emphasis, links, tables,
 * images, mentions) and nothing else. No script, style, frame, form, event handler or `javascript:` address can
 * come out of it, however the input is malformed: the output is written by this file from what it recognised, never
 * copied from the input. No dependency: a small tokenizer, not a browser's parser — so what it does not understand
 * becomes text.
 */

/** Tags kept, each with the attributes it may carry. */
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  p: [],
  br: [],
  hr: [],
  strong: [],
  b: [],
  em: [],
  i: [],
  u: [],
  s: [],
  code: [],
  pre: [],
  blockquote: [],
  h1: [],
  h2: [],
  h3: [],
  h4: [],
  ul: [],
  ol: ['start'],
  li: [],
  a: ['href'],
  img: ['src', 'alt', 'width', 'height'],
  table: [],
  thead: [],
  tbody: [],
  tr: [],
  th: ['colspan', 'rowspan'],
  td: ['colspan', 'rowspan'],
  // A mention of a person or a link to a record: its kind, the record and the text shown.
  span: ['data-type', 'data-model', 'data-id', 'data-label'],
};
const VOID = new Set(['br', 'hr', 'img']);
/** Tags whose content is dropped with them: it is code or markup, never text to show. */
const DROPPED = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'template',
  'noscript',
  'svg',
  'math',
  'head',
  'title',
  'textarea',
  'select',
  'option',
]);
/** Blocks: a block closes an open paragraph, and its end is a line in plain text. */
const BLOCKS = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'ul',
  'ol',
  'li',
  'blockquote',
  'pre',
  'table',
  'tr',
  'hr',
]);
/** The most characters an `html` value may have. */
export const HTML_LIMIT = 500_000;
const DEPTH_LIMIT = 40;

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};
/** Text with its character references read (`&amp;`, `&#x3c;`), as a browser would before showing it. */
export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});?/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code =
        name[1] === 'x' || name[1] === 'X'
          ? Number.parseInt(name.slice(2), 16)
          : Number(name.slice(1));
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return '';
      try {
        return String.fromCodePoint(code);
      } catch {
        return '';
      }
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}
const escapeText = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttribute = (value: string): string => escapeText(value).replace(/"/g, '&quot;');

/** An address a link may have: web, mail, phone, or a path of this installation. */
function safeHref(raw: string): string | null {
  // As a browser reads it: without the control characters and spaces it ignores inside a scheme.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed
  const value = raw.replace(/[\u0000- \u007f]+/g, '');
  if (/^(https?:\/\/|mailto:|tel:)/i.test(value)) return raw.trim();
  if (/^\/(?!\/)/.test(value) || /^#/.test(value)) return raw.trim();
  return null;
}
/** An image's address: the web, or a file of this installation (attachments are served under /api). */
function safeSrc(raw: string): string | null {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed
  const value = raw.replace(/[\u0000- \u007f]+/g, '');
  if (/^https:\/\//i.test(value) || /^\/api\//.test(value)) return raw.trim();
  return null;
}
const wholeNumber = (raw: string, max: number): string | null =>
  /^\d{1,5}$/.test(raw.trim()) && Number(raw) >= 1 && Number(raw) <= max
    ? String(Number(raw))
    : null;

/** The attributes of a tag as text, each checked; null when the tag is not worth keeping without them. */
function attributesOf(tag: string, raw: ReadonlyMap<string, string>): string | null {
  const out: string[] = [];
  for (const name of ALLOWED[tag] ?? []) {
    const given = raw.get(name);
    if (given === undefined) continue;
    let value: string | null = given;
    if (name === 'href') value = safeHref(given);
    else if (name === 'src') value = safeSrc(given);
    else if (name === 'colspan' || name === 'rowspan') value = wholeNumber(given, 50);
    else if (name === 'width' || name === 'height') value = wholeNumber(given, 4000);
    else if (name === 'start') value = wholeNumber(given, 99_999);
    else if (name === 'data-type') value = given === 'mention' || given === 'record' ? given : null;
    else if (name === 'data-id')
      value = wholeNumber(given, 99_999) ?? (/^\d{1,15}$/.test(given) ? given : null);
    else if (name === 'data-model') value = /^[a-z][a-z0-9_.]{1,80}$/.test(given) ? given : null;
    else if (name === 'alt' || name === 'data-label') value = given.slice(0, 300);
    if (value !== null) out.push(`${name}="${escapeAttribute(value)}"`);
  }
  if (tag === 'img' && !out.some((a) => a.startsWith('src='))) return null;
  if (tag === 'a') {
    if (!out.some((a) => a.startsWith('href='))) return null;
    // A link never gets the opener, and says it is not vouched for.
    out.push('target="_blank"', 'rel="noopener noreferrer nofollow"');
  }
  if (tag === 'span' && !out.some((a) => a.startsWith('data-type='))) return null;
  return out.length === 0 ? '' : ` ${out.join(' ')}`;
}

/** The attributes written in a tag: `a="x" b='y' c=z d`. Names in lower case, values with their references read. */
function readAttributes(source: string): Map<string, string> {
  const out = new Map<string, string>();
  const pattern = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (let m = pattern.exec(source); m !== null; m = pattern.exec(source)) {
    const name = (m[1] as string).toLowerCase();
    // The first one wins, as in a browser.
    if (!out.has(name)) out.set(name, decodeEntities(m[2] ?? m[3] ?? m[4] ?? ''));
  }
  return out;
}

/**
 * Rich text rebuilt from the allow-list. Tags it does not know are dropped and their text kept; what holds code is
 * dropped with its content; tags left open are closed; a value over {@link HTML_LIMIT} is cut before it is read.
 */
export function sanitizeHtml(input: string): string {
  const source = input.length > HTML_LIMIT ? input.slice(0, HTML_LIMIT) : input;
  const out: string[] = [];
  const open: string[] = [];
  let at = 0;
  const close = (tag: string) => {
    const index = open.lastIndexOf(tag);
    if (index < 0) return;
    while (open.length > index) out.push(`</${open.pop()}>`);
  };
  while (at < source.length) {
    const lt = source.indexOf('<', at);
    if (lt < 0) {
      out.push(escapeText(decodeEntities(source.slice(at))));
      break;
    }
    if (lt > at) out.push(escapeText(decodeEntities(source.slice(at, lt))));
    // A comment, a declaration or a processing instruction: gone with what it holds.
    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      at = end < 0 ? source.length : end + 3;
      continue;
    }
    if (source[lt + 1] === '!' || source[lt + 1] === '?') {
      const end = source.indexOf('>', lt);
      at = end < 0 ? source.length : end + 1;
      continue;
    }
    const tag = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/.exec(
      source.slice(lt, lt + 4000),
    );
    if (tag === null) {
      // Not a tag: a lone `<` is text.
      out.push('&lt;');
      at = lt + 1;
      continue;
    }
    at = lt + tag[0].length;
    const closing = tag[1] === '/';
    const name = (tag[2] as string).toLowerCase();
    if (DROPPED.has(name)) {
      if (!closing) {
        // To its end tag (or to the end of the text: an unclosed script hides the rest).
        const end = new RegExp(`</${name}\\s*>`, 'i').exec(source.slice(at));
        at = end === null ? source.length : at + end.index + end[0].length;
      }
      continue;
    }
    if (!(name in ALLOWED)) continue; // unknown: the tag goes, its text stays
    if (closing) {
      close(name);
      continue;
    }
    const attributes = attributesOf(name, readAttributes(tag[3] ?? ''));
    if (attributes === null) continue; // a link without an address, an image without a source: only its text
    // A paragraph does not hold a block: it ends where one starts.
    if (BLOCKS.has(name) && open.includes('p')) close('p');
    if (VOID.has(name)) {
      out.push(`<${name}${attributes}>`);
      continue;
    }
    if (open.length >= DEPTH_LIMIT) continue;
    out.push(`<${name}${attributes}>`);
    open.push(name);
  }
  while (open.length > 0) out.push(`</${open.pop()}>`);
  return out.join('');
}

/** Rich text as plain text: a line per block, lists and cells kept apart — for a list cell, an email, a search. */
export function htmlToText(html: string): string {
  const clean = sanitizeHtml(html);
  return decodeEntities(
    clean
      .replace(/<br>/g, '\n')
      .replace(/<li>/g, '• ')
      .replace(/<\/(td|th)>/g, '\t')
      .replace(/<\/(p|h[1-4]|li|tr|blockquote|pre)>|<hr>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
