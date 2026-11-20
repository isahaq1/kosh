/**
 * Which rate an hour is billed at (RFC 0034 §2.5), without a database: a rate card's lines name a person, a role,
 * a kind of task, or several of them; the most specific line that fits wins — a person before a role, a role
 * before a kind of task —, then the card's rate for everyone else.
 */

/** A line of a rate card: `null` means "whoever" / "whatever". */
export interface RateLine {
  readonly user: number | null;
  readonly role: number | null;
  readonly category: number | null;
  /** A decimal string, per hour. */
  readonly rate: string;
}

/** The hour to price: who worked, in which role on the project that day, on which kind of task. */
export interface RateQuery {
  readonly user: number;
  readonly role: number | null;
  readonly category: number | null;
}

/** Why a rate was chosen: what the winning line named, or the card's own rate. */
export type RateSource = 'person_and_task' | 'person' | 'role_and_task' | 'role' | 'task' | 'card';

export interface RateFound {
  readonly rate: string;
  readonly source: RateSource;
}

const fits = (wanted: number | null, given: number | null): boolean =>
  wanted === null || wanted === given;

/** A person weighs more than a role, a role more than a kind of task; a line naming both wins over one alone. */
const weight = (line: RateLine): number =>
  (line.user === null ? 0 : 4) + (line.role === null ? 0 : 2) + (line.category === null ? 0 : 1);

function sourceOf(line: RateLine): RateSource {
  if (line.user !== null) return line.category === null ? 'person' : 'person_and_task';
  if (line.role !== null) return line.category === null ? 'role' : 'role_and_task';
  return 'task';
}

/**
 * The rate of an hour: the most specific line that fits (the first of equals, in the card's order), else
 * `fallback` (the card's rate for everyone else), else `null` — there is no rate, and the hour cannot be billed.
 */
export function rateFor(
  lines: readonly RateLine[],
  query: RateQuery,
  fallback: string | null,
): RateFound | null {
  let best: RateLine | null = null;
  for (const line of lines) {
    if (line.user === null && line.role === null && line.category === null) continue;
    if (!fits(line.user, query.user)) continue;
    if (!fits(line.role, query.role)) continue;
    if (!fits(line.category, query.category)) continue;
    if (best === null || weight(line) > weight(best)) best = line;
  }
  if (best !== null) return { rate: best.rate, source: sourceOf(best) };
  return fallback === null ? null : { rate: fallback, source: 'card' };
}
