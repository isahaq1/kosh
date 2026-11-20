/**
 * The survey engine (RFC 0034 §2.6), without a database: which questions a respondent sees — a question may wait
 * for an earlier answer —, whether what they sent is an answer to each (and nothing to the ones they never saw),
 * what it scores, and the two figures every survey of customers ends in: NPS and CSAT.
 *
 * The server is the authority: the page hides and shows questions for comfort, and `review` decides.
 */

export const QUESTION_KINDS = [
  'text',
  'long_text',
  'number',
  'yes_no',
  'choice',
  'choices',
  'rating',
  'nps',
  'date',
] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

export const CONDITIONS = ['eq', 'ne', 'gt', 'lt', 'answered'] as const;
export type ConditionOp = (typeof CONDITIONS)[number];

export interface Choice {
  readonly id: number;
  /** What choosing it scores, in hundredths. */
  readonly score: number;
}

export interface Question {
  readonly id: number;
  readonly kind: QuestionKind;
  readonly required: boolean;
  /** `rating`: the top of the scale (stars), 2 to 10. */
  readonly scaleMax: number;
  /** `rating`, `nps`, `number` (capped at `scaleMax` × weight for ratings): a point of the answer scores this, in hundredths. */
  readonly weight: number;
  readonly choices: readonly Choice[];
  /** Shown only when an earlier question's answer meets a condition. */
  readonly showWhen: {
    readonly question: number;
    readonly op: ConditionOp;
    /** A number, a choice's id, `yes` / `no`, or text — as text. */
    readonly value: string;
  } | null;
}

/** What a respondent sent for a question: text, a number, a choice's id, several, or yes / no. */
export type RawAnswer = string | number | boolean | readonly number[] | null | undefined;

/** An answer the engine accepted. */
export interface Answer {
  readonly question: number;
  readonly text: string | null;
  readonly number: number | null;
  readonly choices: readonly number[];
  /** In hundredths. */
  readonly score: number;
}

export interface Review {
  readonly answers: readonly Answer[];
  /** The question's id, and what is wrong with its answer. */
  readonly errors: readonly { readonly question: number; readonly problem: string }[];
  /** In hundredths. */
  readonly score: number;
  readonly maxScore: number;
}

const TEXT_LIMIT = 4000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const empty = (raw: RawAnswer): boolean =>
  raw === null ||
  raw === undefined ||
  (typeof raw === 'string' && raw.trim() === '') ||
  (Array.isArray(raw) && raw.length === 0);

/** An answer as the text a condition compares with: a choice's id, a number, `yes` / `no`, the text itself. */
function comparable(raw: RawAnswer): string[] {
  if (empty(raw)) return [];
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'boolean') return [raw ? 'yes' : 'no'];
  return [String(raw).trim()];
}

function holds(
  condition: NonNullable<Question['showWhen']>,
  raw: RawAnswer,
  seen: boolean,
): boolean {
  // A question that was not shown has no answer, whatever was sent for it.
  const given = seen ? comparable(raw) : [];
  switch (condition.op) {
    case 'answered':
      return given.length > 0;
    case 'eq':
      return given.includes(condition.value);
    case 'ne':
      return given.length > 0 && !given.includes(condition.value);
    case 'gt':
      return given.some((g) => Number.isFinite(Number(g)) && Number(g) > Number(condition.value));
    case 'lt':
      return given.some((g) => Number.isFinite(Number(g)) && Number(g) < Number(condition.value));
  }
}

/**
 * The questions a respondent sees, in order, given what they answered so far: a question that waits for another
 * shows when that one is itself shown and its answer meets the condition (so a hidden question hides what waits
 * for it). A condition on a later or an unknown question never holds.
 */
export function visibleQuestions(
  questions: readonly Question[],
  answers: Readonly<Record<number, RawAnswer>>,
): Set<number> {
  const seen = new Set<number>();
  const before = new Set<number>();
  for (const q of questions) {
    const c = q.showWhen;
    if (c === null) seen.add(q.id);
    else if (before.has(c.question) && holds(c, answers[c.question], seen.has(c.question)))
      seen.add(q.id);
    before.add(q.id);
  }
  return seen;
}

