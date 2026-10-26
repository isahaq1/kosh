/**
 * Parsing inbound email (RFC 0006 §7.1): a raw RFC 5322 message (`postal-mime`) or a provider's JSON (Postmark)
 * becomes one {@link InboundMail}. HTML from outside is sanitized to a small allow-list, the plain text is
 * preferred for the chatter, quoted history is cut at the usual markers, and automatic messages (auto-replies,
 * bounces, bulk) are recognised so they never post.
 */
import { createHash } from 'node:crypto';
import PostalMime from 'postal-mime';
import sanitizeHtml from 'sanitize-html';

export interface InboundAddress {
  readonly name: string;
  readonly address: string;
}

export interface InboundAttachment {
  readonly name: string;
  readonly mime: string;
  readonly data: Uint8Array;
  readonly contentId: string | null;
  /** Referenced from the HTML (`cid:`), not listed as a file by the sender. */
  readonly inline: boolean;
}

export interface InboundMail {
  readonly messageId: string;
  readonly from: InboundAddress | null;
  /** Every recipient address (to, cc, delivered-to), lowercase. */
  readonly to: readonly string[];
  readonly subject: string;
  /** The plain-text part, or the text of the HTML part. */
  readonly text: string;
  /** The sanitized HTML part, or null. */
  readonly html: string | null;
  readonly inReplyTo: string | null;
  readonly references: readonly string[];
  readonly date: string | null;
  readonly attachments: readonly InboundAttachment[];
  /** An auto-reply, a bounce, a bulk message: never posted. */
  readonly automatic: boolean;
  /** A delivery status report (a bounce of a message of ours, when `inReplyTo` names it). */
  readonly bounce: boolean;
}

/** At most this many characters of text are kept per message. */
export const MAX_TEXT = 20_000;

