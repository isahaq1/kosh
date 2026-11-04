/** The critical path and slipping successors (RFC 0026 step 5), without a database. */
import { expect, test } from 'vitest';
import { criticalPath, type PlanTask, slipMoves } from '../src/schedule.js';

// A (3 days) → B (5 days), A → C (2 days), B and C → D (1 day): A, B, D are critical; C has 3 days to spare.
const tasks: PlanTask[] = [
  { id: 1, start: '2027-03-01', end: '2027-03-03', hours: 0, predecessors: [] },
  { id: 2, start: '2027-03-04', end: '2027-03-08', hours: 0, predecessors: [{ id: 1, lag: 0 }] },
  { id: 3, start: '2027-03-04', end: '2027-03-05', hours: 0, predecessors: [{ id: 1, lag: 0 }] },
  {
    id: 4,
    start: '2027-03-09',
    end: '2027-03-09',
    hours: 0,
    predecessors: [
      { id: 2, lag: 0 },
      { id: 3, lag: 0 },
    ],
  },
];

test('the critical path: no float on A, B and D; C may slip three days', () => {
  const byId = new Map(criticalPath(tasks, '2027-03-01').map((s) => [s.id, s]));
  expect([1, 2, 4].map((id) => byId.get(id)?.critical)).toEqual([true, true, true]);
  expect(byId.get(3)).toMatchObject({ critical: false, float: 3, lateFinish: '2027-03-08' });
  expect(byId.get(4)).toMatchObject({ earlyStart: '2027-03-09', earlyFinish: '2027-03-09' });
});

test('a lag pushes the successor; a task without dates lasts its planned hours at 8 a day', () => {
  const s = criticalPath(
    [
      { id: 1, start: '2027-03-01', end: '2027-03-01', hours: 0, predecessors: [] },
      { id: 2, start: null, end: null, hours: 20, predecessors: [{ id: 1, lag: 2 }] },
    ],
    '2027-03-01',
  );
  expect(s[1]).toMatchObject({ earlyStart: '2027-03-04', earlyFinish: '2027-03-06' });
});

test('slipping: A ends two days later, B and then D move two days, keeping their length; C has room', () => {
  const late = tasks.map((t) => (t.id === 1 ? { ...t, end: '2027-03-05' } : t));
  expect(slipMoves(late)).toEqual([
    { id: 2, start: '2027-03-06', end: '2027-03-10', days: 2 },
    { id: 3, start: '2027-03-06', end: '2027-03-07', days: 2 },
    { id: 4, start: '2027-03-11', end: '2027-03-11', days: 2 },
  ]);
  expect(slipMoves(tasks)).toEqual([]);
});
