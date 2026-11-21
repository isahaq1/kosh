/**
 * The live chat engine (RFC 0034 §2.6), without a database: who is there to answer, who gets the next
 * conversation, what a visitor may send, and when a conversation nobody tends is over.
 */

/** How long after an operator's inbox last said "I am here" they still count as there. */
export const PRESENCE_TTL_MS = 90_000;
/** A message is at most this long. */
export const MAX_MESSAGE = 2000;
/** A conversation holds at most this many messages: a chat, not a mailbox. */
export const MAX_MESSAGES = 400;

export interface Presence {
  /** They said they take conversations. */
  readonly available: boolean;
  /** When their inbox was last open, as a time in milliseconds; `null`: never. */
  readonly seenAt: number | null;
}

/** An operator is there when they said so and their inbox was open a moment ago. */
export function isThere(presence: Presence, now: number, ttlMs: number = PRESENCE_TTL_MS): boolean {
  return (
    presence.available &&
    presence.seenAt !== null &&
    now - presence.seenAt <= ttlMs &&
    presence.seenAt <= now + ttlMs
  );
}

export interface Operator {
  readonly id: number;
  readonly there: boolean;
  /** Conversations they are in right now. */
  readonly open: number;
  /** When they were last given one, in milliseconds; `null`: never. */
  readonly lastAssignedAt: number | null;
}

export type AssignRule = 'turn' | 'load' | 'manual';

/**
 * The operator the next conversation goes to: among those who are there and below their limit — in turn (who
 * waited longest for one), or to the least busy (then in turn). `null`: nobody — it waits for someone to take it.
 */
export function pickOperator(
  operators: readonly Operator[],
  rule: AssignRule,
  limit: number,
): number | null {
  if (rule === 'manual') return null;
  const free = operators.filter((o) => o.there && o.open < Math.max(1, limit));
  if (free.length === 0) return null;
  const turn = (a: Operator, b: Operator): number =>
    (a.lastAssignedAt ?? Number.NEGATIVE_INFINITY) -
      (b.lastAssignedAt ?? Number.NEGATIVE_INFINITY) || a.id - b.id;
  const [first] = [...free].sort(rule === 'load' ? (a, b) => a.open - b.open || turn(a, b) : turn);
  return first?.id ?? null;
}

/**
 * What a visitor or an operator typed, as it is kept: text only — control characters out, line ends alike, no
 * more than two empty lines, trimmed, cut at the limit. Empty: nothing was said.
 */
export function cleanText(value: unknown, max: number = MAX_MESSAGE): string {
  if (typeof value !== 'string') return '';
  let out = '';
  for (const ch of value.replace(/\r\n?/g, '\n')) {
    const code = ch.codePointAt(0) ?? 0;
    // Tabs become spaces; other control characters (and the Unicode line and paragraph separators) go.
    if (ch === '\t') out += ' ';
    else if (ch === '\n' || (code >= 32 && code !== 127 && code !== 0x2028 && code !== 0x2029))
      out += ch;
  }
  return out
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max)
    .trim();
}

/** A visitor sees who answers by their first name only. */
export function firstName(name: string | null | undefined): string {
  return (name ?? '').trim().split(/\s+/)[0] ?? '';
}

export interface Idle {
  readonly state: 'waiting' | 'active' | 'closed' | 'missed';
  /** When the last message came (or the conversation started), in milliseconds. */
  readonly lastAt: number;
  /** Nobody has it, but what the visitor asked was answered (by the assistant): no person is waited for. */
  readonly answered?: boolean;
}

/**
 * What time does to a conversation nobody tends: one still waiting for a person after `missAfterMin` was missed;
 * one that was being answered — or was answered without a person — and went quiet for `closeAfterMin` is closed.
 */
export function overdue(
  session: Idle,
  now: number,
  limits: { readonly missAfterMin: number; readonly closeAfterMin: number },
): 'miss' | 'close' | null {
  const quiet = (now - session.lastAt) / 60_000;
  if (session.state === 'waiting' && session.answered === true)
    return quiet >= limits.closeAfterMin ? 'close' : null;
  if (session.state === 'waiting' && quiet >= limits.missAfterMin) return 'miss';
  if (session.state === 'active' && quiet >= limits.closeAfterMin) return 'close';
  return null;
}

/** The seconds a visitor waited for the first answer; never below zero. */
export function waited(startedAt: number, answeredAt: number): number {
  return Math.max(0, Math.round((answeredAt - startedAt) / 1000));
}

// ---- where a conversation goes when it ends

/** A rule of a channel: conversations that end this way, about this, become a record of another app. */
export interface RouteRule {
  readonly id: number;
  /** How the conversation ended: closed, missed, or either. */
  readonly on: 'closed' | 'missed' | 'any';
  /** Any of these words in what the visitor wrote (whole words, any case); none: whatever they wrote. */
  readonly keywords: readonly string[];
  /** A part of the address of the page they wrote from; `null`: any page. */
  readonly page: string | null;
  /** The model the conversation becomes a record of. */
  readonly target: string;
}

/** The words of a rule's setting: separated by commas or lines, trimmed, lower case, none twice. */
export function keywordsOf(setting: string | null | undefined): string[] {
  return [
    ...new Set(
      (setting ?? '')
        .split(/[,\n]/)
        .map((w) => w.trim().toLowerCase())
        .filter((w) => w !== ''),
    ),
  ].slice(0, 50);
}

const wordsOf = (text: string): string =>
  ` ${text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim()} `;

/**
 * The first rule, in the channel's order, that a conversation which ended meets: how it ended, a word the
 * visitor wrote, the page they wrote from. `null`: no rule — the conversation stays a conversation.
 */
export function pickRule(
  rules: readonly RouteRule[],
  ended: {
    readonly outcome: 'closed' | 'missed';
    readonly said: string;
    readonly page: string | null;
  },
): RouteRule | null {
  const said = wordsOf(ended.said);
  const page = (ended.page ?? '').toLowerCase();
  return (
    rules.find(
      (r) =>
        (r.on === 'any' || r.on === ended.outcome) &&
        (r.keywords.length === 0 || r.keywords.some((k) => said.includes(wordsOf(k)))) &&
        (r.page === null || r.page.trim() === '' || page.includes(r.page.trim().toLowerCase())),
    ) ?? null
  );
}

export interface Line {
  readonly kind: string;
  readonly author: string;
  readonly body: string;
  /** ISO time. */
  readonly at: string;
}

/** A conversation as text, for the record it becomes: a line per message, with the time (UTC) and who said it. */
export function transcriptOf(
  lines: readonly Line[],
  names: { readonly visitor: string; readonly operator: string },
): string {
  return lines
    .map((l) => {
      const at = l.at.slice(11, 16);
      if (l.kind === 'system') return `[${at}] — ${l.body}`;
      const who = l.author.trim() || (l.kind === 'operator' ? names.operator : names.visitor);
      return `[${at}] ${who}: ${l.body}`;
    })
    .join('\n');
}

/** What a conversation is about, in a line: the start of the visitor's first message. */
export function subjectOf(first: string, max = 80): string {
  const line = first.replace(/\s+/g, ' ').trim();
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
