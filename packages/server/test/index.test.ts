import { expect, test } from 'vitest';
import { orm } from '../src/orm.js';

test('orm.ts is the Shutro import point and exposes the ORM API', () => {
  expect(typeof orm.createShutro).toBe('function');
  expect(typeof orm.buildRegistry).toBe('function');
  expect(typeof orm.defineModel).toBe('function');
});
