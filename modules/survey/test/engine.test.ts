/**
 * The survey engine (RFC 0034 §2.6), without a database: which questions show, what counts as an answer, the
 * score, NPS and CSAT.
 */
import { expect, test } from 'vitest';
import {
  csat,
  maxScoreOf,
  nps,
  type Question,
  type QuestionKind,
  review,
  visibleQuestions,
} from '../src/engine.js';

const q = (id: number, kind: QuestionKind, more: Partial<Question> = {}): Question => ({
  id,
  kind,
  required: false,
  scaleMax: 5,
  weight: 0,
  choices: [],
  showWhen: null,
  ...more,
});

// Would you recommend us (0–10)? Below 7: what went wrong, and may we call you; if yes, your number.
const FOLLOW_UP: readonly Question[] = [
  q(1, 'nps', { required: true }),
  q(2, 'long_text', { required: true, showWhen: { question: 1, op: 'lt', value: '7' } }),
  q(3, 'yes_no', { showWhen: { question: 1, op: 'lt', value: '7' } }),
  q(4, 'text', { required: true, showWhen: { question: 3, op: 'eq', value: 'yes' } }),
  q(5, 'text'),
];

test('a question waits for an earlier answer; a hidden question hides what waits for it', () => {
  expect([...visibleQuestions(FOLLOW_UP, {})]).toEqual([1, 5]);
  expect([...visibleQuestions(FOLLOW_UP, { 1: 9 })]).toEqual([1, 5]);
  expect([...visibleQuestions(FOLLOW_UP, { 1: 4 })]).toEqual([1, 2, 3, 5]);
  expect([...visibleQuestions(FOLLOW_UP, { 1: 4, 3: true })]).toEqual([1, 2, 3, 4, 5]);
  // "Yes" was sent for a question that is not shown: what waits for it stays hidden.
  expect([...visibleQuestions(FOLLOW_UP, { 1: 9, 3: 'yes' })]).toEqual([1, 5]);
  // A condition on a later question, or on none that exists, never holds.
  const backwards = [
    q(1, 'text', { showWhen: { question: 2, op: 'answered', value: '' } }),
    q(2, 'text'),
  ];
  expect([...visibleQuestions(backwards, { 2: 'x' })]).toEqual([2]);
  // The other conditions: answered, not equal (of an answer given), greater than, a choice by its id.
  const more = [
    q(1, 'choice', {
      choices: [
        { id: 11, score: 0 },
        { id: 12, score: 0 },
      ],
    }),
    q(2, 'text', { showWhen: { question: 1, op: 'eq', value: '12' } }),
    q(3, 'text', { showWhen: { question: 1, op: 'ne', value: '12' } }),
    q(4, 'text', { showWhen: { question: 1, op: 'answered', value: '' } }),
    q(5, 'number'),
    q(6, 'text', { showWhen: { question: 5, op: 'gt', value: '100' } }),
  ];
  expect([...visibleQuestions(more, { 1: 12, 5: 250 })]).toEqual([1, 2, 4, 5, 6]);
  expect([...visibleQuestions(more, { 1: 11, 5: 100 })]).toEqual([1, 3, 4, 5]);
  expect([...visibleQuestions(more, {})]).toEqual([1, 5]);
});

test('required questions that are seen need an answer; hidden ones take none', () => {
  // A promoter: nothing more is asked, and what was sent for hidden questions is dropped.
  const happy = review(FOLLOW_UP, { 1: 10, 2: 'ignored', 4: '017…' });
  expect(happy.errors).toEqual([]);
  expect(happy.answers.map((a) => a.question)).toEqual([1]);
  // A detractor who says nothing more: the reason is required.
  expect(review(FOLLOW_UP, { 1: 3 }).errors).toEqual([{ question: 2, problem: 'needs an answer' }]);
  // … and who agrees to a call: the number too.
  expect(review(FOLLOW_UP, { 1: 3, 2: 'Late delivery', 3: 'yes' }).errors).toEqual([
    { question: 4, problem: 'needs an answer' },
  ]);
  const full = review(FOLLOW_UP, { 1: 3, 2: ' Late delivery ', 3: 'yes', 4: '01711' });
  expect(full.errors).toEqual([]);
  expect(full.answers.map((a) => [a.question, a.text ?? a.number])).toEqual([
    [1, 3],
    [2, 'Late delivery'],
    [3, 'yes'],
    [4, '01711'],
  ]);
  // Nothing at all: the first question is required.
  expect(review(FOLLOW_UP, {}).errors).toEqual([{ question: 1, problem: 'needs an answer' }]);
});

