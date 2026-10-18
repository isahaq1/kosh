/**
 * Message bodies: users write text with a small markdown subset; the server renders the HTML. Everything the user
 * typed is escaped first and only the markup produced here is emitted, so a stored body is safe by construction
 * (no sanitizer needed, nothing to bypass).
 *
 * - paragraphs (blank lines), line breaks, `- ` / `* ` bullet lists
 * - `**bold**`, `_italic_`, `` `code` ``, `http(s)://` links (opened in a new tab, `noopener noreferrer`)
 * - mentions `@[Name](user:12)`: rendered with the user's current name (never the typed label), when the user exists
 */

/** At most this many characters of text per message. */
export const MAX_TEXT = 20_000;

const MENTION = /@\[([^\]\n]{1,100})\]\(user:(\d{1,12})\)/g;
const LINK = /\bhttps?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]]/g;
const CODE = /`([^`\n]{1,500})`/g;
/** Placeholder delimiters: private-use characters, removed from the input first. */
const OPEN = String.fromCharCode(0xe000);
const CLOSE = String.fromCharCode(0xe001);
const SLOT = new RegExp(`${OPEN}(\\d+)${CLOSE}`, 'g');
const DELIMITERS = new RegExp(`[${OPEN}${CLOSE}]`, 'g');

const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** The user ids mentioned in `text`, in order, without duplicates. */
export function mentionIds(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(MENTION)) {
    const id = Number(m[2]);
    if (Number.isSafeInteger(id) && id > 0 && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * One line of inline markup: placeholders (private-use characters, removed from the input) protect code, links and
 * mentions from the emphasis rules.
 */
function inline(line: string, users: ReadonlyMap<number, string>): string {
  const slots: string[] = [];
  const slot = (html: string) => `${OPEN}${slots.push(html) - 1}${CLOSE}`;
  let text = line
    .replace(CODE, (_m, code: string) => slot(`<code>${escapeHtml(code)}</code>`))
    .replace(MENTION, (_m, label: string, id: string) => {
      const name = users.get(Number(id));
      return name === undefined
        ? slot(escapeHtml(`@${label}`))
        : slot(`<span class="mention" data-user="${Number(id)}">@${escapeHtml(name)}</span>`);
    })
    .replace(LINK, (url: string) =>
      slot(
        `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer nofollow">${escapeHtml(url)}</a>`,
      ),
    );
  text = escapeHtml(text)
    .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])_([^_\n]+?)_(?=$|[\s).,;:!?])/g, '$1<em>$2</em>');
  return text.replace(SLOT, (_m, i: string) => slots[Number(i)] ?? '');
}

/** The HTML of `text`, with `users` (id → current name) for mentions. */
export function renderBody(text: string, users: ReadonlyMap<number, string>): string {
  const clean = text.replace(DELIMITERS, '').replace(/\r\n?/g, '\n').trim();
  const blocks = clean.split(/\n{2,}/);
  const html: string[] = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    let paragraph: string[] = [];
    let list: string[] = [];
    const flush = () => {
      if (paragraph.length > 0) html.push(`<p>${paragraph.join('<br>')}</p>`);
      if (list.length > 0) html.push(`<ul>${list.map((li) => `<li>${li}</li>`).join('')}</ul>`);
      paragraph = [];
      list = [];
    };
    for (const line of lines) {
      const item = /^\s*[-*]\s+(.*)$/.exec(line);
      if (item !== null) {
        if (paragraph.length > 0) flush();
        list.push(inline(item[1] ?? '', users));
      } else {
        if (list.length > 0) flush();
        paragraph.push(inline(line, users));
      }
    }
    flush();
  }
  return html.join('');
}

/** Plain text of `text` (notifications, previews): mentions as `@Name`, markup removed. */
export function plainText(text: string, users: ReadonlyMap<number, string>): string {
  return text
    .replace(MENTION, (_m, label: string, id: string) => `@${users.get(Number(id)) ?? label}`)
    .replace(/\*\*([^*\n]+?)\*\*/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .trim();
}