/** The most a question can score, in hundredths. */
export function maxScoreOf(q: Question): number {
  switch (q.kind) {
    case 'choice':
      return Math.max(0, ...q.choices.map((c) => c.score));
    case 'choices':
      return q.choices.reduce((sum, c) => sum + Math.max(0, c.score), 0);
    case 'rating':
      return Math.max(0, q.scaleMax * q.weight);
    case 'nps':
      return Math.max(0, 10 * q.weight);
    default:
      return 0;
  }
}

function accept(q: Question, raw: RawAnswer): Answer | string {
  const base = { question: q.id, text: null, number: null, choices: [] as number[], score: 0 };
  switch (q.kind) {
    case 'text':
    case 'long_text': {
      if (typeof raw !== 'string') return 'is text';
      const text = raw.trim();
      if (text.length > TEXT_LIMIT) return `is at most ${TEXT_LIMIT} characters`;
      return { ...base, text };
    }
    case 'date': {
      if (typeof raw !== 'string' || !DATE.test(raw) || Number.isNaN(Date.parse(raw)))
        return 'is a date (YYYY-MM-DD)';
      return { ...base, text: raw };
    }
    case 'yes_no': {
      const value =
        raw === true || raw === 'yes' ? 'yes' : raw === false || raw === 'no' ? 'no' : null;
      if (value === null) return 'is yes or no';
      return { ...base, text: value };
    }
    case 'number': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN;
      if (!Number.isFinite(n)) return 'is a number';
      return { ...base, number: n };
    }
    case 'rating':
    case 'nps': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN;
      const [low, high] = q.kind === 'nps' ? [0, 10] : [1, q.scaleMax];
      if (!Number.isInteger(n) || n < low || n > high)
        return `is a whole number from ${low} to ${high}`;
      return { ...base, number: n, score: n * q.weight };
    }
    case 'choice': {
      const id = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
      const chosen = q.choices.find((c) => c.id === id);
      if (chosen === undefined) return 'is one of the choices';
      return { ...base, choices: [chosen.id], score: chosen.score };
    }
    case 'choices': {
      if (!Array.isArray(raw)) return 'is a list of choices';
      const ids = [...new Set(raw.map(Number))];
      const chosen = ids.map((id) => q.choices.find((c) => c.id === id));
      if (chosen.some((c) => c === undefined)) return 'is among the choices';
      return {
        ...base,
        choices: ids,
        score: chosen.reduce((sum, c) => sum + (c?.score ?? 0), 0),
      };
    }
  }
}

/**
 * Reviews what a respondent sent (RFC 0034 §2.6): the answers to the questions they could see — each of its kind
 * —, an error for every required one left empty and every answer that is not one, nothing for questions they did
 * not see, and the score against the most the questions they saw could give.
 */
export function review(
  questions: readonly Question[],
  sent: Readonly<Record<number, RawAnswer>>,
): Review {
  const seen = visibleQuestions(questions, sent);
  const answers: Answer[] = [];
  const errors: { question: number; problem: string }[] = [];
  let score = 0;
  let maxScore = 0;
  for (const q of questions) {
    if (!seen.has(q.id)) continue;
    maxScore += maxScoreOf(q);
    const raw = sent[q.id];
    if (empty(raw)) {
      if (q.required) errors.push({ question: q.id, problem: 'needs an answer' });
      continue;
    }
    const accepted = accept(q, raw);
    if (typeof accepted === 'string') errors.push({ question: q.id, problem: accepted });
    else {
      answers.push(accepted);
      score += accepted.score;
    }
  }
  return { answers, errors, score, maxScore };
}

/**
 * The Net Promoter Score of answers from 0 to 10: the share of promoters (9 and 10) less the share of detractors
 * (0 to 6), from −100 to 100; `null` without an answer.
 */
export function nps(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const promoters = values.filter((v) => v >= 9).length;
  const detractors = values.filter((v) => v <= 6).length;
  return Math.round(((promoters - detractors) * 100) / values.length);
}

/**
 * Customer satisfaction: the share of ratings in the top two fifths of the scale (4 and 5 of 5; 8 to 10 of 10), in
 * percent; `null` without a rating.
 */
export function csat(values: readonly number[], scaleMax: number): number | null {
  if (values.length === 0 || scaleMax < 2) return null;
  const satisfied = values.filter((v) => v > scaleMax * 0.6).length;
  return Math.round((satisfied * 100) / values.length);
}
