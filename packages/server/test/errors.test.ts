/**
 * Problems for errors raised by the database driver: a constraint is the user's answer (422 with what to change), a
 * conflict with another transaction is "try again" (409) — neither is a server failure.
 */
import { expect, test } from 'vitest';
import { problemOf } from '../src/errors.js';
import { pg } from '../src/orm.js';

test('a unique constraint is a 422 with the problem and the hint apart', () => {
  const error = new pg.ConstraintViolationError(
    'unique',
    'A record with the same value already exists (unique constraint "product_group_code_idx" on "product_group").',
    'Key (code)=(WL) already exists. Use a different value.',
    { sqlState: '23505', constraint: 'product_group_code_idx', table: 'product_group' },
  );
  expect(problemOf(error)).toEqual({
    type: 'https://kosh.dev/problems/constraint-violation',
    title: 'Refused by a constraint',
    status: 422,
    detail:
      'A record with the same value already exists (unique constraint "product_group_code_idx" on "product_group").',
    hint: 'Key (code)=(WL) already exists. Use a different value.',
  });
});

test('a deadlock is a 409 to try again; anything unknown stays a 500 without internals', () => {
  expect(problemOf(new pg.DeadlockError({ sqlState: '40P01' }))).toMatchObject({
    status: 409,
    type: 'https://kosh.dev/problems/concurrent-update',
  });
  expect(problemOf(new Error('secret internals'))).toMatchObject({
    status: 500,
    detail: expect.not.stringContaining('secret'),
  });
});