const SANITIZE: sanitizeHtml.IOptions = {
  allowedTags: [
    'p',
    'br',
    'b',
    'strong',
    'i',
    'em',
    'u',
    's',
    'ul',
    'ol',
    'li',
    'blockquote',
    'pre',
    'code',
    'a',
    'h1',
    'h2',
    'h3',
    'h4',
    'table',
    'thead',
    'tbody',
    'tr',
    'th',
    'td',
    'div',
    'span',
  ],
  allowedAttributes: {
    a: ['href', 'rel', 'target'],
    td: ['colspan', 'rowspan'],
    th: ['colspan', 'rowspan'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  transformTags: {
    a: (tagName, attribs) => ({
      tagName,
      attribs: { ...attribs, rel: 'noopener noreferrer nofollow', target: '_blank' },
    }),
  },
  disallowedTagsMode: 'discard',
};

/** HTML from outside, reduced to the allow-list (no scripts, styles, images, forms, event handlers). */
export function cleanHtml(html: string): string {
  return sanitizeHtml(html, SANITIZE).trim();
}

/** The plain text of an HTML part: block elements become lines, entities are decoded, the rest is stripped. */
export function htmlToText(html: string): string {
  const text = sanitizeHtml(html, {
    allowedTags: [],
    allowedAttributes: {},
    textFilter: (t) => t,
    // Keep the structure: a line break for the block elements.
    transformTags: {},
  });
  // sanitize-html removes tags without adding separators: run the block-level ones through first.
  const withBreaks = html
    .replace(/<\s*(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/blockquote)\s*\/?>/gi, '\n')
    .replace(/<\s*(style|script)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '');
  const stripped = sanitizeHtml(withBreaks, { allowedTags: [], allowedAttributes: {} });
  return (stripped || text)
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const QUOTE_MARKERS = [
  /^On .{1,200}wrote:\s*$/m,
  /^-{2,}\s*Original Message\s*-{2,}\s*$/im,
  /^From:\s.+\nSent:\s.+$/m,
  /^_{10,}\s*$/m,
  /^Le .{1,200}a écrit\s*:\s*$/m,
  /^Am .{1,200}schrieb .{1,100}:\s*$/m,
  /^\s*>+\s?.*$/m,
];

/** The reply itself: the text above the quoted history (lines starting with `>`, "On … wrote:", …). */
export function cutQuotes(text: string): string {
  let cut = text.replace(/\r\n?/g, '\n');
  for (const marker of QUOTE_MARKERS) {
    const at = cut.search(marker);
    if (at > 0) cut = cut.slice(0, at);
  }
  return cut.replace(/\n{3,}/g, '\n\n').trim();
}

/** The text that goes to the chatter: the reply (quotes cut), at most {@link MAX_TEXT} characters. */
export function bodyText(mail: Pick<InboundMail, 'text'>): string {
  return cutQuotes(mail.text).slice(0, MAX_TEXT);
}

const address = (value: unknown): InboundAddress | null => {
  if (value === null || typeof value !== 'object') return null;
  const v = value as { name?: unknown; address?: unknown; group?: unknown };
  if (Array.isArray(v.group)) {
    const first = v.group[0] as { name?: unknown; address?: unknown } | undefined;
    return first === undefined ? null : address(first);
  }
  if (typeof v.address !== 'string' || v.address === '') return null;
  return { name: typeof v.name === 'string' ? v.name : '', address: v.address.toLowerCase() };
};
const addresses = (list: unknown): string[] =>
  (Array.isArray(list) ? list : [])
    .flatMap((a) => {
      const v = a as { address?: unknown; group?: unknown };
      return Array.isArray(v.group) ? v.group : [v];
    })
    .map((a) => (a as { address?: unknown }).address)
    .filter((a): a is string => typeof a === 'string' && a !== '')
    .map((a) => a.toLowerCase());

const header = (headers: readonly { key: string; value: string }[], key: string): string | null =>
  headers.find((h) => h.key.toLowerCase() === key)?.value ?? null;

function automaticOf(
  headers: readonly { key: string; value: string }[],
  from: InboundAddress | null,
  returnPath: string | null,
): { automatic: boolean; bounce: boolean } {
  const auto = header(headers, 'auto-submitted');
  const precedence = header(headers, 'precedence')?.toLowerCase() ?? '';
  const contentType = header(headers, 'content-type')?.toLowerCase() ?? '';
  const daemon =
    from !== null &&
    /^(mailer-daemon|postmaster|no-?reply|noreply|do-?not-?reply)@/.test(from.address);
  const bounce =
    contentType.includes('report-type=delivery-status') ||
    returnPath === '' ||
    returnPath === '<>' ||
    (from !== null && /^(mailer-daemon|postmaster)@/.test(from.address));
  const automatic =
    bounce ||
    daemon ||
    (auto !== null && auto.toLowerCase() !== 'no') ||
    header(headers, 'x-autoreply') !== null ||
    header(headers, 'x-autorespond') !== null ||
    header(headers, 'x-auto-response-suppress') !== null ||
    precedence === 'bulk' ||
    precedence === 'auto_reply' ||
    precedence === 'junk';
  return { automatic, bounce };
}

const references = (value: string | null | undefined): string[] =>
  (value ?? '')
    .split(/\s+/)
    .map((r) => r.trim())
    .filter((r) => r !== '');

function syntheticId(parts: readonly string[]): string {
  return `<${createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 40)}@inbound.kosh>`;
}

const bytes = (content: ArrayBuffer | Uint8Array | string, encoding?: string): Uint8Array =>
  typeof content === 'string'
    ? encoding === 'base64'
      ? new Uint8Array(Buffer.from(content, 'base64'))
      : new TextEncoder().encode(content)
    : content instanceof Uint8Array
      ? content
      : new Uint8Array(content);

/** Parses a raw message. */
export async function parseMail(raw: string | Uint8Array): Promise<InboundMail> {
  const email = await PostalMime.parse(raw, { attachmentEncoding: 'arraybuffer' });
  const from = address(email.from);
  const returnPath = email.returnPath === undefined ? null : email.returnPath.trim();
  const { automatic, bounce } = automaticOf(email.headers, from, returnPath);
  const html = email.html === undefined || email.html.trim() === '' ? null : cleanHtml(email.html);
  const text =
    email.text !== undefined && email.text.trim() !== ''
      ? email.text
      : email.html === undefined
        ? ''
        : htmlToText(email.html);
  const to = [
    ...new Set([
      ...addresses(email.to),
      ...addresses(email.cc),
      ...(email.deliveredTo === undefined ? [] : [email.deliveredTo.toLowerCase()]),
    ]),
  ];
  return {
    messageId:
      email.messageId ??
      syntheticId([from?.address ?? '', email.subject ?? '', email.date ?? '', text]),
    from,
    to,
    subject: email.subject ?? '',
    text: text.slice(0, MAX_TEXT * 4),
    html,
    inReplyTo: email.inReplyTo ?? null,
    references: references(email.references),
    date: email.date ?? null,
    attachments: email.attachments.map((a) => ({
      name: a.filename ?? 'attachment',
      mime: a.mimeType,
      data: bytes(a.content, a.encoding),
      contentId: a.contentId ?? null,
      inline: a.disposition === 'inline' || a.related === true,
    })),
    automatic,
    bounce,
  };
}

/** Postmark's inbound webhook JSON (`FromFull`, `ToFull`, `TextBody`, `HtmlBody`, `Headers`, `Attachments`). */
export function fromPostmark(json: Record<string, unknown>): InboundMail {
  const fromFull = json['FromFull'] as { Email?: unknown; Name?: unknown } | undefined;
  const from =
    typeof fromFull?.Email === 'string' && fromFull.Email !== ''
      ? {
          name: typeof fromFull.Name === 'string' ? fromFull.Name : '',
          address: fromFull.Email.toLowerCase(),
        }
      : null;
  const list = (key: string): string[] =>
    (Array.isArray(json[key]) ? (json[key] as { Email?: unknown }[]) : [])
      .map((r) => r.Email)
      .filter((e): e is string => typeof e === 'string' && e !== '')
      .map((e) => e.toLowerCase());
  const headers = (
    Array.isArray(json['Headers']) ? (json['Headers'] as { Name?: unknown; Value?: unknown }[]) : []
  )
    .filter((h) => typeof h.Name === 'string' && typeof h.Value === 'string')
    .map((h) => ({ key: String(h.Name).toLowerCase(), value: String(h.Value) }));
  const inReplyTo = header(headers, 'in-reply-to');
  const { automatic, bounce } = automaticOf(headers, from, null);
  const html =
    typeof json['HtmlBody'] === 'string' && json['HtmlBody'].trim() !== ''
      ? cleanHtml(json['HtmlBody'])
      : null;
  const text =
    typeof json['TextBody'] === 'string' && json['TextBody'].trim() !== ''
      ? json['TextBody']
      : typeof json['HtmlBody'] === 'string'
        ? htmlToText(json['HtmlBody'])
        : '';
  const messageId =
    typeof json['MessageID'] === 'string' && json['MessageID'] !== ''
      ? `<${json['MessageID']}>`
      : null;
  return {
    messageId:
      messageId ??
      syntheticId([
        from?.address ?? '',
        String(json['Subject'] ?? ''),
        String(json['Date'] ?? ''),
        text,
      ]),
    from,
    to: [...new Set([...list('ToFull'), ...list('CcFull')])],
    subject: typeof json['Subject'] === 'string' ? json['Subject'] : '',
    text: text.slice(0, MAX_TEXT * 4),
    html,
    inReplyTo,
    references: references(header(headers, 'references')),
    date: typeof json['Date'] === 'string' ? json['Date'] : null,
    attachments: (Array.isArray(json['Attachments'])
      ? (json['Attachments'] as Record<string, unknown>[])
      : []
    )
      .filter((a) => typeof a['Content'] === 'string')
      .map((a) => ({
        name: typeof a['Name'] === 'string' ? a['Name'] : 'attachment',
        mime: typeof a['ContentType'] === 'string' ? a['ContentType'] : 'application/octet-stream',
        data: new Uint8Array(Buffer.from(String(a['Content']), 'base64')),
        contentId:
          typeof a['ContentID'] === 'string' && a['ContentID'] !== '' ? a['ContentID'] : null,
        inline: typeof a['ContentID'] === 'string' && a['ContentID'] !== '',
      })),
    automatic,
    bounce,
  };
}

/** A raw message, or a provider's JSON: Postmark (`FromFull`), or any `{ RawEmail }`. */
export async function parseInbound(
  body: string | Uint8Array,
  contentType: string,
): Promise<InboundMail> {
  if (contentType.includes('application/json')) {
    const json = JSON.parse(
      typeof body === 'string' ? body : new TextDecoder().decode(body),
    ) as Record<string, unknown>;
    if (typeof json['RawEmail'] === 'string') return parseMail(json['RawEmail']);
    return fromPostmark(json);
  }
  return parseMail(body);
}
