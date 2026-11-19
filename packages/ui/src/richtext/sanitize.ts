/**
 * Rich text in the browser (RFC 0034 §2.4): what is shown is rebuilt from the same allow-list the server saves
 * with — a second gate, so that a value that reached the database another way (an import, a module's own code)
 * still cannot run anything when it is displayed. Parsed by the browser's own inert parser (`DOMParser`), then
 * copied node by node into a new tree; nothing of the input's markup is reused.
 */

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
  span: ['data-type', 'data-model', 'data-id', 'data-label'],
};
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

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed
const compact = (value: string): string => value.replace(/[\u0000- \u007f]+/g, '');
const safeHref = (value: string): boolean =>
  /^(https?:\/\/|mailto:|tel:)/i.test(compact(value)) ||
  /^\/(?!\/)/.test(compact(value)) ||
  /^#/.test(compact(value));
const safeSrc = (value: string): boolean =>
  /^https:\/\//i.test(compact(value)) || /^\/api\//.test(compact(value));
const whole = (value: string, max: number): boolean =>
  /^\d{1,5}$/.test(value.trim()) && Number(value) >= 1 && Number(value) <= max;

function attributeOk(name: string, value: string): boolean {
  switch (name) {
    case 'href':
      return safeHref(value);
    case 'src':
      return safeSrc(value);
    case 'colspan':
    case 'rowspan':
      return whole(value, 50);
    case 'width':
    case 'height':
      return whole(value, 4000);
    case 'start':
      return whole(value, 99_999);
    case 'data-type':
      return value === 'mention' || value === 'record';
    case 'data-id':
      return /^\d{1,15}$/.test(value);
    case 'data-model':
      return /^[a-z][a-z0-9_.]{1,80}$/.test(value);
    default:
      return true; // alt, data-label: text
  }
}

function copy(from: Node, into: Node, doc: Document, depth: number): void {
  for (const child of Array.from(from.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      into.appendChild(doc.createTextNode(child.textContent ?? ''));
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue; // comments and the rest
    const element = child as Element;
    const tag = element.tagName.toLowerCase();
    if (DROPPED.has(tag)) continue;
    const allowed = ALLOWED[tag];
    if (allowed === undefined || depth > 40) {
      copy(element, into, doc, depth + 1); // unknown: its text stays
      continue;
    }
    const made = doc.createElement(tag);
    for (const name of allowed) {
      const value = element.getAttribute(name);
      if (value !== null && attributeOk(name, value)) made.setAttribute(name, value.slice(0, 2000));
    }
    if (tag === 'a') {
      if (!made.hasAttribute('href')) {
        copy(element, into, doc, depth + 1);
        continue;
      }
      made.setAttribute('target', '_blank');
      made.setAttribute('rel', 'noopener noreferrer nofollow');
    }
    if (tag === 'img' && !made.hasAttribute('src')) continue;
    if (tag === 'span' && !made.hasAttribute('data-type')) {
      copy(element, into, doc, depth + 1);
      continue;
    }
    copy(element, made, doc, depth + 1);
    into.appendChild(made);
  }
}

/** Rich text safe to show. Plain text (nothing that looks like a tag) becomes paragraphs, a line each. */
export function sanitizeForDisplay(value: string): string {
  if (value === '') return '';
  if (typeof DOMParser === 'undefined') return '';
  const doc = new DOMParser().parseFromString('<!doctype html><body></body>', 'text/html');
  const out = doc.createElement('div');
  if (!/<[a-z!/]/i.test(value)) {
    // Text written before the field was rich, or typed through the API: its lines are kept.
    for (const line of value.split(/\r?\n/)) {
      const p = doc.createElement('p');
      p.textContent = line;
      out.appendChild(p);
    }
    return out.innerHTML;
  }
  // Parsed in a document of its own: nothing loads, nothing runs.
  const parsed = new DOMParser().parseFromString(value, 'text/html');
  copy(parsed.body, out, doc, 0);
  return out.innerHTML;
}

/** Whether rich text says nothing (an editor's empty paragraph). */
export const isEmptyRichText = (value: string): boolean =>
  value.replace(/<(?!img\b|hr\b)[^>]*>/gi, '').replace(/&nbsp;|\s/g, '') === '';
