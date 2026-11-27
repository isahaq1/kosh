/**
 * What a campaign's email is made of, without a database (RFC 0038, Campaigns): the address as a key, the
 * placeholders, the links to follow, the A/B variant of a recipient, and the message itself — the body in a plain
 * frame, every link through the server, a pixel for the open, and **always** the way out: an unsubscribe link in
 * the footer and in the `List-Unsubscribe` headers.
 */
import { decodeEntities, htmlToText } from '@kosh/server';

const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** An address as the key it is known by — trimmed, lower case — or `null` when it is not an address. */
export function emailKey(raw: string | null | undefined): string | null {
  const key = (raw ?? '').trim().toLowerCase();
  return /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(key) && key.length <= 254 ? key : null;
}

/** What a placeholder may read of a recipient. */
export interface Recipient {
  readonly name: string;
  readonly email: string;
}

/**
 * Fills `{{name}}`, `{{first_name}}` and `{{email}}`; `{{name|friend}}` says what to write when it is empty. A
 * placeholder it does not know is removed. Values are escaped when the text is HTML.
 */
export function personalize(text: string, who: Recipient, html: boolean): string {
  const name = who.name.trim();
  const values: Readonly<Record<string, string>> = {
    name,
    first_name: name.split(/\s+/)[0] ?? '',
    email: who.email,
  };
  return text.replace(
    /\{\{\s*([a-z_]+)\s*(?:\|([^}]*))?\}\}/gi,
    (_all, key: string, or?: string) => {
      const value = values[key.toLowerCase()] ?? '';
      // The fallback comes from the text itself, which is HTML already when `html`.
      if (value === '') return (or ?? '').trim();
      return html ? escapeHtml(value) : value;
    },
  );
}

const HREF = /href="([^"]*)"/gi;
const followed = (url: string): boolean => /^https?:\/\//i.test(url);

/** The web links of a body, each once, in the order they first appear. */
export function linksOf(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(HREF)) {
    const url = decodeEntities(m[1] ?? '').trim();
    if (followed(url) && !out.includes(url)) out.push(url);
  }
  return out;
}

/** Subject A or B: recipients alternate, so the two halves are alike. Without a second subject, all are A. */
export const variantOf = (position: number, hasB: boolean): 'a' | 'b' =>
  hasB && position % 2 === 1 ? 'b' : 'a';

/** Where a recipient's links lead: through the server, which counts and sends on. */
export interface Tracking {
  /** The address that counts a click on link `n` (its place in {@link linksOf}) and redirects. */
  click(n: number): string;
  /** The pixel that counts the open. */
  readonly open: string;
  /** The page, and the one-click address, that takes the recipient off. */
  readonly unsubscribe: string;
}

const WORDS = {
  en: {
    why: (sender: string) => `You receive this because you are on a mailing list of ${sender}.`,
    unsubscribe: 'Unsubscribe',
  },
  bn: {
    why: (sender: string) => `আপনি ${sender}-এর একটি মেইলিং তালিকায় আছেন বলে এটি পাচ্ছেন।`,
    unsubscribe: 'তালিকা থেকে বাদ দিন',
  },
} as const;

export type MailLanguage = keyof typeof WORDS;

export interface Composed {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * One recipient's message. With `tracking`, links go through the server, the open is counted and the way out is
 * there; without it (a test send) the body is as written and nothing is counted.
 */
export function compose(input: {
  readonly subject: string;
  readonly preheader: string | null;
  readonly body: string;
  readonly who: Recipient;
  readonly links: readonly string[];
  readonly tracking: Tracking | null;
  readonly language: MailLanguage;
  readonly sender: string;
}): Composed {
  const { who, tracking } = input;
  const words = WORDS[input.language];
  const subject = personalize(input.subject, who, false);
  const filled = personalize(input.body, who, true);
  const body =
    tracking === null
      ? filled
      : filled.replace(HREF, (all, raw: string) => {
          const n = input.links.indexOf(decodeEntities(raw).trim());
          return n < 0 ? all : `href="${escapeHtml(tracking.click(n))}"`;
        });
  const preheader =
    input.preheader === null || input.preheader.trim() === ''
      ? ''
      : `<div style="display:none;max-height:0;overflow:hidden">${escapeHtml(personalize(input.preheader, who, false))}</div>`;
  const footer =
    tracking === null
      ? ''
      : `<p style="margin:24px 0 0;padding-top:12px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280;line-height:1.5">${escapeHtml(words.why(input.sender))} <a href="${escapeHtml(tracking.unsubscribe)}" style="color:#6b7280">${escapeHtml(words.unsubscribe)}</a></p>`;
  const pixel =
    tracking === null
      ? ''
      : `<img src="${escapeHtml(tracking.open)}" width="1" height="1" alt="" style="display:block;border:0">`;
  const html = `<!doctype html>
<html lang="${input.language}">
<body style="margin:0;padding:24px;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2937">
${preheader}<div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:24px;line-height:1.5">
${body}
${footer}
</div>${pixel}
</body>
</html>`;
  const text =
    htmlToText(filled) +
    (tracking === null
      ? ''
      : `\n\n${words.why(input.sender)}\n${words.unsubscribe}: ${tracking.unsubscribe}`);
  return {
    subject,
    html,
    text,
    headers:
      tracking === null
        ? {}
        : {
            'List-Unsubscribe': `<${tracking.unsubscribe}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          },
  };
}

/** A share as a percentage to one place (`12.5`), or `null` over nothing. */
export const percent = (part: number, whole: number): string | null =>
  whole > 0 ? (Math.round((part / whole) * 1000) / 10).toFixed(1) : null;
