/**
 * The unsubscribe page (RFC 0038, Campaigns): served without a sign-in to whoever holds the link of a message.
 * Opening it changes nothing — mail scanners follow links —; the button posts, and that takes the address off.
 * No script, its own styles, never framed.
 */
import type { MailLanguage } from './render.js';

const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const WORDS = {
  en: {
    title: 'Unsubscribe',
    ask: (email: string, sender: string) => `Stop emails from ${sender} to ${email}?`,
    button: 'Unsubscribe',
    done: (email: string, sender: string) =>
      `${email} will get no more emails from ${sender}'s mailing lists.`,
    unknown: 'This link does not belong to a message.',
  },
  bn: {
    title: 'তালিকা থেকে বাদ দিন',
    ask: (email: string, sender: string) => `${sender} থেকে ${email}-এ ইমেইল বন্ধ করবেন?`,
    button: 'বাদ দিন',
    done: (email: string, sender: string) =>
      `${email} আর ${sender}-এর মেইলিং তালিকা থেকে কোনো ইমেইল পাবে না।`,
    unknown: 'এই লিংকটি কোনো বার্তার নয়।',
  },
} as const;

const STYLE = `body{margin:0;padding:24px;background:#f4f5f7;color:#1f2937;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
main{max-width:480px;margin:10vh auto 0;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:24px;line-height:1.5}
h1{margin:0 0 12px;font-size:18px}p{margin:0 0 16px}
button{font:inherit;padding:10px 18px;border:0;border-radius:8px;background:#1d4ed8;color:#fff;cursor:pointer}
button:focus-visible{outline:3px solid #93c5fd;outline-offset:2px}
@media (prefers-color-scheme:dark){body{background:#111827;color:#e5e7eb}main{background:#1f2937;border-color:#374151}}`;

/** The headers of the page: its own styles and its own form only, never framed, never cached. */
export const PAGE_SECURITY: Readonly<Record<string, string>> = {
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

const frame = (language: MailLanguage, title: string, inner: string): string =>
  `<!doctype html><html lang="${language}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body><main><h1>${escapeHtml(title)}</h1>${inner}</main></body></html>`;

/** The page of a link: the question with its button, what was done, or that the link is nobody's. */
export function renderUnsubscribe(
  view: { email: string; sender: string; done: boolean } | null,
  language: MailLanguage,
  post: string,
): string {
  const words = WORDS[language];
  if (view === null)
    return frame(language, words.title, `<p role="status">${escapeHtml(words.unknown)}</p>`);
  if (view.done)
    return frame(
      language,
      words.title,
      `<p role="status">${escapeHtml(words.done(view.email, view.sender))}</p>`,
    );
  return frame(
    language,
    words.title,
    `<p>${escapeHtml(words.ask(view.email, view.sender))}</p>
<form method="post" action="${escapeHtml(post)}"><button type="submit">${escapeHtml(words.button)}</button></form>`,
  );
}