test('each kind takes its own answers, and says what it wants otherwise', () => {
  const all: readonly Question[] = [
    q(1, 'text'),
    q(2, 'number'),
    q(3, 'yes_no'),
    q(4, 'choice', {
      choices: [
        { id: 41, score: 0 },
        { id: 42, score: 0 },
      ],
    }),
    q(5, 'choices', {
      choices: [
        { id: 51, score: 0 },
        { id: 52, score: 0 },
      ],
    }),
    q(6, 'rating', { scaleMax: 5 }),
    q(7, 'nps'),
    q(8, 'date'),
  ];
  const good = review(all, {
    1: 'a',
    2: '12.5',
    3: false,
    4: '42',
    5: [51, 52, 51],
    6: 5,
    7: 0,
    8: '2027-02-28',
  });
  expect(good.errors).toEqual([]);
  expect(good.answers.map((a) => a.text ?? a.number ?? a.choices)).toEqual([
    'a',
    12.5,
    'no',
    [42],
    [51, 52],
    5,
    0,
    '2027-02-28',
  ]);
  const bad = review(all, {
    1: 7,
    2: 'many',
    3: 'maybe',
    4: 43,
    5: [51, 99],
    6: 6,
    7: 10.5,
    8: '28/02/2027',
  });
  expect(bad.answers).toEqual([]);
  expect(bad.errors.map((e) => e.problem)).toEqual([
    'is text',
    'is a number',
    'is yes or no',
    'is one of the choices',
    'is among the choices',
    'is a whole number from 1 to 5',
    'is a whole number from 0 to 10',
    'is a date (YYYY-MM-DD)',
  ]);
  expect(review([q(1, 'long_text')], { 1: 'x'.repeat(4001) }).errors[0]?.problem).toBe(
    'is at most 4000 characters',
  );
});

test('the score: choices by their points, ratings by their weight, against what was seen', () => {
  // A screening: years of experience by choice, a skill by several, a self-rating that counts double.
  const screening: readonly Question[] = [
    q(1, 'choice', {
      choices: [
        { id: 11, score: 0 },
        { id: 12, score: 500 },
        { id: 13, score: 1000 },
      ],
    }),
    q(2, 'choices', {
      choices: [
        { id: 21, score: 300 },
        { id: 22, score: 200 },
        { id: 23, score: -100 },
      ],
    }),
    q(3, 'rating', { scaleMax: 5, weight: 200 }),
    q(4, 'choice', {
      choices: [{ id: 41, score: 400 }],
      showWhen: { question: 1, op: 'eq', value: '13' },
    }),
    q(5, 'text'),
  ];
  expect(screening.map(maxScoreOf)).toEqual([1000, 500, 1000, 400, 0]);
  const senior = review(screening, { 1: 13, 2: [21, 22], 3: 4, 4: 41 });
  expect([senior.score, senior.maxScore]).toEqual([1000 + 500 + 800 + 400, 2900]);
  // The fourth question is not asked of a junior: it is not in what they could have scored.
  const junior = review(screening, { 1: 11, 2: [21, 23], 3: 2 });
  expect([junior.score, junior.maxScore]).toEqual([0 + 200 + 400, 2500]);
});

test('NPS and CSAT', () => {
  // Promoters 9–10, detractors 0–6: 3 of 6 less 2 of 6.
  expect(nps([10, 9, 9, 8, 6, 0])).toBe(17);
  expect(nps([10, 10])).toBe(100);
  expect(nps([0, 6])).toBe(-100);
  expect(nps([7, 8])).toBe(0);
  expect(nps([])).toBeNull();
  // Satisfied: 4 and 5 of 5; 7 to 10 of 10.
  expect(csat([5, 4, 3, 1], 5)).toBe(50);
  expect(csat([10, 7, 6], 10)).toBe(67);
  expect(csat([], 5)).toBeNull();
});
