/** A project's health from its figures (RFC 0026 step 4): the worst of schedule, late milestones and cost. */
import { expect, test } from 'vitest';
import { judgeHealth } from '../src/module.js';

const rules = { behindRisk: 10, behindOff: 25, costRisk: 90 };
const base = {
  today: '2027-03-01',
  dateStart: '2027-01-01',
  dateEnd: '2027-05-01', // 59 of 120 days gone: 49 %
  progress: 49,
  milestonesLate: 0,
  budget: 0,
  spent: 0,
};

test('on track when progress keeps up with the time elapsed', () => {
  expect(judgeHealth(base, rules)).toEqual({ health: 'on_track', reasons: [] });
});

test('behind the schedule: at risk from 10 points, off track from 25', () => {
  expect(judgeHealth({ ...base, progress: 35 }, rules).health).toBe('at_risk');
  const off = judgeHealth({ ...base, progress: 20 }, rules);
  expect(off.health).toBe('off_track');
  expect(off.reasons[0]).toBe('29 points behind: 49% of the time gone, 20% done.');
});

test('past the deadline and not done: off track; done: on track', () => {
  expect(judgeHealth({ ...base, today: '2027-05-02', progress: 90 }, rules).health).toBe(
    'off_track',
  );
  expect(judgeHealth({ ...base, today: '2027-05-02', progress: 100 }, rules).health).toBe(
    'on_track',
  );
});

test('a late milestone puts it at risk; the budget used at 90 % too, beyond it off track', () => {
  expect(judgeHealth({ ...base, milestonesLate: 1 }, rules).health).toBe('at_risk');
  expect(judgeHealth({ ...base, budget: 1000, spent: 900 }, rules).health).toBe('at_risk');
  const over = judgeHealth({ ...base, budget: 1000, spent: 1200, milestonesLate: 2 }, rules);
  expect(over.health).toBe('off_track');
  expect(over.reasons).toEqual(['2 milestone(s) late.', '120% of the budget used.']);
});

test('without dates or a budget there is nothing to judge: on track', () => {
  expect(judgeHealth({ ...base, dateStart: null, dateEnd: null, progress: 0 }, rules).health).toBe(
    'on_track',
  );
});
