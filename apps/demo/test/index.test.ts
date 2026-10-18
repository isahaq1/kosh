import { expect, test } from 'vitest';
import { DEMO_MODULES } from '../src/index.js';

test('the demo lists its modules', () => {
  expect(DEMO_MODULES).toContain('purchase');
});
